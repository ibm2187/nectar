import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createTestDb } = require('../../src/core/db');
const IncidentStore = require('../../src/core/incident-store');

function openBasic(store, patch = {}) {
  return store.open({
    summary: 'Cache is down',
    triggerType: 'env-unhealthy',
    customerId: 'qualitycare',
    envId: 'qualitycare-prod',
    subjectKey: 'env-health:qualitycare-prod',
    severity: 'critical',
    ...patch,
  });
}

describe('IncidentStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = createTestDb();
    store = new IncidentStore({ db });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // ── Open ───────────────────────────────────────────────

  describe('open', () => {
    it('creates an incident in the open state', () => {
      const inc = openBasic(store);
      expect(inc.id).toMatch(/^inc-/);
      expect(inc.status).toBe('open');
      expect(inc.source).toBe('auto');
      expect(inc.severity).toBe('critical');
      expect(inc.openedAt).toBeTruthy();
      expect(inc.resolvedAt).toBeNull();
    });

    it('writes an opened event', () => {
      const inc = openBasic(store);
      const events = store.listEvents(inc.id);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('opened');
    });

    it('emits incident:opened', () => {
      let emitted = null;
      store.on('incident:opened', (inc) => { emitted = inc; });
      const inc = openBasic(store);
      expect(emitted).not.toBeNull();
      expect(emitted.id).toBe(inc.id);
    });

    it('supports manual source with actor attribution', () => {
      const inc = store.open({
        summary: 'Manual',
        triggerType: 'manual',
        source: 'manual',
        actorUserId: 'nukul@vivtechnologies.com',
        actorName: 'Nukul',
      });
      expect(inc.source).toBe('manual');
      const events = store.listEvents(inc.id);
      expect(events[0].actorName).toBe('Nukul');
      expect(events[0].actorUserId).toBe('nukul@vivtechnologies.com');
    });

    it('coerces invalid severity to critical', () => {
      const inc = store.open({
        summary: 's', triggerType: 'env-unhealthy', severity: 'fatal',
      });
      expect(inc.severity).toBe('critical');
    });

    it('requires summary and triggerType', () => {
      expect(() => store.open({ triggerType: 'x' })).toThrow(/summary/);
      expect(() => store.open({ summary: 's' })).toThrow(/triggerType/);
    });
  });

  // ── Acknowledge ────────────────────────────────────────

  describe('acknowledge', () => {
    it('transitions open → acknowledged', () => {
      const inc = openBasic(store);
      const acked = store.acknowledge(inc.id, { actorName: 'Nukul' });
      expect(acked.status).toBe('acknowledged');
      expect(acked.acknowledgedAt).toBeTruthy();
      expect(acked.acknowledgedBy).toBe('Nukul');
    });

    it('is idempotent when already acknowledged', () => {
      const inc = openBasic(store);
      const first = store.acknowledge(inc.id, { actorName: 'A' });
      const second = store.acknowledge(inc.id, { actorName: 'B' });
      expect(second.acknowledgedBy).toBe('A'); // unchanged
      // Only one ack event
      const events = store.listEvents(inc.id).filter(e => e.type === 'acknowledged');
      expect(events).toHaveLength(1);
    });

    it('throws when trying to ack a resolved incident', () => {
      const inc = openBasic(store);
      store.resolve(inc.id, { actorName: 'x' });
      expect(() => store.acknowledge(inc.id, { actorName: 'y' })).toThrow(/resolved/);
    });

    it('emits incident:acknowledged', () => {
      const inc = openBasic(store);
      let fired = null;
      store.on('incident:acknowledged', (i, ev) => { fired = { i, ev }; });
      store.acknowledge(inc.id, { actorName: 'x' });
      expect(fired).not.toBeNull();
      expect(fired.i.status).toBe('acknowledged');
      expect(fired.ev.type).toBe('acknowledged');
    });

    it('records note on ack event', () => {
      const inc = openBasic(store);
      store.acknowledge(inc.id, { actorName: 'A', note: 'investigating' });
      const events = store.listEvents(inc.id);
      const ack = events.find(e => e.type === 'acknowledged');
      expect(ack.payload.note).toBe('investigating');
    });

    it('returns null for unknown id', () => {
      expect(store.acknowledge('bogus')).toBeNull();
    });
  });

  // ── Resolve ────────────────────────────────────────────

  describe('resolve', () => {
    it('transitions open → resolved', () => {
      const inc = openBasic(store);
      const r = store.resolve(inc.id, { actorName: 'x', resolution: 'manual' });
      expect(r.status).toBe('resolved');
      expect(r.resolvedAt).toBeTruthy();
      expect(r.resolution).toBe('manual');
    });

    it('resolves acknowledged incidents too', () => {
      const inc = openBasic(store);
      store.acknowledge(inc.id, { actorName: 'a' });
      const r = store.resolve(inc.id, { actorName: 'x', resolution: 'manual' });
      expect(r.status).toBe('resolved');
      expect(r.acknowledgedBy).toBe('a'); // ack history preserved
    });

    it('auto resolution records resolution=auto', () => {
      const inc = openBasic(store);
      const r = store.resolve(inc.id, { resolution: 'auto' });
      expect(r.resolution).toBe('auto');
      expect(r.resolvedBy).toBe('system');
    });

    it('is idempotent', () => {
      const inc = openBasic(store);
      store.resolve(inc.id, { actorName: 'x' });
      const again = store.resolve(inc.id, { actorName: 'y' });
      expect(again.resolvedBy).toBe('x'); // unchanged
      const events = store.listEvents(inc.id).filter(e => e.type === 'resolved');
      expect(events).toHaveLength(1);
    });

    it('emits incident:resolved', () => {
      const inc = openBasic(store);
      let fired = null;
      store.on('incident:resolved', (i, ev) => { fired = { i, ev }; });
      store.resolve(inc.id, { actorName: 'x' });
      expect(fired).not.toBeNull();
      expect(fired.ev.payload.resolution).toBe('manual');
    });
  });

  // ── Reopen ─────────────────────────────────────────────

  describe('reopen', () => {
    it('transitions resolved → reopened and clears resolution fields', () => {
      const inc = openBasic(store);
      store.resolve(inc.id, { actorName: 'x' });
      const r = store.reopen(inc.id, { actorName: 'y' });
      expect(r.status).toBe('reopened');
      expect(r.resolvedAt).toBeNull();
      expect(r.resolution).toBeNull();
    });

    it('is no-op on already-open incidents', () => {
      const inc = openBasic(store);
      const r = store.reopen(inc.id, { actorName: 'x' });
      expect(r.status).toBe('open');
    });
  });

  // ── Assign ─────────────────────────────────────────────

  describe('assign', () => {
    it('sets assignee fields', () => {
      const inc = openBasic(store);
      const r = store.assign(inc.id, {
        assigneeUserId: 'nukul@vivtechnologies.com',
        assigneeSlackId: 'U12345',
        assigneeName: 'Nukul',
        actorName: 'admin',
      });
      expect(r.assigneeUserId).toBe('nukul@vivtechnologies.com');
      expect(r.assigneeSlackId).toBe('U12345');
    });

    it('unassigns when passed nulls', () => {
      const inc = openBasic(store);
      store.assign(inc.id, { assigneeUserId: 'a', assigneeSlackId: 'S' });
      const r = store.assign(inc.id, { assigneeUserId: null, assigneeSlackId: null });
      expect(r.assigneeUserId).toBeNull();
      expect(r.assigneeSlackId).toBeNull();
    });

    it('records an assigned event with the assignee details', () => {
      const inc = openBasic(store);
      store.assign(inc.id, {
        assigneeUserId: 'nukul@viv',
        assigneeSlackId: 'U1',
        assigneeName: 'Nukul',
        actorName: 'admin',
      });
      const events = store.listEvents(inc.id).filter(e => e.type === 'assigned');
      expect(events).toHaveLength(1);
      expect(events[0].payload.assigneeName).toBe('Nukul');
      expect(events[0].actorName).toBe('admin');
    });
  });

  // ── Notes ──────────────────────────────────────────────

  describe('addNote', () => {
    it('appends a note event', () => {
      const inc = openBasic(store);
      store.addNote(inc.id, { text: 'first pass', actorName: 'a' });
      const events = store.listEvents(inc.id).filter(e => e.type === 'note');
      expect(events).toHaveLength(1);
      expect(events[0].payload.text).toBe('first pass');
    });

    it('rejects empty notes', () => {
      const inc = openBasic(store);
      expect(() => store.addNote(inc.id, { text: '' })).toThrow(/text/);
      expect(() => store.addNote(inc.id, { text: '   ' })).toThrow(/text/);
    });

    it('supports multiple notes on one incident', () => {
      const inc = openBasic(store);
      store.addNote(inc.id, { text: '1', actorName: 'a' });
      store.addNote(inc.id, { text: '2', actorName: 'a' });
      const events = store.listEvents(inc.id).filter(e => e.type === 'note');
      expect(events).toHaveLength(2);
    });

    it('persists broadcast=true by default and broadcast=false explicitly', () => {
      // The AlertRouter reads payload.broadcast to decide whether to relay
      // to the Slack thread; default true preserves the prior behavior.
      const inc = openBasic(store);
      store.addNote(inc.id, { text: 'broadcast', actorName: 'a' });
      store.addNote(inc.id, { text: 'internal-only', broadcast: false, actorName: 'a' });
      const notes = store.listEvents(inc.id).filter(e => e.type === 'note');
      expect(notes[0].payload.broadcast).toBe(true);
      expect(notes[1].payload.broadcast).toBe(false);
    });
  });

  // ── Severity ───────────────────────────────────────────

  describe('updateSeverity', () => {
    it('changes severity and logs event', () => {
      const inc = openBasic(store); // critical
      const r = store.updateSeverity(inc.id, { severity: 'warning', actorName: 'a' });
      expect(r.severity).toBe('warning');
      const events = store.listEvents(inc.id).filter(e => e.type === 'severity-changed');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ from: 'critical', to: 'warning' });
    });

    it('is no-op when severity unchanged', () => {
      const inc = openBasic(store);
      const r = store.updateSeverity(inc.id, { severity: 'critical', actorName: 'a' });
      expect(r.severity).toBe('critical');
      expect(store.listEvents(inc.id).filter(e => e.type === 'severity-changed')).toHaveLength(0);
    });

    it('rejects unknown severity', () => {
      const inc = openBasic(store);
      expect(() => store.updateSeverity(inc.id, { severity: 'fatal' })).toThrow(/invalid severity/);
    });
  });

  // ── Slack tracking ─────────────────────────────────────

  describe('trackSlackPost', () => {
    it('records the first post as the primary anchor', () => {
      const inc = openBasic(store);
      const r = store.trackSlackPost(inc.id, { channel: '#a', ts: '1' });
      expect(r.slackChannel).toBe('#a');
      expect(r.slackTs).toBe('1');
      expect(r.slackPosts).toEqual([{ channel: '#a', ts: '1' }]);
    });

    it('appends additional posts without replacing the anchor', () => {
      const inc = openBasic(store);
      store.trackSlackPost(inc.id, { channel: '#a', ts: '1' });
      const r = store.trackSlackPost(inc.id, { channel: '#b', ts: '2' });
      expect(r.slackChannel).toBe('#a');
      expect(r.slackPosts).toEqual([{ channel: '#a', ts: '1' }, { channel: '#b', ts: '2' }]);
    });
  });

  // ── Queries ────────────────────────────────────────────

  describe('queries', () => {
    it('list filters by status', () => {
      const a = openBasic(store);
      const b = openBasic(store, { summary: 'b', subjectKey: 'b' });
      store.resolve(b.id, { actorName: 'x' });
      const active = store.list({ status: ['open', 'acknowledged'] });
      expect(active.map(i => i.id)).toEqual([a.id]);
      expect(store.list({ status: 'resolved' })).toHaveLength(1);
    });

    it('list filters by customerId + envId', () => {
      openBasic(store, { customerId: 'bayada', envId: 'bayada-prod' });
      openBasic(store, { customerId: 'ck',     envId: 'ck-prod' });
      expect(store.list({ customerId: 'bayada' })).toHaveLength(1);
      expect(store.list({ envId: 'ck-prod' })).toHaveLength(1);
    });

    it('findActiveBySubject returns the most recent open/ack/reopened', () => {
      const a = openBasic(store, { subjectKey: 'env:x' });
      const found = store.findActiveBySubject('env:x');
      expect(found.id).toBe(a.id);
    });

    it('findActiveBySubject ignores resolved incidents', () => {
      const a = openBasic(store, { subjectKey: 'env:x' });
      store.resolve(a.id, { actorName: 'x' });
      expect(store.findActiveBySubject('env:x')).toBeNull();
    });

    it('counts returns status totals', () => {
      openBasic(store);
      openBasic(store, { summary: 'b', subjectKey: 'b' });
      const c = openBasic(store, { summary: 'c', subjectKey: 'c' });
      store.resolve(c.id, { actorName: 'x' });
      const counts = store.counts();
      expect(counts.open).toBe(2);
      expect(counts.resolved).toBe(1);
      expect(counts.active).toBe(2);
    });

    it('getWithEvents returns full event timeline', () => {
      const inc = openBasic(store);
      store.acknowledge(inc.id, { actorName: 'a' });
      store.addNote(inc.id, { text: 'note', actorName: 'a' });
      const full = store.getWithEvents(inc.id);
      expect(full.events).toHaveLength(3); // opened + acknowledged + note
      expect(full.events.map(e => e.type)).toEqual(['opened', 'acknowledged', 'note']);
    });
  });

  // ── System events ──────────────────────────────────────

  describe('recordSystemEvent', () => {
    it('appends a system event without changing status', () => {
      const inc = openBasic(store);
      const before = inc.status;
      store.recordSystemEvent(inc.id, 'dedup-suppressed', { reason: 'dedup window' });
      const after = store.get(inc.id);
      expect(after.status).toBe(before);
      const events = store.listEvents(inc.id).filter(e => e.type === 'dedup-suppressed');
      expect(events).toHaveLength(1);
      expect(events[0].payload.reason).toBe('dedup window');
    });
  });
});
