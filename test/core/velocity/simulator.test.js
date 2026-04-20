import { describe, it, expect } from 'vitest';

const Simulator = require('../../../src/core/velocity/simulator');
const { addDay, isWeekend } = Simulator;

/**
 * Helper: build a minimal ticket for simulation queues.
 */
function makeQueueTicket(overrides = {}) {
  return {
    key: 'DEV-1',
    summary: 'Test ticket',
    status: 'In Progress',
    assignee: 'Alice',
    qaAssignee: 'Carol',
    _releaseVersions: ['4.2.1'],
    _urgency: '2026-05-01',
    _stateProximity: 4,
    ...overrides,
  };
}

/**
 * Helper: build person velocities map.
 */
function makeVelocities(entries) {
  const map = new Map();
  for (const [name, dev, qa] of entries) {
    map.set(name, {
      dev: dev > 0 ? { ticketsPerDay: dev, completedInWindow: 10, businessDays: 20, window: { start: '2026-03-21', end: '2026-04-18' }, dataQuality: 'accurate' } : null,
      qa: qa > 0 ? { ticketsPerDay: qa, completedInWindow: 10, businessDays: 20, window: { start: '2026-03-21', end: '2026-04-18' }, dataQuality: 'accurate' } : null,
    });
  }
  return map;
}

/**
 * Helper: build work queues from tickets.
 */
function makeWorkQueues(personQueues, unassigned = []) {
  const people = new Map();
  for (const [name, devQueue, qaQueue] of personQueues) {
    people.set(name, { devQueue, qaQueue });
  }
  return { people, unassigned };
}

describe('Simulator', () => {
  // ── Utility functions ────────────────────────────────

  describe('addDay', () => {
    it('increments by one calendar day', () => {
      expect(addDay('2026-04-18')).toBe('2026-04-19');
    });

    it('handles month boundary', () => {
      expect(addDay('2026-04-30')).toBe('2026-05-01');
    });
  });

  describe('isWeekend', () => {
    it('identifies Saturday as weekend', () => {
      expect(isWeekend('2026-04-18')).toBe(true); // Saturday
    });

    it('identifies Sunday as weekend', () => {
      expect(isWeekend('2026-04-19')).toBe(true); // Sunday
    });

    it('identifies Monday as weekday', () => {
      expect(isWeekend('2026-04-20')).toBe(false); // Monday
    });
  });

  // ── Simulation ────────────────────────────────────────

  describe('simulate', () => {
    it('completes a single ticket with one person', () => {
      // TESTING: Basic simulation — single person, single ticket
      //
      // SETUP:
      // - Alice has 1 ticket in dev queue, velocity 1/day
      // - No QA needed (no qaAssignee)
      // - Start on Monday 2026-04-20
      //
      // EXPECTED RESULT:
      // - Ticket completed on day 1 (2026-04-20)
      // - Release projected on 2026-04-20

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0]]);
      const ticket = makeQueueTicket({ key: 'DEV-1', assignee: 'Alice', qaAssignee: null });
      const workQueues = makeWorkQueues([['Alice', [ticket], []]]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }],
        { now: new Date('2026-04-20T12:00:00Z') }, // Monday
      );

      expect(result.releases.get('4.2.1').projectedDate).toBe('2026-04-20');
      expect(result.simulation.totalDays).toBeGreaterThanOrEqual(1);
    });

    it('projects multiple tickets with correct timeline', () => {
      // TESTING: Multiple tickets take multiple days to complete
      //
      // SETUP:
      // - Alice has 5 tickets, velocity = 1/day
      // - No QA needed
      // - Start Monday 2026-04-20
      //
      // EXPECTED RESULT:
      // - Takes 5 business days: completed by 2026-04-24 (Friday)

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0]]);
      const tickets = [];
      for (let i = 1; i <= 5; i++) {
        tickets.push(makeQueueTicket({ key: `DEV-${i}`, assignee: 'Alice', qaAssignee: null }));
      }
      const workQueues = makeWorkQueues([['Alice', tickets, []]]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.releases.get('4.2.1').projectedDate).toBe('2026-04-24');
    });

    it('simulates parallel work across multiple people', () => {
      // TESTING: Two people working in parallel finish faster
      //
      // SETUP:
      // - Alice has 3 tickets, velocity = 1/day
      // - Bob has 3 tickets, velocity = 1/day
      // - No QA needed
      // - All tickets in the same release
      //
      // EXPECTED RESULT:
      // - Release finishes in 3 days (not 6) because parallel work

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0], ['Bob', 1, 0]]);

      const aliceTickets = [];
      const bobTickets = [];
      for (let i = 1; i <= 3; i++) {
        aliceTickets.push(makeQueueTicket({ key: `DEV-A${i}`, assignee: 'Alice', qaAssignee: null }));
        bobTickets.push(makeQueueTicket({ key: `DEV-B${i}`, assignee: 'Bob', qaAssignee: null }));
      }
      const workQueues = makeWorkQueues([
        ['Alice', aliceTickets, []],
        ['Bob', bobTickets, []],
      ]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.releases.get('4.2.1').projectedDate).toBe('2026-04-22');
    });

    it('skips weekends in simulation', () => {
      // TESTING: Weekends are not working days
      //
      // SETUP:
      // - Start on Thursday 2026-04-16
      // - Alice has 3 tickets, velocity = 1/day
      // - No QA needed
      //
      // EXPECTED RESULT:
      // - Thu: 1 done, Fri: 1 done, (skip Sat/Sun), Mon: 1 done
      // - Projected: 2026-04-20 (Monday)

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0]]);
      const tickets = [];
      for (let i = 1; i <= 3; i++) {
        tickets.push(makeQueueTicket({ key: `DEV-${i}`, assignee: 'Alice', qaAssignee: null }));
      }
      const workQueues = makeWorkQueues([['Alice', tickets, []]]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-16T12:00:00Z') }, // Thursday
      );

      expect(result.releases.get('4.2.1').projectedDate).toBe('2026-04-20');
    });

    it('skips OOO days for a person', () => {
      // TESTING: OOO days mean no work gets done for that person
      //
      // SETUP:
      // - Alice has 2 tickets, velocity = 1/day
      // - Alice is OOO on 2026-04-21 (Tuesday)
      // - Start Monday 2026-04-20
      //
      // EXPECTED RESULT:
      // - Mon: 1 done, Tue: skip (OOO), Wed: 1 done
      // - Projected: 2026-04-22 (Wednesday)

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0]]);
      const tickets = [];
      for (let i = 1; i <= 2; i++) {
        tickets.push(makeQueueTicket({ key: `DEV-${i}`, assignee: 'Alice', qaAssignee: null }));
      }
      const workQueues = makeWorkQueues([['Alice', tickets, []]]);

      // Mock availability
      const availability = {
        isPersonOut: (name, date) => name === 'Alice' && date === '2026-04-21',
      };

      const result = sim.simulate(
        velocities, workQueues, availability,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.releases.get('4.2.1').projectedDate).toBe('2026-04-22');
    });

    it('flows tickets from dev queue to QA queue', () => {
      // TESTING: When dev completes a ticket with qaAssignee, it enters QA queue
      //
      // SETUP:
      // - Alice (dev, 1/day) has 1 ticket with qaAssignee = Carol
      // - Carol (qa, 1/day) has an initially empty QA queue
      // - Start Monday 2026-04-20
      //
      // EXPECTED RESULT:
      // - Day 1: Alice completes dev → ticket enters Carol's dynamic QA queue →
      //   Carol processes QA within the same day (dev happens first, then QA merges arrivals)
      // - Projected: 2026-04-20 (same day since both dev and QA happen within a single sim day)

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0], ['Carol', 0, 1]]);
      const ticket = makeQueueTicket({ key: 'DEV-1', assignee: 'Alice', qaAssignee: 'Carol' });
      const workQueues = makeWorkQueues([
        ['Alice', [ticket], []],
        ['Carol', [], []],
      ]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.releases.get('4.2.1').projectedDate).toBe('2026-04-20');
    });

    it('identifies bottleneck correctly', () => {
      // TESTING: Person with the longest queue / lowest velocity is identified as bottleneck
      //
      // SETUP:
      // - Alice (dev, 2/day) has 4 tickets → 2 days
      // - Bob (dev, 0.5/day) has 4 tickets → 8 days
      // - Both in same release, no QA
      //
      // EXPECTED RESULT:
      // - Bob is the bottleneck (8 days vs 2 days)

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 2, 0], ['Bob', 0.5, 0]]);

      const aliceTickets = [];
      const bobTickets = [];
      for (let i = 1; i <= 4; i++) {
        aliceTickets.push(makeQueueTicket({ key: `DEV-A${i}`, assignee: 'Alice', qaAssignee: null }));
        bobTickets.push(makeQueueTicket({ key: `DEV-B${i}`, assignee: 'Bob', qaAssignee: null }));
      }
      const workQueues = makeWorkQueues([
        ['Alice', aliceTickets, []],
        ['Bob', bobTickets, []],
      ]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      const release = result.releases.get('4.2.1');
      expect(release.bottleneck).toBeTruthy();
      expect(release.bottleneck.person).toBe('Bob');
    });

    it('handles multiple releases with shared tickets', () => {
      // TESTING: A ticket in two releases counts as done for both when completed
      //
      // SETUP:
      // - DEV-1 is in both 4.2.0 and 4.3.0 releases
      // - Alice velocity = 1/day
      //
      // EXPECTED RESULT:
      // - Both releases project completion on the same day

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0]]);
      const ticket = makeQueueTicket({
        key: 'DEV-1',
        assignee: 'Alice',
        qaAssignee: null,
        _releaseVersions: ['4.2.0', '4.3.0'],
      });
      const workQueues = makeWorkQueues([['Alice', [ticket], []]]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [
          { version: '4.2.0', jiraReleaseDate: '2026-05-01' },
          { version: '4.3.0', jiraReleaseDate: '2026-06-01' },
        ],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.releases.get('4.2.0').projectedDate).toBe('2026-04-20');
      expect(result.releases.get('4.3.0').projectedDate).toBe('2026-04-20');
    });

    it('caps simulation at 90 business days to prevent infinite loop', () => {
      // TESTING: Simulation stops after 90 day iterations
      //
      // SETUP:
      // - Alice has 1 ticket but velocity = 0 (never completes)
      //
      // EXPECTED RESULT:
      // - Simulation ends, projectedDate is null (release not projected)
      // - totalDays capped

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 0, 0]]);
      const ticket = makeQueueTicket({ key: 'DEV-1', assignee: 'Alice', qaAssignee: null });
      const workQueues = makeWorkQueues([['Alice', [ticket], []]]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.releases.get('4.2.1').projectedDate).toBeNull();
      // Should have stopped (totalDays reflects business days simulated)
      expect(result.simulation.totalDays).toBeLessThanOrEqual(90);
    });

    it('computes daysLate correctly when projected after deadline', () => {
      // TESTING: daysLate is positive when projected date is after deadline
      //
      // SETUP:
      // - Release date: 2026-04-23 → deadline: 2026-04-21
      // - Alice has 5 tickets, velocity = 1/day → finishes in 5 days
      // - Start Monday 2026-04-20 → finishes 2026-04-24
      // - daysLate = 2026-04-24 - 2026-04-21 = 3 days
      //
      // EXPECTED RESULT: daysLate = 3

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0]]);
      const tickets = [];
      for (let i = 1; i <= 5; i++) {
        tickets.push(makeQueueTicket({ key: `DEV-${i}`, assignee: 'Alice', qaAssignee: null }));
      }
      const workQueues = makeWorkQueues([['Alice', tickets, []]]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-04-23' }],
        { now: new Date('2026-04-20T12:00:00Z'), bufferDays: 2 },
      );

      const release = result.releases.get('4.2.1');
      expect(release.projectedDate).toBe('2026-04-24');
      expect(release.deadlineDate).toBe('2026-04-21');
      expect(release.daysLate).toBe(3);
    });

    it('returns global velocity totals', () => {
      // TESTING: globalVelocity sums across all people
      //
      // SETUP:
      // - Alice: dev velocity 2/day
      // - Bob: dev velocity 1.5/day, qa velocity 3/day
      //
      // EXPECTED RESULT:
      // - dev = 2 + 1.5 = 3.5
      // - qa = 0 + 3 = 3

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 2, 0], ['Bob', 1.5, 3]]);
      const workQueues = makeWorkQueues([
        ['Alice', [], []],
        ['Bob', [], []],
      ]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.globalVelocity.dev).toBe(3.5);
      expect(result.globalVelocity.qa).toBe(3);
    });

    it('handles QA ticket where dev is not done yet — skips gracefully', () => {
      // TESTING: QA worker cannot complete a ticket if dev is not done
      //
      // SETUP:
      // - Carol has a ticket in her QA queue (In Progress status = dev not done)
      // - The ticket's status does not indicate devDone = true
      //
      // EXPECTED RESULT:
      // - Ticket stays in QA queue, not completed on first pass

      const sim = new Simulator();
      const velocities = makeVelocities([['Carol', 0, 1]]);
      const ticket = makeQueueTicket({
        key: 'DEV-1',
        assignee: 'Alice',
        qaAssignee: 'Carol',
        status: 'In Progress', // dev not done
      });
      const workQueues = makeWorkQueues([
        ['Carol', [], [ticket]],
      ]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      // The ticket never completes via simulation, but the fallback projects based on velocity
      // The projected date should exist (from the velocity-based fallback)
      expect(result.releases.get('4.2.1').remaining).toBe(1);
    });

    it('handles empty releases gracefully', () => {
      // TESTING: No tickets in release → immediate completion
      //
      // SETUP:
      // - Release with no tickets
      //
      // EXPECTED RESULT:
      // - Release projects immediately (no work to do)

      const sim = new Simulator();
      const velocities = new Map();
      const workQueues = makeWorkQueues([]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      // With no tickets, the release has 0 remaining and should project immediately
      const release = result.releases.get('4.2.1');
      // The tickets set is empty, so remaining = 0, projected on first day
      expect(release.remaining).toBe(0);
    });

    it('records day-by-day simulation log', () => {
      // TESTING: Simulation log records daily progress
      //
      // SETUP:
      // - Alice has 2 tickets, velocity = 1/day
      //
      // EXPECTED RESULT:
      // - Day log has entries with date, completedToday, remainingByRelease

      const sim = new Simulator();
      const velocities = makeVelocities([['Alice', 1, 0]]);
      const tickets = [
        makeQueueTicket({ key: 'DEV-1', assignee: 'Alice', qaAssignee: null }),
        makeQueueTicket({ key: 'DEV-2', assignee: 'Alice', qaAssignee: null }),
      ];
      const workQueues = makeWorkQueues([['Alice', tickets, []]]);

      const result = sim.simulate(
        velocities, workQueues, null,
        [{ version: '4.2.1', jiraReleaseDate: '2026-06-01' }],
        { now: new Date('2026-04-20T12:00:00Z') },
      );

      expect(result.simulation.days.length).toBeGreaterThanOrEqual(2);
      expect(result.simulation.days[0]).toHaveProperty('date');
      expect(result.simulation.days[0]).toHaveProperty('completedToday');
      expect(result.simulation.days[0]).toHaveProperty('remainingByRelease');
    });
  });
});
