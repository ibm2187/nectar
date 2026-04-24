import { describe, it, expect, beforeEach } from 'vitest';
const { createTestDb } = require('../../src/core/db');
const backfillJiraNames = require('../../src/core/backfill-jira-names');

describe('backfillJiraNames', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    db.prepare(`INSERT INTO jira_tickets (key, assignee, reporter, syncedAt) VALUES
      ('DEV-1', 'Eric Fang', 'Eric Fang', '2026-04-01'),
      ('DEV-2', 'Dinith Perera', 'Dinith Perera', '2026-04-01')`).run();

    db.prepare(`INSERT INTO users (email, name, role, notificationPrefs, createdAt)
      VALUES ('ericfang@x.com', 'Eric Fang', 'user', '{}', '2026-04-01'),
             ('dinith@x.com', 'Dinith P', 'user', '{}', '2026-04-01'),
             ('nomatch@x.com', 'Nobody Here', 'user', '{}', '2026-04-01')`).run();
  });

  it('populates jiraName for users whose name fuzzy-matches a ticket assignee', () => {
    backfillJiraNames(db);
    const rows = db.prepare('SELECT email, jiraName FROM users ORDER BY email').all();
    const byEmail = Object.fromEntries(rows.map(r => [r.email, r.jiraName]));
    expect(byEmail['ericfang@x.com']).toBe('Eric Fang');
    expect(byEmail['dinith@x.com']).toBe('Dinith Perera');
    expect(byEmail['nomatch@x.com']).toBeNull();
  });

  it('is a no-op when jira_tickets is empty', () => {
    db.prepare('DELETE FROM jira_tickets').run();
    expect(() => backfillJiraNames(db)).not.toThrow();
  });

  it('does not overwrite existing jiraName values', () => {
    db.prepare("UPDATE users SET jiraName = 'Eric F (override)' WHERE email = 'ericfang@x.com'").run();
    backfillJiraNames(db);
    const r = db.prepare("SELECT jiraName FROM users WHERE email = 'ericfang@x.com'").get();
    expect(r.jiraName).toBe('Eric F (override)');
  });
});
