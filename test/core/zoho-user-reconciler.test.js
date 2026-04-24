import { describe, it, expect, beforeEach, vi } from 'vitest';

const ZohoUserReconciler = require('../../src/core/zoho-user-reconciler');
const UserStore = require('../../src/core/user-store');
const { createTestDb } = require('../../src/core/db');

/**
 * Reconciler tests mock the Zoho + JIRA integration clients so they exercise
 * the orchestration logic without network calls.
 */

function makeZohoMock(agents = []) {
  return {
    isConfigured: () => true,
    listAgents: vi.fn(async () => agents),
  };
}

function makeJiraMock(userMap = {}) {
  return {
    isConfigured: () => true,
    getUserByEmail: vi.fn(async (email) => userMap[email.toLowerCase()] || null),
  };
}

describe('ZohoUserReconciler', () => {
  let db;
  let userStore;

  beforeEach(() => {
    db = createTestDb();
    // Seed the admin role so UserStore doesn't blow up in getCapabilities paths
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
       VALUES ('admin', 'Admin', '', '[]', 1, ?, ?)`
    ).run(now, now);
    userStore = new UserStore({ db });
  });

  describe('upserts Zoho agents into users', () => {
    it('creates users with zohoAgentId + displayNameZoho from a fresh run', async () => {
      const zoho = makeZohoMock([
        { id: 'zoho-1', emailId: 'bryan.nothling@vivtechnologies.com', name: 'Bryan Nothling' },
        { id: 'zoho-2', emailId: 'Aaron@VIVTECHNOLOGIES.COM', name: 'Aaron Lal' },
      ]);
      const jira = makeJiraMock({
        'bryan.nothling@vivtechnologies.com': { accountId: 'acct-bryan' },
        'aaron@vivtechnologies.com': { accountId: 'acct-aaron' },
      });

      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      const results = await r.run();

      expect(results.agentsFetched).toBe(2);
      expect(results.usersUpserted).toBe(2);
      expect(results.jiraResolved).toBe(2);
      expect(results.jiraMisses).toBe(0);

      const bryan = userStore.getUser('bryan.nothling@vivtechnologies.com');
      expect(bryan.zohoAgentId).toBe('zoho-1');
      expect(bryan.jiraAccountId).toBe('acct-bryan');
      expect(bryan.displayNameZoho).toBe('Bryan Nothling');
      expect(bryan.isBot).toBe(false);

      // Verify email case was normalized and Aaron still resolved
      const aaron = userStore.getUser('aaron@vivtechnologies.com');
      expect(aaron.zohoAgentId).toBe('zoho-2');
      expect(aaron.jiraAccountId).toBe('acct-aaron');
    });

    it('marks hive@ as a bot and skips JIRA lookup for it', async () => {
      const zoho = makeZohoMock([
        { id: 'zoho-hive', emailId: 'hive@vivtechnologies.com', name: 'Hive User' },
        { id: 'zoho-real', emailId: 'real@vivtechnologies.com', name: 'Real Person' },
      ]);
      const jira = makeJiraMock({ 'real@vivtechnologies.com': { accountId: 'acct-real' } });

      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      await r.run();

      const hive = userStore.getUser('hive@vivtechnologies.com');
      expect(hive.isBot).toBe(true);
      expect(hive.zohoAgentId).toBe('zoho-hive');
      // JIRA should NOT have been queried for the bot
      expect(jira.getUserByEmail).not.toHaveBeenCalledWith('hive@vivtechnologies.com');

      const real = userStore.getUser('real@vivtechnologies.com');
      expect(real.isBot).toBe(false);
      expect(real.jiraAccountId).toBe('acct-real');
    });

    it('honors ZOHO_BOT_EMAILS env override', async () => {
      const original = process.env.ZOHO_BOT_EMAILS;
      process.env.ZOHO_BOT_EMAILS = 'custom-bot@vivtechnologies.com';
      try {
        const zoho = makeZohoMock([
          { id: 'z1', emailId: 'custom-bot@vivtechnologies.com', name: 'Custom Bot' },
          { id: 'z2', emailId: 'hive@vivtechnologies.com', name: 'Hive User' },
        ]);
        const jira = makeJiraMock({
          'hive@vivtechnologies.com': { accountId: 'hive-jira' },
        });

        const r = new ZohoUserReconciler({ userStore, zoho, jira });
        await r.run();

        expect(userStore.getUser('custom-bot@vivtechnologies.com').isBot).toBe(true);
        // hive@ is now NOT in the allowlist so it's treated as a real user
        expect(userStore.getUser('hive@vivtechnologies.com').isBot).toBe(false);
      } finally {
        if (original === undefined) delete process.env.ZOHO_BOT_EMAILS;
        else process.env.ZOHO_BOT_EMAILS = original;
      }
    });
  });

  describe('JIRA reconciliation caching', () => {
    it('does not re-query JIRA on a second run when accountId already known', async () => {
      const zoho = makeZohoMock([
        { id: 'z1', emailId: 'a@v.com', name: 'A' },
      ]);
      const jira = makeJiraMock({ 'a@v.com': { accountId: 'acct-a' } });

      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      await r.run();
      expect(jira.getUserByEmail).toHaveBeenCalledTimes(1);

      await r.run();
      // Second run: accountId already populated, should NOT re-query
      expect(jira.getUserByEmail).toHaveBeenCalledTimes(1);
    });

    it('retries JIRA on subsequent runs when a miss was recorded', async () => {
      const zoho = makeZohoMock([{ id: 'z1', emailId: 'a@v.com', name: 'A' }]);
      const jira = makeJiraMock({}); // no match

      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      await r.run();
      expect(jira.getUserByEmail).toHaveBeenCalledTimes(1);

      // Same email, still no accountId → will retry
      await r.run();
      expect(jira.getUserByEmail).toHaveBeenCalledTimes(2);
    });

    it('survives JIRA errors without crashing', async () => {
      const zoho = makeZohoMock([{ id: 'z1', emailId: 'a@v.com', name: 'A' }]);
      const jira = {
        isConfigured: () => true,
        getUserByEmail: vi.fn(async () => { throw new Error('429 rate limited'); }),
      };

      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      const results = await r.run();

      expect(results.errors).toBe(1);
      expect(userStore.getUser('a@v.com')).toBeTruthy(); // user still created
    });
  });

  describe('degraded modes', () => {
    it('returns zero-results when Zoho is not configured', async () => {
      const zoho = { isConfigured: () => false, listAgents: vi.fn() };
      const jira = makeJiraMock();

      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      const results = await r.run();
      expect(results.agentsFetched).toBe(0);
      expect(zoho.listAgents).not.toHaveBeenCalled();
    });

    it('skips JIRA lookups when JIRA is not configured', async () => {
      const zoho = makeZohoMock([{ id: 'z1', emailId: 'a@v.com', name: 'A' }]);
      const jira = { isConfigured: () => false, getUserByEmail: vi.fn() };

      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      const results = await r.run();
      expect(results.usersUpserted).toBe(1);
      expect(jira.getUserByEmail).not.toHaveBeenCalled();
    });

    it('tolerates agents without emails', async () => {
      const zoho = makeZohoMock([
        { id: 'z1', emailId: null, name: 'Ghost' },
        { id: 'z2', emailId: 'real@v.com', name: 'Real' },
      ]);
      const jira = makeJiraMock();
      const r = new ZohoUserReconciler({ userStore, zoho, jira });
      const results = await r.run();
      expect(results.usersUpserted).toBe(1); // ghost agent skipped
    });
  });
});

describe('UserStore identity methods', () => {
  let db;
  let store;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
       VALUES ('admin', 'Admin', '', '[]', 1, ?, ?)`
    ).run(now, now);
    store = new UserStore({ db });
  });

  it('upsertIdentity creates a non-login user', () => {
    const user = store.upsertIdentity({
      email: 'new@v.com',
      name: 'New Person',
      zohoAgentId: 'z-1',
      displayNameZoho: 'New Person',
      isBot: false,
    });
    expect(user.email).toBe('new@v.com');
    expect(user.lastLoginAt).toBeNull();
    expect(user.zohoAgentId).toBe('z-1');
    expect(user.displayNameZoho).toBe('New Person');
  });

  it('upsertIdentity preserves existing fields via COALESCE', () => {
    store.upsertIdentity({ email: 'a@v.com', zohoAgentId: 'z-1', name: 'A' });
    store.upsertIdentity({ email: 'a@v.com', jiraAccountId: 'j-1' });
    const user = store.getUser('a@v.com');
    expect(user.zohoAgentId).toBe('z-1'); // preserved
    expect(user.jiraAccountId).toBe('j-1'); // added
  });

  it('findByZohoAgentId / findByJiraAccountId round-trip', () => {
    store.upsertIdentity({ email: 'a@v.com', zohoAgentId: 'z-1', jiraAccountId: 'j-1' });
    expect(store.findByZohoAgentId('z-1').email).toBe('a@v.com');
    expect(store.findByJiraAccountId('j-1').email).toBe('a@v.com');
    expect(store.findByZohoAgentId('nope')).toBeNull();
  });

  it('upsertOnLogin preserves identity columns from a prior upsertIdentity', () => {
    store.upsertIdentity({ email: 'a@v.com', zohoAgentId: 'z-1', name: 'A' });
    store.upsertOnLogin('a@v.com', 'A Logged In', 'https://pic');
    const user = store.getUser('a@v.com');
    expect(user.zohoAgentId).toBe('z-1'); // identity survived login
    expect(user.lastLoginAt).toBeTruthy();
    expect(user.name).toBe('A Logged In');
  });
});
