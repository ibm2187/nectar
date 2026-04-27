/**
 * Helpers for tagging GitHub issues opened via Nectar with the
 * Nectar user who clicked "New Issue". GitHub records the PAT owner
 * as the issue's `user` regardless of who actually clicked, so we
 * embed the reporter in the body itself:
 *
 *   - A hidden HTML comment (machine-readable, not rendered by GitHub)
 *   - A visible markdown footer (human-readable on github.com)
 *
 * The HTML comment is the source of truth; the footer is a courtesy.
 */

const MARKER_RE = /<!--\s*nectar:reporter=([^\s>]+)\s*-->/;
const MARKER_RE_GLOBAL = /<!--\s*nectar:reporter=[^\s>]+\s*-->/g;
// Anchored to end-of-string (no /m flag) — only strips the footer when it
// is genuinely the tail of the body. With /m, a stray "---\n_Reported via
// Nectar by **x**_" mid-body could be falsely matched.
const FOOTER_TAIL_RE = /\n*---\n+_Reported via Nectar by \*\*[^*]+\*\*_\s*$/;

function buildMarker(email) {
  return `<!-- nectar:reporter=${email} -->`;
}

// Escape Markdown special chars when interpolating into the visible
// footer — an email like `first_last@co.com` would otherwise render with
// stray italics. The marker itself stores the raw email and is exempt:
// HTML comments aren't markdown-rendered by GitHub, and extractReporter
// reads the unescaped value.
function escapeMd(text) {
  return String(text || '').replace(/([\\*_[\]`])/g, '\\$1');
}

function buildFooter(email) {
  return `${buildMarker(email)}\n\n---\n_Reported via Nectar by **${escapeMd(email)}**_`;
}

/**
 * Tag a body with the authoritative reporter. Any caller-supplied marker
 * is stripped first — otherwise an authenticated client could impersonate
 * another user by pre-injecting `<!-- nectar:reporter=victim@... -->`.
 * No-op when email is falsy.
 */
function appendReporterFooter(body, email) {
  if (!email) return body || '';
  const stripped = (body || '')
    .replace(MARKER_RE_GLOBAL, '')
    .replace(FOOTER_TAIL_RE, '')
    .replace(/\s+$/, '');
  const sep = stripped.length ? '\n\n' : '';
  return `${stripped}${sep}${buildFooter(email)}`;
}

/**
 * Extract the Nectar reporter email from an issue body. Returns null
 * when the marker is absent (e.g. issue opened directly on github.com).
 */
function extractReporter(body) {
  if (!body) return null;
  const m = body.match(MARKER_RE);
  return m ? m[1] : null;
}

/**
 * Return the body with the Nectar marker(s) and visible "Reported via …"
 * footer removed. Use when previewing the body to humans (channel posts,
 * UI rendering); the marker is plumbing, not content.
 */
function stripReporterFooter(body) {
  if (!body) return body || '';
  return body
    .replace(MARKER_RE_GLOBAL, '')
    .replace(FOOTER_TAIL_RE, '')
    .replace(/\s+$/, '');
}

/**
 * Parse closing-keyword issue references out of a PR body.
 * Recognizes the GitHub-supported keywords: close(s|d), fix(es|ed),
 * resolve(s|d). Returns a sorted, de-duplicated array of issue numbers.
 *
 *   "Closes #42 and fixes #43.\nCloses  #42 again." → [42, 43]
 *   "Closes: #42"                                   → [42]   (colon form)
 *
 * Cross-repo references (e.g. `org/repo#42`) are intentionally ignored —
 * we only care about issues filed against this same repo.
 */
// `[\s:]+` after the keyword matches both `Closes #42` and `Closes: #42` —
// GitHub supports both forms. The whitespace is required, so `closes#42`
// without a separator does not match (also matching GitHub's parser).
const CLOSING_REF_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+#(\d+)\b/gi;

function parseClosingReferences(body) {
  if (!body) return [];
  const seen = new Set();
  for (const match of body.matchAll(CLOSING_REF_RE)) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

module.exports = {
  appendReporterFooter,
  extractReporter,
  stripReporterFooter,
  parseClosingReferences,
  MARKER_RE,
  CLOSING_REF_RE,
};
