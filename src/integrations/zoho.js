const log = require('../core/log');

const ZOHO_BASE = 'https://desk.zoho.com/api/v1';
const TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token';

/**
 * Zoho Desk REST API client with OAuth token management.
 * Ported from Hive's pm-sources.js — self-contained OAuth refresh flow.
 */
class ZohoClient {
  constructor() {
    this.orgId = process.env.ZOHO_DESK_ORG_ID || '';
    this._clientId = process.env.ZOHO_DESK_CLIENT_ID || '';
    this._clientSecret = process.env.ZOHO_DESK_CLIENT_SECRET || '';
    this._refreshToken = process.env.ZOHO_DESK_REFRESH_TOKEN || '';
    this._staticToken = process.env.ZOHO_DESK_API_TOKEN || '';
    this._accessToken = null;
    this._tokenExpiry = 0;
  }

  isConfigured() {
    return !!(this.orgId && (this._staticToken || (this._clientId && this._clientSecret && this._refreshToken)));
  }

  // ── Token management ───────────────────────────────────

  async _refreshAccessToken() {
    if (!this._clientId || !this._clientSecret || !this._refreshToken) {
      throw new Error('Zoho OAuth credentials not configured');
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this._refreshToken,
        client_id: this._clientId,
        client_secret: this._clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Zoho token refresh failed: ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error('Zoho token refresh returned no access_token');
    this._accessToken = data.access_token;
    this._tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
    return this._accessToken;
  }

  async _getToken() {
    if (this._accessToken && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }
    if (this._staticToken) return this._staticToken;
    return this._refreshAccessToken();
  }

  // ── Core request ───────────────────────────────────────

  async _request(method, path, body = null) {
    const token = await this._getToken();
    const url = `${ZOHO_BASE}${path}`;
    const headers = {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'orgId': this.orgId,
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
      throw new Error(`Zoho ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ── Tickets ────────────────────────────────────────────

  /**
   * Get a single ticket by ID.
   */
  async getTicket(ticketId) {
    return this._request('GET', `/tickets/${ticketId}`);
  }

  /**
   * List tickets with optional filters.
   * @param {object} opts - { departmentId, status, sortBy, limit }
   */
  async listTickets(opts = {}) {
    const params = new URLSearchParams();
    if (opts.departmentId) params.set('departmentId', opts.departmentId);
    if (opts.status) params.set('status', opts.status);
    if (opts.sortBy) params.set('sortBy', opts.sortBy);
    params.set('limit', String(opts.limit || 50));

    const data = await this._request('GET', `/tickets?${params}`);
    return data?.data || [];
  }

  /**
   * Get Zoho tickets linked to a JIRA issue via the integration.
   * Uses the Zoho Desk JIRA integration API endpoint.
   * @param {string} jiraIssueId - JIRA issue ID (numeric) or key
   */
  async getLinkedTickets(jiraIssueId) {
    try {
      const data = await this._request('GET', `/jiraIssue/${jiraIssueId}/tickets`);
      return data?.data || [];
    } catch (err) {
      // 404 = no linked tickets, which is fine
      if (err.message.includes('404')) return [];
      throw err;
    }
  }

  /**
   * Search tickets by query string.
   * @param {string} query
   * @param {object} opts - { departmentId, limit }
   */
  async searchTickets(query, opts = {}) {
    const params = new URLSearchParams({ searchStr: query });
    if (opts.departmentId) params.set('departmentId', opts.departmentId);
    params.set('limit', String(opts.limit || 50));

    try {
      const data = await this._request('GET', `/tickets/search?${params}`);
      return data?.data || [];
    } catch (err) {
      if (err.message.includes('404')) return [];
      throw err;
    }
  }

  /**
   * Normalize a Zoho ticket into Nectar's format.
   */
  static normalizeTicket(ticket) {
    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber || null,
      subject: ticket.subject || '',
      status: ticket.status || 'Unknown',
      statusType: ticket.statusType || null,
      priority: ticket.priority || null,
      category: ticket.category || null,
      subCategory: ticket.subCategory || null,
      channel: ticket.channel || null,
      departmentId: ticket.departmentId || null,
      contactId: ticket.contactId || null,
      email: ticket.email || null,
      createdTime: ticket.createdTime || null,
      modifiedTime: ticket.modifiedTime || null,
      closedTime: ticket.closedTime || null,
      webUrl: ticket.webUrl || null,
      // Custom fields for JIRA linkage
      associatedJiraIssues: ticket.cf?.cf_associated_jira_issues
        || ticket.customFields?.['Associated Jira Issues']
        || null,
      associatedJiraCount: ticket.cf?.cf_associated_jira_issues_count
        || ticket.customFields?.['Associated Jira Issues Count']
        || null,
      uatRelease: ticket.cf?.cf_if_uat_which_release
        || ticket.customFields?.['If UAT, which release?']
        || null,
      ticketType: ticket.cf?.cf_ticket_type
        || ticket.customFields?.['Ticket Type']
        || null,
    };
  }
}

module.exports = ZohoClient;
