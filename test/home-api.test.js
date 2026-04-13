import { describe, it, expect } from 'vitest';

describe('Home API — release filtering logic', () => {
  const TODAY = '2026-04-13';
  const TWO_WEEKS = '2026-04-27';

  function makeRelease(version, opts = {}) {
    return {
      version,
      repo: opts.repo || 'webplatform',
      state: opts.state || 'stabilizing',
      jiraArchived: opts.jiraArchived || false,
      jiraReleaseDate: opts.jiraReleaseDate || null,
      tickets: opts.tickets || [],
      zohoTickets: opts.zohoTickets || [],
    };
  }

  function filterHomeReleases(releases) {
    return releases
      .filter(r => r.state !== 'done' && !r.jiraArchived)
      .filter(r => {
        if (!r.jiraReleaseDate) return true;
        if (r.jiraReleaseDate < TODAY) return true;
        if (r.jiraReleaseDate <= TWO_WEEKS) return true;
        return false;
      });
  }

  it('includes overdue releases', () => {
    const releases = [
      makeRelease('4.2.0', { jiraReleaseDate: '2026-04-10' }), // overdue
    ];
    expect(filterHomeReleases(releases)).toHaveLength(1);
  });

  it('includes upcoming releases within 2 weeks', () => {
    const releases = [
      makeRelease('4.3.0', { jiraReleaseDate: '2026-04-20' }), // upcoming
    ];
    expect(filterHomeReleases(releases)).toHaveLength(1);
  });

  it('excludes releases more than 2 weeks out', () => {
    const releases = [
      makeRelease('4.4.0', { jiraReleaseDate: '2026-05-15' }), // too far
    ];
    expect(filterHomeReleases(releases)).toHaveLength(0);
  });

  it('includes unscheduled active releases', () => {
    const releases = [
      makeRelease('4.3.0', { jiraReleaseDate: null }), // no date
    ];
    expect(filterHomeReleases(releases)).toHaveLength(1);
  });

  it('excludes done releases', () => {
    const releases = [
      makeRelease('4.1.0', { state: 'done', jiraReleaseDate: '2026-04-10' }),
    ];
    expect(filterHomeReleases(releases)).toHaveLength(0);
  });

  it('excludes archived releases', () => {
    const releases = [
      makeRelease('4.0.0', { jiraArchived: true, jiraReleaseDate: '2026-04-10' }),
    ];
    expect(filterHomeReleases(releases)).toHaveLength(0);
  });

  it('handles mixed set correctly', () => {
    const releases = [
      makeRelease('4.0.0', { state: 'done' }),                              // excluded: done
      makeRelease('4.1.0', { jiraArchived: true }),                          // excluded: archived
      makeRelease('4.2.0', { jiraReleaseDate: '2026-04-10' }),               // included: overdue
      makeRelease('4.3.0', { jiraReleaseDate: '2026-04-20' }),               // included: upcoming
      makeRelease('4.4.0', { jiraReleaseDate: '2026-05-15' }),               // excluded: too far
      makeRelease('4.5.0', {}),                                               // included: unscheduled
    ];
    const result = filterHomeReleases(releases);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.version).sort()).toEqual(['4.2.0', '4.3.0', '4.5.0']);
  });

  it('includes all repos as separate releases', () => {
    const releases = [
      makeRelease('4.2.1', { repo: 'webplatform', jiraReleaseDate: '2026-04-20' }),
      makeRelease('4.2.1', { repo: 'bluesummit', jiraReleaseDate: '2026-04-20' }),
      makeRelease('2026.4.0', { repo: 'android', jiraReleaseDate: '2026-04-20' }),
      makeRelease('2026.4.0', { repo: 'ios', jiraReleaseDate: '2026-04-20' }),
    ];
    const result = filterHomeReleases(releases);
    expect(result).toHaveLength(4);
  });
});

describe('Home API — empty release hiding', () => {
  function filterEmptyReleases(releases, view, person) {
    if (person && view && (view === 'dev' || view === 'qa')) {
      return releases.filter(r => r.ticketCount > 0);
    }
    return releases;
  }

  it('hides releases with 0 matching tickets in dev view with person selected', () => {
    const releases = [
      { version: '4.1.1', ticketCount: 0, totalTicketCount: 10 },
      { version: '4.2.1', ticketCount: 5, totalTicketCount: 78 },
    ];
    const result = filterEmptyReleases(releases, 'dev', 'Max Collie');
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe('4.2.1');
  });

  it('hides releases with 0 matching tickets in qa view with person selected', () => {
    const releases = [
      { version: '4.1.1', ticketCount: 0, totalTicketCount: 5 },
      { version: '4.2.0', ticketCount: 3, totalTicketCount: 20 },
    ];
    const result = filterEmptyReleases(releases, 'qa', 'Prateek');
    expect(result).toHaveLength(1);
  });

  it('keeps empty releases in pm view (shows everything)', () => {
    const releases = [
      { version: '4.1.1', ticketCount: 0, totalTicketCount: 10 },
      { version: '4.2.1', ticketCount: 5, totalTicketCount: 78 },
    ];
    const result = filterEmptyReleases(releases, 'pm', 'Anyone');
    expect(result).toHaveLength(2);
  });

  it('keeps all releases when no person is selected', () => {
    const releases = [
      { version: '4.1.1', ticketCount: 0, totalTicketCount: 10 },
      { version: '4.2.1', ticketCount: 5, totalTicketCount: 78 },
    ];
    const result = filterEmptyReleases(releases, 'dev', null);
    expect(result).toHaveLength(2);
  });
});

describe('Home API — ticket filtering by view/person', () => {
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
    { key: 'DEV-100', assignee: 'Alice', qaAssignee: 'Bob', reporter: 'Charlie', productAssignee: 'Diana' },
    { key: 'DEV-101', assignee: 'Bob', qaAssignee: 'Alice', reporter: 'Alice', productAssignee: null },
    { key: 'DEV-102', assignee: 'Alice', qaAssignee: 'Charlie', reporter: 'Bob', productAssignee: 'Diana' },
  ];

  it('dev view: filters by assignee', () => {
    const result = filterTickets(tickets, 'dev', 'Alice');
    expect(result.map(t => t.key)).toEqual(['DEV-100', 'DEV-102']);
  });

  it('qa view: filters by qaAssignee', () => {
    const result = filterTickets(tickets, 'qa', 'Alice');
    expect(result.map(t => t.key)).toEqual(['DEV-101']);
  });

  it('pm view: returns ALL tickets regardless of person', () => {
    const result = filterTickets(tickets, 'pm', 'Alice');
    expect(result).toHaveLength(3);
  });

  it('support view: returns all tickets', () => {
    const result = filterTickets(tickets, 'support', 'Alice');
    expect(result).toHaveLength(3);
  });

  it('cs view: returns all tickets', () => {
    const result = filterTickets(tickets, 'cs', 'Alice');
    expect(result).toHaveLength(3);
  });

  it('no person selected: returns all', () => {
    const result = filterTickets(tickets, 'dev', null);
    expect(result).toHaveLength(3);
  });

  it('person with no matching tickets: returns empty', () => {
    const result = filterTickets(tickets, 'dev', 'Zara');
    expect(result).toHaveLength(0);
  });

  it('case insensitive person matching', () => {
    const result = filterTickets(tickets, 'dev', 'alice');
    expect(result).toHaveLength(2);
  });
});

describe('Home API — release sorting', () => {
  function sortHomeReleases(releases) {
    return [...releases].sort((a, b) => {
      const aDate = a.jiraReleaseDate || 'zzzz';
      const bDate = b.jiraReleaseDate || 'zzzz';
      return aDate.localeCompare(bDate);
    });
  }

  it('sorts overdue before upcoming', () => {
    const releases = [
      { version: '4.3.0', jiraReleaseDate: '2026-04-20' },
      { version: '4.2.0', jiraReleaseDate: '2026-04-10' },
    ];
    const sorted = sortHomeReleases(releases);
    expect(sorted[0].version).toBe('4.2.0');
    expect(sorted[1].version).toBe('4.3.0');
  });

  it('puts unscheduled last', () => {
    const releases = [
      { version: '4.5.0', jiraReleaseDate: null },
      { version: '4.2.0', jiraReleaseDate: '2026-04-10' },
    ];
    const sorted = sortHomeReleases(releases);
    expect(sorted[0].version).toBe('4.2.0');
    expect(sorted[1].version).toBe('4.5.0');
  });
});

describe('View configuration', () => {
  const VIEW_CONFIG = {
    dev:     { personField: 'assignee' },
    qa:      { personField: 'qaAssignee' },
    pm:      { personField: null },
    support: { personField: null },
    cs:      { personField: null },
  };

  it('dev view uses assignee', () => {
    expect(VIEW_CONFIG.dev.personField).toBe('assignee');
  });

  it('qa view uses qaAssignee', () => {
    expect(VIEW_CONFIG.qa.personField).toBe('qaAssignee');
  });

  it('pm view has no person filter', () => {
    expect(VIEW_CONFIG.pm.personField).toBeNull();
  });

  it('support view has no person filter', () => {
    expect(VIEW_CONFIG.support.personField).toBeNull();
  });

  it('cs view has no person filter', () => {
    expect(VIEW_CONFIG.cs.personField).toBeNull();
  });
});
