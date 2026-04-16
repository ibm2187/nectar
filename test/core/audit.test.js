import { describe, it, expect, beforeEach } from 'vitest';
const Audit = require('../../src/core/audit');
const { createTestDb } = require('../../src/core/db');

describe('Audit', () => {
  let audit;
  let db;

  beforeEach(() => {
    db = createTestDb();
    audit = new Audit({ db });
  });

  it('records an entry with all fields', () => {
    const entry = audit.record('4.2.0', 'release:created', { branch: 'release/4.2.0' }, 'testuser');

    expect(entry).toMatchObject({
      version: '4.2.0',
      action: 'release:created',
      detail: { branch: 'release/4.2.0' },
      user: 'testuser',
    });
    expect(entry.id).toMatch(/^aud-/);
    expect(entry.at).toBeTruthy();
  });

  it('records entries with null user for system actions', () => {
    const entry = audit.record('4.2.0', 'ticket:added', {});
    expect(entry.user).toBeNull();
  });

  it('emits entry event on record', () => {
    let emitted = null;
    audit.on('entry', (e) => { emitted = e; });

    audit.record('4.2.0', 'test', {});
    expect(emitted).not.toBeNull();
    expect(emitted.version).toBe('4.2.0');
  });

  it('filters entries by release version', () => {
    audit.record('4.2.0', 'a', {});
    audit.record('4.3.0', 'b', {});
    audit.record('4.2.0', 'c', {});

    const filtered = audit.forRelease('4.2.0');
    expect(filtered).toHaveLength(2);
    expect(filtered.every(e => e.version === '4.2.0')).toBe(true);
  });

  it('returns empty array for unknown version', () => {
    expect(audit.forRelease('99.99.99')).toHaveLength(0);
  });

  it('toJSON caps at 5000 entries', () => {
    // Push directly to the mirror to avoid 5050 inserts
    for (let i = 0; i < 5050; i++) {
      audit.entries.push({ id: `aud-${i}`, version: 'v', action: 'a', detail: {}, user: null, at: '' });
    }
    const json = audit.toJSON();
    expect(json).toHaveLength(5000);
    // Should keep the last 5000
    expect(json[0].id).toBe('aud-50');
  });

  it('loadState restores entries', () => {
    const entries = [
      { id: 'aud-1', version: '4.2.0', action: 'test', detail: {}, user: null, at: '2026-01-01T00:00:00Z' },
    ];
    audit.loadState(entries);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].id).toBe('aud-1');
  });

  it('loadState handles non-array gracefully', () => {
    audit.loadState('garbage');
    expect(audit.entries).toHaveLength(0);
  });

  it('entries setter replaces both mirror and DB', () => {
    audit.record('v1', 'a', {});
    audit.record('v2', 'b', {});
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n).toBe(2);

    audit.entries = [{ id: 'aud-x', version: 'vx', action: 'replaced', detail: {}, user: null, at: '2026-01-01T00:00:00Z' }];

    expect(audit.entries).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n).toBe(1);
    expect(db.prepare('SELECT action FROM audit').get().action).toBe('replaced');
  });

  it('record persists to DB', () => {
    audit.record('4.2.0', 'release:created', { branch: 'x' }, 'me');
    const rows = db.prepare('SELECT * FROM audit').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('release:created');
    expect(JSON.parse(rows[0].detail)).toEqual({ branch: 'x' });
  });

  it('loads existing entries from DB on construction', () => {
    audit.record('4.2.0', 'first', { a: 1 });
    audit.record('4.2.0', 'second', { b: 2 });

    const audit2 = new Audit({ db });
    expect(audit2.entries).toHaveLength(2);
    expect(audit2.entries[0].action).toBe('first');
    expect(audit2.entries[1].action).toBe('second');
    expect(audit2.entries[1].detail).toEqual({ b: 2 });
  });
});
