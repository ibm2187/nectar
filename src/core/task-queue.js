const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-tasks.json');

const VALID_TYPES = ['release-notes', 'release-presentation'];
const VALID_STATUSES = ['pending', 'in-progress', 'completed', 'failed'];

/**
 * TaskQueue — persistent async task queue for Hive-executed work.
 *
 * Tasks flow through: pending → in-progress → completed | failed
 * Persisted to .nectar-tasks.json.
 *
 * Events:
 *   task:created    (task)
 *   task:claimed    (task)
 *   task:completed  (task)
 *   task:failed     (task)
 */
class TaskQueue extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map(); // id → task
    this._saveTimer = null;
    this._loadState();
  }

  /**
   * Create a new task.
   * @param {string} type - Task type (release-notes, release-presentation)
   * @param {object} input - Task input data
   * @param {string|null} requestedBy - Email of requester (from SSO) or null
   * @param {object} [opts] - Optional fields
   * @param {string|null} [opts.slackUserId] - Slack user ID for completion notification
   * @returns {object} The created task
   */
  createTask(type, input, requestedBy = null, opts = {}) {
    if (!VALID_TYPES.includes(type)) {
      throw new Error(`Invalid task type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`);
    }
    if (!input || typeof input !== 'object') {
      throw new Error('Task input is required');
    }

    const id = `task-${crypto.randomBytes(8).toString('hex')}`;
    const task = {
      id,
      type,
      status: 'pending',
      input,
      output: null,
      requestedBy,
      slackUserId: opts.slackUserId || null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
    };

    this.tasks.set(id, task);
    this._save();
    this.emit('task:created', task);
    log.info(`Task created: ${id} (${type}) by ${requestedBy || 'anonymous'}`);
    return { ...task };
  }

  /**
   * Get pending tasks, optionally filtered by type.
   * @param {string} [type] - Filter by task type
   * @returns {object[]}
   */
  getPending(type) {
    let tasks = Array.from(this.tasks.values()).filter(t => t.status === 'pending');
    if (type) tasks = tasks.filter(t => t.type === type);
    return tasks.map(t => ({ ...t })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Claim a task — atomically set status to in-progress.
   * @param {string} taskId
   * @returns {object} The updated task
   * @throws {Error} If task not found or not pending
   */
  claim(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'pending') {
      throw new Error(`Task ${taskId} is ${task.status}, cannot claim (must be pending)`);
    }

    task.status = 'in-progress';
    task.startedAt = new Date().toISOString();
    this._save();
    this.emit('task:claimed', task);
    log.info(`Task claimed: ${taskId}`);
    return { ...task };
  }

  /**
   * Complete a task — set status, output, and completedAt.
   * @param {string} taskId
   * @param {object} output - Task output (gammaUrl, notes, perTicketSummaries, etc.)
   * @returns {object} The updated task
   * @throws {Error} If task not found or not in-progress
   */
  complete(taskId, output) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'in-progress') {
      throw new Error(`Task ${taskId} is ${task.status}, cannot complete (must be in-progress)`);
    }

    task.status = 'completed';
    task.output = output || {};
    task.completedAt = new Date().toISOString();
    this._save();
    this.emit('task:completed', task);
    log.info(`Task completed: ${taskId}`);
    return { ...task };
  }

  /**
   * Fail a task — set status and error message.
   * @param {string} taskId
   * @param {string} error - Error message
   * @returns {object} The updated task
   * @throws {Error} If task not found or not in-progress
   */
  fail(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'in-progress') {
      throw new Error(`Task ${taskId} is ${task.status}, cannot fail (must be in-progress)`);
    }

    task.status = 'failed';
    task.error = error || 'Unknown error';
    task.completedAt = new Date().toISOString();
    this._save();
    this.emit('task:failed', task);
    log.warn(`Task failed: ${taskId} — ${error}`);
    return { ...task };
  }

  /**
   * Get a single task by ID.
   * @param {string} taskId
   * @returns {object|null}
   */
  getTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  /**
   * List tasks with optional filters.
   * @param {object} [filters]
   * @param {string} [filters.status] - Filter by status
   * @param {string} [filters.type] - Filter by type
   * @param {number} [filters.limit] - Max results (default 100)
   * @returns {object[]}
   */
  listTasks(filters = {}) {
    let tasks = Array.from(this.tasks.values());

    if (filters.status) {
      tasks = tasks.filter(t => t.status === filters.status);
    }
    if (filters.type) {
      tasks = tasks.filter(t => t.type === filters.type);
    }

    // Sort newest first
    tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const limit = filters.limit || 100;
    return tasks.slice(0, limit).map(t => ({ ...t }));
  }

  /**
   * Find an existing task for a given release version and type.
   * Useful to prevent creating duplicates.
   * @param {string} type
   * @param {string} version - Release version from input
   * @returns {object|null} The most recent matching task, or null
   */
  findByRelease(type, version) {
    const matching = Array.from(this.tasks.values())
      .filter(t => t.type === type && t.input && t.input.version === version)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matching.length > 0 ? { ...matching[0] } : null;
  }

  /**
   * Flush state to disk immediately (for shutdown).
   */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._save();
  }

  // ── Internal ────────────────────────────────────────────

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (Array.isArray(data.tasks)) {
          for (const task of data.tasks) {
            this.tasks.set(task.id, task);
          }
        }
        log.info(`Loaded ${this.tasks.size} tasks`);
      }
    } catch (err) {
      log.error(`Failed to load tasks: ${err.message}`);
    }
  }

  _save() {
    try {
      const data = { tasks: Array.from(this.tasks.values()) };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error(`Failed to save tasks: ${err.message}`);
    }
  }
}

module.exports = TaskQueue;
