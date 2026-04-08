const log = require('../core/log');

const JIRA_KEY_REGEX = /\b(DEV|MAV)-\d+\b/g;
const PAGE_SIZE = 100;

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
   * @param {string} versionName - e.g., "4.2.1"
   * @param {object} opts - { updatedSince, onPage }
   */
  async getIssuesForVersion(versionName, opts = {}) {
    let jql = `fixVersion = "${versionName}"`;
    if (opts.updatedSince) {
      // JIRA date format: "2026-04-07 00:00"
      jql += ` AND updated >= "${opts.updatedSince}"`;
    }
    jql += ' ORDER BY key ASC';

    return this.searchAllIssues(jql, {
      onPage: opts.onPage,
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
   */
  static normalizeIssue(issue) {
    const fields = issue.fields || {};
    return {
      key: issue.key,
      summary: fields.summary || '',
      status: fields.status ? fields.status.name : 'Unknown',
      type: fields.issuetype ? fields.issuetype.name : 'Unknown',
      assignee: fields.assignee ? fields.assignee.displayName : null,
      fixVersions: (fields.fixVersions || []).map(v => v.name),
      labels: fields.labels || [],
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
