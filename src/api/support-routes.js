const { Router } = require('express');
const log = require('../core/log');

/**
 * /api/support/* — routes backing the /support UI surface.
 *
 * All reads hit the Zoho mirror in SQLite; no live Zoho API calls except
 * for the manual refresh endpoint. Every response includes a
 * `lastSyncedAt` / `mirrorLastRunAt` timestamp so the UI can surface
 * "Last synced Xmin ago" to the user.
 *
 * @param {object} deps
 *   zohoStore:       ZohoStore
 *   zohoMirrorSync:  ZohoMirrorSync (optional — enables /refresh endpoint)
 *   userStore:       UserStore (for display-name enrichment)
 */
function createSupportRoutes({ zohoStore, zohoMirrorSync, userStore } = {}) {
  const router = Router();
  if (!zohoStore) {
    // Degraded mode: respond 503 on every route so the UI can detect
    // that the feature isn't wired rather than silently 404'ing.
    router.use((req, res) => res.status(503).json({ error: 'zoho mirror not configured' }));
    return router;
  }

  const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  // ── GET /support/sync-status ───────────────────────────
  router.get('/sync-status', (req, res) => {
    const meta = zohoStore.getSyncMeta();
    res.json({
      lastRunAt: meta.lastRunAt,
      lastBackfillAt: meta.lastBackfillAt,
      backfillStatus: meta.backfillStatus,
      backfillProgress: meta.backfillProgress,
      backfillTotal: meta.backfillTotal,
      lastModifiedCursor: meta.lastModifiedCursor,
      lastSyncError: meta.lastSyncError,
      lastSyncDurationMs: meta.lastSyncDurationMs,
      ticketCount: zohoStore.count(),
      openTicketCount: zohoStore.countOpen(),
    });
  });

  // ── GET /support/stats ─────────────────────────────────
  // Filter-aware count distribution for the /support page's grouping tabs.
  // Accepts the same filter params as /tickets, plus `groupBy` (assignee |
  // account | deptPrefix | fixVersion). The dimension being grouped on is
  // stripped from the filters before counting (otherwise the pills would
  // show only the currently-selected entity).
  //
  // Response: { total, open, matchTotal, groupBy, groups: [...] }
  // For backwards compat with older clients, when groupBy is omitted (or
  // 'assignee') we ALSO include the legacy `assignees` field.
  const VALID_GROUP_BY = new Set(['assignee', 'account', 'deptPrefix', 'fixVersion']);
  router.get('/stats', (req, res) => {
    const opts = _parseListQuery(req.query);
    delete opts.limit;
    delete opts.offset;
    const groupBy = VALID_GROUP_BY.has(req.query.groupBy) ? req.query.groupBy : 'assignee';

    const rows = zohoStore.groupedStats(opts, groupBy);

    // Enrich each row's displayName when it has a richer source than the raw key.
    const groups = rows.map(row => {
      let displayName = row.displayName;
      if (groupBy === 'assignee' && row.key && userStore) {
        const user = userStore.getUser(row.key);
        if (user) displayName = user.displayNameZoho || user.name || row.key;
      }
      return {
        key: row.key,
        displayName: displayName || row.key,
        total: Number(row.total || 0),
        openCount: Number(row.openCount || 0),
      };
    });

    const matchTotal = groups.reduce((sum, g) => sum + g.total, 0);
    const body = {
      total: zohoStore.count(),
      open: zohoStore.countOpen(),
      matchTotal,
      groupBy,
      groups,
    };
    // Legacy `assignees` field — old client builds may still read this.
    if (groupBy === 'assignee') {
      body.assignees = groups.map(g => ({
        assigneeEmail: g.key,
        displayName: g.displayName,
        total: g.total,
        openCount: g.openCount,
      }));
    }
    res.json(body);
  });

  // ── GET /support/accounts ──────────────────────────────
  router.get('/accounts', (req, res) => {
    res.json({ accounts: zohoStore.listAccounts() });
  });

  // ── GET /support/departments ───────────────────────────
  // Returns distinct ticket-number prefixes (VHC, BYD, THC, VIV) with counts
  // for the Department filter dropdown.
  router.get('/departments', (req, res) => {
    res.json({ departments: zohoStore.listDeptPrefixes() });
  });

  // ── GET /support/tickets ───────────────────────────────
  // Standard list-API contract:
  //   query:    page (1-based), pageSize, sort, sortDir, …all filter params
  //   response: { tickets, total, page, pageSize, hasMore, filters }
  // Legacy callers may still pass `limit` directly (used by presets/CSV
  // export); offset is derived from page/pageSize when provided.
  router.get('/tickets', (req, res) => {
    const opts = _parseListQuery(req.query);
    const total = zohoStore.countTickets(opts);
    const tickets = zohoStore.listTickets(opts);
    const ids = tickets.map(t => t.id);
    const linkCounts = zohoStore.linkCountsByTicketId(ids);
    const linkedJiras = zohoStore.linkedJirasByTicketId(ids);
    const enriched = tickets.map(t => ({
      ..._enrichTicket(t, { zohoStore, userStore }),
      linkedJiraCount: linkCounts.get(t.id) || 0,
      linkedJiras: linkedJiras.get(t.id) || [],
    }));
    const pageSize = opts.limit;
    const page = pageSize > 0 ? Math.floor((opts.offset || 0) / pageSize) + 1 : 1;
    res.json({
      tickets: enriched,
      total,
      page,
      pageSize,
      hasMore: (opts.offset || 0) + enriched.length < total,
      // legacy fields kept for any client still reading them
      count: enriched.length,
      filters: opts,
    });
  });

  // ── GET /support/tickets/:ticketNumber ─────────────────
  router.get('/tickets/:ticketNumber', (req, res) => {
    const ticket = zohoStore.getTicketByNumber(req.params.ticketNumber);
    if (!ticket) return res.status(404).json({ error: 'ticket not found in mirror' });

    const links = zohoStore.listLinksByZoho(ticket.id);
    const history = zohoStore.listHistory(ticket.id);
    const daysInCurrentStatus = zohoStore.daysInCurrentStatus(ticket.id);
    const enrichedJiras = zohoStore.linkedJirasByTicketId([ticket.id]).get(ticket.id) || [];

    res.json({
      ticket: _enrichTicket(ticket, { zohoStore, userStore }),
      linkedJiraKeys: links.map(l => ({ jiraKey: l.jiraKey, source: l.source })),
      linkedJiras: enrichedJiras,
      history,
      daysInCurrentStatus,
    });
  });

  // ── POST /support/tickets/:ticketNumber/refresh ────────
  router.post('/tickets/:ticketNumber/refresh', asyncHandler(async (req, res) => {
    if (!zohoMirrorSync) {
      return res.status(503).json({ error: 'zoho mirror sync not available' });
    }
    const existing = zohoStore.getTicketByNumber(req.params.ticketNumber);
    if (!existing) return res.status(404).json({ error: 'ticket not in mirror — use backfill first' });
    try {
      const refreshed = await zohoMirrorSync.refreshTicket(existing.id);
      res.json({ ticket: refreshed ? _enrichTicket(refreshed, { zohoStore, userStore }) : null });
    } catch (err) {
      log.warn(`support.refresh ${req.params.ticketNumber}: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  }));

  // ── POST /support/jira/links/batch ────────────────────
  // Reverse lookup for many JIRAs at once — used by /standup Customer
  // Resolutions section. Accepts { keys: string[] }.
  router.post('/jira/links/batch', (req, res) => {
    const raw = Array.isArray(req.body?.keys) ? req.body.keys.filter(Boolean) : [];
    // Cap at 200 keys per call — standup cards typically send <30 and this
    // prevents a megapayload from bloating the SQL IN(...) placeholder list.
    const keys = raw.slice(0, 200);
    if (keys.length === 0) return res.json({ linksByJiraKey: {} });
    const map = zohoStore.linkedZohoByJiraKeys(keys);
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    res.json({ linksByJiraKey: obj, truncated: raw.length > keys.length ? raw.length - keys.length : 0 });
  });

  // ── GET /support/jira/:jiraKey/links ───────────────────
  // Reverse lookup — which Zoho tickets does this JIRA link to?
  router.get('/jira/:jiraKey/links', (req, res) => {
    const links = zohoStore.listLinksByJira(req.params.jiraKey);
    const tickets = links
      .map(l => zohoStore.getTicketById(l.zohoTicketId))
      .filter(Boolean)
      .map(t => _enrichTicket(t, { zohoStore, userStore }));
    res.json({
      jiraKey: req.params.jiraKey,
      links,
      tickets,
    });
  });

  return router;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Translate query-string params into ZohoStore.listTickets options.
 * All array-valued filters accept either repeated keys (?status=A&status=B)
 * or comma-separated (?status=A,B).
 */
function _parseListQuery(q) {
  const opts = {};
  if (q.assigneeEmail) opts.assigneeEmail = String(q.assigneeEmail).toLowerCase();
  if (q.statuses) opts.statuses = _splitList(q.statuses);
  if (q.statusTypes) opts.statusTypes = _splitList(q.statusTypes);
  if (q.priorities) opts.priorities = _splitList(q.priorities);
  if (q.deptPrefixes) opts.deptPrefixes = _splitList(q.deptPrefixes);
  if (q.accountIds) opts.accountIds = _splitList(q.accountIds);
  if (q.openOnly === 'true' || q.openOnly === '1') opts.openOnly = true;
  if (q.closedOnly === 'true' || q.closedOnly === '1') opts.closedOnly = true;
  if (q.hasJiraLinks === 'true' || q.hasJiraLinks === '1') opts.hasJiraLinks = true;
  if (q.minAgeDays != null && q.minAgeDays !== '') opts.minAgeDays = Number(q.minAgeDays);
  if (q.maxAgeDays != null && q.maxAgeDays !== '') opts.maxAgeDays = Number(q.maxAgeDays);
  if (q.fixVersions) opts.fixVersions = _splitList(q.fixVersions);
  if (q.search) opts.search = String(q.search);

  // ── Paging + sorting (standard list-API contract) ──────
  // Accept `page`/`pageSize` (1-based), `sort`/`sortDir` from new clients;
  // fall back to legacy `limit`/`orderBy`/`orderDir` for backwards compat.
  const pageSize = q.pageSize ? Number(q.pageSize) : (q.limit ? Number(q.limit) : 50);
  // Cap at 5000 — high enough to fit the full open-ticket set so the
  // /support page can do per-assignee client-side pagination off a single
  // fetch. The store layer's listTickets caps to 5000 too.
  opts.limit = Math.min(Math.max(pageSize, 1), 5000);
  if (q.page) {
    const page = Math.max(1, Number(q.page));
    opts.offset = (page - 1) * opts.limit;
  } else if (q.offset) {
    opts.offset = Math.max(0, Number(q.offset));
  }
  if (q.sort) opts.orderBy = String(q.sort);
  else if (q.orderBy) opts.orderBy = String(q.orderBy);
  if (q.sortDir) opts.orderDir = String(q.sortDir);
  else if (q.orderDir) opts.orderDir = String(q.orderDir);
  return opts;
}

function _splitList(v) {
  if (Array.isArray(v)) return v.flatMap(_splitList);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Attach assignee display name + account name to a ticket row.
 * Keeps client-side rendering simple and avoids N+1 fetches.
 */
function _enrichTicket(ticket, { zohoStore, userStore }) {
  let assigneeName = null;
  if (ticket.assigneeEmail && userStore) {
    const user = userStore.getUser(ticket.assigneeEmail);
    if (user) assigneeName = user.displayNameZoho || user.name || ticket.assigneeEmail;
  }

  let accountName = null;
  if (ticket.accountId) {
    const acct = zohoStore.getAccount(ticket.accountId);
    if (acct) accountName = acct.name;
  }

  // Days since the ticket was last modified (simpler surrogate for
  // "Days on Dashboard" when status history is absent). Status-history-based
  // daysInCurrentStatus is on the detail endpoint.
  const ageDays = ticket.createdAt
    ? Math.floor((Date.now() - new Date(ticket.createdAt).getTime()) / 86400000)
    : null;

  return {
    ...ticket,
    // Don't ship rawPayload over the wire — detail endpoint returns it if needed
    rawPayload: undefined,
    assigneeName,
    accountName,
    ageDays,
  };
}

module.exports = { createSupportRoutes };
