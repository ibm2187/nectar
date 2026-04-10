const fs = require('fs');
const path = require('path');
const log = require('./log');

const CONFIG_FILE = path.join(process.cwd(), '.nectar-themes.json');

/**
 * Theme configuration for the roadmap view.
 *
 * Maps JIRA component values (customfield_10463) to display-friendly theme
 * names. Persisted to .nectar-themes.json, editable via the API (and
 * eventually a config UI).
 *
 * Shape:
 *   {
 *     themes: [
 *       { name: "EVV & Aggregators", components: ["RCM - Aggregators", "Ascend - EVV Aggregators"], icon: "🎯" },
 *       ...
 *     ],
 *     unmappedLabel: "Other",
 *     updatedAt: "2026-04-09T..."
 *   }
 */
class ThemeConfig {
  constructor() {
    this.themes = [];
    this.unmappedLabel = 'Other';
    this.updatedAt = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        this.themes = raw.themes || [];
        this.unmappedLabel = raw.unmappedLabel || 'Other';
        this.updatedAt = raw.updatedAt || null;
        log.info(`Theme config loaded: ${this.themes.length} themes`);
      }
    } catch (err) {
      log.warn('Failed to load theme config:', err.message);
    }
  }

  _save() {
    this.updatedAt = new Date().toISOString();
    const data = {
      themes: this.themes,
      unmappedLabel: this.unmappedLabel,
      updatedAt: this.updatedAt,
    };
    try {
      const json = JSON.stringify(data, null, 2);
      const tmpFile = CONFIG_FILE + '.tmp';
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, CONFIG_FILE);
    } catch (err) {
      log.error('Failed to save theme config:', err.message);
      try { fs.unlinkSync(CONFIG_FILE + '.tmp'); } catch { /* ok */ }
    }
  }

  /**
   * Get the full config for the API / frontend.
   */
  getConfig() {
    return {
      themes: this.themes,
      unmappedLabel: this.unmappedLabel,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Replace the full config (from the config UI).
   */
  setConfig({ themes, unmappedLabel }) {
    if (Array.isArray(themes)) this.themes = themes;
    if (unmappedLabel != null) this.unmappedLabel = unmappedLabel;
    this._save();
  }

  /**
   * Resolve a JIRA component string to a theme name.
   * Returns the theme name or unmappedLabel if no match.
   */
  resolveComponent(component) {
    if (!component) return this.unmappedLabel;
    for (const theme of this.themes) {
      if (theme.components.some(c =>
        c.toLowerCase() === component.toLowerCase()
      )) {
        return theme.name;
      }
    }
    return this.unmappedLabel;
  }

  /**
   * Auto-generate themes from observed component values.
   * Groups obvious prefixes (e.g., "RCM - Aggregators" and "Ascend - EVV Aggregators"
   * both have "Aggregators"). Falls back to each component as its own theme.
   *
   * Only runs when the config is empty (first boot).
   */
  autoGenerate(components) {
    if (this.themes.length > 0) return; // Don't overwrite user config

    // Group by prefix before " - " or by exact name
    const groups = new Map();
    for (const comp of components) {
      // Try to extract a meaningful group: use text after " - " if present,
      // otherwise use the full name
      const parts = comp.split(' - ');
      const groupKey = parts.length > 1 ? parts[parts.length - 1].trim() : comp.trim();
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(comp);
    }

    this.themes = Array.from(groups.entries())
      .filter(([key]) => key.toLowerCase() !== 'other')
      .map(([key, comps]) => ({
        name: key,
        components: comps,
        icon: null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this._save();
    log.info(`Theme config auto-generated: ${this.themes.length} themes from ${components.length} components`);
  }
}

module.exports = ThemeConfig;
