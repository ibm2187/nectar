import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');

describe('ReleaseManager', () => {
  let audit, rm;

  beforeEach(() => {
    vi.useFakeTimers();
    audit = new Audit();
    rm = new ReleaseManager(audit);
    // Clear any state loaded from the real .nectar-state.json
    rm.releases.clear();
    audit.entries = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('create', () => {
    it('creates a release with default state', () => {
      const r = rm.create({ version: '4.2.0', repo: 'webplatform' });
      expect(r.version).toBe('4.2.0');
      expect(r.repo).toBe('webplatform');
      expect(r.state).toBe('planning');
      expect(r.tickets).toEqual([]);
      expect(r.cherryPicks).toEqual([]);
    });

    it('throws on duplicate version', () => {
      rm.create({ version: '4.2.0', repo: 'webplatform' });
      expect(() => rm.create({ version: '4.2.0', repo: 'webplatform' }))
        .toThrow('already exists');
    });

    it('allows same version for different repos', () => {
      rm.create({ version: '4.2.0', repo: 'webplatform' });
      rm.create({ version: '4.2.0', repo: 'android' });
      expect(rm.releases.size).toBe(2);
    });

    it('records audit entry on create', () => {
      rm.create({ version: '4.2.0', repo: 'wp', cutBy: 'testuser' });
      const entries = audit.forRelease('4.2.0');
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('release:created');
    });

    it('emits release:created event', () => {
      let emitted = null;
      rm.on('release:created', (r) => { emitted = r; });
      rm.create({ version: '4.2.0' });
      expect(emitted).not.toBeNull();
      expect(emitted.version).toBe('4.2.0');
    });
  });

  describe('state transitions', () => {
    it('follows valid transition chain', () => {
      rm.create({ version: '4.2.0' });

      let r = rm.transition('4.2.0', 'cutting', 'user1');
      expect(r.state).toBe('cutting');

      r = rm.transition('4.2.0', 'stabilizing');
      expect(r.state).toBe('stabilizing');

      r = rm.transition('4.2.0', 'approved');
      expect(r.state).toBe('approved');

      r = rm.transition('4.2.0', 'deploying');
      expect(r.state).toBe('deploying');

      r = rm.transition('4.2.0', 'done');
      expect(r.state).toBe('done');
    });

    it('rejects invalid transition', () => {
      rm.create({ version: '4.2.0' });
      expect(() => rm.transition('4.2.0', 'done'))
        .toThrow('Invalid transition');
    });

    it('allows regression from deploying to stabilizing', () => {
      rm.create({ version: '4.2.0' });
      rm.transition('4.2.0', 'cutting');
      rm.transition('4.2.0', 'stabilizing');
      rm.transition('4.2.0', 'approved');
      rm.transition('4.2.0', 'deploying');
      const r = rm.transition('4.2.0', 'stabilizing');
      expect(r.state).toBe('stabilizing');
    });

    it('rejects transitions from done state', () => {
      rm.create({ version: '4.2.0' });
      rm.transition('4.2.0', 'cutting');
      rm.transition('4.2.0', 'stabilizing');
      rm.transition('4.2.0', 'approved');
      rm.transition('4.2.0', 'deploying');
      rm.transition('4.2.0', 'done');
      expect(() => rm.transition('4.2.0', 'deploying'))
        .toThrow('Invalid transition');
    });

    it('sets cutAt when entering cutting state', () => {
      rm.create({ version: '4.2.0' });
      const r = rm.transition('4.2.0', 'cutting');
      expect(r.cutAt).not.toBeNull();
    });

    it('emits transition event with from/to', () => {
      rm.create({ version: '4.2.0' });
      let transition = null;
      rm.on('release:transition', (_, t) => { transition = t; });
      rm.transition('4.2.0', 'cutting', 'tester');
      expect(transition).toEqual({ from: 'planning', to: 'cutting', user: 'tester' });
    });
  });

  describe('update', () => {
    it('updates allowed fields', () => {
      rm.create({ version: '4.2.0' });
      const r = rm.update('4.2.0', { branch: 'release/4.2.0', notes: 'test notes' });
      expect(r.branch).toBe('release/4.2.0');
      expect(r.notes).toBe('test notes');
    });

    it('ignores disallowed fields', () => {
      rm.create({ version: '4.2.0' });
      const r = rm.update('4.2.0', { state: 'done', version: '9.9.9' });
      expect(r.state).toBe('planning');
      expect(r.version).toBe('4.2.0');
    });

    it('throws for unknown release', () => {
      expect(() => rm.update('nonexistent', { notes: 'x' }))
        .toThrow('not found');
    });
  });

  describe('tickets', () => {
    it('adds a ticket to a release', () => {
      rm.create({ version: '4.2.0' });
      rm.addTicket('4.2.0', { key: 'DEV-100', summary: 'Fix bug' });
      const r = rm.get('4.2.0');
      expect(r.tickets).toHaveLength(1);
      expect(r.tickets[0].key).toBe('DEV-100');
    });

    it('updates existing ticket by key', () => {
      rm.create({ version: '4.2.0' });
      rm.addTicket('4.2.0', { key: 'DEV-100', summary: 'Fix bug', state: 'pending' });
      rm.addTicket('4.2.0', { key: 'DEV-100', state: 'done' });
      const r = rm.get('4.2.0');
      expect(r.tickets).toHaveLength(1);
      expect(r.tickets[0].state).toBe('done');
    });

    it('removes a ticket', () => {
      rm.create({ version: '4.2.0' });
      rm.addTicket('4.2.0', { key: 'DEV-100' });
      rm.addTicket('4.2.0', { key: 'DEV-101' });
      rm.removeTicket('4.2.0', 'DEV-100');
      const r = rm.get('4.2.0');
      expect(r.tickets).toHaveLength(1);
      expect(r.tickets[0].key).toBe('DEV-101');
    });
  });

  describe('cherry-picks', () => {
    it('adds a cherry-pick', () => {
      rm.create({ version: '4.2.0' });
      rm.addCherryPick('4.2.0', { sha: 'abc123', pr: 1234, ticket: 'DEV-100', status: 'merged' });
      const r = rm.get('4.2.0');
      expect(r.cherryPicks).toHaveLength(1);
      expect(r.cherryPicks[0].status).toBe('merged');
    });

    it('updates matching ticket state on cherry-pick merge', () => {
      rm.create({ version: '4.2.0' });
      rm.addTicket('4.2.0', { key: 'DEV-100', state: 'pending' });
      rm.addCherryPick('4.2.0', { sha: 'abc', ticket: 'DEV-100', status: 'merged' });
      const r = rm.get('4.2.0');
      expect(r.tickets[0].state).toBe('cherry-picked');
    });

    it('updates existing cherry-pick by SHA', () => {
      rm.create({ version: '4.2.0' });
      rm.addCherryPick('4.2.0', { sha: 'abc', status: 'pending' });
      rm.addCherryPick('4.2.0', { sha: 'abc', status: 'merged' });
      const r = rm.get('4.2.0');
      expect(r.cherryPicks).toHaveLength(1);
      expect(r.cherryPicks[0].status).toBe('merged');
    });
  });

  describe('approvals', () => {
    it('adds an approval', () => {
      rm.create({ version: '4.2.0' });
      rm.addApproval('4.2.0', { user: 'jsmith', role: 'engineering' });
      const r = rm.get('4.2.0');
      expect(r.approvals).toHaveLength(1);
      expect(r.approvals[0].role).toBe('engineering');
    });

    it('replaces approval from same role', () => {
      rm.create({ version: '4.2.0' });
      rm.addApproval('4.2.0', { user: 'jsmith', role: 'engineering' });
      rm.addApproval('4.2.0', { user: 'jdoe', role: 'engineering' });
      const r = rm.get('4.2.0');
      expect(r.approvals).toHaveLength(1);
      expect(r.approvals[0].user).toBe('jdoe');
    });
  });

  describe('deployments', () => {
    it('adds a deployment', () => {
      rm.create({ version: '4.2.0' });
      rm.addDeployment('4.2.0', { customer: 'CK', env: 'staging', status: 'pending' }, 'admin');
      const r = rm.get('4.2.0');
      expect(r.deployments).toHaveLength(1);
    });

    it('updates existing deployment by customer+env', () => {
      rm.create({ version: '4.2.0' });
      rm.addDeployment('4.2.0', { customer: 'CK', env: 'staging', status: 'pending' });
      rm.addDeployment('4.2.0', { customer: 'CK', env: 'staging', status: 'success' });
      const r = rm.get('4.2.0');
      expect(r.deployments).toHaveLength(1);
      expect(r.deployments[0].status).toBe('success');
    });
  });

  describe('queries', () => {
    it('list returns all releases sorted by createdAt desc', () => {
      rm.create({ version: '4.1.0' });
      rm.create({ version: '4.2.0' });
      rm.create({ version: '4.3.0' });
      const list = rm.list();
      expect(list).toHaveLength(3);
    });

    it('list filters by state', () => {
      rm.create({ version: '4.1.0' });
      rm.create({ version: '4.2.0' });
      rm.transition('4.2.0', 'cutting');
      const list = rm.list({ state: 'cutting' });
      expect(list).toHaveLength(1);
      expect(list[0].version).toBe('4.2.0');
    });

    it('list filters by repo', () => {
      rm.create({ version: '4.1.0', repo: 'webplatform' });
      rm.create({ version: '4.1.0', repo: 'android' });
      const list = rm.list({ repo: 'android' });
      expect(list).toHaveLength(1);
    });

    it('get finds by version', () => {
      rm.create({ version: '4.2.0' });
      expect(rm.get('4.2.0')).not.toBeNull();
      expect(rm.get('nonexistent')).toBeNull();
    });

    it('active excludes done releases', () => {
      rm.create({ version: '4.1.0' });
      rm.create({ version: '4.2.0' });
      rm.transition('4.1.0', 'cutting');
      rm.transition('4.1.0', 'stabilizing');
      rm.transition('4.1.0', 'approved');
      rm.transition('4.1.0', 'deploying');
      rm.transition('4.1.0', 'done');
      const active = rm.active();
      expect(active).toHaveLength(1);
      expect(active[0].version).toBe('4.2.0');
    });
  });

  describe('delete', () => {
    it('deletes a release', () => {
      rm.create({ version: '4.2.0' });
      rm.delete('4.2.0');
      expect(rm.get('4.2.0')).toBeNull();
    });

    it('throws when deleting nonexistent release', () => {
      expect(() => rm.delete('nonexistent')).toThrow('not found');
    });

    it('emits release:deleted event', () => {
      rm.create({ version: '4.2.0' });
      let deleted = null;
      rm.on('release:deleted', (v) => { deleted = v; });
      rm.delete('4.2.0');
      expect(deleted).toBe('4.2.0');
    });
  });

  describe('persistence', () => {
    it('debounce save triggers after 5s', () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

      rm.create({ version: '4.9.0' });
      // writeFileSync may have been called during state load — clear
      writeSpy.mockClear();

      vi.advanceTimersByTime(5000);
      expect(writeSpy).toHaveBeenCalled();

      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });

    it('flush saves immediately using atomic write', () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

      rm.create({ version: '4.9.1' });
      writeSpy.mockClear();
      renameSpy.mockClear();

      rm.flush();
      expect(writeSpy).toHaveBeenCalled();
      expect(renameSpy).toHaveBeenCalled();
      // Verify tmp file pattern
      expect(writeSpy.mock.calls[0][0]).toMatch(/\.tmp$/);

      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });
  });

  describe('persistence round-trip', () => {
    it('_saveState/_loadState preserves releases and audit', () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

      // Create releases with tickets and deployments
      rm.create({ version: '4.2.0', repo: 'webplatform', branch: 'releases/4.2.0' });
      rm.addTicket('4.2.0', { key: 'DEV-100', summary: 'Test ticket' });
      rm.addDeployment('4.2.0', { customer: 'CK', env: 'staging', status: 'success' });
      rm.transition('4.2.0', 'cutting');

      // Capture what _saveState writes
      writeSpy.mockClear();
      rm._saveState();

      // Extract the JSON that was written
      expect(writeSpy).toHaveBeenCalled();
      const writtenJson = writeSpy.mock.calls[0][1];
      const data = JSON.parse(writtenJson);

      // Verify structure
      expect(data.releases).toHaveLength(1);
      expect(data.releases[0].version).toBe('4.2.0');
      expect(data.releases[0].tickets).toHaveLength(1);
      expect(data.releases[0].deployments).toHaveLength(1);
      expect(data.releases[0].state).toBe('cutting');
      expect(data.audit).toBeDefined();
      expect(data.savedAt).toBeTruthy();

      // Now simulate loading that data into a fresh manager
      const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(writtenJson);
      const audit2 = new Audit();
      const rm2 = new ReleaseManager(audit2);

      expect(rm2.get('4.2.0')).not.toBeNull();
      expect(rm2.get('4.2.0').state).toBe('cutting');
      expect(rm2.get('4.2.0').tickets).toHaveLength(1);

      writeSpy.mockRestore();
      renameSpy.mockRestore();
      readSpy.mockRestore();
    });
  });

  describe('STATES and TRANSITIONS exports', () => {
    it('exposes state machine constants', () => {
      expect(ReleaseManager.STATES).toContain('planning');
      expect(ReleaseManager.STATES).toContain('done');
      expect(ReleaseManager.TRANSITIONS.planning).toEqual(['cutting']);
    });
  });
});
