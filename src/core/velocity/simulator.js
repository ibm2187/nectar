/**
 * Day-by-day forward simulation engine.
 *
 * Takes person velocities and work queues, simulates work completion
 * day by day, and projects when each release will be done.
 */

const MAX_SIMULATION_DAYS = 90;

/**
 * Add one calendar day to an ISO date string.
 * @param {string} isoDate - YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
function addDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Check if an ISO date falls on a weekend (Saturday or Sunday).
 * @param {string} isoDate - YYYY-MM-DD
 * @returns {boolean}
 */
function isWeekend(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Status groups for breakdown counting.
 */
const BLOCKED_STATUSES = new Set(['Blocked', 'Testing Failed', 'Test Failed', 'Pending Bug Fix']);
const READY_FOR_QA_STATUSES = new Set(['Ready For Testing', 'Cherry Picked', 'Cherrypick is Building', 'Retest After Cherrypick', 'DQA Required']);
const IN_QA_STATUSES = new Set(['In Testing', 'Testing in Branch', 'Testing', 'Re-verify Bug', 'Validating', 'Pending Customer QA/UAT']);
const NOT_STARTED_STATUSES = new Set([
  'Open', 'To Do', 'Backlog', 'Planning', 'Requirements',
  'Needs Requirements', 'Ready to Develop', 'Ready For Estimation', 'Pending',
]);
const CP_STATUSES = new Set(['Cherry Picked', 'Cherrypick is Building', 'Retest After Cherrypick']);

class Simulator {
  /**
   * Run simulation.
   *
   * @param {Map<string, { dev: object|null, qa: object|null }>} personVelocities - from PersonVelocity.computeAll()
   * @param {{ people: Map<string, { devQueue: object[], qaQueue: object[] }>, unassigned: object[] }} workQueues - from WorkloadBuilder
   * @param {object|null} availability - Availability instance with isPersonOut(name, date)
   * @param {Array<{ version: string, jiraReleaseDate?: string }>} releases
   * @param {object} [opts]
   * @param {Date}   [opts.now]        - Override current date
   * @param {number} [opts.bufferDays] - Days before release date for deadline (default 2)
   * @returns {object} SimulationResult
   */
  simulate(personVelocities, workQueues, availability, releases, opts = {}) {
    const bufferDays = opts.bufferDays != null ? opts.bufferDays : 2;
    const now = opts.now || new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Build release tracking
    const releaseMap = new Map();
    for (const rel of releases) {
      let deadlineDate = null;
      if (rel.jiraReleaseDate) {
        const rd = new Date(rel.jiraReleaseDate + 'T00:00:00Z');
        rd.setUTCDate(rd.getUTCDate() - bufferDays);
        deadlineDate = rd.toISOString().slice(0, 10);
      }
      releaseMap.set(rel.version, {
        version: rel.version,
        deadlineDate,
        releaseDate: rel.jiraReleaseDate || null,
        projectedDate: null,
        tickets: new Set(),   // ticket keys in this release
      });
    }

    // Build the global simulated tickets map
    // Each ticket tracks: devDone, qaDone, done, releases it belongs to
    const simulatedTickets = new Map();

    // Deep-copy each person's queues (we'll mutate them during simulation)
    const simQueues = new Map(); // name → { devQueue: [...], qaQueue: [...] }
    const dynamicQaQueues = new Map(); // name → tickets pushed into QA during sim

    for (const [name, queues] of workQueues.people) {
      const devQ = queues.devQueue.map(t => ({ ...t }));
      const qaQ = queues.qaQueue.map(t => ({ ...t }));
      simQueues.set(name, { devQueue: devQ, qaQueue: qaQ });
      dynamicQaQueues.set(name, []);

      // Register tickets in the simulation
      for (const t of [...devQ, ...qaQ]) {
        if (!simulatedTickets.has(t.key)) {
          const needsQa = !!t.qaAssignee;
          // If ticket is already in QA states, dev is already done
          const devAlreadyDone = READY_FOR_QA_STATUSES.has(t.status) || IN_QA_STATUSES.has(t.status);
          simulatedTickets.set(t.key, {
            key: t.key,
            devDone: devAlreadyDone,
            qaDone: false,
            done: false,
            needsQa,
            qaAssignee: t.qaAssignee,
            releases: t._releaseVersions || [],
            status: t.status,
          });
        }
        // Register ticket in its releases
        const sim = simulatedTickets.get(t.key);
        for (const v of (t._releaseVersions || [])) {
          if (releaseMap.has(v)) {
            releaseMap.get(v).tickets.add(t.key);
          }
        }
      }
    }

    // Build team averages for fallback velocity
    const teamAvgDev = this._computeTeamAverage(personVelocities, 'dev');
    const teamAvgQa = this._computeTeamAverage(personVelocities, 'qa');

    // Compute initial breakdown per release
    const initialBreakdowns = new Map();
    for (const [version, relInfo] of releaseMap) {
      initialBreakdowns.set(version, this._computeBreakdown(relInfo.tickets, simulatedTickets, workQueues));
    }

    // Day-by-day simulation
    const dayLog = [];
    let currentDate = todayStr;
    let simulationDays = 0;

    for (let day = 0; day < MAX_SIMULATION_DAYS; day++) {
      // Skip weekends
      if (isWeekend(currentDate)) {
        currentDate = addDay(currentDate);
        continue;
      }

      simulationDays++;
      let completedToday = 0;

      for (const [name, queues] of simQueues) {
        // Check OOO
        if (availability && typeof availability.isPersonOut === 'function') {
          if (availability.isPersonOut(name, currentDate)) continue;
        }

        // Get person's velocity
        const vel = personVelocities.get(name);
        const devVelocity = vel?.dev?.ticketsPerDay || teamAvgDev;
        const qaVelocity = vel?.qa?.ticketsPerDay || teamAvgQa;

        // Dev work — use fractional accumulation to prevent sub-1.0 velocity
        // from being inflated to 1 ticket/day
        if (!queues._devAccumulator) queues._devAccumulator = 0;
        queues._devAccumulator += devVelocity;
        let devCapacity = Math.floor(queues._devAccumulator);
        queues._devAccumulator -= devCapacity;
        let devDone = 0;
        while (devDone < devCapacity && queues.devQueue.length > 0) {
          const ticket = queues.devQueue[0];
          const sim = simulatedTickets.get(ticket.key);
          if (!sim || sim.done || sim.devDone) {
            queues.devQueue.shift();
            continue;
          }
          queues.devQueue.shift();
          sim.devDone = true;
          devDone++;

          // If ticket needs QA, push to QA assignee's queue
          if (sim.needsQa && sim.qaAssignee) {
            if (!simQueues.has(sim.qaAssignee)) {
              simQueues.set(sim.qaAssignee, { devQueue: [], qaQueue: [] });
              dynamicQaQueues.set(sim.qaAssignee, []);
            }
            dynamicQaQueues.get(sim.qaAssignee).push(ticket);
          } else {
            // No QA needed — ticket is fully done
            sim.qaDone = true;
            sim.done = true;
            completedToday++;
          }
        }

        // Merge dynamic QA arrivals into the QA queue
        const dynamicQa = dynamicQaQueues.get(name) || [];
        if (dynamicQa.length > 0) {
          queues.qaQueue.push(...dynamicQa);
          dynamicQa.length = 0;
        }

        // QA work — fractional accumulation same as dev
        if (!queues._qaAccumulator) queues._qaAccumulator = 0;
        queues._qaAccumulator += qaVelocity;
        let qaCapacity = Math.floor(queues._qaAccumulator);
        queues._qaAccumulator -= qaCapacity;
        let qaDone = 0;
        const skipped = [];
        while (qaDone < qaCapacity && queues.qaQueue.length > 0) {
          const ticket = queues.qaQueue.shift();
          const sim = simulatedTickets.get(ticket.key);
          if (!sim || sim.done || sim.qaDone) continue;
          if (!sim.devDone) {
            // Dev not done yet — skip, re-add to end of queue
            skipped.push(ticket);
            continue;
          }
          sim.qaDone = true;
          sim.done = true;
          qaDone++;
          completedToday++;
        }
        // Put skipped tickets back
        if (skipped.length > 0) {
          queues.qaQueue.push(...skipped);
        }
      }

      // Check release completion
      const remainingByRelease = {};
      for (const [version, relInfo] of releaseMap) {
        let remaining = 0;
        for (const key of relInfo.tickets) {
          const sim = simulatedTickets.get(key);
          if (!sim || !sim.done) remaining++;
        }
        remainingByRelease[version] = remaining;
        if (remaining === 0 && !relInfo.projectedDate) {
          relInfo.projectedDate = currentDate;
        }
      }

      dayLog.push({
        date: currentDate,
        completedToday,
        remainingByRelease: { ...remainingByRelease },
      });

      // Check if all releases are projected
      let allProjected = true;
      for (const relInfo of releaseMap.values()) {
        if (!relInfo.projectedDate) { allProjected = false; break; }
      }
      if (allProjected && releaseMap.size > 0) break;

      currentDate = addDay(currentDate);
    }

    // Compute global velocity before building results (needed for fallback projections)
    let totalDevVelocity = 0;
    let totalQaVelocity = 0;
    for (const vel of personVelocities.values()) {
      if (vel.dev) totalDevVelocity += vel.dev.ticketsPerDay;
      if (vel.qa) totalQaVelocity += vel.qa.ticketsPerDay;
    }
    const globalVel = {
      dev: Math.round(totalDevVelocity * 100) / 100,
      qa: Math.round(totalQaVelocity * 100) / 100,
    };

    // Build results
    return this._buildResults(
      releaseMap, simulatedTickets, personVelocities, workQueues,
      initialBreakdowns, teamAvgDev, teamAvgQa, dayLog, simulationDays, todayStr, globalVel,
    );
  }

  /**
   * Compute team average velocity for a role.
   * @param {Map} personVelocities
   * @param {'dev'|'qa'} role
   * @returns {number} average ticketsPerDay (0 if no data)
   */
  _computeTeamAverage(personVelocities, role) {
    let sum = 0;
    let count = 0;
    for (const vel of personVelocities.values()) {
      const rv = vel[role];
      if (rv && rv.ticketsPerDay > 0) {
        sum += rv.ticketsPerDay;
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  /**
   * Compute initial breakdown for a release's tickets.
   */
  _computeBreakdown(ticketKeys, simulatedTickets, workQueues) {
    const breakdown = { notStarted: 0, inDev: 0, blocked: 0, readyForQa: 0, inQa: 0, awaitingCp: 0 };

    for (const key of ticketKeys) {
      const sim = simulatedTickets.get(key);
      if (sim && sim.done) continue;

      if (!sim) {
        // Ticket not in any queue — count as not started
        breakdown.notStarted++;
        continue;
      }

      const status = sim.status;
      if (BLOCKED_STATUSES.has(status)) {
        breakdown.blocked++;
      } else if (CP_STATUSES.has(status)) {
        breakdown.awaitingCp++;
      } else if (READY_FOR_QA_STATUSES.has(status)) {
        breakdown.readyForQa++;
      } else if (IN_QA_STATUSES.has(status)) {
        breakdown.inQa++;
      } else if (NOT_STARTED_STATUSES.has(status)) {
        breakdown.notStarted++;
      } else {
        breakdown.inDev++;
      }
    }

    return breakdown;
  }

  /**
   * Build the final SimulationResult from simulation state.
   */
  _buildResults(releaseMap, simulatedTickets, personVelocities, workQueues, initialBreakdowns, teamAvgDev, teamAvgQa, dayLog, simulationDays, todayStr, globalVel) {
    // Release results
    const releaseResults = new Map();
    for (const [version, relInfo] of releaseMap) {
      const totalTickets = relInfo.tickets.size;
      let remaining = 0;
      const doneKeys = new Set();
      for (const key of relInfo.tickets) {
        const sim = simulatedTickets.get(key);
        if (!sim) {
          // Ticket not in any person's queue (e.g., unassigned or status not in queues)
          // Still counts as remaining work
          remaining++;
        } else if (!sim.done) {
          remaining++;
        } else {
          doneKeys.add(key);
        }
      }

      // If simulation didn't project (unqueued tickets prevented completion),
      // fall back to remaining / global velocity
      let projectedDate = relInfo.projectedDate;
      if (!projectedDate && relInfo.tickets.size > 0) {
        const totalVelocity = (globalVel.dev + globalVel.qa) / 2; // conservative estimate
        if (totalVelocity > 0) {
          const daysNeeded = Math.ceil(relInfo.tickets.size / totalVelocity);
          projectedDate = this._addBusinessDays(todayStr, daysNeeded);
        }
      }

      let daysLate = 0;
      if (projectedDate && relInfo.deadlineDate) {
        const proj = new Date(projectedDate + 'T00:00:00Z');
        const dead = new Date(relInfo.deadlineDate + 'T00:00:00Z');
        daysLate = Math.round((proj - dead) / (1000 * 60 * 60 * 24));
      }

      releaseResults.set(version, {
        remaining: relInfo.tickets.size,  // total not-done at start
        projectedDate,
        deadlineDate: relInfo.deadlineDate,
        daysLate,
        bottleneck: this._findBottleneck(relInfo, personVelocities, workQueues, teamAvgDev, teamAvgQa),
        breakdown: initialBreakdowns.get(version) || { notStarted: 0, inDev: 0, blocked: 0, readyForQa: 0, inQa: 0, awaitingCp: 0 },
      });
    }

    // Person results
    const personResults = new Map();
    const bottleneckVersions = new Map(); // person → [versions they bottleneck]

    // Determine who is the bottleneck for each release
    for (const [version, relResult] of releaseResults) {
      if (relResult.bottleneck?.person) {
        const bn = relResult.bottleneck.person;
        if (!bottleneckVersions.has(bn)) bottleneckVersions.set(bn, []);
        bottleneckVersions.get(bn).push(version);
      }
    }

    for (const [name, queues] of workQueues.people) {
      const vel = personVelocities.get(name);
      const devVelocity = vel?.dev?.ticketsPerDay || teamAvgDev;
      const qaVelocity = vel?.qa?.ticketsPerDay || teamAvgQa;
      const devQueueSize = queues.devQueue.length;
      const qaQueueSize = queues.qaQueue.length;

      // Projected clear date = max of dev and QA clear
      let projectedClearDays = 0;
      if (devVelocity > 0 && devQueueSize > 0) {
        projectedClearDays = Math.max(projectedClearDays, devQueueSize / devVelocity);
      }
      if (qaVelocity > 0 && qaQueueSize > 0) {
        projectedClearDays = Math.max(projectedClearDays, qaQueueSize / qaVelocity);
      }

      // Convert to business days from today
      let projectedClearDate = null;
      if (projectedClearDays > 0) {
        projectedClearDate = this._addBusinessDays(
          todayStr,
          Math.ceil(projectedClearDays),
        );
      }

      const isBottleneck = bottleneckVersions.has(name);

      personResults.set(name, {
        devQueue: devQueueSize,
        qaQueue: qaQueueSize,
        velocity: {
          dev: devVelocity,
          qa: qaVelocity,
        },
        projectedClearDate,
        isBottleneck,
        bottleneckFor: bottleneckVersions.get(name) || [],
      });
    }

    // Attach global velocity to each release so the frontend can display it
    for (const [, relResult] of releaseResults) {
      relResult.velocity = { devTotal: globalVel.dev, qaTotal: globalVel.qa };
    }

    return {
      releases: releaseResults,
      people: personResults,
      simulation: {
        days: dayLog,
        totalDays: simulationDays,
      },
      globalVelocity: globalVel,
    };
  }

  /**
   * Find bottleneck people for a release — returns worst dev AND worst QA.
   */
  _findBottleneck(relInfo, personVelocities, workQueues, teamAvgDev, teamAvgQa) {
    let worstDev = null;
    let worstDevDays = 0;
    let worstQa = null;
    let worstQaDays = 0;

    for (const [name, queues] of workQueues.people) {
      const vel = personVelocities.get(name);

      // Check dev queue for this release
      const devInRelease = queues.devQueue.filter(t =>
        (t._releaseVersions || []).includes(relInfo.version),
      ).length;
      const devV = vel?.dev?.ticketsPerDay || teamAvgDev;
      const devDays = devV > 0 ? devInRelease / devV : (devInRelease > 0 ? Infinity : 0);

      if (devDays > worstDevDays) {
        worstDevDays = devDays;
        worstDev = { person: name, role: 'dev', queueSize: devInRelease, velocity: devV };
      }

      // Check QA queue for this release
      const qaInRelease = queues.qaQueue.filter(t =>
        (t._releaseVersions || []).includes(relInfo.version),
      ).length;
      const qaV = vel?.qa?.ticketsPerDay || teamAvgQa;
      const qaDays = qaV > 0 ? qaInRelease / qaV : (qaInRelease > 0 ? Infinity : 0);

      if (qaDays > worstQaDays) {
        worstQaDays = qaDays;
        worstQa = { person: name, role: 'qa', queueSize: qaInRelease, velocity: qaV };
      }
    }

    // Return the single worst bottleneck (backward compat) + both dev/qa bottlenecks
    const overall = (worstDevDays >= worstQaDays) ? worstDev : worstQa;
    if (!overall) return null;

    return {
      ...overall,
      projectedClear: Math.max(worstDevDays, worstQaDays) === Infinity ? null : Math.ceil(Math.max(worstDevDays, worstQaDays)),
      devBottleneck: worstDev,
      qaBottleneck: worstQa,
    };
  }

  /**
   * Add N business days to an ISO date.
   * @param {string} isoDate - YYYY-MM-DD
   * @param {number} days - business days to add
   * @returns {string} YYYY-MM-DD
   */
  _addBusinessDays(isoDate, days) {
    let remaining = days;
    let d = isoDate;
    while (remaining > 0) {
      d = addDay(d);
      if (!isWeekend(d)) remaining--;
    }
    return d;
  }
}

module.exports = Simulator;
module.exports.addDay = addDay;
module.exports.isWeekend = isWeekend;
module.exports.MAX_SIMULATION_DAYS = MAX_SIMULATION_DAYS;
