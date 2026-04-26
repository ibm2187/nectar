import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

const { registerTools } = require('../../src/mcp/tools');

/**
 * Tests for the shared tool registry. Both /mcp and /mcp-oauth call
 * registerTools(server, deps, reqCtx); we exercise the handlers
 * directly via a fake server that captures the (name, schema, handler)
 * triples. That keeps the surface narrow and runs without booting the
 * full Express app or the MCP SDK transport.
 */
function fakeServer() {
  const tools = new Map();
  return {
    tool(name, description, schema, handler) {
      tools.set(name, { name, description, schema, handler });
    },
    get(name) { return tools.get(name); },
    names() { return [...tools.keys()]; },
    async call(name, args = {}) {
      const t = tools.get(name);
      if (!t) throw new Error(`tool ${name} not registered`);
      // Apply zod defaults — production SDK parses through zod before
      // invoking the handler. Fake parity matters for tests that omit
      // optional fields.
      let parsed = args;
      if (t.schema && typeof t.schema === 'object') {
        try { parsed = z.object(t.schema).parse(args); } catch { /* fall through with raw */ }
      }
      const out = await t.handler(parsed);
      const txt = out?.content?.[0]?.text;
      if (typeof txt === 'string') {
        try { return { ok: true, raw: txt, data: JSON.parse(txt) }; }
        catch { return { ok: true, raw: txt }; }
      }
      return { ok: false, out };
    },
  };
}

function fakeDeps(overrides = {}) {
  const customers = [
    { id: 'bayada', name: 'Bayada', shortName: 'Bayada' },
    { id: 'lumen', name: 'Help at Home', shortName: 'Lumen' },
  ];
  const environments = [
    { id: 'bayada-prod', name: 'bayada-prod', customerId: 'bayada', tier: 'production', currentVersion: '4.1.2', reachable: true, health: { status: 'healthy', failingComponents: [] }, lastChecked: '2026-04-26T00:00:00Z' },
    { id: 'bayada-staging', name: 'bayada-staging', customerId: 'bayada', tier: 'staging', currentVersion: '4.2.0-rc1', reachable: true, health: { status: 'degraded', failingComponents: ['Cache'] }, lastChecked: '2026-04-26T00:00:00Z' },
    { id: 'lumen-prod', name: 'lumen-prod', customerId: 'lumen', tier: 'production', currentVersion: '4.1.2', reachable: true, health: { status: 'unhealthy', failingComponents: ['Database'] }, lastChecked: '2026-04-26T00:00:00Z' },
  ];
  return {
    customerStore: {
      listCustomers: () => customers,
      listEnvironments: (filter) => filter?.customerId ? environments.filter(e => e.customerId === filter.customerId) : environments,
      listDeployments: () => [],
    },
    releases: {
      list: () => [],
      get: () => null,
      getTickets: () => [],
    },
    releaseTruth: { compute: async () => ({ rollup: {}, tickets: [], rogues: [] }), computeImpact: async () => ({}) },
    ...overrides,
  };
}

describe('registerTools — baseline (no optional stores)', () => {
  it('registers the always-on tool set', () => {
    const server = fakeServer();
    const count = registerTools(server, fakeDeps(), {});
    // Always-on tools (no stores): customers/envs/releases/aggregates/health/check_capability
    expect(count).toBeGreaterThanOrEqual(15);
    const names = server.names();
    for (const n of [
      'get_customer', 'get_environment', 'search_environments',
      'get_release', 'list_releases',
      'aggregate_feature_flags', 'aggregate_integrations',
      'get_health_overview', 'get_customer_health',
      'list_deployments', 'check_capability',
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe('get_health_overview', () => {
  it('returns rollup stats and per-customer breakdown', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps(), {});
    const r = await server.call('get_health_overview', {});
    expect(r.data.stats.total).toBe(3);
    expect(r.data.stats.healthy).toBe(1);
    expect(r.data.stats.degraded).toBe(1);
    expect(r.data.stats.unhealthy).toBe(1);
    expect(r.data.customers.find(c => c.id === 'bayada').envCount).toBe(2);
  });
});

describe('get_customer_health', () => {
  it('returns environments narrowed to one customer', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps(), {});
    const r = await server.call('get_customer_health', { customerId: 'bayada' });
    expect(r.data.customer.id).toBe('bayada');
    expect(r.data.environments).toHaveLength(2);
    expect(r.data.environments[0].failingComponents).toBeDefined();
  });

  it('resolves customer by short name too', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps(), {});
    const r = await server.call('get_customer_health', { customerId: 'Lumen' });
    expect(r.data.customer.id).toBe('lumen');
  });
});

// ── Incidents ────────────────────────────────────────────

describe('incident tools', () => {
  function makeIncidentStore() {
    const incidents = new Map();
    const events = new Map(); // id → []
    return {
      _seed(arr) { for (const i of arr) incidents.set(i.id, i); },
      list: (f = {}) => {
        let arr = [...incidents.values()];
        if (f.status) {
          // Match production: status accepts string OR string[]
          const statuses = Array.isArray(f.status) ? f.status : [f.status];
          arr = arr.filter(i => statuses.includes(i.status));
        }
        if (f.customerId) arr = arr.filter(i => i.customerId === f.customerId);
        if (f.severity) arr = arr.filter(i => i.severity === f.severity);
        if (f.triggerType) arr = arr.filter(i => i.triggerType === f.triggerType);
        return arr;
      },
      get: (id) => incidents.get(id) || null,
      listEvents: (id) => events.get(id) || [],
      acknowledge: (id) => {
        const i = incidents.get(id);
        if (!i) return null;
        i.status = 'acknowledged';
        return i;
      },
      resolve: (id, opts) => {
        const i = incidents.get(id);
        if (!i) return null;
        i.status = 'resolved';
        i.resolution = opts?.resolution || 'manual';
        return i;
      },
      reopen: (id) => {
        const i = incidents.get(id);
        if (!i) return null;
        i.status = 'open';
        return i;
      },
      addNote: (id) => incidents.get(id) || null,
      assign: (id, opts) => {
        const i = incidents.get(id);
        if (!i) return null;
        i.assigneeUserId = opts.assigneeUserId;
        return i;
      },
    };
  }

  let server, store;
  beforeEach(() => {
    server = fakeServer();
    store = makeIncidentStore();
    store._seed([
      { id: 'inc-1', status: 'open',         severity: 'critical', triggerType: 'env-unhealthy', summary: 'bayada-prod down',     customerId: 'bayada', envId: 'bayada-prod', openedAt: '2026-04-26T00:00:00Z', slackPosts: [{ channel: '#a', ts: '1' }] },
      { id: 'inc-2', status: 'resolved',     severity: 'warning',  triggerType: 'deploy-failed',  summary: 'lumen deploy failed',  customerId: 'lumen',  envId: 'lumen-prod',  openedAt: '2026-04-25T00:00:00Z', resolvedAt: '2026-04-25T01:00:00Z', slackPosts: [] },
      { id: 'inc-3', status: 'acknowledged', severity: 'critical', triggerType: 'env-unhealthy', summary: 'lumen-prod degraded',  customerId: 'lumen',  envId: 'lumen-prod',  openedAt: '2026-04-26T01:00:00Z', slackPosts: [] },
      { id: 'inc-4', status: 'reopened',     severity: 'warning',  triggerType: 'env-unhealthy', summary: 'flap',                customerId: 'lumen',  envId: 'lumen-prod',  openedAt: '2026-04-26T02:00:00Z', slackPosts: [] },
    ]);
    // Dev-mode authz: SSO disabled means authorize() returns true for all
    delete process.env.ENABLE_GOOGLE_SSO;
    registerTools(server, fakeDeps({ incidents: store }), { user: { email: 'admin@viv.com' } });
  });

  it('list_incidents defaults to "active" — open + acknowledged + reopened', async () => {
    const r = await server.call('list_incidents', {});
    // open + acknowledged + reopened = 3 (excludes resolved)
    expect(r.data.count).toBe(3);
    const ids = r.data.incidents.map(i => i.id).sort();
    expect(ids).toEqual(['inc-1', 'inc-3', 'inc-4']);
  });

  it('list_incidents status=open is narrower than active', async () => {
    const r = await server.call('list_incidents', { status: 'open' });
    expect(r.data.count).toBe(1);
    expect(r.data.incidents[0].id).toBe('inc-1');
  });

  it('list_incidents status=all returns every status', async () => {
    const r = await server.call('list_incidents', { status: 'all' });
    expect(r.data.count).toBe(4);
  });

  it('list_incidents narrows by customer', async () => {
    const r = await server.call('list_incidents', { status: 'all', customerId: 'lumen' });
    expect(r.data.count).toBe(3);
  });

  it('list_incidents narrows by severity', async () => {
    const r = await server.call('list_incidents', { status: 'all', severity: 'critical' });
    expect(r.data.count).toBe(2);
  });

  it('get_incident returns the full record', async () => {
    const r = await server.call('get_incident', { incidentId: 'inc-1' });
    expect(r.data.severity).toBe('critical');
    expect(r.data.slackPosts).toHaveLength(1);
  });

  it('acknowledge_incident flips status', async () => {
    const r = await server.call('acknowledge_incident', { incidentId: 'inc-1', note: 'on it' });
    expect(r.data.ok).toBe(true);
    expect(store.get('inc-1').status).toBe('acknowledged');
  });

  it('resolve_incident records resolution', async () => {
    const r = await server.call('resolve_incident', { incidentId: 'inc-1', resolution: 'wontfix' });
    expect(r.data.ok).toBe(true);
    expect(store.get('inc-1').resolution).toBe('wontfix');
  });
});

// ── Alert rules ──────────────────────────────────────────

describe('alert rule tools', () => {
  it('list_alert_rules + get_alert_rule', async () => {
    const server = fakeServer();
    const rules = [
      { id: 'r1', name: 'Prod health', triggerType: 'env-unhealthy', channels: ['#a'], severity: 'critical', enabled: true, lastFiredAt: null, filter: {} },
      { id: 'r2', name: 'Deploy fails', triggerType: 'deploy-failed', channels: ['#a'], severity: 'warning', enabled: false, lastFiredAt: null, filter: {} },
    ];
    const alertRules = {
      list: (f = {}) => {
        let arr = [...rules];
        if (f.triggerType) arr = arr.filter(r => r.triggerType === f.triggerType);
        if (f.enabled !== undefined) arr = arr.filter(r => r.enabled === f.enabled);
        return arr;
      },
      get: (id) => rules.find(r => r.id === id) || null,
    };
    registerTools(server, fakeDeps({ alertRules }), {});

    const all = await server.call('list_alert_rules', {});
    expect(all.data.count).toBe(2);

    const enabled = await server.call('list_alert_rules', { enabled: true });
    expect(enabled.data.count).toBe(1);

    const one = await server.call('get_alert_rule', { ruleId: 'r1' });
    expect(one.data.name).toBe('Prod health');
  });

  it('evaluate_alert_rule_now invokes the router', async () => {
    const server = fakeServer();
    const evaluateNow = vi.fn(async () => ({ ok: true, fired: 1, skipped: 0 }));
    registerTools(server, fakeDeps({ alertRules: { list: () => [], get: () => null }, alertRouter: { evaluateNow } }), {});
    const r = await server.call('evaluate_alert_rule_now', { ruleId: 'r1' });
    expect(r.data.ok).toBe(true);
    expect(r.data.fired).toBe(1);
    expect(evaluateNow).toHaveBeenCalledWith('r1');
  });
});

// ── Support tickets ──────────────────────────────────────

describe('support ticket tools', () => {
  it('search_support_tickets paginates + filters by status', async () => {
    const server = fakeServer();
    const allTickets = [
      { id: '1', ticketNumber: 'VHC-1', subject: 'Login fails', status: 'Open', statusType: 'Open', priority: 'High', accountId: 'a1', assigneeEmail: 'x@viv.com', createdAt: '2026-04-25T00:00:00Z', modifiedAt: '2026-04-25T01:00:00Z', webUrl: 'https://x' },
      { id: '2', ticketNumber: 'VHC-2', subject: 'Slow page', status: 'Closed', statusType: 'Closed', priority: 'Low', accountId: 'a1', assigneeEmail: 'y@viv.com', createdAt: '2026-04-20T00:00:00Z', modifiedAt: '2026-04-21T00:00:00Z', webUrl: 'https://y' },
    ];
    const filterTickets = (opts) => {
      let arr = [...allTickets];
      if (opts.openOnly) arr = arr.filter(t => t.statusType !== 'Closed');
      if (opts.closedOnly) arr = arr.filter(t => t.statusType === 'Closed');
      // Production expects ARRAY filters here — the regression we just fixed.
      if (opts.deptPrefixes) arr = arr.filter(t => opts.deptPrefixes.includes(t.deptPrefix || (t.ticketNumber || '').split('-')[0]));
      if (opts.accountIds) arr = arr.filter(t => opts.accountIds.includes(t.accountId));
      return arr;
    };
    const zohoStore = {
      listTickets: (opts) => filterTickets(opts).slice(opts.offset || 0, (opts.offset || 0) + opts.limit),
      countTickets: (opts) => filterTickets(opts).length,
      getTicketByNumber: (n) => allTickets.find(t => t.ticketNumber === n) || null,
      listDeptPrefixes: () => [{ deptPrefix: 'VHC', count: 2 }],
    };
    registerTools(server, fakeDeps({ zohoStore }), {});

    const open = await server.call('search_support_tickets', {});
    expect(open.data.total).toBe(1);
    expect(open.data.tickets[0].ticketNumber).toBe('VHC-1');

    const all = await server.call('search_support_tickets', { status: 'all' });
    expect(all.data.total).toBe(2);

    const one = await server.call('get_support_ticket', { ticketNumber: 'VHC-1' });
    expect(one.data.subject).toBe('Login fails');

    const depts = await server.call('list_support_departments', {});
    expect(depts.data.departments[0].deptPrefix).toBe('VHC');
  });

  it('search_support_tickets accepts array filters (regression)', async () => {
    const server = fakeServer();
    const allTickets = [
      { id: '1', ticketNumber: 'VHC-1', deptPrefix: 'VHC', accountId: 'a1', statusType: 'Open', subject: 'x' },
      { id: '2', ticketNumber: 'BYD-1', deptPrefix: 'BYD', accountId: 'a2', statusType: 'Open', subject: 'y' },
    ];
    const filterTickets = (opts) => {
      let arr = [...allTickets];
      if (opts.openOnly) arr = arr.filter(t => t.statusType !== 'Closed');
      if (opts.deptPrefixes) arr = arr.filter(t => opts.deptPrefixes.includes(t.deptPrefix));
      if (opts.accountIds) arr = arr.filter(t => opts.accountIds.includes(t.accountId));
      return arr;
    };
    registerTools(server, fakeDeps({
      zohoStore: {
        listTickets: (o) => filterTickets(o).slice(o.offset || 0, (o.offset || 0) + o.limit),
        countTickets: (o) => filterTickets(o).length,
        getTicketByNumber: () => null,
        listDeptPrefixes: () => [],
      },
    }), {});

    const r = await server.call('search_support_tickets', { deptPrefixes: ['VHC'] });
    expect(r.data.total).toBe(1);
    expect(r.data.tickets[0].ticketNumber).toBe('VHC-1');

    const r2 = await server.call('search_support_tickets', { accountIds: ['a2'], status: 'all' });
    expect(r2.data.total).toBe(1);
    expect(r2.data.tickets[0].ticketNumber).toBe('BYD-1');
  });
});

// ── JIRA tickets ─────────────────────────────────────────

describe('JIRA ticket tools', () => {
  function makeTicketStore() {
    const tickets = {
      'DEV-1': { key: 'DEV-1', summary: 'Add field', status: 'Done', assignee: 'a@viv', fixVersion: '4.1.2', fixVersions: ['4.1.2'], targetFixVersions: ['4.1.2'], module: 'rcm', projects: [], product: [], updated: '2026-04-25' },
    };
    const truthByKey = {
      'DEV-1': [
        { repo: 'webplatform', version: '4.1.2', jiraStatus: 'Done', branchStatus: 'merged', healthCategory: 'done', healthMessage: 'Merged on releases/4.1.2', prs: [{ number: 25500, mergedAt: '2026-04-20' }] },
      ],
    };
    const rollups = {
      'webplatform:4.1.2': { done: 12, inQa: 3, awaitingCp: 1, inDev: 0, attention: 0, rogue: 0 },
    };
    const all = Object.values(tickets);
    return {
      // Match production shape — both helpers return { tickets, total, hasMore }.
      search: () => ({ tickets: all, total: all.length, hasMore: false }),
      getByFilter: (opts) => {
        let arr = all;
        if (opts.person) arr = arr.filter(t => t.assignee === opts.person || t.qaAssignee === opts.person);
        if (opts.module) arr = arr.filter(t => t.module === opts.module);
        return { tickets: arr, total: arr.length, hasMore: false };
      },
      get: (k) => tickets[k] || null,
      getTruthForTicket: (k) => truthByKey[k] || [],
      getTruthRollup: (repo, version) => rollups[`${repo}:${version}`] || { done: 0, inQa: 0, awaitingCp: 0, inDev: 0, attention: 0, rogue: 0 },
    };
  }

  it('search_jira_tickets returns summary fields', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps({ ticketStore: makeTicketStore() }), {});

    const r = await server.call('search_jira_tickets', { query: 'field' });
    expect(r.data.count).toBe(1);
    expect(r.data.tickets[0].key).toBe('DEV-1');
    expect(r.data.total).toBe(1);
    expect(r.data.hasMore).toBe(false);

    const one = await server.call('get_jira_ticket', { key: 'DEV-1' });
    expect(one.data.summary).toBe('Add field');

    const miss = await server.call('get_jira_ticket', { key: 'DEV-99' });
    expect(miss.raw).toMatch(/not found/);
  });

  it('search_jira_tickets without query uses structured filters via getByFilter', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps({ ticketStore: makeTicketStore() }), {});
    // No query — should still return results via getByFilter
    const r = await server.call('search_jira_tickets', { assignee: 'a@viv' });
    expect(r.data.count).toBe(1);
    expect(r.data.tickets[0].key).toBe('DEV-1');
  });

  it('search_jira_tickets unwraps the result envelope (regression — used to crash on result.length)', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps({ ticketStore: makeTicketStore() }), {});
    const r = await server.call('search_jira_tickets', {});
    // Must succeed without throwing — was breaking because the tool
    // treated { tickets, total, hasMore } as an Array.
    expect(r.data).toBeDefined();
    expect(Array.isArray(r.data.tickets)).toBe(true);
  });

  it('get_jira_ticket_truth returns per-release health info', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps({ ticketStore: makeTicketStore() }), {});
    const r = await server.call('get_jira_ticket_truth', { key: 'DEV-1' });
    expect(r.data.jiraStatus).toBe('Done');
    expect(r.data.truthCount).toBe(1);
    expect(r.data.truth[0].healthCategory).toBe('done');
    expect(r.data.truth[0].prs[0].number).toBe(25500);
  });

  it('get_jira_ticket_truth on unknown key returns not found', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps({ ticketStore: makeTicketStore() }), {});
    const r = await server.call('get_jira_ticket_truth', { key: 'DEV-99' });
    expect(r.raw).toMatch(/not found/);
  });

  it('get_release_truth_rollup returns counts by health category', async () => {
    const server = fakeServer();
    registerTools(server, fakeDeps({ ticketStore: makeTicketStore() }), {});
    const r = await server.call('get_release_truth_rollup', { version: '4.1.2', repo: 'webplatform' });
    expect(r.data.rollup.done).toBe(12);
    expect(r.data.rollup.inQa).toBe(3);
  });
});

// ── People ───────────────────────────────────────────────

describe('get_release_prs', () => {
  it('uses prStore.findByJiraKey (regression — was calling non-existent getByTicket)', async () => {
    const server = fakeServer();
    const release = { version: '4.1.2', repo: 'webplatform' };
    const releases = {
      list: () => [],
      get: (v, r) => v === '4.1.2' ? release : null,
      getTickets: () => [{ key: 'DEV-1' }, { key: 'DEV-2' }],
    };
    const prStore = {
      findByJiraKey: (k) => k === 'DEV-1'
        ? [{ prNumber: 25500, title: 'add field', author: 'alice', prMergedAt: '2026-04-20', repo: 'webplatform' }]
        : [],
    };
    registerTools(server, fakeDeps({ releases: { ...releases }, prStore }), {});
    const r = await server.call('get_release_prs', { version: '4.1.2', repo: 'webplatform' });
    expect(r.data.count).toBe(1);
    expect(r.data.prs[0].number).toBe(25500);
    expect(r.data.prs[0].mergedAt).toBe('2026-04-20');
  });
});

describe('list_people', () => {
  it('lists users from userStore', async () => {
    const server = fakeServer();
    const userStore = {
      listUsers: () => [
        { email: 'a@viv.com', name: 'Alice', teamId: 't1', jiraName: 'alice' },
        { email: 'b@viv.com', name: 'Bob', teamId: 't2', jiraName: 'bob' },
      ],
    };
    registerTools(server, fakeDeps({ userStore }), {});
    const r = await server.call('list_people', {});
    expect(r.data.count).toBe(2);
    expect(r.data.users[0].email).toBe('a@viv.com');
  });
});

// ── Tool count snapshots ─────────────────────────────────

describe('full toolset snapshot', () => {
  it('with all stores wired, registers ~25 tools', () => {
    const server = fakeServer();
    const count = registerTools(server, fakeDeps({
      incidents: { list: () => [], get: () => null, listEvents: () => [], acknowledge: () => null, resolve: () => null, reopen: () => null, addNote: () => null, assign: () => null },
      alertRules: { list: () => [], get: () => null },
      alertRouter: { evaluateNow: async () => ({}) },
      zohoStore: { listTickets: () => [], countTickets: () => 0, getTicketByNumber: () => null, listDeptPrefixes: () => [] },
      ticketStore: { search: () => ({ tickets: [], total: 0, hasMore: false }), get: () => null, getByFilter: () => ({ tickets: [], total: 0, hasMore: false }), getTruthForTicket: () => [], getTruthRollup: () => ({}) },
      prStore: { getByTicket: () => [] },
      userStore: { listUsers: () => [] },
      taskQueue: { getPending: () => [], claim: () => null, complete: () => null, getTask: () => null },
      risk: { assess: async () => ({}) },
    }), {});
    expect(count).toBeGreaterThanOrEqual(25);
  });
});
