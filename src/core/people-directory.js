const fs = require('fs');
const path = require('path');
const log = require('./log');

// Primary: bundled with the repo so production has it.
// Override with SLACK_IDS_PATH env var for alternative locations.
const BUNDLED_PATH = path.join(__dirname, '..', '..', 'config', 'slack-ids.json');
const DEFAULT_PATH = BUNDLED_PATH;

/**
 * PeopleDirectory — resolves JIRA display names to Slack user IDs.
 *
 * Loads a slack-ids.json file (format: { users: { username: { name, id } } })
 * and builds a multi-strategy lookup index for fuzzy name matching.
 */
class PeopleDirectory {
  constructor(config = {}) {
    this.config = config;
    this._byNameNorm = new Map();   // normalizedName → { name, slackId, username }
    this._byFirstLast = new Map();  // "first|last0" → { name, slackId, username }
    this._all = [];                 // all entries for fallback search
    this._overrides = new Map();    // jiraName (lowercase) → slackId
    this._unresolved = new Map();   // jiraName → queryCount
    this._loaded = false;
  }

  /**
   * Load (or reload) the directory from the bundled slack-ids.json file.
   * @returns {number} count of users loaded
   */
  load() {
    const filePath = process.env.SLACK_IDS_PATH || DEFAULT_PATH;

    if (!fs.existsSync(filePath)) {
      log.warn(`People directory: file not found: ${filePath}`);
      return 0;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const users = raw.users || {};

      this._byNameNorm.clear();
      this._byFirstLast.clear();
      this._all = [];

      for (const [username, entry] of Object.entries(users)) {
        if (!entry.id || !entry.name) continue;

        const record = {
          name: entry.name,
          slackId: entry.id,
          username,
        };

        this._all.push(record);

        const norm = this._normalize(entry.name);
        this._byNameNorm.set(norm, record);

        const tokens = norm.split(/\s+/).filter(Boolean);
        if (tokens.length >= 2) {
          const key = tokens[0] + '|' + tokens[tokens.length - 1][0];
          this._byFirstLast.set(key, record);
        }
      }

      this._loaded = this._all.length > 0;
      log.info(`People directory: loaded ${this._all.length} users from ${filePath}`);
      return this._all.length;
    } catch (err) {
      log.error(`People directory: failed to load: ${err.message}`);
      return 0;
    }
  }

  reload() {
    return this.load();
  }

  isLoaded() {
    return this._loaded;
  }

  /**
   * Resolve a JIRA display name to a Slack user ID.
   * Uses layered matching: exact → normalized → first+lastInitial → token overlap.
   *
   * @param {string} jiraDisplayName - e.g. "Nukul Bhasin"
   * @returns {{ slackId: string, username: string, name: string, match: string } | null}
   */
  resolveSlackId(jiraDisplayName) {
    if (!jiraDisplayName || !this._loaded) return null;

    const nameLower = jiraDisplayName.trim().toLowerCase();

    // Check manual overrides first
    const override = this._overrides.get(nameLower);
    if (override) {
      const record = this._all.find(r => r.slackId === override);
      return record
        ? { slackId: override, username: record.username, name: record.name, match: 'override' }
        : { slackId: override, username: nameLower, name: jiraDisplayName, match: 'override' };
    }

    const norm = this._normalize(jiraDisplayName);

    // Strategy 1: Exact normalized match
    const exact = this._byNameNorm.get(norm);
    if (exact) return { ...exact, match: 'exact' };

    // Strategy 2: First name + last name initial
    const tokens = norm.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const key = tokens[0] + '|' + tokens[tokens.length - 1][0];
      const partial = this._byFirstLast.get(key);
      if (partial) return { ...partial, match: 'firstLastInitial' };
    }

    // Strategy 2b: Exact last name + same first initial (handles typos in first name)
    if (tokens.length >= 2) {
      const queryLast = tokens[tokens.length - 1];
      const queryFirstInitial = tokens[0][0];
      for (const record of this._all) {
        const recTokens = this._normalize(record.name).split(/\s+/).filter(Boolean);
        if (recTokens.length < 2) continue;
        const recLast = recTokens[recTokens.length - 1];
        const recFirstInitial = recTokens[0][0];
        if (recLast === queryLast && recFirstInitial === queryFirstInitial) {
          return { ...record, match: 'lastNameInitial' };
        }
      }
    }

    // Strategy 3: Token overlap (Jaccard-like) with last-name bias
    let bestMatch = null;
    let bestScore = 0;

    for (const record of this._all) {
      const recTokens = this._normalize(record.name).split(/\s+/).filter(Boolean);
      const queryTokens = new Set(tokens);
      const recSet = new Set(recTokens);

      let overlap = 0;
      let lastNameMatch = false;
      for (const t of queryTokens) {
        if (recSet.has(t)) {
          overlap++;
          // Check if it's the last token (likely last name)
          if (t === tokens[tokens.length - 1] && t === recTokens[recTokens.length - 1]) {
            lastNameMatch = true;
          }
        }
      }

      const union = new Set([...queryTokens, ...recSet]).size;
      const score = overlap / union;

      if (score > bestScore && lastNameMatch && score >= 0.4) {
        bestScore = score;
        bestMatch = record;
      }
    }

    if (bestMatch) return { ...bestMatch, match: 'fuzzy' };

    // No match — track as unresolved
    this._unresolved.set(jiraDisplayName, (this._unresolved.get(jiraDisplayName) || 0) + 1);
    return null;
  }

  /**
   * Batch-resolve multiple names.
   * @param {string[]} names
   * @returns {Map<string, { slackId, username, name, match } | null>}
   */
  resolveAll(names) {
    const results = new Map();
    for (const name of names) {
      results.set(name, this.resolveSlackId(name));
    }
    return results;
  }

  /**
   * Add a manual override for names that can't be fuzzy-matched.
   * @param {string} jiraName
   * @param {string} slackId
   */
  addOverride(jiraName, slackId) {
    this._overrides.set(jiraName.trim().toLowerCase(), slackId);
  }

  /**
   * Get names that have been queried but never resolved.
   * @returns {Array<{ name: string, queryCount: number }>}
   */
  getUnresolved() {
    return Array.from(this._unresolved.entries())
      .map(([name, queryCount]) => ({ name, queryCount }))
      .sort((a, b) => b.queryCount - a.queryCount);
  }

  /**
   * Get all loaded entries (for admin/debug).
   * @returns {Array<{ name, slackId, username }>}
   */
  getAll() {
    return [...this._all];
  }

  /**
   * Normalize a name for comparison.
   * Lowercase, strip accents, collapse whitespace.
   */
  _normalize(name) {
    return (name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')     // strip punctuation
      .replace(/\s+/g, ' ')
      .trim();
  }
}

module.exports = PeopleDirectory;
