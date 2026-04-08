const { EventEmitter } = require('events');

/**
 * Audit trail — records every action on every release.
 * Emits 'entry' on each new audit record for WebSocket broadcasting.
 */
class Audit extends EventEmitter {
  constructor() {
    super();
    this.entries = []; // Loaded from state file by ReleaseManager
  }

  /**
   * Record an audit entry.
   * @param {string} version - Release version (e.g., '4.2.1')
   * @param {string} action - What happened (e.g., 'state:transition', 'cherry-pick:added')
   * @param {object} detail - Action-specific data
   * @param {string|null} user - Who did it (null = system)
   */
  record(version, action, detail = {}, user = null) {
    const entry = {
      id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      version,
      action,
      detail,
      user,
      at: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.emit('entry', entry);
    return entry;
  }

  /**
   * Get audit entries for a specific release.
   */
  forRelease(version) {
    return this.entries.filter(e => e.version === version);
  }

  /**
   * Serialize for state persistence.
   */
  toJSON() {
    // Keep last 5000 entries to avoid unbounded growth
    const trimmed = this.entries.slice(-5000);
    return trimmed;
  }

  /**
   * Restore from persisted state.
   */
  loadState(entries) {
    if (Array.isArray(entries)) {
      this.entries = entries;
    }
  }
}

module.exports = Audit;
