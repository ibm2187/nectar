import { describe, it, expect, beforeEach } from 'vitest';
const { createTestDb } = require('../../src/core/db');
const UserStore = require('../../src/core/user-store');
const resolveAndStoreJiraName = require('../../src/core/resolve-and-store-jira-name');

function mockTicketStore(distinctNames) {
  return { getDistinctPeople: () => distinctNames.map(name => ({ name, roles: ['dev'] })) };
}

describe('resolveAndStoreJiraName', () => {
  let db, users;
  beforeEach(() => {
    db = createTestDb();
    users = new UserStore({ db });
  });

  it('sets jiraName on first call when fuzzy match succeeds', () => {
    users.upsertOnLogin('ericfang@viv.com', 'Eric Fang', null);
    const ts = mockTicketStore(['Eric Fang']);
    const result = resolveAndStoreJiraName({ userStore: users, ticketStore: ts, email: 'ericfang@viv.com' });
    expect(result).toBe('Eric Fang');
    expect(users.getUser('ericfang@viv.com').jiraName).toBe('Eric Fang');
  });

  it('is a no-op when jiraName is already set', () => {
    users.upsertOnLogin('e@x.com', 'Eric Fang', null);
    users.setJiraName('e@x.com', 'Eric F (override)');
    const ts = mockTicketStore(['Eric Fang']);
    const result = resolveAndStoreJiraName({ userStore: users, ticketStore: ts, email: 'e@x.com' });
    expect(result).toBeNull();
    expect(users.getUser('e@x.com').jiraName).toBe('Eric F (override)');
  });

  it('leaves jiraName null when no match found', () => {
    users.upsertOnLogin('n@x.com', 'Nobody Matches', null);
    const ts = mockTicketStore(['Eric Fang']);
    const result = resolveAndStoreJiraName({ userStore: users, ticketStore: ts, email: 'n@x.com' });
    expect(result).toBeNull();
    expect(users.getUser('n@x.com').jiraName).toBeNull();
  });

  it('returns null silently when ticketStore is missing', () => {
    users.upsertOnLogin('e@x.com', 'Eric Fang', null);
    const result = resolveAndStoreJiraName({ userStore: users, ticketStore: null, email: 'e@x.com' });
    expect(result).toBeNull();
  });
});
