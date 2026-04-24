import { describe, it, expect, beforeEach } from 'vitest';
const { createTestDb } = require('../../src/core/db');
const TeamStore = require('../../src/core/team-store');

describe('TeamStore', () => {
  let db;
  let store;
  beforeEach(() => {
    db = createTestDb();
    store = new TeamStore({ db });
  });

  it('creates a team with a slug id derived from name', () => {
    const t = store.create({ name: 'Web Platform', description: 'Web stuff', color: '#60a5fa' });
    expect(t.id).toBe('web-platform');
    expect(t.name).toBe('Web Platform');
    expect(t.color).toBe('#60a5fa');
    expect(t.createdAt).toMatch(/^\d{4}-/);
  });

  it('deduplicates slug collisions by appending a counter', () => {
    store.create({ name: 'Web Platform', color: '#60a5fa' });
    const t2 = store.create({ name: 'Web platform', color: '#a78bfa' }); // same slug
    expect(t2.id).toBe('web-platform-2');
  });

  it('rejects duplicate names', () => {
    store.create({ name: 'Web Platform', color: '#60a5fa' });
    expect(() => store.create({ name: 'Web Platform', color: '#a78bfa' }))
      .toThrow(/already exists|UNIQUE/i);
  });

  it('rejects invalid colors', () => {
    expect(() => store.create({ name: 'X', color: 'blue' })).toThrow(/color/i);
    expect(() => store.create({ name: 'X', color: '#xyz' })).toThrow(/color/i);
  });

  it('list() returns teams sorted by name', () => {
    store.create({ name: 'Zeta', color: '#f472b6' });
    store.create({ name: 'Alpha', color: '#60a5fa' });
    expect(store.list().map(t => t.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('update() edits name, description, color but never id', () => {
    const t = store.create({ name: 'Old', color: '#60a5fa' });
    const updated = store.update(t.id, { name: 'New', color: '#a78bfa', description: 'x' });
    expect(updated.id).toBe(t.id);
    expect(updated.name).toBe('New');
    expect(updated.color).toBe('#a78bfa');
  });

  it('update() surfaces UNIQUE name collisions with a friendly error', () => {
    const a = store.create({ name: 'Alpha', color: '#60a5fa' });
    store.create({ name: 'Beta', color: '#a78bfa' });
    expect(() => store.update(a.id, { name: 'Beta' })).toThrow(/already exists/i);
  });

  it('remove() deletes a team and returns true', () => {
    const t = store.create({ name: 'X', color: '#60a5fa' });
    expect(store.remove(t.id)).toBe(true);
    expect(store.get(t.id)).toBeNull();
  });

  it('countMembers() returns number of users with teamId = id', () => {
    const t = store.create({ name: 'X', color: '#60a5fa' });
    // seed a user row directly
    db.prepare(`INSERT INTO users (email, name, role, notificationPrefs, createdAt, teamId)
      VALUES ('a@x.com', 'A', 'user', '{}', '2026-01-01', ?)`).run(t.id);
    expect(store.countMembers(t.id)).toBe(1);
  });
});
