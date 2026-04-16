const { EventEmitter } = require('events');
const log = require('./log');
const bamboohr = require('../integrations/bamboohr');

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Normalize a name for fuzzy matching (same rules as PeopleDirectory).
 * Lowercase, strip diacritics, collapse whitespace, strip punctuation.
 */
function normalize(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Availability store — in-memory index of BambooHR "Who's Out" + "Holidays"
 * feeds, refreshed hourly.
 *
 * Events:
 *   updated ({ outCount, holidayCount, at })
 */
class Availability extends EventEmitter {
  constructor() {
    super();
    this._outEvents = [];           // [{ name, startDate, endDate, summary, uid }]
    this._byNormalizedName = new Map(); // normalized-name → [events]
    this._holidays = new Map();     // ISO date → { name, countries, summary }
    this._unresolvedQueries = new Map(); // normalized query name → count (names queried but not in feed)
    this._loaded = false;
    this._lastRefreshedAt = null;
    this._refreshTimer = null;
  }

  async start() {
    await this.refresh();
    this._refreshTimer = setInterval(
      () => this.refresh().catch(err => log.error(`Availability refresh failed: ${err.message}`)),
      REFRESH_INTERVAL_MS,
    );
  }

  stop() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  }

  async refresh() {
    const whosOutUrl = process.env.BAMBOOHR_WHOSOUT_URL;
    const holidaysUrl = process.env.BAMBOOHR_HOLIDAYS_URL;

    if (!whosOutUrl && !holidaysUrl) {
      this._loaded = false;
      return { outCount: 0, holidayCount: 0 };
    }

    const [out, holidays] = await Promise.all([
      whosOutUrl ? bamboohr.fetchWhosOut(whosOutUrl) : Promise.resolve([]),
      holidaysUrl ? bamboohr.fetchHolidays(holidaysUrl) : Promise.resolve([]),
    ]);

    this._outEvents = out;
    this._byNormalizedName.clear();
    for (const e of out) {
      const key = normalize(e.name);
      if (!key) continue;
      if (!this._byNormalizedName.has(key)) this._byNormalizedName.set(key, []);
      this._byNormalizedName.get(key).push(e);
    }

    this._holidays.clear();
    for (const h of holidays) {
      this._holidays.set(h.date, { name: h.name, countries: h.countries, summary: h.summary });
    }

    this._loaded = true;
    this._lastRefreshedAt = new Date().toISOString();

    log.info(`Availability refreshed: ${out.length} out events, ${holidays.length} holidays`);
    this.emit('updated', { outCount: out.length, holidayCount: holidays.length, at: this._lastRefreshedAt });
    return { outCount: out.length, holidayCount: holidays.length };
  }

  isLoaded() { return this._loaded; }
  lastRefreshedAt() { return this._lastRefreshedAt; }

  // ── Person lookups ─────────────────────────────────────

  /**
   * Get all events (current + future) for a person.
   */
  _eventsFor(name) {
    if (!name) return [];
    const key = normalize(name);
    const exact = this._byNormalizedName.get(key);
    if (exact && exact.length) return exact;

    // Fuzzy fallback — first name + last-name initial
    const tokens = key.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const wantFirst = tokens[0];
      const wantLast = tokens[tokens.length - 1];
      for (const [storedKey, events] of this._byNormalizedName) {
        const storedTokens = storedKey.split(/\s+/).filter(Boolean);
        if (storedTokens.length < 2) continue;
        const storedLast = storedTokens[storedTokens.length - 1];
        const storedFirst = storedTokens[0];
        if (storedLast === wantLast && storedFirst[0] === wantFirst[0]) {
          return events;
        }
      }
    }

    // Track unresolved for admin debugging
    this._unresolvedQueries.set(name, (this._unresolvedQueries.get(name) || 0) + 1);
    return [];
  }

  /**
   * Is this person out on a given date (default: today)?
   */
  isPersonOut(name, date = null) {
    const d = date || todayIso();
    for (const e of this._eventsFor(name)) {
      if (e.startDate <= d && d <= e.endDate) return true;
    }
    return false;
  }

  /**
   * Get the current OOO event for this person (if any).
   * Returns { startDate, endDate, summary } or null.
   */
  getPersonOut(name, date = null) {
    const d = date || todayIso();
    for (const e of this._eventsFor(name)) {
      if (e.startDate <= d && d <= e.endDate) return e;
    }
    return null;
  }

  /**
   * Is this person out at any point in the [startDate, endDate] range?
   * Returns the overlapping event, or null.
   */
  getPersonOutInRange(name, startDate, endDate) {
    for (const e of this._eventsFor(name)) {
      // Overlap: e.startDate <= endDate AND e.endDate >= startDate
      if (e.startDate <= endDate && e.endDate >= startDate) return e;
    }
    return null;
  }

  /**
   * Everyone out on a given date.
   */
  listOutOn(date = null) {
    const d = date || todayIso();
    const out = [];
    for (const e of this._outEvents) {
      if (e.startDate <= d && d <= e.endDate) {
        out.push({ name: e.name, startDate: e.startDate, endDate: e.endDate, summary: e.summary });
      }
    }
    return out;
  }

  /**
   * Everyone currently out (i.e., today falls within their range).
   */
  listCurrentlyOut() {
    return this.listOutOn();
  }

  // ── Holiday + business-day helpers ────────────────────

  isHoliday(date) {
    return this._holidays.has(date);
  }

  getHoliday(date) {
    return this._holidays.get(date) || null;
  }

  /**
   * True if date is a business day (not weekend, not holiday).
   */
  isBusinessDay(date) {
    if (isWeekend(date)) return false;
    if (this.isHoliday(date)) return false;
    return true;
  }

  /**
   * Next N business days starting from `from` (default: today).
   * Returns array of ISO date strings.
   */
  nextBusinessDays(n, from = null) {
    const result = [];
    let d = from || todayIso();
    // Start from tomorrow if `from` is today (we want the "next" N, not today)
    d = addDaysIso(d, 1);
    let safety = 60;
    while (result.length < n && safety-- > 0) {
      if (this.isBusinessDay(d)) result.push(d);
      d = addDaysIso(d, 1);
    }
    return result;
  }

  // ── Admin / debug ──────────────────────────────────────

  getUnresolved() {
    return Array.from(this._unresolvedQueries.entries())
      .map(([name, count]) => ({ name, queryCount: count }))
      .sort((a, b) => b.queryCount - a.queryCount);
  }

  /**
   * Snapshot for API response.
   */
  snapshot() {
    const today = todayIso();
    const upcoming = [];
    for (const [date, h] of this._holidays) {
      if (date >= today) upcoming.push({ date, ...h });
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));
    return {
      loaded: this._loaded,
      lastRefreshedAt: this._lastRefreshedAt,
      currentlyOut: this.listCurrentlyOut(),
      upcomingHolidays: upcoming.slice(0, 10),
      todayIsHoliday: this.getHoliday(today),
    };
  }
}

Availability._normalize = normalize;
Availability._addDaysIso = addDaysIso;
Availability._isWeekend = isWeekend;

module.exports = Availability;
