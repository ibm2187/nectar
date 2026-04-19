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

// Component / area (used for roadmap theme grouping) and customer tag
// (multi-select — "Bayada", "CK", "Lumen", "Internal", etc.)
const COMPONENT_FIELD = 'customfield_10463';
const CUSTOMER_TAG_FIELD = 'customfield_11056';
const DEPLOYED_ENVS_FIELD = 'customfield_10595';
const QA_ASSIGNEE_FIELD = 'customfield_10466';
const PRODUCT_ASSIGNEE_FIELD = 'customfield_10757';

// Product taxonomy fields — added 2026-04-18 for roadmap categorization.
const MODULE_FIELD = 'customfield_11124';     // Viv Module — single select
const PRODUCT_FIELD = 'customfield_11123';    // Viv Product — multi checkbox
const PROJECTS_FIELD = 'customfield_11122';   // Projects — multi checkbox

// Risk and priority signals — used by Nectar to sort/filter tickets.
const RISK_LEVEL_FIELD = 'customfield_10650';        // "1 - Low Risk" / "2 - Medium Risk" / "3 - High Risk"
const CUSTOMER_PRIORITY_FIELD = 'customfield_11023'; // URGENT / High / Medium / Low / Internal Only

// Shared fields list — every Nectar JIRA query should request at minimum these
// so normalizeIssue can populate all fields consistently.
const NECTAR_FIELDS = [
  'summary', 'status', 'issuetype', 'assignee', 'reporter', 'fixVersions', 'labels',
  'priority',           // Built-in priority (Urgent/High/Medium/Low/Lowest)
  'created',            // Issue creation date (for triage views)
  'customfield_10594',  // Target FixVersion
  'customfield_10463',  // Component / area
  'customfield_11056',  // Customer tag
  'customfield_10691',  // Zoho Desk Ticket ID
  'customfield_10466',  // QA Assignee
  'customfield_10757',  // Product Assignee
  'customfield_10595',  // Deployed Environments
  'customfield_10650',  // Risk Level
  'customfield_11023',  // Customer Priority
  'customfield_10992',  // Submitter Name
  'customfield_10993',  // Submitter Email
  'customfield_11124',  // Viv Module
  'customfield_11123',  // Viv Product
  'customfield_11122',  // Projects
];
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
      fields: JiraClient.NECTAR_FIELDS,
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
      priority: fields.priority ? fields.priority.name : null,
      fixVersions: (fields.fixVersions || []).map(v => JiraClient.cleanVersionName(v.name)),
      targetFixVersions: JiraClient.extractVersionNames(fields[TARGET_FIX_VERSION_FIELD]).map(v => JiraClient.cleanVersionName(v)),
      labels: fields.labels || [],
      component: JiraClient.extractFieldString(fields[COMPONENT_FIELD]),
      module: JiraClient.extractFieldString(fields[MODULE_FIELD]),
      product: JiraClient.extractStringArray(fields[PRODUCT_FIELD]),
      projects: JiraClient.extractStringArray(fields[PROJECTS_FIELD]),
      customerTags: JiraClient.extractStringArray(fields[CUSTOMER_TAG_FIELD]),
      reporter: fields.reporter ? fields.reporter.displayName : null,
      qaAssignee: fields[QA_ASSIGNEE_FIELD] ? fields[QA_ASSIGNEE_FIELD].displayName || null : null,
      productAssignee: fields[PRODUCT_ASSIGNEE_FIELD] ? fields[PRODUCT_ASSIGNEE_FIELD].displayName || null : null,
      deployedEnvironments: JiraClient.extractStringArray(fields[DEPLOYED_ENVS_FIELD]),
      riskLevel: JiraClient.extractFieldString(fields[RISK_LEVEL_FIELD]),
      customerPriority: JiraClient.extractFieldString(fields[CUSTOMER_PRIORITY_FIELD]),
      zohoRef: rawZoho ? JiraClient.parseZohoRef(rawZoho) : null,
      submitterName: fields[ZOHO_SUBMITTER_NAME_FIELD] || null,
      submitterEmail: fields[ZOHO_SUBMITTER_EMAIL_FIELD] || null,
      statusCategory: fields.status && fields.status.statusCategory
        ? fields.status.statusCategory.name : null,
      created: fields.created || null,
      state: JiraClient.mapStatus(fields.status ? fields.status.name : 'Unknown'),
    };
  }

  /**
   * Strip repo prefixes from JIRA version names so they match release.version.
   * "iOS 2026.4.0" → "2026.4.0", "Android 2026.4.0" → "2026.4.0", "4.2.0" → "4.2.0"
   */
  static cleanVersionName(name) {
    if (!name) return name;
    const lower = name.toLowerCase();
    if (lower.startsWith('ios ')) return name.substring(4).trim();
    if (lower.startsWith('android ')) return name.substring(8).trim();
    return name;
  }

  /**
   * Extract a plain string from a custom field that may be string, { value: "..." },
   * or null. Returns string or null.
   */
  static extractFieldString(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') return raw || null;
    if (typeof raw === 'object' && 'value' in raw) {
      return typeof raw.value === 'string' ? raw.value || null : null;
    }
    return null;
  }

  /**
   * Extract a string array from a labels/multi-select custom field.
   * Handles: ["a","b"], { value: ["a","b"] }, [{ value: "a" }], null.
   */
  static extractStringArray(raw) {
    if (raw == null) return [];
    let candidate = raw;
    if (!Array.isArray(candidate) && typeof candidate === 'object' && 'value' in candidate) {
      candidate = candidate.value;
    }
    if (candidate == null) return [];
    if (!Array.isArray(candidate)) return [String(candidate)].filter(Boolean);
    return candidate
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.value === 'string') return item.value;
        if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
        return null;
      })
      .filter(Boolean);
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
  /**
   * Map JIRA status to Nectar internal state.
   * Based on full audit of all DEV project statuses (2026-04-15).
   */
  static mapStatus(jiraStatus) {
    const s = (jiraStatus || '').toLowerCase();

    // Done — JIRA category: Done
    if (s.includes('qa certified') || s.includes('no qa')) return 'done';
    if (s.includes('resolved') || s.includes('closed') || s === 'done') return 'done';
    if (s.includes('completed') || s.includes('released') || s.includes('rollout')) return 'done';
    if (s.includes('approved') && !s.includes('awaiting') && !s.includes('pending')) return 'done';
    if (s.includes('test passed') || s.includes('test deferred')) return 'done';
    if (s.includes('dqa approved') || s.includes('design complete')) return 'done';
    if (s.includes('migrated') || s.includes('declined') || s.includes('rejected')) return 'done';
    if (s.includes('canceled') || s.includes('release night')) return 'done';

    // Cherry-picked
    if (s.includes('cherry picked') || s.includes('cherrypick is building')) return 'cherry-picked';
    if (s.includes('retest after cherry')) return 'ready-for-testing';

    // Ready for testing / QA
    if (s.includes('ready for testing') || s.includes('ready for qa')) return 'ready-for-testing';

    // In QA / testing
    if (s.includes('in testing') || s.includes('testing in branch') || s === 'testing') return 'in-progress';
    if (s.includes('validating') || s.includes('dqa required')) return 'in-progress';
    if (s.includes('pending customer qa') || s.includes('pending bug fix')) return 'in-progress';

    // Blocked / failed
    if (s === 'blocked' || s.includes('testing failed') || s.includes('test failed')) return 'in-progress';

    // In dev / active work
    if (s.includes('in progress') || s.includes('in development') || s === 'development') return 'in-progress';
    if (s.includes('in review') || s.includes('design in')) return 'in-progress';
    if (s.includes('implementing') || s.includes('remediation')) return 'in-progress';
    if (s.includes('waiting for cherry pick')) return 'in-progress';
    if (s.includes('investigating') || s.includes('escalated')) return 'in-progress';
    if (s.includes('pending dev') || s.includes('pending defect')) return 'in-progress';
    if (s.includes('pending config') || s.includes('pending priorit')) return 'in-progress';

    // Pending / to do
    if (s.includes('to do') || s.includes('open') || s.includes('backlog')) return 'pending';
    if (s.includes('planning') || s.includes('requirements') || s.includes('designs')) return 'pending';
    if (s.includes('on hold') || s.includes('deprioritized') || s.includes('archived')) return 'pending';
    if (s.includes('reopened') || s.includes('roadmap')) return 'pending';
    if (s.includes('ready to develop') || s.includes('ready for est')) return 'pending';
    if (s.includes('re-verify bug')) return 'pending';

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

JiraClient.NECTAR_FIELDS = NECTAR_FIELDS;
module.exports = JiraClient;
