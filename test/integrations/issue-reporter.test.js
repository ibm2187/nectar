import { describe, it, expect } from 'vitest';
const {
  appendReporterFooter,
  extractReporter,
  stripReporterFooter,
  parseClosingReferences,
} = require('../../src/integrations/issue-reporter');

describe('appendReporterFooter', () => {
  it('appends a hidden marker + visible footer to a non-empty body', () => {
    const out = appendReporterFooter('Repro:\n1. click X', 'eric@vivtechnologies.com');
    expect(out).toMatch(/<!-- nectar:reporter=eric@vivtechnologies\.com -->/);
    expect(out).toMatch(/_Reported via Nectar by \*\*eric@vivtechnologies\.com\*\*_/);
    // The original body content is preserved verbatim above the footer.
    expect(out).toMatch(/^Repro:\n1\. click X/);
  });

  it('handles an empty body — no leading separator', () => {
    const out = appendReporterFooter('', 'a@b.com');
    expect(out.startsWith('<!-- nectar:reporter=a@b.com -->')).toBe(true);
  });

  it('handles a null body', () => {
    const out = appendReporterFooter(null, 'a@b.com');
    expect(extractReporter(out)).toBe('a@b.com');
  });

  it('returns the body unchanged when email is falsy', () => {
    expect(appendReporterFooter('hi', null)).toBe('hi');
    expect(appendReporterFooter('hi', '')).toBe('hi');
    expect(appendReporterFooter('hi', undefined)).toBe('hi');
  });

  it('does not double-tag a body that already has the same marker (no accumulation)', () => {
    const once = appendReporterFooter('hi', 'a@b.com');
    const twice = appendReporterFooter(once, 'a@b.com');
    expect(twice).toBe(once);
    expect(twice.match(/nectar:reporter=/g)).toHaveLength(1);
  });

  it('SECURITY: strips a pre-injected marker and overwrites with the supplied email', () => {
    // The threat: an authenticated caller hand-injects another user's marker
    // in the body of POST /api/issues to impersonate them. The helper must
    // treat the *email argument* as the sole source of truth.
    const malicious = 'Innocent body text\n<!-- nectar:reporter=victim@example.com -->';
    const out = appendReporterFooter(malicious, 'real-caller@viv.com');
    expect(extractReporter(out)).toBe('real-caller@viv.com');
    // Only one marker remains
    expect(out.match(/nectar:reporter=/g)).toHaveLength(1);
    // The visible content is preserved
    expect(out).toMatch(/^Innocent body text/);
  });

  it('SECURITY: strips multiple pre-injected markers, leaving only the authoritative one', () => {
    const malicious =
      '<!-- nectar:reporter=evil1@x.com -->\n' +
      'middle\n' +
      '<!-- nectar:reporter=evil2@x.com -->';
    const out = appendReporterFooter(malicious, 'real@viv.com');
    expect(extractReporter(out)).toBe('real@viv.com');
    expect(out.match(/nectar:reporter=/g)).toHaveLength(1);
  });

  it('does not duplicate the visible footer when the body already had one', () => {
    const once = appendReporterFooter('hi', 'a@b.com');
    const twice = appendReporterFooter(once, 'b@b.com');
    expect(twice.match(/_Reported via Nectar by/g)).toHaveLength(1);
  });

  it('escapes Markdown special chars in the visible footer email', () => {
    // `first_last@co.com` would otherwise render with `_last@co.com` italicized.
    const out = appendReporterFooter('hi', 'first_last@co.com');
    expect(out).toMatch(/\*\*first\\_last@co\.com\*\*/);
    // The marker itself stores the raw email — that's what extractReporter reads.
    expect(extractReporter(out)).toBe('first_last@co.com');
    // stripReporterFooter still removes the escaped footer cleanly.
    expect(stripReporterFooter(out)).toBe('hi');
  });
});

describe('extractReporter', () => {
  it('returns the email from a marker', () => {
    expect(extractReporter('foo\n<!-- nectar:reporter=eric@vivtechnologies.com -->\nbar'))
      .toBe('eric@vivtechnologies.com');
  });

  it('returns null when no marker is present', () => {
    expect(extractReporter('regular issue body, no Nectar marker here')).toBeNull();
  });

  it('returns null on null/empty body', () => {
    expect(extractReporter(null)).toBeNull();
    expect(extractReporter('')).toBeNull();
    expect(extractReporter(undefined)).toBeNull();
  });

  it('round-trips with appendReporterFooter', () => {
    const tagged = appendReporterFooter('a body', 'someone@viv.io');
    expect(extractReporter(tagged)).toBe('someone@viv.io');
  });

  it('handles whitespace inside the marker tolerantly', () => {
    expect(extractReporter('<!--   nectar:reporter=x@y.com   -->')).toBe('x@y.com');
  });
});

describe('stripReporterFooter', () => {
  it('removes the marker and the visible footer, leaving only the user content', () => {
    const tagged = appendReporterFooter('Steps:\n1. click X', 'a@b.com');
    const stripped = stripReporterFooter(tagged);
    expect(stripped).toBe('Steps:\n1. click X');
  });

  it('removes multiple markers if a body somehow has them', () => {
    const body = '<!-- nectar:reporter=x@y.com -->body<!-- nectar:reporter=z@w.com -->';
    expect(stripReporterFooter(body)).toBe('body');
  });

  it('leaves an unmarked body untouched (modulo trailing whitespace)', () => {
    expect(stripReporterFooter('plain body\n\n')).toBe('plain body');
  });

  it('handles null / empty', () => {
    expect(stripReporterFooter(null)).toBe('');
    expect(stripReporterFooter('')).toBe('');
  });

  it('does not falsely match a body that has the footer pattern in the middle (mid-body --- followed by Reported-via-Nectar text on a different line)', () => {
    // Without an end-of-string anchor, a /m-flagged regex would greedily
    // match the mid-body occurrence and chop off the rest.
    const body = 'intro\n\n---\n_Reported via Nectar by **stale@x.com**_\n\nimportant content stays';
    const out = stripReporterFooter(body);
    // The mid-body sequence is left alone since it's not the actual tail.
    expect(out).toMatch(/important content stays/);
  });
});

describe('parseClosingReferences', () => {
  it('finds Closes/Fixes/Resolves keywords + their tense variants', () => {
    expect(parseClosingReferences('Closes #1, fix #2, resolved #3')).toEqual([1, 2, 3]);
    expect(parseClosingReferences('closed #4 fixes #5 resolves #6')).toEqual([4, 5, 6]);
  });

  it('accepts the colon form GitHub also supports (Closes: #42)', () => {
    expect(parseClosingReferences('Closes: #42')).toEqual([42]);
    expect(parseClosingReferences('Fixes: #1, Resolves: #2')).toEqual([1, 2]);
  });

  it('does not match with no whitespace between keyword and #', () => {
    expect(parseClosingReferences('closes#42')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(parseClosingReferences('CLOSES #7 FiXeS #8')).toEqual([7, 8]);
  });

  it('de-duplicates and sorts numerically', () => {
    expect(parseClosingReferences('fixes #20 closes #3 resolves #20')).toEqual([3, 20]);
  });

  it('ignores cross-repo references like org/repo#42', () => {
    expect(parseClosingReferences('Closes mavencare/other#42 and fixes #7')).toEqual([7]);
  });

  it('returns [] for empty/null body', () => {
    expect(parseClosingReferences('')).toEqual([]);
    expect(parseClosingReferences(null)).toEqual([]);
    expect(parseClosingReferences(undefined)).toEqual([]);
  });

  it('returns [] when the keyword is missing', () => {
    expect(parseClosingReferences('See #42 for context')).toEqual([]);
    expect(parseClosingReferences('Just touching #42 — not closing it')).toEqual([]);
  });

  it('does not match keywords inside larger words', () => {
    // "prefixes #1" should not count as "fixes #1"
    expect(parseClosingReferences('prefixes #1 are different')).toEqual([]);
  });
});
