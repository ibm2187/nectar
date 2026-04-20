import { describe, it, expect, beforeEach } from 'vitest';

const TicketStore = require('../../src/core/ticket-store');
const { createTestDb } = require('../../src/core/db');

function insertTicket(db, key, overrides = {}) {
  const defaults = {
    key,
    summary: `Test ${key}`,
    status: 'In Progress',
    statusCategory: 'In Progress',
    state: 'in-progress',
    type: 'Story',
    assignee: null,
    reporter: null,
    qaAssignee: null,
    productAssignee: null,
    component: null,
    module: null,
    product: '[]',
    projects: '[]',
    priority: null,
    riskLevel: null,
    customerPriority: null,
    fixVersions: '[]',
    targetFixVersions: '[]',
    customerTags: '[]',
    deployedEnvironments: '[]',
    labels: '[]',
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: '2026-04-01',
    updatedInJira: '2026-04-01',
    syncedAt: new Date().toISOString(),
  };
  const row = { ...defaults, ...overrides };
  db.prepare(`
    INSERT OR REPLACE INTO jira_tickets (
      key, summary, status, statusCategory, state, type,
      assignee, reporter, qaAssignee, productAssignee,
      component, module, product, projects,
      priority, riskLevel, customerPriority,
      fixVersions, targetFixVersions, customerTags,
      deployedEnvironments, labels, zohoRef,
      submitterName, submitterEmail,
      created, updatedInJira, syncedAt
    ) VALUES (
      @key, @summary, @status, @statusCategory, @state, @type,
      @assignee, @reporter, @qaAssignee, @productAssignee,
      @component, @module, @product, @projects,
      @priority, @riskLevel, @customerPriority,
      @fixVersions, @targetFixVersions, @customerTags,
      @deployedEnvironments, @labels, @zohoRef,
      @submitterName, @submitterEmail,
      @created, @updatedInJira, @syncedAt
    )
  `).run(row);
}

describe('TicketStore.getDistinctPeople', () => {
  let db, store;

  beforeEach(() => {
    db = createTestDb();
    store = new TicketStore({ db });
  });

  it('returns distinct people with their roles', () => {
    insertTicket(db, 'DEV-1', { assignee: 'Alice', qaAssignee: 'Bob' });
    insertTicket(db, 'DEV-2', { assignee: 'Alice', reporter: 'Charlie' });
    insertTicket(db, 'DEV-3', { qaAssignee: 'Alice', productAssignee: 'Diana' });

    const people = store.getDistinctPeople();

    expect(people.length).toBe(4);

    const alice = people.find(p => p.name === 'Alice');
    expect(alice).toBeDefined();
    expect(alice.roles).toContain('dev');
    expect(alice.roles).toContain('qa');

    const bob = people.find(p => p.name === 'Bob');
    expect(bob.roles).toEqual(['qa']);

    const charlie = people.find(p => p.name === 'Charlie');
    expect(charlie.roles).toEqual(['reporter']);

    const diana = people.find(p => p.name === 'Diana');
    expect(diana.roles).toEqual(['pm']);
  });

  it('returns sorted by name case-insensitive', () => {
    insertTicket(db, 'DEV-1', { assignee: 'Zara' });
    insertTicket(db, 'DEV-2', { assignee: 'alice' });
    insertTicket(db, 'DEV-3', { assignee: 'Bob' });

    const people = store.getDistinctPeople();
    expect(people.map(p => p.name)).toEqual(['alice', 'Bob', 'Zara']);
  });

  it('returns empty array when no tickets', () => {
    const people = store.getDistinctPeople();
    expect(people).toEqual([]);
  });

  it('skips null and empty assignee fields', () => {
    insertTicket(db, 'DEV-1', { assignee: 'Alice', qaAssignee: null, reporter: '' });

    const people = store.getDistinctPeople();
    expect(people.length).toBe(1);
    expect(people[0].name).toBe('Alice');
  });

  it('deduplicates across many tickets', () => {
    for (let i = 1; i <= 100; i++) {
      insertTicket(db, `DEV-${i}`, {
        assignee: i % 2 === 0 ? 'Alice' : 'Bob',
        qaAssignee: 'Carol',
      });
    }

    const people = store.getDistinctPeople();
    expect(people.length).toBe(3);
    expect(people.find(p => p.name === 'Alice').roles).toEqual(['dev']);
    expect(people.find(p => p.name === 'Bob').roles).toEqual(['dev']);
    expect(people.find(p => p.name === 'Carol').roles).toEqual(['qa']);
  });

  it('person with all 4 roles gets all roles', () => {
    insertTicket(db, 'DEV-1', { assignee: 'Alice' });
    insertTicket(db, 'DEV-2', { reporter: 'Alice' });
    insertTicket(db, 'DEV-3', { qaAssignee: 'Alice' });
    insertTicket(db, 'DEV-4', { productAssignee: 'Alice' });

    const people = store.getDistinctPeople();
    expect(people.length).toBe(1);
    expect(people[0].roles.sort()).toEqual(['dev', 'pm', 'qa', 'reporter']);
  });
});
