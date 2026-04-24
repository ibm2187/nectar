const log = require('./log');

/**
 * Reconciles Viv-internal identities across Zoho Desk, JIRA, and Nectar.
 *
 * Run flow:
 *   1. Pull all Zoho agents (paginated)
 *   2. For each agent, upsert a users row keyed by normalized email.
 *      Populate zohoAgentId, displayNameZoho, and isBot flag.
 *   3. For agents missing jiraAccountId, query JIRA for the matching user
 *      by email. Cache the resolved accountId.
 *
 * Email is the bootstrap join; once stable IDs are populated we never
 * re-resolve by email unless the row is missing one of the IDs.
 *
 * The reconciler is idempotent — subsequent runs are cheap and only
 * re-fetch JIRA for rows still missing jiraAccountId.
 */
class ZohoUserReconciler {
  /**
   * @param {object} deps
   *   userStore: UserStore
   *   zoho:      ZohoClient
   *   jira:      JiraClient
   *   config:    optional Nectar config (unused for now)
   */
  constructor({ userStore, zoho, jira, config }) {
    this.userStore = userStore;
    this.zoho = zoho;
    this.jira = jira;
    this.config = config || {};
    this.lastRun = null;
    this.lastResults = null;

    // Bot allowlist — email prefix or exact match.
    // Overridable via ZOHO_BOT_EMAILS env var (comma-separated).
    this.botPatterns = (process.env.ZOHO_BOT_EMAILS || 'hive@,noreply@,support+bot@')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Run one reconciliation pass.
   * @returns {Promise<{agentsFetched, usersUpserted, jiraResolved, jiraMisses, errors}>}
   */
  async run() {
    const start = Date.now();
    const results = {
      agentsFetched: 0,
      usersUpserted: 0,
      jiraResolved: 0,
      jiraMisses: 0,
      errors: 0,
      durationMs: 0,
    };

    if (!this.zoho.isConfigured()) {
      log.warn('Zoho user reconciler: Zoho not configured, skipping');
      return results;
    }

    let agents;
    try {
      agents = await this.zoho.listAgents();
    } catch (err) {
      log.error(`Zoho user reconciler: listAgents failed: ${err.message}`);
      results.errors++;
      return results;
    }
    results.agentsFetched = agents.length;

    // Step 1: upsert every agent as a user row
    const needsJiraLookup = [];
    for (const agent of agents) {
      const email = agent.emailId ? agent.emailId.toLowerCase().trim() : null;
      if (!email) continue;

      const isBot = this._isBot(email, agent.name);
      const existing = this.userStore.getUser(email);

      this.userStore.upsertIdentity({
        email,
        name: existing && existing.name ? existing.name : agent.name,
        displayNameZoho: agent.name || null,
        zohoAgentId: agent.id,
        isBot,
      });
      results.usersUpserted++;

      // Schedule JIRA lookup only if we don't already have an accountId
      const after = this.userStore.getUser(email);
      if (!isBot && !after.jiraAccountId && this.jira.isConfigured()) {
        needsJiraLookup.push(email);
      }
    }

    // Step 2: resolve JIRA accountId for agents missing it
    for (const email of needsJiraLookup) {
      try {
        const user = await this.jira.getUserByEmail(email);
        if (user && user.accountId) {
          this.userStore.upsertIdentity({ email, jiraAccountId: user.accountId });
          results.jiraResolved++;
        } else {
          results.jiraMisses++;
        }
      } catch (err) {
        log.warn(`Zoho user reconciler: JIRA lookup for ${email} failed: ${err.message}`);
        results.errors++;
      }
      // Throttle: JIRA 429'd at ~10+ parallel earlier. Sequential + pause = safe.
      await _sleep(250);
    }

    results.durationMs = Date.now() - start;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    log.info(
      `Zoho user reconciler: ${results.agentsFetched} agents, ` +
      `${results.usersUpserted} users upserted, ` +
      `${results.jiraResolved} JIRA matches, ${results.jiraMisses} misses, ` +
      `${results.errors} errors, ${results.durationMs}ms`
    );
    return results;
  }

  _isBot(email, name) {
    if (!email) return false;
    const lc = email.toLowerCase();
    for (const pat of this.botPatterns) {
      if (lc === pat || lc.startsWith(pat)) return true;
    }
    // Secondary heuristic: tight match on "bot" only — "automation" and
    // "integration" are legitimate human job titles (e.g. "Integration
    // Engineer") and would false-positive.
    if (name && /\bbot\b/i.test(name)) return true;
    return false;
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = ZohoUserReconciler;
