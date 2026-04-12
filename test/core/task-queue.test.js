import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TaskQueue = require('../../src/core/task-queue');

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-tasks.json');

describe('TaskQueue', () => {
  let queue;
  let originalState;

  beforeEach(() => {
    // Preserve any existing state file
    if (fs.existsSync(STATE_FILE)) {
      originalState = fs.readFileSync(STATE_FILE, 'utf8');
    }
    queue = new TaskQueue();
    queue.tasks.clear();
  });

  afterEach(() => {
    // Restore original state file
    if (originalState) {
      fs.writeFileSync(STATE_FILE, originalState);
    } else if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    originalState = undefined;
    vi.restoreAllMocks();
  });

  describe('createTask', () => {
    // TESTING: Creating a task with valid type and input
    // EXPECTED: Task is created with pending status and proper fields
    it('creates a task with pending status', () => {
      const task = queue.createTask('release-notes', {
        repo: 'webplatform',
        version: '4.2.3-lumen',
        tickets: [],
      }, 'user@test.com');

      expect(task.id).toMatch(/^task-/);
      expect(task.type).toBe('release-notes');
      expect(task.status).toBe('pending');
      expect(task.input.version).toBe('4.2.3-lumen');
      expect(task.requestedBy).toBe('user@test.com');
      expect(task.output).toBeNull();
      expect(task.createdAt).toBeTruthy();
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
    });

    // TESTING: Invalid task type
    // EXPECTED: Throws an error
    it('throws on invalid task type', () => {
      expect(() => queue.createTask('invalid-type', {})).toThrow('Invalid task type');
    });

    // TESTING: Missing input
    // EXPECTED: Throws an error
    it('throws on missing input', () => {
      expect(() => queue.createTask('release-notes', null)).toThrow('Task input is required');
    });

    // TESTING: Task with optional slackUserId
    // EXPECTED: slackUserId is stored on the task
    it('stores optional slackUserId', () => {
      const task = queue.createTask('release-presentation', { version: '1.0' }, null, {
        slackUserId: 'U12345',
      });
      expect(task.slackUserId).toBe('U12345');
    });

    // TESTING: Event emission on create
    // EXPECTED: task:created event is emitted with the task
    it('emits task:created event', () => {
      const handler = vi.fn();
      queue.on('task:created', handler);

      queue.createTask('release-notes', { version: '1.0' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].type).toBe('release-notes');
    });
  });

  describe('claim', () => {
    // TESTING: Claiming a pending task
    // EXPECTED: Status becomes in-progress, startedAt is set
    it('sets status to in-progress and startedAt', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      const claimed = queue.claim(created.id);

      expect(claimed.status).toBe('in-progress');
      expect(claimed.startedAt).toBeTruthy();
    });

    // TESTING: Claiming a non-pending task
    // EXPECTED: Throws an error
    it('throws when task is not pending', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      queue.claim(created.id);

      expect(() => queue.claim(created.id)).toThrow('cannot claim');
    });

    // TESTING: Claiming non-existent task
    // EXPECTED: Throws an error
    it('throws for non-existent task', () => {
      expect(() => queue.claim('task-nonexistent')).toThrow('Task not found');
    });

    // TESTING: Event emission on claim
    // EXPECTED: task:claimed event is emitted
    it('emits task:claimed event', () => {
      const handler = vi.fn();
      queue.on('task:claimed', handler);

      const task = queue.createTask('release-notes', { version: '1.0' });
      queue.claim(task.id);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('complete', () => {
    // TESTING: Completing an in-progress task
    // EXPECTED: Status becomes completed, output and completedAt are set
    it('sets status to completed with output', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      queue.claim(created.id);

      const output = {
        gammaUrl: 'https://gamma.app/docs/test',
        notes: '# Release 1.0',
      };
      const completed = queue.complete(created.id, output);

      expect(completed.status).toBe('completed');
      expect(completed.output.gammaUrl).toBe('https://gamma.app/docs/test');
      expect(completed.output.notes).toBe('# Release 1.0');
      expect(completed.completedAt).toBeTruthy();
    });

    // TESTING: Completing a non-in-progress task
    // EXPECTED: Throws an error
    it('throws when task is not in-progress', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      expect(() => queue.complete(created.id, {})).toThrow('cannot complete');
    });

    // TESTING: Event emission on complete
    // EXPECTED: task:completed event is emitted
    it('emits task:completed event', () => {
      const handler = vi.fn();
      queue.on('task:completed', handler);

      const task = queue.createTask('release-notes', { version: '1.0' });
      queue.claim(task.id);
      queue.complete(task.id, { notes: 'done' });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('fail', () => {
    // TESTING: Failing an in-progress task
    // EXPECTED: Status becomes failed, error is set
    it('sets status to failed with error message', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      queue.claim(created.id);

      const failed = queue.fail(created.id, 'Something went wrong');

      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('Something went wrong');
      expect(failed.completedAt).toBeTruthy();
    });

    // TESTING: Failing a completed task
    // EXPECTED: Throws — cannot fail a completed task
    it('throws when task is already completed', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      queue.claim(created.id);
      queue.complete(created.id, {});
      expect(() => queue.fail(created.id, 'error')).toThrow('cannot fail');
    });

    // TESTING: Failing a pending task (for supersede)
    // EXPECTED: Allowed — pending tasks can be failed to supersede them
    it('allows failing a pending task', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      const failed = queue.fail(created.id, 'Superseded');
      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('Superseded');
    });
  });

  describe('getPending', () => {
    // TESTING: Getting pending tasks
    // EXPECTED: Returns only tasks with pending status
    it('returns only pending tasks', () => {
      queue.createTask('release-notes', { version: '1.0' });
      const t2 = queue.createTask('release-notes', { version: '2.0' });
      queue.createTask('release-presentation', { version: '3.0' });
      queue.claim(t2.id); // Make one in-progress

      const pending = queue.getPending();
      expect(pending).toHaveLength(2);
      expect(pending.every(t => t.status === 'pending')).toBe(true);
    });

    // TESTING: Filtering pending tasks by type
    // EXPECTED: Returns only pending tasks of the specified type
    it('filters by type', () => {
      queue.createTask('release-notes', { version: '1.0' });
      queue.createTask('release-presentation', { version: '2.0' });

      const notes = queue.getPending('release-notes');
      expect(notes).toHaveLength(1);
      expect(notes[0].type).toBe('release-notes');
    });

    // TESTING: Pending tasks are sorted oldest first (FIFO)
    // EXPECTED: Tasks are ordered by createdAt ascending
    it('sorts oldest first (FIFO)', () => {
      queue.createTask('release-notes', { version: '1.0' });
      queue.createTask('release-notes', { version: '2.0' });

      const pending = queue.getPending();
      expect(pending[0].input.version).toBe('1.0');
      expect(pending[1].input.version).toBe('2.0');
    });
  });

  describe('listTasks', () => {
    // TESTING: Listing tasks with filters
    // EXPECTED: Correct filtering by status and type
    it('filters by status', () => {
      const t1 = queue.createTask('release-notes', { version: '1.0' });
      queue.createTask('release-notes', { version: '2.0' });
      queue.claim(t1.id);

      const result = queue.listTasks({ status: 'in-progress' });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].input.version).toBe('1.0');
    });

    it('filters by type', () => {
      queue.createTask('release-notes', { version: '1.0' });
      queue.createTask('release-presentation', { version: '2.0' });

      const result = queue.listTasks({ type: 'release-presentation' });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].type).toBe('release-presentation');
    });

    // TESTING: List is sorted newest first
    // EXPECTED: Most recent task appears first
    it('sorts newest first', () => {
      const t1 = queue.createTask('release-notes', { version: '1.0' });
      // Manually adjust createdAt so t2 is clearly newer
      const t2 = queue.createTask('release-notes', { version: '2.0' });
      const task2 = queue.tasks.get(t2.id);
      task2.createdAt = new Date(Date.now() + 1000).toISOString();

      const result = queue.listTasks();
      expect(result.tasks[0].input.version).toBe('2.0');
    });

    // TESTING: List limit
    // EXPECTED: Returns at most limit tasks
    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        queue.createTask('release-notes', { version: `${i}.0` });
      }

      const result = queue.listTasks({ limit: 3 });
      expect(result.tasks).toHaveLength(3);
      expect(result.total).toBe(5);
      expect(result.hasMore).toBe(true);
    });
  });

  describe('findByRelease', () => {
    // TESTING: Finding a task by release version and type
    // EXPECTED: Returns the most recent matching task
    it('finds the most recent task for a version', () => {
      queue.createTask('release-notes', { version: '4.2.3' });
      queue.createTask('release-notes', { version: '4.2.3' });

      const found = queue.findByRelease('release-notes', '4.2.3');
      expect(found).toBeTruthy();
      expect(found.input.version).toBe('4.2.3');
    });

    // TESTING: No matching task
    // EXPECTED: Returns null
    it('returns null when no match', () => {
      const found = queue.findByRelease('release-notes', 'nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('getTask', () => {
    // TESTING: Getting a task by ID
    // EXPECTED: Returns the task, or null if not found
    it('returns task by ID', () => {
      const created = queue.createTask('release-notes', { version: '1.0' });
      const found = queue.getTask(created.id);
      expect(found).toBeTruthy();
      expect(found.id).toBe(created.id);
    });

    it('returns null for non-existent ID', () => {
      expect(queue.getTask('task-nonexistent')).toBeNull();
    });
  });

  describe('full lifecycle', () => {
    // TESTING: Full task lifecycle: create → claim → complete
    //
    // SETUP: Create a task, claim it, then complete it with output
    //
    // EXPECTED: Task moves through all states correctly and events fire
    it('handles create → claim → complete', () => {
      const handlers = {
        created: vi.fn(),
        claimed: vi.fn(),
        completed: vi.fn(),
      };
      queue.on('task:created', handlers.created);
      queue.on('task:claimed', handlers.claimed);
      queue.on('task:completed', handlers.completed);

      // Create
      const task = queue.createTask('release-presentation', {
        repo: 'webplatform',
        version: '4.2.3-lumen',
        tickets: [{ key: 'DEV-100', summary: 'Test ticket' }],
      }, 'user@test.com', { slackUserId: 'U999' });

      expect(task.status).toBe('pending');
      expect(handlers.created).toHaveBeenCalledTimes(1);

      // Claim
      const claimed = queue.claim(task.id);
      expect(claimed.status).toBe('in-progress');
      expect(claimed.startedAt).toBeTruthy();
      expect(handlers.claimed).toHaveBeenCalledTimes(1);

      // Complete
      const completed = queue.complete(task.id, {
        gammaUrl: 'https://gamma.app/docs/release-4-2-3',
        notes: '# Release 4.2.3-lumen\n\nChanges...',
        perTicketSummaries: { 'DEV-100': 'Fixed the thing' },
      });

      expect(completed.status).toBe('completed');
      expect(completed.output.gammaUrl).toBe('https://gamma.app/docs/release-4-2-3');
      expect(completed.completedAt).toBeTruthy();
      expect(handlers.completed).toHaveBeenCalledTimes(1);

      // Verify it shows up correctly in lists
      expect(queue.getPending()).toHaveLength(0);
      expect(queue.listTasks({ status: 'completed' }).tasks).toHaveLength(1);
    });

    // TESTING: Full lifecycle with failure: create → claim → fail
    // EXPECTED: Task ends in failed state with error
    it('handles create → claim → fail', () => {
      const task = queue.createTask('release-notes', { version: '1.0' });
      queue.claim(task.id);
      const failed = queue.fail(task.id, 'API rate limit exceeded');

      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('API rate limit exceeded');

      // Can't claim/complete/fail again
      expect(() => queue.claim(task.id)).toThrow();
      expect(() => queue.complete(task.id, {})).toThrow();
      expect(() => queue.fail(task.id, 'again')).toThrow();
    });
  });
});
