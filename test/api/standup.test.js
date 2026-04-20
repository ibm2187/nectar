import { describe, it, expect, beforeEach, vi } from 'vitest';

const { buildStandupData } = require('../../src/api/standup');

// ── Test helpers ────────────────────────────────────────

function makeTicket(key, overrides = {}) {
  return {
    key,
    summary: `Test ticket ${key}`,
    jiraStatus: 'Development In Progress',
    type: 'Story',
    priority: 'Medium',
    assignee: null,
    qaAssignee: null,
    ...overrides,
  };
}

function makeRelease(version, overrides = {}) {
  return {
    version,
    state: 'stabilizing',
    jiraReleaseDate: '2026-04-22', // this Tuesday
    jiraArchived: false,
    repo: 'mavencare/webplatform',
    ...overrides,
  };
}

function createMockServices(releases = [], ticketsByRelease = {}, prsByKey = new Map(), truthByKey = new Map(), teamMembers = []) {
  return {
    releases: {
      list: () => releases,
      getTickets: (release) => ticketsByRelease[release.version] || [],
    },
    ticketStore: {
      getTruthForTicketsSlim: (keys) => truthByKey,
      getDistinctPeople: () => teamMembers,
    },
    prStore: {
      findByJiraKeysSlim: (keys) => prsByKey,
    },
    availability: {
      isPersonOut: (name) => false,
      getPersonOut: (name) => null,
    },
    peopleDirectory: {
      resolveSlackId: (name) => {
        const map = { 'Alice Dev': { slackId: 'U001' }, 'Bob QA': { slackId: 'U002' }, 'Carol Dev': { slackId: 'U003' } };
        return map[name] || null;
      },
    },
  };
}

// ── Tests ───────────────────────────────────────────────

describe('buildStandupData', () => {
  it('returns empty when no active releases exist', () => {
    const services = createMockServices([], {});
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    expect(result.people).toEqual([]);
    expect(result.releasesDueThisWeek).toEqual([]);
    expect(result.generatedAt).toBeDefined();
  });

  it('excludes done releases', () => {
    const releases = [makeRelease('4.2.0', { state: 'done' })];
    const services = createMockServices(releases, { '4.2.0': [makeTicket('DEV-1', { assignee: 'Alice Dev' })] });
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    expect(result.people).toEqual([]);
  });

  it('excludes archived releases', () => {
    const releases = [makeRelease('4.2.0', { jiraArchived: true })];
    const services = createMockServices(releases, { '4.2.0': [makeTicket('DEV-1', { assignee: 'Alice Dev' })] });
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    expect(result.people).toEqual([]);
  });

  it('includes releases beyond horizon (standup shows all active work)', () => {
    const releases = [makeRelease('4.2.0', { jiraReleaseDate: '2026-05-15' })];
    const services = createMockServices(releases, { '4.2.0': [makeTicket('DEV-1', { assignee: 'Alice Dev' })] });
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    // Person still shows up — their work is visible regardless of release date
    const alice = result.people.find(p => p.name === 'Alice Dev');
    expect(alice).toBeDefined();
    expect(alice.buckets.inDev).toHaveLength(1);
    // But it's NOT in releasesDueThisWeek header (beyond horizon)
    expect(result.releasesDueThisWeek).toHaveLength(0);
  });

  it('groups tickets by person from assignee and qaAssignee', () => {
    const releases = [makeRelease('4.2.0')];
    const tickets = [
      makeTicket('DEV-1', { assignee: 'Alice Dev', qaAssignee: 'Bob QA' }),
      makeTicket('DEV-2', { assignee: 'Alice Dev' }),
      makeTicket('DEV-3', { qaAssignee: 'Bob QA' }),
    ];
    const services = createMockServices(releases, { '4.2.0': tickets });
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    expect(result.people).toHaveLength(2);
    const alice = result.people.find(p => p.name === 'Alice Dev');
    const bob = result.people.find(p => p.name === 'Bob QA');
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice.roles).toContain('dev');
    expect(bob.roles).toContain('qa');
  });

  it('skips done tickets from buckets but includes person with 0 items via team list', () => {
    const releases = [makeRelease('4.2.0')];
    const tickets = [
      makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'QA Certified' }),
      makeTicket('DEV-2', { assignee: 'Alice Dev', jiraStatus: 'Done' }),
    ];
    const team = [{ name: 'Alice Dev', roles: ['dev'] }];
    const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), new Map(), team);
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    // Alice shows up from team list with 0 items
    expect(result.people).toHaveLength(1);
    expect(result.people[0].name).toBe('Alice Dev');
    expect(result.people[0].totalItems).toBe(0);
  });

  it('includes all team members even those without any tickets', () => {
    const releases = [makeRelease('4.2.0')];
    const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
    const team = [
      { name: 'Alice Dev', roles: ['dev'] },
      { name: 'Bob QA', roles: ['qa'] },
      { name: 'Carol Dev', roles: ['dev'] },
    ];
    const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), new Map(), team);
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    expect(result.people).toHaveLength(3);
    const bob = result.people.find(p => p.name === 'Bob QA');
    const carol = result.people.find(p => p.name === 'Carol Dev');
    expect(bob.totalItems).toBe(0);
    expect(carol.totalItems).toBe(0);
  });

  it('does not include reporters or PMs in standup list', () => {
    const releases = [makeRelease('4.2.0')];
    const team = [
      { name: 'Alice Dev', roles: ['dev'] },
      { name: 'Diana PM', roles: ['pm'] },
      { name: 'Eve Reporter', roles: ['reporter'] },
    ];
    const services = createMockServices(releases, { '4.2.0': [] }, new Map(), new Map(), team);
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    // Only dev/qa roles included
    expect(result.people).toHaveLength(1);
    expect(result.people[0].name).toBe('Alice Dev');
  });

  it('resolves Slack IDs via people directory', () => {
    const releases = [makeRelease('4.2.0')];
    const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
    const services = createMockServices(releases, { '4.2.0': tickets });
    const result = buildStandupData(services, { horizon: '2026-04-27' });

    expect(result.people[0].slackId).toBe('U001');
  });

  it('marks OOO people', () => {
    const releases = [makeRelease('4.2.0')];
    const tickets = [
      makeTicket('DEV-1', { assignee: 'Alice Dev' }),
      makeTicket('DEV-2', { assignee: 'Carol Dev' }),
    ];
    const services = createMockServices(releases, { '4.2.0': tickets });
    services.availability.isPersonOut = (name) => name === 'Carol Dev';

    const result = buildStandupData(services, { horizon: '2026-04-27' });

    const carol = result.people.find(p => p.name === 'Carol Dev');
    expect(carol.isOoo).toBe(true);
  });

  it('sorts OOO people last', () => {
    const releases = [makeRelease('4.2.0')];
    const tickets = [
      makeTicket('DEV-1', { assignee: 'Alice Dev' }),
      makeTicket('DEV-2', { assignee: 'Carol Dev' }),
    ];
    const services = createMockServices(releases, { '4.2.0': tickets });
    services.availability.isPersonOut = (name) => name === 'Alice Dev';

    const result = buildStandupData(services, { horizon: '2026-04-27' });

    // Carol (not OOO) should be first
    expect(result.people[0].name).toBe('Carol Dev');
    expect(result.people[1].name).toBe('Alice Dev');
  });

  describe('priority buckets', () => {
    it('classifies blocked tickets (attention health category)', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'Blocked' })];
      const truthMap = new Map([['DEV-1', [{ version: '4.2.0', health: 'blocked', healthCategory: 'attention' }]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.blocked).toHaveLength(1);
      expect(alice.buckets.blocked[0].key).toBe('DEV-1');
    });

    it('classifies awaiting cherry-pick tickets', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'Waiting for Cherry Pick' })];
      const truthMap = new Map([['DEV-1', [{ version: '4.2.0', health: 'awaiting-cp', healthCategory: 'awaiting-cp' }]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.awaitingCherryPick).toHaveLength(1);
    });

    it('classifies pending testing tickets (in-qa category)', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { qaAssignee: 'Bob QA', jiraStatus: 'Ready For Testing' })];
      const truthMap = new Map([['DEV-1', [{ version: '4.2.0', health: 'in-qa', healthCategory: 'in-qa' }]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const bob = result.people.find(p => p.name === 'Bob QA');
      expect(bob.buckets.pendingTesting).toHaveLength(1);
    });

    it('classifies in-dev tickets', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'Development In Progress' })];
      const truthMap = new Map([['DEV-1', [{ version: '4.2.0', health: 'in-dev', healthCategory: 'in-dev' }]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.inDev).toHaveLength(1);
    });

    it('puts tickets with no truth into inDev bucket', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
      const services = createMockServices(releases, { '4.2.0': tickets });

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.inDev).toHaveLength(1);
    });
  });

  describe('PR review buckets', () => {
    it('adds PRs with CHANGES_REQUESTED to reviewChangesRequested', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
      const prMap = new Map([['DEV-1', [
        { prNumber: 100, repo: 'mavencare/webplatform', prUrl: 'https://gh/100', status: 'open', reviewDecision: 'CHANGES_REQUESTED', prAuthor: 'alice' },
      ]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, prMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.reviewChangesRequested).toHaveLength(1);
      expect(alice.buckets.reviewChangesRequested[0].prNumber).toBe(100);
    });

    it('adds PRs with APPROVED to reviewApproved', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
      const prMap = new Map([['DEV-1', [
        { prNumber: 101, repo: 'mavencare/webplatform', prUrl: 'https://gh/101', status: 'open', reviewDecision: 'APPROVED', prAuthor: 'alice' },
      ]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, prMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.reviewApproved).toHaveLength(1);
      expect(alice.buckets.reviewApproved[0].prNumber).toBe(101);
    });

    it('ignores closed PRs for review buckets', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
      const prMap = new Map([['DEV-1', [
        { prNumber: 102, repo: 'mavencare/webplatform', prUrl: 'https://gh/102', status: 'merged', reviewDecision: 'APPROVED', prAuthor: 'alice' },
      ]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, prMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.reviewApproved).toHaveLength(0);
    });

    it('does not duplicate PRs in review buckets', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [
        makeTicket('DEV-1', { assignee: 'Alice Dev' }),
        makeTicket('DEV-2', { assignee: 'Alice Dev' }),
      ];
      // Same PR linked to both tickets
      const prMap = new Map([
        ['DEV-1', [{ prNumber: 100, repo: 'mavencare/webplatform', prUrl: 'https://gh/100', status: 'open', reviewDecision: 'APPROVED', prAuthor: 'alice' }]],
        ['DEV-2', [{ prNumber: 100, repo: 'mavencare/webplatform', prUrl: 'https://gh/100', status: 'open', reviewDecision: 'APPROVED', prAuthor: 'alice' }]],
      ]);
      const services = createMockServices(releases, { '4.2.0': tickets }, prMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.reviewApproved).toHaveLength(1);
    });
  });

  describe('release-critical classification', () => {
    it('marks blocked tickets on imminent releases as release-critical', () => {
      // Due tomorrow
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const releases = [makeRelease('4.2.0', { jiraReleaseDate: tomorrow })];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'Blocked' })];
      const truthMap = new Map([['DEV-1', [{ version: '4.2.0', health: 'blocked', healthCategory: 'attention' }]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.releaseCritical).toHaveLength(1);
      expect(alice.buckets.releaseCritical[0].key).toBe('DEV-1');
    });

    it('does not mark tickets on distant releases as critical', () => {
      const releases = [makeRelease('4.2.0', { jiraReleaseDate: '2026-04-28' })];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'Blocked' })];
      const truthMap = new Map([['DEV-1', [{ version: '4.2.0', health: 'blocked', healthCategory: 'attention' }]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-30' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice.buckets.releaseCritical).toHaveLength(0);
    });
  });

  describe('urgency scoring and sort order', () => {
    it('scores people with blocked tickets higher', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [
        makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'Blocked' }),
        makeTicket('DEV-2', { assignee: 'Carol Dev', jiraStatus: 'Development In Progress' }),
      ];
      const truthMap = new Map([
        ['DEV-1', [{ version: '4.2.0', health: 'blocked', healthCategory: 'attention' }]],
        ['DEV-2', [{ version: '4.2.0', health: 'in-dev', healthCategory: 'in-dev' }]],
      ]);
      const services = createMockServices(releases, { '4.2.0': tickets }, new Map(), truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      // Alice (blocked=4) should be before Carol (inDev=0)
      expect(result.people[0].name).toBe('Alice Dev');
      expect(result.people[1].name).toBe('Carol Dev');
      expect(result.people[0].urgencyScore).toBeGreaterThan(result.people[1].urgencyScore);
    });
  });

  describe('releasesDueThisWeek summary', () => {
    it('includes relevant releases with ticket counts', () => {
      const releases = [
        makeRelease('4.2.0', { jiraReleaseDate: '2026-04-22' }),
        makeRelease('4.2.1', { jiraReleaseDate: '2026-04-24' }),
      ];
      const tickets = {
        '4.2.0': [
          makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'In Progress' }),
          makeTicket('DEV-2', { assignee: 'Alice Dev', jiraStatus: 'Done' }),
        ],
        '4.2.1': [
          makeTicket('DEV-3', { assignee: 'Alice Dev', jiraStatus: 'Testing' }),
        ],
      };
      const services = createMockServices(releases, tickets);
      const result = buildStandupData(services, { horizon: '2026-04-27' });

      expect(result.releasesDueThisWeek).toHaveLength(2);
      expect(result.releasesDueThisWeek[0].version).toBe('4.2.0');
      expect(result.releasesDueThisWeek[0].ticketsRemaining).toBe(1); // DEV-2 is Done
      expect(result.releasesDueThisWeek[1].version).toBe('4.2.1');
      expect(result.releasesDueThisWeek[1].ticketsRemaining).toBe(1);
    });

    it('sorts releases by due date', () => {
      const releases = [
        makeRelease('4.2.1', { jiraReleaseDate: '2026-04-25' }),
        makeRelease('4.2.0', { jiraReleaseDate: '2026-04-22' }),
      ];
      const services = createMockServices(releases, {
        '4.2.0': [makeTicket('DEV-1', { assignee: 'A' })],
        '4.2.1': [makeTicket('DEV-2', { assignee: 'B' })],
      });
      const result = buildStandupData(services, { horizon: '2026-04-27' });

      expect(result.releasesDueThisWeek[0].version).toBe('4.2.0');
      expect(result.releasesDueThisWeek[1].version).toBe('4.2.1');
    });
  });

  describe('ticket item shape', () => {
    it('includes expected fields on ticket items', () => {
      const releases = [makeRelease('4.2.0')];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev', jiraStatus: 'In Progress', priority: 'High', type: 'Bug' })];
      const truthMap = new Map([['DEV-1', [{ version: '4.2.0', health: 'in-dev', healthCategory: 'in-dev' }]]]);
      const prMap = new Map([['DEV-1', [
        { prNumber: 55, repo: 'mavencare/webplatform', prUrl: 'https://gh/55', status: 'open', reviewDecision: 'APPROVED', prAuthor: 'alice' },
      ]]]);
      const services = createMockServices(releases, { '4.2.0': tickets }, prMap, truthMap);

      const result = buildStandupData(services, { horizon: '2026-04-27' });
      const alice = result.people.find(p => p.name === 'Alice Dev');
      const item = alice.buckets.inDev[0];

      expect(item.key).toBe('DEV-1');
      expect(item.summary).toBe('Test ticket DEV-1');
      expect(item.jiraStatus).toBe('In Progress');
      expect(item.type).toBe('Bug');
      expect(item.priority).toBe('High');
      expect(item.role).toBe('dev');
      expect(item.release.version).toBe('4.2.0');
      expect(item.release.dueDate).toBe('2026-04-22');
      expect(item.prs).toHaveLength(1);
      expect(item.prs[0].prNumber).toBe(55);
      expect(item.prs[0].reviewDecision).toBe('APPROVED');
      expect(item.health).toBe('in-dev');
      expect(item.healthCategory).toBe('in-dev');
    });
  });

  describe('multi-release handling', () => {
    it('handles a person with tickets across multiple releases', () => {
      const releases = [
        makeRelease('4.2.0', { jiraReleaseDate: '2026-04-22' }),
        makeRelease('4.2.1', { jiraReleaseDate: '2026-04-25' }),
      ];
      const tickets = {
        '4.2.0': [makeTicket('DEV-1', { assignee: 'Alice Dev' })],
        '4.2.1': [makeTicket('DEV-2', { assignee: 'Alice Dev' })],
      };
      const services = createMockServices(releases, tickets);
      const result = buildStandupData(services, { horizon: '2026-04-27' });

      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice).toBeDefined();
      // Both tickets land in inDev (no truth)
      expect(alice.buckets.inDev).toHaveLength(2);
      expect(alice.buckets.inDev.map(t => t.release.version).sort()).toEqual(['4.2.0', '4.2.1']);
    });
  });

  describe('default horizon (5 business days)', () => {
    it('uses availability.nextBusinessDays when available', () => {
      // Release on the 5th business day should be included
      const releases = [makeRelease('4.2.0', { jiraReleaseDate: '2026-04-28' })];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
      const services = createMockServices(releases, { '4.2.0': tickets });
      // Mock availability to return 5 business days ending on Apr 28
      services.availability.nextBusinessDays = (n) => {
        // 5 business days from Apr 20 (Mon) = Apr 24 (Fri)... but let's say it returns Apr 28
        return ['2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24', '2026-04-28'];
      };

      // No explicit horizon — should use availability's 5 business days
      const result = buildStandupData(services);
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice).toBeDefined();
      expect(alice.buckets.inDev).toHaveLength(1);
    });

    it('falls back to calendar-based calculation without availability', () => {
      // Release 6 days out — always within fallback window (min 7 calendar days)
      const futureDate = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const releases = [makeRelease('4.2.0', { jiraReleaseDate: futureDate })];
      const tickets = [makeTicket('DEV-1', { assignee: 'Alice Dev' })];
      const services = createMockServices(releases, { '4.2.0': tickets });
      services.availability = null; // no availability

      const result = buildStandupData(services);
      const alice = result.people.find(p => p.name === 'Alice Dev');
      expect(alice).toBeDefined();
    });
  });
});
