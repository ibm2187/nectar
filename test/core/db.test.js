import { describe, it, expect } from 'vitest';
const { createTestDb } = require('../../src/core/db');

describe('migration v15 (teams)', () => {
  it('creates teams table and adds teamId + jiraName to users', () => {
    const db = createTestDb();

    const pragmaV = db.pragma('user_version', { simple: true });
    expect(pragmaV).toBeGreaterThanOrEqual(15);

    const teamsInfo = db.prepare('PRAGMA table_info(teams)').all().map(c => c.name);
    expect(teamsInfo).toEqual(expect.arrayContaining([
      'id', 'name', 'description', 'color', 'createdAt', 'updatedAt',
    ]));

    const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    expect(userCols).toContain('teamId');
    expect(userCols).toContain('jiraName');

    const indexes = db.prepare("PRAGMA index_list('users')").all().map(i => i.name);
    expect(indexes).toContain('idx_users_teamId');
  });

  it('is idempotent — creating two test DBs does not throw and both land at the same version', () => {
    const db1 = createTestDb();
    const db2 = createTestDb();
    const v1 = db1.pragma('user_version', { simple: true });
    const v2 = db2.pragma('user_version', { simple: true });
    expect(v1).toBe(v2);
  });
});
