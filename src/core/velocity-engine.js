const PersonVelocity = require('./velocity/person');
const WorkloadBuilder = require('./velocity/workload');
const Simulator = require('./velocity/simulator');
const RiskAssessor = require('./velocity/risk');
const { getDb } = require('./db');

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Main orchestrator for the velocity forecast engine.
 *
 * Calls PersonVelocity -> WorkloadBuilder -> Simulator -> RiskAssessor
 * in sequence and returns a unified forecast result.
 *
 * Caches the result for 5 minutes to avoid expensive recomputation.
 */
class VelocityEngine {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} [opts.db]       - Database handle
   * @param {object}                            [opts.releases] - ReleaseManager instance
   * @param {object}                            [opts.availability] - Availability instance
   * @param {object}                            [opts.config]   - Optional config overrides
   */
  constructor(opts = {}) {
    this.db = opts.db || getDb();
    this.releases = opts.releases || null;
    this.availability = opts.availability || null;
    this.config = opts.config || {};

    this._personVelocity = new PersonVelocity(this.db);
    this._workloadBuilder = new WorkloadBuilder(this.db);
    this._simulator = new Simulator();
    this._riskAssessor = new RiskAssessor();

    this._cache = null;
    this._cacheAt = null;
    this._cacheTTL = this.config.cacheTTL || DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Run the full simulation for all active releases.
   *
   * @param {object} [opts]
   * @param {Date}   [opts.now]           - Override current date (for testing)
   * @param {number} [opts.lookbackDays]  - Override velocity lookback window
   * @param {number} [opts.bufferDays]    - Override deadline buffer
   * @param {Array}  [opts.releases]      - Override active releases (instead of using ReleaseManager)
   * @returns {object} Full SimulationResult with risk assessments
   */
  forecast(opts = {}) {
    const now = opts.now || new Date();

    // 1. Get active releases
    const activeReleases = opts.releases || this._getActiveReleases();
    if (activeReleases.length === 0) {
      return this._emptyResult();
    }

    // 2. Compute person velocities
    const personVelocities = this._personVelocity.computeAll({
      lookbackDays: opts.lookbackDays,
      now,
    });

    // 3. Build work queues
    const workQueues = this._workloadBuilder.buildQueues(activeReleases);

    // 4. Run simulation
    const simulationResult = this._simulator.simulate(
      personVelocities,
      workQueues,
      this.availability,
      activeReleases,
      { now, bufferDays: opts.bufferDays },
    );

    // 5. Assess risk for each release
    for (const [version, projection] of simulationResult.releases) {
      const riskAssessment = this._riskAssessor.assess(
        projection,
        projection.deadlineDate,
        {
          unassigned: workQueues.unassigned.filter(t =>
            (t._releaseVersions || []).includes(version),
          ),
          now,
        },
      );
      // Merge risk into the release projection
      projection.risk = riskAssessment.risk;
      projection.riskMessage = riskAssessment.riskMessage;
      projection.suggestions = riskAssessment.suggestions;
    }

    // 6. Add team averages
    const teamAverages = this._personVelocity.getTeamAverages({
      lookbackDays: opts.lookbackDays,
      now,
    });

    return {
      ...simulationResult,
      teamAverages,
      unassigned: workQueues.unassigned,
      computedAt: now.toISOString(),
    };
  }

  /**
   * Get cached forecast. Recomputes if stale (older than cache TTL).
   *
   * @param {object} [opts] - Same options as forecast()
   * @returns {object}
   */
  getCachedForecast(opts = {}) {
    const now = opts.now || new Date();
    if (this._cache && this._cacheAt) {
      const age = now.getTime() - this._cacheAt;
      if (age < this._cacheTTL) {
        return this._cache;
      }
    }

    const result = this.forecast(opts);
    this._cache = result;
    this._cacheAt = now.getTime();
    return result;
  }

  /**
   * Invalidate the cache (e.g., after ticket sync or release update).
   */
  invalidateCache() {
    this._cache = null;
    this._cacheAt = null;
  }

  /**
   * Get active releases from the ReleaseManager.
   * @returns {Array<{ version: string, repo: string, jiraReleaseDate: string, state: string }>}
   */
  _getActiveReleases() {
    if (!this.releases) return [];
    return this.releases.active().map(r => ({
      version: r.version,
      repo: r.repo,
      jiraReleaseDate: r.jiraReleaseDate || null,
      state: r.state,
    }));
  }

  /**
   * Return an empty result (no releases to forecast).
   * @returns {object}
   */
  _emptyResult() {
    return {
      releases: new Map(),
      people: new Map(),
      simulation: { days: [], totalDays: 0 },
      globalVelocity: { dev: 0, qa: 0 },
      teamAverages: { dev: 0, qa: 0, dataQuality: 'accurate' },
      unassigned: [],
      computedAt: new Date().toISOString(),
    };
  }
}

module.exports = VelocityEngine;
