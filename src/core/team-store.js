const { getDb } = require('./db');

const TEAM_COLORS = [
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#34d399', // emerald
  '#f472b6', // pink
  '#fbbf24', // amber
  '#fb7185', // rose
  '#2dd4bf', // teal
  '#a3a3a3', // slate
];

function slugify(name) {
  return (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'team';
}

function assertValidColor(color) {
  if (!color || !TEAM_COLORS.includes(color)) {
    throw new Error(`Invalid color "${color}" — must be one of the 8 swatch values`);
  }
}

class TeamStore {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db] — inject a DB (tests)
   */
  constructor(opts = {}) {
    this.db = opts.db || getDb();
  }

  list() {
    return this.db.prepare('SELECT * FROM teams ORDER BY name COLLATE NOCASE ASC').all();
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    return row || null;
  }

  create({ name, description = null, color }) {
    if (!name) throw new Error('name is required');
    assertValidColor(color);
    const now = new Date().toISOString();
    const base = slugify(name);
    let id = base;
    let n = 2;
    while (this.get(id)) {
      id = `${base}-${n++}`;
    }
    try {
      this.db.prepare(`INSERT INTO teams (id, name, description, color, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, description, color, now, now);
    } catch (err) {
      if (/UNIQUE constraint failed: teams\.name/i.test(String(err.message))) {
        throw new Error(`Team name "${name}" already exists`);
      }
      throw err;
    }
    return this.get(id);
  }

  update(id, patch) {
    const existing = this.get(id);
    if (!existing) throw new Error(`Team ${id} not found`);
    if (patch.color !== undefined) assertValidColor(patch.color);
    const next = {
      name:        patch.name        ?? existing.name,
      description: patch.description ?? existing.description,
      color:       patch.color       ?? existing.color,
    };
    try {
      this.db.prepare(`UPDATE teams SET name=?, description=?, color=?, updatedAt=? WHERE id=?`)
        .run(next.name, next.description, next.color, new Date().toISOString(), id);
    } catch (err) {
      if (/UNIQUE constraint failed: teams\.name/i.test(String(err.message))) {
        throw new Error(`Team name "${next.name}" already exists`);
      }
      throw err;
    }
    return this.get(id);
  }

  remove(id) {
    const res = this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    return res.changes > 0;
  }

  countMembers(id) {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE teamId = ?').get(id);
    return row.c;
  }

  listMembers(id, limit = 20) {
    return this.db.prepare('SELECT email, name FROM users WHERE teamId = ? ORDER BY name COLLATE NOCASE LIMIT ?')
      .all(id, limit);
  }
}

module.exports = TeamStore;
module.exports.TEAM_COLORS = TEAM_COLORS;
