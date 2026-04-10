const log = require('../core/log');

const JIRA_KEY_REGEX = /\b(DEV|MAV)-\d+\b/g;
const PAGE_SIZE = 100;

// Zoho Desk linkage — stored in JIRA customfield_10691 ("Zoho Desk Ticket ID").
// Free text field, so values come in three shapes: full agent URL, #VHC-xxxx shorthand,
// or garbage (someone pasted the subject). See reference_zoho_jira_linkage memory for context.
const ZOHO_CUSTOM_FIELD = 'customfield_10691';
const ZOHO_SUBMITTER_NAME_FIELD = 'customfield_10992';
const ZOHO_SUBMITTER_EMAIL_FIELD = 'customfield_10993';

// Target FixVersion — mavencare's planning-intent field (where a ticket was
// *meant* to ship). Distinct from the canonical fixVersion which captures
// where the code actually landed. The gap between the two is the "missing
// plans" signal that surfaces on the release truth view.
const TARGET_FIX_VERSION_FIELD = 'customfield_10594';
// Matches /details/<digits> in Zoho agent URLs
const ZOHO_URL_ID_REGEX = /\/details\/(\d+)/;
// Matches the VHC-xxxx ticket number form, optionally prefixed with #
const ZOHO_TICKET_NUMBER_REGEX = /#?\s*(VHC-\d+)/i;

/**
 * JIRA REST API client.
 * Basic auth with email:apiToken.
 */
class JiraClient {
  constructor() {
    // Support both JIRA_BASE_URL / JIRA_URL and JIRA_EMAIL/JIRA_USERNAME + JIRA_TOKEN/JIRA_API_TOKEN
    this.baseUrl = (process.env.JIRA_BASE_URL || process.env.JIRA_URL || '').replace(/\/$/, '');
    const email = process.env.JIRA_EMAIL || process.env.JIRA_USERNAME;
    const token = process.env.JIRA_TOKEN || process.env.JIRA_API_TOKEN;
    this.auth = email && token
      ? Buffer.from(`${email}:${token}`).toString('base64')
      : null;
  }

  isConfigured() {
    return !!(this.baseUrl && this.auth);
  }

  // ── Core requests ───────────────────────────────────────

  async _request(method, path, body = null) {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const headers = {
      'Authorization': `Basic ${this.auth}`,
      'Accept': 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`JIRA ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }

    if (res.status === 204) return null;
    return res.json();
  }

  // ── Versions (Releases) ────────────────────────────────

  /**
   * Get all versions for a project.
   * Returns array of { id, name, released, archived, releaseDate, ... }
   */
  async getProjectVersions(projectKey) {
    return this._request('GET', `/project/${projectKey}/versions`);
  }

  /**
   * Get unreleased versions (active releases).
   */
  async getUnreleasedVersions(projectKey) {
    const versions = await this.getProjectVersions(projectKey);
    return versions.filter(v => !v.released && !v.archived);
  }

  /**
   * Get all versions with their status — released, unreleased, archived.
   * Returns normalized array.
   */
  async getVersionsSummary(projectKey) {
    const versions = await this.getProjectVersions(projectKey);
    return versions.map(v => ({
      id: v.id,
      name: v.name,
      released: !!v.released,
      archived: !!v.archived,
      releaseDate: v.releaseDate || null,
      description: v.description || null,
      startDate: v.startDate || null,
    }));
  }

  // ── Issues ──────────────────────────────────────────────

  async getIssue(key) {
    return this._request('GET', `/issue/${key}?fields=summary,status,issuetype,assignee,fixVersions,labels`);
  }

  /**
   * Search issues with pagination using the new /search/jql endpoint.
   * Uses nextPageToken for pagination (old /search was deprecated in 2024).
   * @param {string} jql
   * @param {object} opts - { maxResults, fields, onPage }
   */
  async searchAllIssues(jql, opts = {}) {
    const fields = opts.fields || ['summary', 'status', 'issuetype', 'assignee', 'fixVersions', 'labels'];
    const maxTotal = opts.maxResults || 10000;
    const onPage = opts.onPage || null;
    const allIssues = [];
    let nextPageToken = null;
    let safety = 0;

    while (safety < 200) {
      safety++;
      const body = {
        jql,
        fields,
        maxResults: PAGE_SIZE,
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const data = await this._request('POST', '/search/jql', body);
      const issues = data.issues || [];
      allIssues.push(...issues);

      if (onPage) onPage(allIssues.length, null);

      // New API: use isLast flag and nextPageToken
      if (data.isLast || !data.nextPageToken) break;
      nextPageToken = data.nextPageToken;
      if (allIssues.length >= maxTotal) break;
    }

    return allIssues;
  }

  /**
   * Get all issues for a specific fixVersion, with pagination.
   *
   * Pulls the **union** of `fixVersion = X OR "Target FixVersion" = X` so
   * target-only tickets (planned for X but not yet cherry-picked) are visible
   * in Nectar's release truth view. See customfield_10594 semantics above.
   *
   * @param {string} versionName - e.g., "4.2.1"
   * @param {object} opts - { updatedSince, onPage }
   */
  async getIssuesForVersion(versionName, opts = {}) {
    const escaped = versionName.replace(/"/g, '\\"');
    let jql = `(fixVersion = "${escaped}" OR cf[10594] = "${escaped}")`;
    if (opts.updatedSince) {
      // JIRA date format: "2026-04-07 00:00"
      jql += ` AND updated >= "${opts.updatedSince}"`;
    }
    jql += ' ORDER BY key ASC';

    return this.searchAllIssues(jql, {
      onPage: opts.onPage,
      // Include Target FixVersion in the fields list so jira-sync can populate it
      fields: [
        'summary', 'status', 'issuetype', 'assignee', 'fixVersions', 'labels',
        'customfield_10594', 'customfield_10691', 'customfield_10992', 'customfield_10993',
      ],
    });
  }

  /**
   * Get approximate issue count for a JQL query (new API).
   */
  async getApproximateCount(jql) {
    try {
      const data = await this._request('POST', '/search/approximate-count', { jql });
      return data.count || 0;
    } catch {
      return 0;
    }
  }

  async getVersionIssueCount(versionName) {
    return this.getApproximateCount(`fixVersion = "${versionName}"`);
  }

  // ── Single-page search (now using new API) ────────────

  async searchIssues(jql, maxResults = 100) {
    const data = await this._request('POST', '/search/jql', {
      jql,
      maxResults,
      fields: ['summary', 'status', 'issuetype', 'assignee', 'fixVersions', 'labels'],
    });
    return data.issues || [];
  }

  // ── Transitions ─────────────────────────────────────────

  async getTransitions(key) {
    const data = await this._request('GET', `/issue/${key}/transitions`);
    return data.transitions || [];
  }

  async transitionIssue(key, transitionName) {
    const transitions = await this.getTransitions(key);
    const match = transitions.find(t =>
      t.name.toLowerCase() === transitionName.toLowerCase()
    );
    if (!match) {
      throw new Error(`Transition "${transitionName}" not found for ${key}. Available: ${transitions.map(t => t.name).join(', ')}`);
    }
    return this._request('POST', `/issue/${key}/transitions`, {
      transition: { id: match.id },
    });
  }

  // ── Comments ────────────────────────────────────────────

  async addComment(key, bodyText) {
    return this._request('POST', `/issue/${key}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: bodyText }],
        }],
      },
    });
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * Normalize a JIRA issue into Nectar's ticket format.
   * Defensively reads the Zoho Desk custom fields — if the caller didn't request
   * them in the JIRA `fields` list they'll simply be null.
   */
  static normalizeIssue(issue) {
    const fields = issue.fields || {};
    const rawZoho = fields[ZOHO_CUSTOM_FIELD];
    return {
      key: issue.key,
      summary: fields.summary || '',
      status: fields.status ? fields.status.name : 'Unknown',
      type: fields.issuetype ? fields.issuetype.name : 'Unknown',
      assignee: fields.assignee ? fields.assignee.displayName : null,
      fixVersions: (fields.fixVersions || []).map(v => v.name),
      targetFixVersions: JiraClient.extractVersionNames(fields[TARGET_FIX_VERSION_FIELD]),
      labels: fields.labels || [],
      zohoRef: rawZoho ? JiraClient.parseZohoRef(rawZoho) : null,
      submitterName: fields[ZOHO_SUBMITTER_NAME_FIELD] || null,
      submitterEmail: fields[ZOHO_SUBMITTER_EMAIL_FIELD] || null,
    };
  }

  /**
   * Normalize a multi-version custom field into a flat array of version name strings.
   * Custom fields come back in several shapes depending on JIRA API surface:
   *   - array of version objects: [{ name: "4.1.2", id: "..." }, ...]
   *   - array of strings: ["4.1.2", "4.2.0"]
   *   - wrapped object: { value: ["4.1.2", "4.2.0"] }
   *   - null / undefined / empty
   * This helper survives all of them and always returns string[].
   */
  static extractVersionNames(raw) {
    if (raw == null) return [];
    let candidate = raw;
    // Unwrap { value: ... } envelope
    if (!Array.isArray(candidate) && typeof candidate === 'object' && 'value' in candidate) {
      candidate = candidate.value;
    }
    if (candidate == null) return [];
    if (!Array.isArray(candidate)) candidate = [candidate];
    return candidate
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Parse whatever humans have pasted into the JIRA `Zoho Desk Ticket ID` field.
   *
   * Returns:
   *   { kind: 'url',          id, ticketNumber: null, zohoUrl, raw, parseable: true  }
   *   { kind: 'ticketNumber', id: null, ticketNumber, zohoUrl: null, raw, parseable: true  }
   *   { kind: 'unknown',      id: null, ticketNumber: null, zohoUrl: null, raw, parseable: false }
   *
   * The canonical link we build for the URL case uses the /support/.../Cases/dv/<id>
   * shape that Zoho's own webUrl returns — reliable and portable.
   */
  static parseZohoRef(raw) {
    if (raw == null) return null;
    // Defensive unwrap: depending on how the custom field was configured in JIRA
    // the value may come back as a plain string, { value: "..." }, or an array.
    // All three have been observed in the wild.
    let candidate = raw;
    if (Array.isArray(candidate)) candidate = candidate[0];
    if (candidate && typeof candidate === 'object' && 'value' in candidate) {
      candidate = candidate.value;
    }
    if (candidate == null) return null;
    const value = String(candidate).trim();
    if (!value) return null;

    const base = {
      raw: value,
      id: null,
      ticketNumber: null,
      zohoUrl: null,
    };

    // Format 1 — full agent URL containing /details/<numericId>
    const urlMatch = value.match(ZOHO_URL_ID_REGEX);
    if (urlMatch) {
      const id = urlMatch[1];
      return {
        ...base,
        kind: 'url',
        id,
        zohoUrl: `https://support.vivtechnologies.com/support/vivtechnologies/ShowHomePage.do#Cases/dv/${id}`,
        parseable: true,
      };
    }

    // Format 2 — #VHC-xxxx shorthand
    const tnMatch = value.match(ZOHO_TICKET_NUMBER_REGEX);
    // Only count this as a short-form ref if the whole value is basically just the ticket
    // number (not a free-form sentence that happens to mention VHC-xxxx).
    if (tnMatch && value.length <= tnMatch[0].length + 4) {
      return {
        ...base,
        kind: 'ticketNumber',
        ticketNumber: tnMatch[1].toUpperCase(),
        parseable: true,
      };
    }

    // Format 3 — unparseable garbage (e.g., someone pasted the subject)
    return {
      ...base,
      kind: 'unknown',
      parseable: false,
    };
  }

  /**
   * Map JIRA status to Nectar ticket state.
   */
  static mapStatus(jiraStatus) {
    const s = (jiraStatus || '').toLowerCase();
    if (s.includes('cherry picked')) return 'cherry-picked';
    if (s.includes('ready for testing') || s.includes('ready for qa')) return 'ready-for-testing';
    if (s.includes('in progress') || s.includes('in development')) return 'in-progress';
    if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'done';
    if (s.includes('to do') || s.includes('open') || s.includes('backlog')) return 'pending';
    return 'pending';
  }

  static extractKeys(text) {
    return [...new Set((text.match(JIRA_KEY_REGEX) || []))];
  }

  static buildJQL(keys, extraClauses = '') {
    if (!keys.length) return null;
    let jql = `key in (${keys.join(',')})`;
    if (extraClauses) jql += ` AND ${extraClauses}`;
    return jql + ' ORDER BY created DESC';
  }
}

module.exports = JiraClient;
