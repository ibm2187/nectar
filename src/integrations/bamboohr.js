const log = require('../core/log');

/**
 * Parse a BambooHR iCal feed into an array of events.
 *
 * BambooHR's feed is well-behaved — no timezones, no recurrence, just
 * VEVENT blocks with DTSTART;VALUE=DATE, DTEND;VALUE=DATE, SUMMARY,
 * DESCRIPTION. We use a minimal line-folding + field parser rather than
 * pulling in node-ical as a dependency.
 *
 * iCal line folding: any line starting with a space is a continuation
 * of the previous line (see RFC 5545). SUMMARY and DESCRIPTION fields
 * wrap often because BambooHR puts long strings in them.
 */
function parseIcal(text) {
  // Un-fold lines: lines beginning with space or tab are continuations.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let current = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (raw === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const colonIdx = raw.indexOf(':');
    if (colonIdx < 0) continue;
    const left = raw.slice(0, colonIdx);
    const value = raw.slice(colonIdx + 1);
    // Handle params like DTSTART;VALUE=DATE
    const [name] = left.split(';');
    current[name] = value;
  }
  return events;
}

/**
 * Convert BambooHR's DTSTART/DTEND (YYYYMMDD) into ISO dates (YYYY-MM-DD).
 * iCal DTEND for all-day events is EXCLUSIVE — so "Mar 30 – Apr 2" becomes
 * DTSTART=20260330, DTEND=20260403. We subtract one day to get the inclusive
 * end date the UI expects.
 */
function toIsoDate(dt) {
  if (!dt || dt.length < 8) return null;
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
}

function subtractOneDay(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse person name from a Who's Out SUMMARY.
 *   "Piyush Puri (Vac - Curr YR - 4 days)" → "Piyush Puri"
 *   "Jane Doe"                              → "Jane Doe"
 */
function parsePersonName(summary) {
  if (!summary) return null;
  const idx = summary.indexOf(' (');
  return (idx > 0 ? summary.slice(0, idx) : summary).trim();
}

/**
 * Parse country codes from a Holiday SUMMARY.
 *   "Company Holiday - Good Friday - CDN"       → ["CDN"]
 *   "Company Holiday - Labour/Labor Day - CDN & USA" → ["CDN", "USA"]
 */
function parseHolidayName(summary) {
  if (!summary) return { name: summary, countries: [] };
  // Strip leading "Company Holiday - "
  let name = summary.replace(/^Company Holiday\s*[-–]\s*/, '');
  const countries = [];
  // Trailing country marker like "- CDN" or "- CDN & USA"
  const match = name.match(/\s*[-–]\s*([A-Z]{2,}(?:\s*&\s*[A-Z]{2,})*)\s*$/);
  if (match) {
    name = name.slice(0, match.index).trim();
    for (const c of match[1].split(/\s*&\s*/)) countries.push(c.trim());
  }
  return { name: name.trim(), countries };
}

async function fetchFeed(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Response is not an iCal feed');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse the "Who's Out" feed.
 * Returns array of { name, startDate, endDate, summary, uid }.
 */
async function fetchWhosOut(url) {
  if (!url) return [];
  try {
    const text = await fetchFeed(url);
    const events = parseIcal(text);
    return events.map(e => {
      const startDate = toIsoDate(e.DTSTART);
      const endDateExclusive = toIsoDate(e.DTEND);
      const endDate = endDateExclusive ? subtractOneDay(endDateExclusive) : startDate;
      return {
        uid: e.UID || null,
        name: parsePersonName(e.SUMMARY),
        startDate,
        endDate,
        summary: e.SUMMARY || '',
        description: e.DESCRIPTION || '',
      };
    }).filter(e => e.name && e.startDate);
  } catch (err) {
    log.error(`BambooHR whos-out fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch and parse the "Holidays" feed.
 * Returns array of { date, name, countries, summary, uid }.
 */
async function fetchHolidays(url) {
  if (!url) return [];
  try {
    const text = await fetchFeed(url);
    const events = parseIcal(text);
    return events.map(e => {
      const date = toIsoDate(e.DTSTART);
      const parsed = parseHolidayName(e.SUMMARY);
      return {
        uid: e.UID || null,
        date,
        name: parsed.name,
        countries: parsed.countries,
        summary: e.SUMMARY || '',
      };
    }).filter(e => e.date && e.name);
  } catch (err) {
    log.error(`BambooHR holidays fetch failed: ${err.message}`);
    return [];
  }
}

module.exports = {
  fetchWhosOut,
  fetchHolidays,
  // Exposed for tests
  _parseIcal: parseIcal,
  _parsePersonName: parsePersonName,
  _parseHolidayName: parseHolidayName,
  _toIsoDate: toIsoDate,
  _subtractOneDay: subtractOneDay,
};
