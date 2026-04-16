const fs = require('fs');
const path = require('path');
const log = require('./log');

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-notification-settings.json');

const DEFAULT_CHANNELS = {
  releases: true,       // #releases channel notifications
  deploys: true,        // #deploys channel notifications
  releaseStatus: true,  // per-release channel status updates
  buildFailures: true,  // build failure/recovery DMs to affected devs
  dailyDigest: true,    // daily per-person DM digests
};

/**
 * NotificationSettings — persists global notification toggles.
 *
 * Channel-level kill switches that admins can toggle on/off.
 * Per-user preferences live in UserStore; these are system-wide.
 */
class NotificationSettings {
  constructor() {
    this.enabled = true; // master kill switch — false = all notifications suppressed
    this.channels = { ...DEFAULT_CHANNELS };
    this._loadState();
  }

  /**
   * Check if a notification type is enabled.
   * @param {string} type - e.g. 'releases', 'deploys', 'buildFailures'
   * @returns {boolean}
   */
  get(type) {
    if (!this.enabled) return false; // master toggle off = everything off
    if (type in this.channels) return this.channels[type];
    return true; // unknown types default to enabled
  }

  /**
   * Toggle a notification type.
   * @param {string} type
   * @param {boolean} enabled
   */
  set(type, enabled) {
    if (!(type in DEFAULT_CHANNELS)) return;
    this.channels[type] = !!enabled;
    this._save();
    log.info(`Notification settings: ${type} = ${this.channels[type]}`);
  }

  /**
   * Get all settings.
   * @returns {{ channels: object }}
   */
  getAll() {
    return { enabled: this.enabled, channels: { ...this.channels } };
  }

  /**
   * Bulk update from API.
   * @param {{ enabled?: boolean, channels?: object }} settings
   */
  update(settings) {
    if (typeof settings.enabled === 'boolean') {
      this.enabled = settings.enabled;
      log.info(`Notification settings: master toggle = ${this.enabled}`);
    }
    if (settings.channels && typeof settings.channels === 'object') {
      for (const key of Object.keys(DEFAULT_CHANNELS)) {
        if (typeof settings.channels[key] === 'boolean') {
          this.channels[key] = settings.channels[key];
        }
      }
    }
    this._save();
  }

  flush() {
    this._save();
  }

  // ── Internal ────────────────────────────────────────────

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (typeof data.enabled === 'boolean') this.enabled = data.enabled;
        if (data.channels && typeof data.channels === 'object') {
          for (const key of Object.keys(DEFAULT_CHANNELS)) {
            if (typeof data.channels[key] === 'boolean') {
              this.channels[key] = data.channels[key];
            }
          }
        }
        log.info(`Notification settings loaded (enabled: ${this.enabled})`);
      }
    } catch (err) {
      log.error(`Failed to load notification settings: ${err.message}`);
    }
  }

  _save() {
    try {
      const data = { enabled: this.enabled, channels: this.channels };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error(`Failed to save notification settings: ${err.message}`);
    }
  }
}

module.exports = NotificationSettings;
