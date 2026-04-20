/**
 * Risk assessment for velocity forecasts.
 *
 * Converts simulation output to risk levels and human-readable messages
 * with actionable suggestions.
 */

/**
 * Risk level thresholds (in days late).
 */
const RISK_THRESHOLDS = {
  onTrack: 0,      // projected <= deadline
  tight: 2,        // 1-2 days after deadline
  atRisk: 7,       // 3-7 days after deadline
  critical: 7,     // 7+ days after deadline
};

class RiskAssessor {
  /**
   * Assess risk for a single release.
   *
   * @param {object} projection - Release projection from simulator output
   * @param {number} projection.remaining      - Tickets remaining
   * @param {string} projection.projectedDate   - ISO date of projected completion
   * @param {string} projection.deadlineDate    - ISO date of deadline
   * @param {number} projection.daysLate        - Positive = late
   * @param {object} projection.bottleneck      - Bottleneck info
   * @param {object} projection.breakdown       - Status breakdown
   * @param {string} deadline - ISO date of deadline (releaseDate - 2 days)
   * @param {object} [context] - Additional context
   * @param {object[]} [context.unassigned] - Unassigned tickets
   * @param {Date}     [context.now]        - Override current date
   * @returns {{ risk: string, riskMessage: string, suggestions: string[] }}
   */
  assess(projection, deadline, context = {}) {
    const now = context.now || new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // No data case
    if (!projection || projection.remaining === undefined) {
      return {
        risk: 'unknown',
        riskMessage: 'Insufficient data for risk assessment',
        suggestions: [],
      };
    }

    // All done
    if (projection.remaining === 0) {
      return {
        risk: 'on-track',
        riskMessage: 'All tickets completed',
        suggestions: [],
      };
    }

    // No deadline — can't assess timing
    if (!deadline) {
      return {
        risk: 'unknown',
        riskMessage: `${projection.remaining} tickets remaining, no deadline set`,
        suggestions: this._generateSuggestions(projection, context),
      };
    }

    // No projected date — simulation couldn't project completion
    if (!projection.projectedDate) {
      // Check if deadline has passed
      if (deadline < todayStr) {
        return {
          risk: 'critical',
          riskMessage: `Deadline passed (${deadline}) with ${projection.remaining} tickets remaining and no velocity data`,
          suggestions: this._generateSuggestions(projection, context),
        };
      }
      return {
        risk: 'unknown',
        riskMessage: `${projection.remaining} tickets remaining, insufficient velocity data to project completion`,
        suggestions: this._generateSuggestions(projection, context),
      };
    }

    // Deadline has passed and tickets remain
    if (deadline < todayStr && projection.remaining > 0) {
      return {
        risk: 'critical',
        riskMessage: `Deadline passed (${deadline}) — ${projection.remaining} tickets remaining, projected completion ${projection.projectedDate}`,
        suggestions: this._generateSuggestions(projection, context),
      };
    }

    // Compare projected vs deadline
    const daysLate = projection.daysLate || this._daysBetween(deadline, projection.projectedDate);
    let risk;
    let riskMessage;

    if (daysLate <= RISK_THRESHOLDS.onTrack) {
      risk = 'on-track';
      const daysEarly = Math.abs(daysLate);
      riskMessage = daysEarly > 0
        ? `On track — projected ${daysEarly} day${daysEarly !== 1 ? 's' : ''} before deadline`
        : `On track — projected to complete on deadline`;
    } else if (daysLate <= RISK_THRESHOLDS.tight) {
      risk = 'tight';
      riskMessage = `Tight — projected ${daysLate} day${daysLate !== 1 ? 's' : ''} after deadline (${deadline})`;
    } else if (daysLate <= RISK_THRESHOLDS.atRisk) {
      risk = 'at-risk';
      riskMessage = `At risk — projected ${daysLate} day${daysLate !== 1 ? 's' : ''} after deadline (${deadline})`;
    } else {
      risk = 'critical';
      riskMessage = `Critical — projected ${daysLate} day${daysLate !== 1 ? 's' : ''} after deadline (${deadline})`;
    }

    return {
      risk,
      riskMessage,
      suggestions: this._generateSuggestions(projection, context),
    };
  }

  /**
   * Calculate business days between two ISO dates.
   * Positive = afterDate is after beforeDate.
   */
  _daysBetween(beforeDate, afterDate) {
    const before = new Date(beforeDate + 'T00:00:00Z');
    const after = new Date(afterDate + 'T00:00:00Z');
    return Math.round((after - before) / (1000 * 60 * 60 * 24));
  }

  /**
   * Generate actionable suggestions based on projection data.
   *
   * @param {object} projection
   * @param {object} context
   * @returns {string[]}
   */
  _generateSuggestions(projection, context = {}) {
    const suggestions = [];

    // QA bottleneck
    if (projection.bottleneck && projection.bottleneck.role === 'qa') {
      const bn = projection.bottleneck;
      suggestions.push(
        `QA is the bottleneck — ${bn.person} has ${bn.queueSize} tickets at ${bn.velocity.toFixed(1)}/day velocity`,
      );
    }

    // Dev bottleneck
    if (projection.bottleneck && projection.bottleneck.role === 'dev') {
      const bn = projection.bottleneck;
      suggestions.push(
        `${bn.person} is on the critical path with ${bn.queueSize} tickets at ${bn.velocity.toFixed(1)}/day velocity`,
      );
    }

    // Blocked tickets
    if (projection.breakdown?.blocked > 0) {
      const blocked = projection.breakdown.blocked;
      suggestions.push(
        `${blocked} ticket${blocked !== 1 ? 's are' : ' is'} blocked. Unblocking could accelerate delivery`,
      );
    }

    // Unassigned tickets
    if (context.unassigned && context.unassigned.length > 0) {
      const missingDev = context.unassigned.filter(t => t.missingDev).length;
      const missingQa = context.unassigned.filter(t => t.missingQa).length;

      if (missingDev > 0) {
        suggestions.push(`${missingDev} ticket${missingDev !== 1 ? 's have' : ' has'} no dev assignee`);
      }
      if (missingQa > 0) {
        suggestions.push(`${missingQa} ticket${missingQa !== 1 ? 's have' : ' has'} no QA assignee`);
      }
    }

    // Single person critical path
    if (projection.bottleneck && projection.bottleneck.projectedClear &&
        projection.bottleneck.projectedClear > 10) {
      const bn = projection.bottleneck;
      suggestions.push(
        `${bn.person} is the single-threaded bottleneck — consider redistributing work`,
      );
    }

    return suggestions;
  }
}

module.exports = RiskAssessor;
module.exports.RISK_THRESHOLDS = RISK_THRESHOLDS;
