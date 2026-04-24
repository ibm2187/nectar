/**
 * Parser for JIRA's customfield_11157 "Linked Zoho Tickets" field.
 *
 * The field is a Paragraph (rich-text) custom field. Atlassian returns it
 * as one of three shapes depending on API version and whether the field
 * contains structured data:
 *   1. ADF document (Atlassian Document Format) — most common, structured
 *   2. Wiki markup string, e.g. "[#VHC-4165|https://.../dv/1078812000011967813]"
 *   3. Null / empty / placeholder junk ("." etc.)
 *
 * Each link contains:
 *   - The Zoho ticket number ("#VHC-4165") — human-readable, per-department
 *   - The Zoho internal ticket ID — 15–20 digit number embedded in the URL
 *     path after "/Cases/dv/". This is the Zoho API's ticketId.
 *
 * Parser returns an array of link objects, empty on null/junk input. Handles
 * multiple links in a single field (dedup by internal ID).
 */

const URL_INTERNAL_ID_RE = /\/dv\/(\d{15,20})/;
const TICKET_NUMBER_RE = /#([A-Z]+)-(\d+)/;
const WIKI_LINK_RE = /\[#([A-Z]+-\d+)\|([^\]]+)\]/g;

/**
 * Parse a JIRA customfield_11157 value into normalized link objects.
 *
 * @param {object|string|null} raw - The raw field value from JIRA
 * @returns {Array<{ticketNumber:string, zohoTicketId:string, deptPrefix:string, url:string}>}
 */
function parseLinkedZohoTickets(raw) {
  if (!raw) return [];

  // Atlassian MCP sometimes wraps the field in { value: ... }. Unwrap.
  const value = raw && typeof raw === 'object' && 'value' in raw && Object.keys(raw).length === 1
    ? raw.value
    : raw;

  if (!value) return [];

  if (typeof value === 'object' && value.type === 'doc') {
    return _parseAdf(value);
  }
  if (typeof value === 'string') {
    return _parseWikiMarkup(value);
  }
  return [];
}

/**
 * Walk an ADF doc collecting every text node that carries a link mark.
 */
function _parseAdf(doc) {
  const results = [];
  const seen = new Set();

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;

    // Text node with link mark
    if (node.type === 'text' && Array.isArray(node.marks)) {
      const linkMark = node.marks.find(m => m && m.type === 'link' && m.attrs && m.attrs.href);
      if (linkMark) {
        const link = _toLink(node.text, linkMark.attrs.href);
        if (link && !seen.has(link.zohoTicketId)) {
          seen.add(link.zohoTicketId);
          results.push(link);
        }
      }
    }

    // Recurse through content arrays
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };

  visit(doc);
  return results;
}

/**
 * Parse wiki-markup-style values like "[#VHC-4165|https://.../dv/12345]".
 */
function _parseWikiMarkup(str) {
  const results = [];
  const seen = new Set();
  let m;
  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(str)) !== null) {
    const link = _toLink('#' + m[1], m[2]);
    if (link && !seen.has(link.zohoTicketId)) {
      seen.add(link.zohoTicketId);
      results.push(link);
    }
  }
  return results;
}

/**
 * Build a link object from a text label + URL. Returns null if parse fails.
 */
function _toLink(text, url) {
  if (!text || !url) return null;

  const urlMatch = url.match(URL_INTERNAL_ID_RE);
  if (!urlMatch) return null;

  const numMatch = String(text).match(TICKET_NUMBER_RE);
  if (!numMatch) return null;

  return {
    ticketNumber: `${numMatch[1]}-${numMatch[2]}`,
    deptPrefix: numMatch[1],
    zohoTicketId: urlMatch[1],
    url,
  };
}

module.exports = {
  parseLinkedZohoTickets,
  // Exported for unit tests
  _parseAdf,
  _parseWikiMarkup,
};
