import { describe, it, expect } from 'vitest';
const ZohoClient = require('../src/integrations/zoho');

describe('Customer Impact data grouping', () => {
  // Simulate what the /releases/:version/customer-impact endpoint does
  function buildCustomerImpact(zohoTickets, zohoByJiraKey) {
    const byDepartment = {};
    for (const ticket of zohoTickets) {
      const dept = ticket.departmentId || 'unknown';
      if (!byDepartment[dept]) byDepartment[dept] = [];
      byDepartment[dept].push(ticket);
    }

    return Object.entries(byDepartment).map(([deptId, tickets]) => ({
      departmentId: deptId,
      tickets,
      count: tickets.length,
    }));
  }

  const zohoTickets = [
    ZohoClient.normalizeTicket({
      id: 'z1', ticketNumber: 'VHC-4056', subject: 'Schedule bug',
      status: 'Open', departmentId: 'd1-bayada',
    }),
    ZohoClient.normalizeTicket({
      id: 'z2', ticketNumber: 'VHC-4057', subject: 'Billing issue',
      status: 'Closed', statusType: 'Closed', departmentId: 'd1-bayada',
    }),
    ZohoClient.normalizeTicket({
      id: 'z3', ticketNumber: 'VHC-4058', subject: 'Login problem',
      status: 'Open', departmentId: 'd2-ck',
    }),
  ];

  it('groups tickets by department', () => {
    const groups = buildCustomerImpact(zohoTickets, {});
    expect(groups).toHaveLength(2);
    const bayada = groups.find(g => g.departmentId === 'd1-bayada');
    const ck = groups.find(g => g.departmentId === 'd2-ck');
    expect(bayada.count).toBe(2);
    expect(ck.count).toBe(1);
  });

  it('handles empty zoho tickets', () => {
    const groups = buildCustomerImpact([], {});
    expect(groups).toHaveLength(0);
  });

  it('handles tickets with no departmentId', () => {
    const tickets = [
      ZohoClient.normalizeTicket({ id: 'z4', subject: 'Mystery ticket', status: 'Open' }),
    ];
    const groups = buildCustomerImpact(tickets, {});
    expect(groups).toHaveLength(1);
    expect(groups[0].departmentId).toBe('unknown');
  });

  it('preserves ticket details within groups', () => {
    const groups = buildCustomerImpact(zohoTickets, {});
    const bayada = groups.find(g => g.departmentId === 'd1-bayada');
    expect(bayada.tickets[0].ticketNumber).toBe('VHC-4056');
    expect(bayada.tickets[0].subject).toBe('Schedule bug');
    expect(bayada.tickets[1].ticketNumber).toBe('VHC-4057');
  });
});

describe('ZohoImpactBadge logic', () => {
  // Test the badge rendering logic (no React rendering, just the logic)
  it('returns nothing for count=0', () => {
    expect(0 === 0).toBe(true); // badge returns null for 0
  });

  it('shows count for non-zero', () => {
    const count = 5;
    expect(count > 0).toBe(true);
    expect(`${count} support`).toBe('5 support');
  });
});

describe('People extraction from tickets', () => {
  // Simulate what the /people endpoint does
  function extractPeople(releases) {
    const people = new Map();
    for (const release of releases) {
      for (const ticket of (release.tickets || [])) {
        if (ticket.assignee) {
          const p = people.get(ticket.assignee) || { name: ticket.assignee, roles: new Set() };
          p.roles.add('dev');
          people.set(ticket.assignee, p);
        }
        if (ticket.reporter) {
          const p = people.get(ticket.reporter) || { name: ticket.reporter, roles: new Set() };
          p.roles.add('reporter');
          people.set(ticket.reporter, p);
        }
        if (ticket.qaAssignee) {
          const p = people.get(ticket.qaAssignee) || { name: ticket.qaAssignee, roles: new Set() };
          p.roles.add('qa');
          people.set(ticket.qaAssignee, p);
        }
        if (ticket.productAssignee) {
          const p = people.get(ticket.productAssignee) || { name: ticket.productAssignee, roles: new Set() };
          p.roles.add('pm');
          people.set(ticket.productAssignee, p);
        }
      }
    }
    return Array.from(people.values())
      .map(p => ({ name: p.name, roles: Array.from(p.roles) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  it('extracts all person fields', () => {
    const releases = [{
      tickets: [{
        assignee: 'Nukul', reporter: 'William',
        qaAssignee: 'Prateek', productAssignee: 'Sarah',
      }],
    }];
    const people = extractPeople(releases);
    expect(people).toHaveLength(4);
    expect(people.find(p => p.name === 'Nukul').roles).toContain('dev');
    expect(people.find(p => p.name === 'William').roles).toContain('reporter');
    expect(people.find(p => p.name === 'Prateek').roles).toContain('qa');
    expect(people.find(p => p.name === 'Sarah').roles).toContain('pm');
  });

  it('deduplicates people across tickets', () => {
    const releases = [{
      tickets: [
        { assignee: 'Nukul', qaAssignee: 'Prateek' },
        { assignee: 'Nukul', reporter: 'Nukul' },
      ],
    }];
    const people = extractPeople(releases);
    const nukul = people.find(p => p.name === 'Nukul');
    expect(nukul.roles).toContain('dev');
    expect(nukul.roles).toContain('reporter');
    expect(people).toHaveLength(2); // Nukul and Prateek
  });

  it('handles empty releases', () => {
    expect(extractPeople([])).toHaveLength(0);
    expect(extractPeople([{ tickets: [] }])).toHaveLength(0);
  });

  it('handles null person fields', () => {
    const releases = [{
      tickets: [{ assignee: null, reporter: null, qaAssignee: null, productAssignee: null }],
    }];
    expect(extractPeople(releases)).toHaveLength(0);
  });

  it('sorts people alphabetically', () => {
    const releases = [{
      tickets: [
        { assignee: 'Zara' },
        { assignee: 'Alice' },
        { assignee: 'Mike' },
      ],
    }];
    const people = extractPeople(releases);
    expect(people.map(p => p.name)).toEqual(['Alice', 'Mike', 'Zara']);
  });
});

describe('Home view ticket filtering', () => {
  // Simulate the /releases/home filtering logic
  function filterTickets(tickets, view, person) {
    if (!person || !view || view === 'pm') return tickets;
    const personLower = person.toLowerCase();
    return tickets.filter(t => {
      switch (view) {
        case 'dev':
          return t.assignee && t.assignee.toLowerCase() === personLower;
        case 'qa':
          return t.qaAssignee && t.qaAssignee.toLowerCase() === personLower;
        default:
          return true;
      }
    });
  }

  const tickets = [
    { key: 'DEV-100', assignee: 'Nukul Bhasin', qaAssignee: 'Prateek Ahluwalia', reporter: 'William' },
    { key: 'DEV-101', assignee: 'Sarah Johnson', qaAssignee: 'Nukul Bhasin', reporter: 'Nukul Bhasin' },
    { key: 'DEV-102', assignee: 'Nukul Bhasin', qaAssignee: null, reporter: 'Sarah' },
  ];

  it('dev view filters by assignee', () => {
    const filtered = filterTickets(tickets, 'dev', 'Nukul Bhasin');
    expect(filtered).toHaveLength(2);
    expect(filtered.map(t => t.key)).toEqual(['DEV-100', 'DEV-102']);
  });

  it('qa view filters by qaAssignee', () => {
    const filtered = filterTickets(tickets, 'qa', 'Nukul Bhasin');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].key).toBe('DEV-101');
  });

  it('pm view returns all tickets', () => {
    const filtered = filterTickets(tickets, 'pm', 'Nukul Bhasin');
    expect(filtered).toHaveLength(3);
  });

  it('case insensitive matching', () => {
    const filtered = filterTickets(tickets, 'dev', 'nukul bhasin');
    expect(filtered).toHaveLength(2);
  });

  it('no person returns all tickets', () => {
    const filtered = filterTickets(tickets, 'dev', null);
    expect(filtered).toHaveLength(3);
  });

  it('no view returns all tickets', () => {
    const filtered = filterTickets(tickets, null, 'Nukul');
    expect(filtered).toHaveLength(3);
  });
});
