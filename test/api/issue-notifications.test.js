import { describe, it, expect, beforeEach, vi } from 'vitest';
const IssueNotifier = require('../../src/api/issue-notifications');
const { createTestDb } = require('../../src/core/db');
const { appendReporterFooter } = require('../../src/integrations/issue-reporter');

/**
 * IssueNotifier — DMs the reporter when their issue gets a comment or
 * is referenced by a PR. These tests exercise the resolution chain
 * (marker → userStore → peopleDirectory → slack), the notification-
 * settings gate, and the PR-link dedup table.
 */

const REPORTER_EMAIL = 'eric@vivtechnologies.com';
const REPORTER_NAME = 'Eric Fang';
const REPORTER_SLACK_ID = 'U123';

// Use the real helper so fixtures stay in sync with the actual on-wire
// body format (otherwise stripReporterFooter / extractReporter assertions
// against this fixture diverge from production behavior).
function bodyWithMarker(prefix = 'Steps to repro:') {
  return appendReporterFooter(prefix, REPORTER_EMAIL);
}

function makeDeps({
  notifyEnabled = true,
  hasUser = true,
  hasSlackId = true,
} = {}) {
  const db = createTestDb();
  const slack = {
    dmUser: vi.fn().mockResolvedValue(undefined),
    // Real postMessage returns { ok, error? } and never throws — match that
    // contract so tests exercise the same branches as production.
    postMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
  const github = {
    repo: 'mavencare/nectar',
    getIssue: vi.fn(),
  };
  const userStore = {
    getUser: vi.fn(email =>
      hasUser && email === REPORTER_EMAIL
        ? { email, name: REPORTER_NAME }
        : null
    ),
  };
  const peopleDirectory = {
    resolveSlackId: vi.fn(name =>
      hasSlackId && name === REPORTER_NAME
        ? { slackId: REPORTER_SLACK_ID, username: 'eric', name, match: 'exact' }
        : null
    ),
  };
  const notificationSettings = {
    get: vi.fn().mockReturnValue(notifyEnabled),
  };
  const notifier = new IssueNotifier({
    slack, github, userStore, peopleDirectory, notificationSettings, db,
  });
  return { notifier, slack, github, userStore, peopleDirectory, notificationSettings, db };
}

// ── issue_comment ─────────────────────────────────────────────────

describe('IssueNotifier.onIssueComment', () => {
  it('DMs the reporter when someone comments on their issue', async () => {
    const { notifier, slack } = makeDeps();
    const result = await notifier.onIssueComment({
      action: 'created',
      issue: { number: 42, title: 'Page is slow', body: bodyWithMarker(), html_url: 'https://gh/i/42' },
      comment: { user: { login: 'nukul' }, body: 'thx for reporting!', html_url: 'https://gh/c/1' },
    });
    expect(result).toMatchObject({ sent: true, reporter: REPORTER_EMAIL, slackId: REPORTER_SLACK_ID });
    expect(slack.dmUser).toHaveBeenCalledTimes(1);
    const [slackId, text] = slack.dmUser.mock.calls[0];
    expect(slackId).toBe(REPORTER_SLACK_ID);
    expect(text).toMatch(/nukul/);
    expect(text).toMatch(/#42 Page is slow/);
    expect(text).toMatch(/thx for reporting!/);
  });

  it('skips actions other than created (edited, deleted)', async () => {
    const { notifier, slack } = makeDeps();
    const r = await notifier.onIssueComment({ action: 'edited', issue: { body: bodyWithMarker() } });
    expect(r).toEqual({ skipped: 'not-created' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('skips PR comments (issue_comment fires for both — pull_request is set on PR comments)', async () => {
    const { notifier, slack } = makeDeps();
    const r = await notifier.onIssueComment({
      action: 'created',
      issue: { number: 1, body: bodyWithMarker(), pull_request: { url: '...' } },
      comment: {},
    });
    expect(r).toEqual({ skipped: 'pr-comment' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('skips when the issue body has no Nectar reporter marker', async () => {
    const { notifier, slack } = makeDeps();
    const r = await notifier.onIssueComment({
      action: 'created',
      issue: { number: 1, body: 'opened directly on github.com — no marker' },
      comment: {},
    });
    expect(r).toEqual({ skipped: 'no-reporter' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('skips when the per-category preference is disabled', async () => {
    const { notifier, slack, notificationSettings } = makeDeps({ notifyEnabled: false });
    const r = await notifier.onIssueComment({
      action: 'created',
      issue: { number: 1, body: bodyWithMarker(), html_url: '' },
      comment: { user: { login: 'x' }, body: '' },
    });
    expect(r).toEqual({ skipped: 'category-disabled' });
    expect(slack.dmUser).not.toHaveBeenCalled();
    expect(notificationSettings.get).toHaveBeenCalledWith('issueActivity');
  });

  it('skips when the reporter has no Nectar user record', async () => {
    const { notifier, slack } = makeDeps({ hasUser: false });
    const r = await notifier.onIssueComment({
      action: 'created',
      issue: { number: 1, body: bodyWithMarker(), html_url: '' },
      comment: { user: { login: 'x' }, body: '' },
    });
    expect(r).toEqual({ skipped: 'no-slack-id' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('skips when the user has no resolvable Slack ID', async () => {
    const { notifier, slack } = makeDeps({ hasSlackId: false });
    const r = await notifier.onIssueComment({
      action: 'created',
      issue: { number: 1, body: bodyWithMarker(), html_url: '' },
      comment: { user: { login: 'x' }, body: '' },
    });
    expect(r).toEqual({ skipped: 'no-slack-id' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });
});

// ── pull_request ──────────────────────────────────────────────────

describe('IssueNotifier.onPullRequest', () => {
  function prPayload({ body = 'Closes #42', action = 'opened', number = 7 } = {}) {
    return {
      action,
      pull_request: {
        number,
        title: 'Fix the slow page',
        body,
        html_url: `https://gh/pr/${number}`,
        user: { login: 'nukul' },
      },
    };
  }

  it('DMs the reporter of each linked issue', async () => {
    const { notifier, slack, github } = makeDeps();
    github.getIssue.mockImplementation(async (n) => ({
      number: n,
      title: `Issue ${n}`,
      body: bodyWithMarker(),
    }));
    const r = await notifier.onPullRequest(prPayload({ body: 'Closes #42 and resolves #43' }));
    expect(r.results).toHaveLength(2);
    expect(slack.dmUser).toHaveBeenCalledTimes(2);
    expect(slack.dmUser.mock.calls[0][1]).toMatch(/#7 Fix the slow page/);
    expect(slack.dmUser.mock.calls[0][1]).toMatch(/#42/);
    expect(slack.dmUser.mock.calls[1][1]).toMatch(/#43/);
  });

  it('skips actions other than opened/edited/reopened', async () => {
    const { notifier, slack } = makeDeps();
    const r = await notifier.onPullRequest(prPayload({ action: 'closed' }));
    expect(r).toEqual({ skipped: 'action=closed' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('skips PR bodies with no closing references', async () => {
    const { notifier, slack } = makeDeps();
    const r = await notifier.onPullRequest(prPayload({ body: 'just a refactor, see #42' }));
    expect(r).toEqual({ skipped: 'no-references' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('does not re-notify when the same PR-issue pair has been seen before', async () => {
    const { notifier, slack, github } = makeDeps();
    github.getIssue.mockResolvedValue({ number: 42, title: 'X', body: bodyWithMarker() });
    // First edit: notify
    await notifier.onPullRequest(prPayload({ body: 'Closes #42', action: 'opened' }));
    expect(slack.dmUser).toHaveBeenCalledTimes(1);
    // Second edit (e.g. PR description tweaked): suppressed by dedup table
    const r = await notifier.onPullRequest(prPayload({ body: 'Closes #42', action: 'edited' }));
    expect(slack.dmUser).toHaveBeenCalledTimes(1);
    expect(r.results[0]).toEqual({ issueNumber: 42, skipped: 'already-notified' });
  });

  it('marks an issue notified even when no Slack ID resolves, so we do not re-fetch on every edit', async () => {
    const { notifier, slack, github, db } = makeDeps({ hasSlackId: false });
    github.getIssue.mockResolvedValue({ number: 42, title: 'X', body: bodyWithMarker() });
    await notifier.onPullRequest(prPayload({ body: 'Closes #42' }));
    expect(slack.dmUser).not.toHaveBeenCalled();
    const row = db.prepare(
      'SELECT * FROM issue_pr_notifications WHERE issueNumber = 42 AND prNumber = 7'
    ).get();
    expect(row).toBeTruthy();
  });

  it('skips when the issue body has no marker (issue not opened via Nectar)', async () => {
    const { notifier, slack, github } = makeDeps();
    github.getIssue.mockResolvedValue({ number: 42, title: 'X', body: 'plain body' });
    const r = await notifier.onPullRequest(prPayload({ body: 'Closes #42' }));
    expect(r.results[0]).toMatchObject({ issueNumber: 42, skipped: 'no-reporter' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('skips when the per-category preference is disabled', async () => {
    const { notifier, slack } = makeDeps({ notifyEnabled: false });
    const r = await notifier.onPullRequest(prPayload({ body: 'Closes #42' }));
    expect(r).toEqual({ skipped: 'category-disabled' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('survives a transient github.getIssue failure without crashing', async () => {
    const { notifier, slack, github } = makeDeps();
    github.getIssue.mockRejectedValue(new Error('rate limit'));
    const r = await notifier.onPullRequest(prPayload({ body: 'Closes #42' }));
    expect(r.results[0]).toMatchObject({ issueNumber: 42, skipped: 'fetch-failed' });
    expect(slack.dmUser).not.toHaveBeenCalled();
  });

  it('releases the dedup claim on getIssue failure so a retry can proceed', async () => {
    // Without releasing the claim, a transient GitHub API failure would
    // permanently mute the notification — the next webhook for the same
    // (issue, PR) pair would see the row as "already notified".
    const { notifier, slack, github, db } = makeDeps();
    github.getIssue
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce({ number: 42, title: 'X', body: bodyWithMarker() });

    await notifier.onPullRequest(prPayload({ body: 'Closes #42' }));
    expect(slack.dmUser).not.toHaveBeenCalled();
    // Row should NOT exist after a failed fetch
    const after1 = db.prepare('SELECT * FROM issue_pr_notifications WHERE issueNumber = 42 AND prNumber = 7').get();
    expect(after1).toBeFalsy();

    // Retry succeeds and DMs
    await notifier.onPullRequest(prPayload({ body: 'Closes #42', action: 'edited' }));
    expect(slack.dmUser).toHaveBeenCalledTimes(1);
  });
});

// ── Concurrency ───────────────────────────────────────────────────

describe('IssueNotifier — race-safe dedup', () => {
  it('only one of two concurrent webhooks for the same (issue, PR) pair sends a DM', async () => {
    // The previous SELECT-then-INSERT flow let two handlers both pass the
    // dedup check across the awaited getIssue/dmUser window. The fix is an
    // INSERT-OR-IGNORE-first claim that's atomic under SQLite.
    const db = createTestDb();
    const slackCalls = [];
    const slack = {
      dmUser: vi.fn(async () => {
        // Simulate Slack latency so a second handler can interleave
        await new Promise(r => setTimeout(r, 5));
        slackCalls.push(Date.now());
      }),
    };
    const github = {
      repo: 'mavencare/nectar',
      getIssue: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 2));
        return { number: 42, title: 'X', body: '<!-- nectar:reporter=eric@vivtechnologies.com -->' };
      }),
    };
    const userStore = { getUser: () => ({ email: REPORTER_EMAIL, name: REPORTER_NAME }) };
    const peopleDirectory = {
      resolveSlackId: () => ({ slackId: REPORTER_SLACK_ID, username: 'eric', name: REPORTER_NAME, match: 'exact' }),
    };
    const notificationSettings = { get: () => true };
    const notifier = new IssueNotifier({
      slack, github, userStore, peopleDirectory, notificationSettings, db,
    });

    const payload = {
      action: 'opened',
      pull_request: {
        number: 7, title: 'fix', body: 'Closes #42',
        html_url: 'u', user: { login: 'someone' },
      },
    };

    // Fire two concurrent handlers — exactly one must DM.
    const [a, b] = await Promise.all([
      notifier.onPullRequest(payload),
      notifier.onPullRequest(payload),
    ]);
    expect(slack.dmUser).toHaveBeenCalledTimes(1);
    const sentResults = [a, b].flatMap(r => r.results || []).filter(x => x.sent);
    const skippedResults = [a, b].flatMap(r => r.results || []).filter(x => x.skipped === 'already-notified');
    expect(sentResults).toHaveLength(1);
    expect(skippedResults).toHaveLength(1);
  });
});

// ── issues.opened (channel post) ──────────────────────────────────

describe('IssueNotifier.onIssueOpened', () => {
  function openedPayload({ body = 'Repro:\n1. step', login = 'octocat', title = 'Page is slow' } = {}) {
    return {
      action: 'opened',
      issue: {
        number: 42,
        title,
        body,
        html_url: 'https://github.com/mavencare/nectar/issues/42',
        user: { login },
      },
    };
  }

  it('posts to the configured channel for a new issue with a Nectar marker (resolved name)', async () => {
    const { notifier, slack } = makeDeps();
    notifier.channel = '#nectar';
    const result = await notifier.onIssueOpened(openedPayload({ body: bodyWithMarker('Repro:') }));
    expect(result).toMatchObject({ posted: true, channel: '#nectar' });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    const [channel, text] = slack.postMessage.mock.calls[0];
    expect(channel).toBe('#nectar');
    expect(text).toMatch(/#42 Page is slow/);
    // Reporter resolved to the Nectar user's display name
    expect(text).toMatch(/\*Eric Fang\* via Nectar/);
    // The marker + visible footer are not included in the snippet
    expect(text).not.toMatch(/nectar:reporter=/);
    expect(text).not.toMatch(/_Reported via Nectar/);
  });

  it('falls back to the GitHub author login when the body has no marker', async () => {
    const { notifier, slack } = makeDeps();
    await notifier.onIssueOpened(openedPayload({ body: 'opened straight from github.com', login: 'octocat' }));
    const text = slack.postMessage.mock.calls[0][1];
    expect(text).toMatch(/\*octocat\* on github\.com/);
    expect(text).toMatch(/> opened straight from github\.com/);
  });

  it('uses the marker email when the user is not in the users table', async () => {
    const { notifier, slack } = makeDeps({ hasUser: false });
    await notifier.onIssueOpened(openedPayload({ body: bodyWithMarker() }));
    const text = slack.postMessage.mock.calls[0][1];
    // No user.name → fall back to the email itself
    expect(text).toMatch(/\*eric@vivtechnologies\.com\* via Nectar/);
  });

  it('skips actions other than opened (edited, closed, labeled, …)', async () => {
    const { notifier, slack } = makeDeps();
    for (const action of ['edited', 'closed', 'reopened', 'labeled', 'assigned']) {
      const r = await notifier.onIssueOpened({ ...openedPayload(), action });
      expect(r).toEqual({ skipped: 'not-opened' });
    }
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('skips when the per-category preference is disabled', async () => {
    const { notifier, slack, notificationSettings } = makeDeps({ notifyEnabled: false });
    const r = await notifier.onIssueOpened(openedPayload());
    expect(r).toEqual({ skipped: 'category-disabled' });
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(notificationSettings.get).toHaveBeenCalledWith('issueOpened');
  });

  it('escapes Slack mrkdwn special chars in title and login', async () => {
    const { notifier, slack } = makeDeps();
    await notifier.onIssueOpened(openedPayload({
      title: 'evil> *<!everyone>*',
      login: 'attacker|fake',
      body: 'plain',
    }));
    const text = slack.postMessage.mock.calls[0][1];
    // The mrkdwn-special chars are scrubbed from the dynamic title and login;
    // only the static <url|...> link wrapper remains.
    const titleSegment = text.match(/#42 ([^*]*)\*/);
    expect(titleSegment[1]).not.toMatch(/[<>|]/);
    expect(text).not.toMatch(/<!everyone>/);
    expect(text).not.toMatch(/attacker\|fake/);
  });

  it('reports a postMessage failure surfaced via the return value', async () => {
    const { notifier, slack } = makeDeps();
    // slack.postMessage swallows errors and reports them via { ok: false } —
    // never throws. We must check the return value.
    slack.postMessage.mockResolvedValueOnce({ ok: false, error: 'not_in_channel' });
    const r = await notifier.onIssueOpened(openedPayload());
    expect(r).toEqual({ posted: false, error: 'not_in_channel' });
  });

  it('treats an undefined postMessage return as failure (defensive)', async () => {
    const { notifier, slack } = makeDeps();
    slack.postMessage.mockResolvedValueOnce(undefined);
    const r = await notifier.onIssueOpened(openedPayload());
    expect(r).toEqual({ posted: false, error: 'unknown' });
  });

  it('uses the default channel #nectar when none is configured', () => {
    const { notifier } = makeDeps();
    expect(notifier.channel).toBe('#nectar');
  });

  it('does not double-post when GitHub redelivers the same issues.opened event', async () => {
    // GitHub allows manual webhook redelivery, plus retries on 5xx. Without
    // dedup, #nectar would get the same post twice for one issue.
    const { notifier, slack } = makeDeps();
    await notifier.onIssueOpened(openedPayload());
    const second = await notifier.onIssueOpened(openedPayload());
    expect(second).toMatchObject({ skipped: 'already-posted' });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
  });

  it('releases the channel-post claim if postMessage fails so a redelivery can succeed', async () => {
    const { notifier, slack } = makeDeps();
    slack.postMessage
      .mockResolvedValueOnce({ ok: false, error: 'not_in_channel' })
      .mockResolvedValueOnce({ ok: true });
    const first = await notifier.onIssueOpened(openedPayload());
    expect(first).toEqual({ posted: false, error: 'not_in_channel' });
    // Operator fixes the channel membership and GitHub redelivers — succeeds
    const second = await notifier.onIssueOpened(openedPayload());
    expect(second).toMatchObject({ posted: true });
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
  });

  it('strips standalone image-embed lines from the snippet and tags the post with the count', async () => {
    const { notifier, slack } = makeDeps();
    const body = [
      'Page broke after I uploaded a screenshot.',
      '',
      '![screenshot.png](https://raw.githubusercontent.com/mavencare/nectar/issue-attachments/uploads/2026/04/a.png)',
      '![console.png](https://raw.githubusercontent.com/mavencare/nectar/issue-attachments/uploads/2026/04/b.png)',
    ].join('\n');
    await notifier.onIssueOpened(openedPayload({ body }));
    const text = slack.postMessage.mock.calls[0][1];
    expect(text).toMatch(/· 2 attachments/);
    expect(text).toMatch(/> Page broke after I uploaded a screenshot\./);
    // Raw markdown image refs must not leak into the snippet
    expect(text).not.toMatch(/!\[/);
    expect(text).not.toMatch(/raw\.githubusercontent/);
  });

  it('uses singular "1 attachment" when only one image is embedded', async () => {
    const { notifier, slack } = makeDeps();
    const body = 'Repro:\n![one.png](https://raw.example/one.png)';
    await notifier.onIssueOpened(openedPayload({ body }));
    const text = slack.postMessage.mock.calls[0][1];
    expect(text).toMatch(/· 1 attachment(?!s)/);
  });

  it('produces a snippet-less post with the count tag for an attachment-only body', async () => {
    const { notifier, slack } = makeDeps();
    const body = '![a.png](https://raw.example/a.png)\n![b.png](https://raw.example/b.png)';
    await notifier.onIssueOpened(openedPayload({ body }));
    const text = slack.postMessage.mock.calls[0][1];
    expect(text).toMatch(/· 2 attachments/);
    // Nothing left to quote — no "> ..." snippet line at all
    expect(text).not.toMatch(/\n> /);
  });

  it('preserves inline image refs that share a line with prose', async () => {
    const { notifier, slack } = makeDeps();
    // An inline embed (not a standalone line) is part of the surrounding
    // sentence and should NOT be stripped — the author chose to weave it in.
    const body = 'See ![tiny](https://x/y.png) here for details.';
    await notifier.onIssueOpened(openedPayload({ body }));
    const text = slack.postMessage.mock.calls[0][1];
    expect(text).not.toMatch(/· \d+ attachment/);
    expect(text).toMatch(/See !\[tiny\]\(https:\/\/x\/y\.png\) here/);
  });

  it('omits the attachment tag when there are none', async () => {
    const { notifier, slack } = makeDeps();
    await notifier.onIssueOpened(openedPayload({ body: 'plain text issue' }));
    const text = slack.postMessage.mock.calls[0][1];
    expect(text).not.toMatch(/· \d+ attachment/);
  });

  it('honors a constructor-supplied channel override', () => {
    const db = createTestDb();
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined), dmUser: vi.fn() };
    const notifier = new IssueNotifier({
      slack, github: { repo: 'mavencare/nectar' },
      userStore: { getUser: () => null },
      peopleDirectory: { resolveSlackId: () => null },
      notificationSettings: { get: () => true },
      db,
      channel: '#my-custom-channel',
    });
    expect(notifier.channel).toBe('#my-custom-channel');
  });
});

// ── Slack injection ───────────────────────────────────────────────

describe('IssueNotifier — Slack mrkdwn escaping', () => {
  it('strips < > | from issue titles so an attacker can not break out of the link or inject @here', async () => {
    const { notifier, slack } = makeDeps();
    await notifier.onIssueComment({
      action: 'created',
      issue: {
        number: 42,
        // Malicious title that, unescaped, would break the <url|text> link
        // and inject a working channel-wide mention.
        title: 'foo> *<!channel> everyone*',
        body: bodyWithMarker(),
        html_url: 'https://gh/i/42',
      },
      comment: { user: { login: 'nukul' }, body: 'hi', html_url: 'https://gh/c/1' },
    });
    expect(slack.dmUser).toHaveBeenCalledTimes(1);
    const text = slack.dmUser.mock.calls[0][1];
    expect(text).not.toMatch(/[<>|]/g === null ? /never/ : /<!channel>/);
    // The four mrkdwn-special chars should be absent from the dynamic title
    // (the static `<url|text>` link wrapper is the only `<` / `|` / `>` left)
    const titleSegment = text.match(/#42 ([^*]*)\*/);
    expect(titleSegment).not.toBeNull();
    expect(titleSegment[1]).not.toMatch(/[<>|]/);
  });

  it('strips mrkdwn-special chars from comment snippet too', async () => {
    const { notifier, slack } = makeDeps();
    await notifier.onIssueComment({
      action: 'created',
      issue: { number: 1, title: 'T', body: bodyWithMarker(), html_url: 'u' },
      comment: { user: { login: 'x' }, body: 'oh no <!here> | <https://evil>' },
    });
    const text = slack.dmUser.mock.calls[0][1];
    // The blockquote line should not contain the special chars from the
    // attacker-controlled snippet
    const quoteLine = text.split('\n').find(l => l.startsWith('> '));
    expect(quoteLine).toBeTruthy();
    expect(quoteLine).not.toMatch(/<!here>/);
    expect(quoteLine).not.toMatch(/[|]/);
  });

  it('strips mrkdwn from PR title in pull_request notifications', async () => {
    const { notifier, slack, github } = makeDeps();
    github.getIssue.mockResolvedValue({ number: 42, title: 'plain', body: bodyWithMarker() });
    await notifier.onPullRequest({
      action: 'opened',
      pull_request: {
        number: 7,
        title: 'evil> *<!everyone>*',
        body: 'Closes #42',
        html_url: 'https://gh/pr/7',
        user: { login: 'attacker|fake' },
      },
    });
    const text = slack.dmUser.mock.calls[0][1];
    // The PR title segment must not contain link-breaking chars
    const prSegment = text.match(/#7 ([^*]*)\*/);
    expect(prSegment[1]).not.toMatch(/[<>|]/);
    // The pr.user.login was also escaped (no `|` anywhere outside the
    // static link wrapper for the PR url)
    expect(text).not.toMatch(/attacker\|fake/);
  });
});
