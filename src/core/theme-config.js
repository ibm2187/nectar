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
   * Only runs when the config is empty (first boot).
   */
  autoGenerate(components) {
    if (this.themes.length > 0) return; // Don't overwrite user config
    this.themes = ThemeConfig.suggestThemes(components);
    this._save();
    log.info(`Theme config auto-generated: ${this.themes.length} themes from ${components.length} components`);
  }

  /**
   * Suggest theme groupings from a list of JIRA component strings.
   * Groups by prefix before " - " (e.g., "RCM - Billing" → "RCM").
   * For components without a dash separator, finds common prefix words
   * (e.g., "AI Agents", "AI CoPilot" → "AI").
   * Singletons (components that don't group with anything) are collected
   * into a single "General" theme.
   *
   * Does NOT modify this.themes — returns the suggestion for the caller
   * (API / UI) to preview and apply.
   */
  static suggestThemes(components, existingThemes = []) {
    // Build a set of already-mapped components to skip
    const alreadyMapped = new Set();
    for (const t of existingThemes) {
      for (const c of t.components) alreadyMapped.add(c.toLowerCase());
    }

    // Only consider unmapped components
    const unmapped = components.filter(c => !alreadyMapped.has(c.toLowerCase()));
    if (unmapped.length === 0) return [];

    // Phase 1: Group by prefix before " - "
    const prefixGroups = new Map();
    const noPrefix = [];

    for (const comp of unmapped) {
      const dashIdx = comp.indexOf(' - ');
      if (dashIdx > 0) {
        const prefix = comp.substring(0, dashIdx).trim();
        if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
        prefixGroups.get(prefix).push(comp);
      } else {
        noPrefix.push(comp);
      }
    }

    // Phase 2: For no-prefix components, try to merge into an existing
    // prefix group by first word, or group with other same-first-word components.
    const singletons = [];

    for (const comp of noPrefix) {
      const firstWord = comp.split(/\s+/)[0];
      // If a prefix group already exists for this word, add to it
      if (prefixGroups.has(firstWord)) {
        prefixGroups.get(firstWord).push(comp);
      } else {
        // Collect for second pass
        singletons.push(comp);
      }
    }

    // Second pass: group remaining singletons by first word if 2+ share one
    const firstWordGroups = new Map();
    const trueSingletons = [];
    for (const comp of singletons) {
      const firstWord = comp.split(/\s+/)[0];
      if (!firstWordGroups.has(firstWord)) firstWordGroups.set(firstWord, []);
      firstWordGroups.get(firstWord).push(comp);
    }
    for (const [word, comps] of firstWordGroups) {
      if (comps.length >= 2) {
        prefixGroups.set(word, comps);
      } else {
        trueSingletons.push(...comps);
      }
    }

    // Phase 3: Build theme suggestions
    const themes = [];

    for (const [prefix, comps] of prefixGroups) {
      if (prefix.toLowerCase() === 'other') continue;
      themes.push({
        name: prefix,
        components: comps.sort(),
        icon: null,
      });
    }

    // Collect true singletons into a "General" theme
    if (trueSingletons.length > 0) {
      themes.push({
        name: 'General',
        components: trueSingletons.sort(),
        icon: null,
      });
    }

    themes.sort((a, b) => a.name.localeCompare(b.name));
    return themes;
  }
}

module.exports = ThemeConfig;
