const crypto = require('crypto');
const { EventEmitter } = require('events');
const log = require('./log');
const { getDb } = require('./db');

const VALID_TYPES = ['release-notes', 'release-presentation'];
// Exposed for anyone who wants to introspect available statuses.
const VALID_STATUSES = ['pending', 'in-progress', 'completed', 'failed'];

/**
 * TaskQueue — persistent async task queue for Hive-executed work.
 *
 * Tasks flow through: pending → in-progress → completed | failed
 * Persisted to the `tasks` SQLite table.
 *
 * Events:
 *   task:created    (task)
 *   task:claimed    (task)
 *   task:completed  (task)
 *   task:failed     (task)
 */
class TaskQueue extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db] — inject a DB (tests)
   */
  constructor(opts = {}) {
    super();
    this.db = opts.db || getDb();
    // In-memory mirror keyed by id. Kept in sync on every mutation so
    // tests that inspect `queue.tasks.get(id)` still work.
    this.tasks = new Map();
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

    this._insert(task);
    this.tasks.set(id, task);
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
    this._update(task);
    this.emit('task:claimed', task);
    log.info(`Task claimed: ${taskId}`);
    return { ...task };
  }

  /**
   * Complete a task — set status, output, and completedAt.
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
    this._update(task);
    this.emit('task:completed', task);
    log.info(`Task completed: ${taskId}`);
    return { ...task };
  }

  /**
   * Fail a task — set status and error message.
   */
  fail(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'in-progress' && task.status !== 'pending') {
      throw new Error(`Task ${taskId} is ${task.status}, cannot fail`);
    }

    task.status = 'failed';
    task.error = error || 'Unknown error';
    task.completedAt = new Date().toISOString();
    this._update(task);
    this.emit('task:failed', task);
    log.warn(`Task failed: ${taskId} — ${error}`);
    return { ...task };
  }

  /**
   * Get a single task by ID.
   */
  getTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  /**
   * List tasks with optional filters.
   */
  listTasks(filters = {}) {
    let tasks = Array.from(this.tasks.values());

    if (filters.status) tasks = tasks.filter(t => t.status === filters.status);
    if (filters.type) tasks = tasks.filter(t => t.type === filters.type);

    // Sort newest first
    tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const total = tasks.length;
    const offset = filters.offset || 0;
    const limit = filters.limit || 100;
    const sliced = tasks.slice(offset, offset + limit).map(t => ({ ...t }));

    return { tasks: sliced, total, hasMore: offset + limit < total };
  }

  /**
   * Find an existing task for a given release version and type.
   */
  findByRelease(type, version) {
    const matching = Array.from(this.tasks.values())
      .filter(t => t.type === type && t.input && t.input.version === version)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matching.length > 0 ? { ...matching[0] } : null;
  }

  /**
   * Backwards-compat no-op — writes are synchronous with SQLite.
   */
  flush() { /* no-op */ }

  // ── Internal ────────────────────────────────────────────

  _insert(task) {
    this.db.prepare(`
      INSERT INTO tasks (id, type, status, input, output, requestedBy, slackUserId,
                         createdAt, startedAt, completedAt, error)
      VALUES (@id, @type, @status, @input, @output, @requestedBy, @slackUserId,
              @createdAt, @startedAt, @completedAt, @error)
    `).run(toRow(task));
  }

  _update(task) {
    this.db.prepare(`
      UPDATE tasks SET
        type = @type,
        status = @status,
        input = @input,
        output = @output,
        requestedBy = @requestedBy,
        slackUserId = @slackUserId,
        startedAt = @startedAt,
        completedAt = @completedAt,
        error = @error
      WHERE id = @id
    `).run(toRow(task));
  }

  _loadState() {
    try {
      const rows = this.db.prepare('SELECT * FROM tasks').all();
      for (const row of rows) {
        this.tasks.set(row.id, fromRow(row));
      }
      log.info(`Loaded ${this.tasks.size} tasks`);
    } catch (err) {
      log.error(`Failed to load tasks: ${err.message}`);
    }
  }
}

function toRow(task) {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    input: JSON.stringify(task.input || {}),
    output: task.output == null ? null : JSON.stringify(task.output),
    requestedBy: task.requestedBy ?? null,
    slackUserId: task.slackUserId ?? null,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    error: task.error ?? null,
  };
}

function fromRow(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    input: safeParse(row.input, {}),
    output: row.output == null ? null : safeParse(row.output, null),
    requestedBy: row.requestedBy,
    slackUserId: row.slackUserId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
  };
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

TaskQueue.VALID_TYPES = VALID_TYPES;
TaskQueue.VALID_STATUSES = VALID_STATUSES;

module.exports = TaskQueue;
