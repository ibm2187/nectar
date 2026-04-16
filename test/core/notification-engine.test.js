import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const NotificationEngine = require('../../src/core/notification-engine');

describe('NotificationEngine', () => {
  let engine;
  let mockSlack;
  let mockReleases;
  let mockPeople;
  let mockUserStore;
  let mockSettings;

  beforeEach(() => {
    mockSlack = {
      isConfigured: () => true,
      dmUser: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
    };

    mockReleases = {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn(),
    };

    mockPeople = {
      resolveSlackId: vi.fn(),
    };

    mockUserStore = {
      listUsers: vi.fn().mockReturnValue([]),
    };

    mockSettings = {
      get: vi.fn().mockReturnValue(true),
    };

    engine = new NotificationEngine({
      slack: mockSlack,
      releases: mockReleases,
      releaseNotifier: null,
      peopleDirectory: mockPeople,
      userStore: mockUserStore,
      notificationSettings: mockSettings,
      config: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ────────────────────────────────────────────────────
  // Daily Digest
  // ────────────────────────────────────────────────────

  describe('sendDailyDigests', () => {
    it('skips when no releases are in the window', async () => {
      mockReleases.list.mockReturnValue([]);
      await engine.sendDailyDigests();
      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('skips releases with no date', async () => {
      mockReleases.list.mockReturnValue([
        { version: '4.2.0', state: 'planning', jiraReleaseDate: null, tickets: [] },
      ]);
      await engine.sendDailyDigests();
      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('skips done releases', async () => {
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        { version: '4.2.0', state: 'done', jiraReleaseDate: future, tickets: [
          { key: 'DEV-1', assignee: 'Alice', jiraStatus: 'In Progress' }
        ]},
      ]);
      await engine.sendDailyDigests();
      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('skips archived releases', async () => {
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        { version: '4.2.0', state: 'planning', jiraArchived: true, jiraReleaseDate: future,
          tickets: [{ key: 'DEV-1', assignee: 'Alice', jiraStatus: 'In Progress' }]},
      ]);
      await engine.sendDailyDigests();
      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('sends DMs grouped by assignee for undone tickets', async () => {
      vi.useFakeTimers();
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        {
          version: '4.2.0',
          state: 'stabilizing',
          jiraReleaseDate: future,
          tickets: [
            { key: 'DEV-1', summary: 'Fix bug', assignee: 'Alice', jiraStatus: 'In Progress' },
            { key: 'DEV-2', summary: 'Other bug', assignee: 'Bob', jiraStatus: 'Ready For Testing' },
          ],
        },
      ]);

      mockPeople.resolveSlackId
        .mockImplementation(name => name === 'Alice' ? { slackId: 'U_ALICE' } :
                                     name === 'Bob' ? { slackId: 'U_BOB' } : null);

      const promise = engine.sendDailyDigests();
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSlack.dmUser).toHaveBeenCalledTimes(2);
      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_ALICE', expect.stringContaining('DEV-1'));
      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_BOB', expect.stringContaining('DEV-2'));
    });

    it('includes QA assignees as separate recipients', async () => {
      vi.useFakeTimers();
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        {
          version: '4.2.0',
          state: 'stabilizing',
          jiraReleaseDate: future,
          tickets: [
            { key: 'DEV-1', summary: 'Bug', assignee: 'Alice', qaAssignee: 'Carol', jiraStatus: 'In Testing' },
          ],
        },
      ]);

      mockPeople.resolveSlackId
        .mockImplementation(name => name === 'Alice' ? { slackId: 'U_ALICE' } :
                                     name === 'Carol' ? { slackId: 'U_CAROL' } : null);

      const promise = engine.sendDailyDigests();
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSlack.dmUser).toHaveBeenCalledTimes(2);
    });

    it('skips people who cannot be resolved to Slack IDs', async () => {
      vi.useFakeTimers();
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        {
          version: '4.2.0', state: 'stabilizing', jiraReleaseDate: future,
          tickets: [
            { key: 'DEV-1', summary: 'X', assignee: 'Known', jiraStatus: 'In Progress' },
            { key: 'DEV-2', summary: 'Y', assignee: 'Unknown', jiraStatus: 'In Progress' },
          ],
        },
      ]);

      mockPeople.resolveSlackId
        .mockImplementation(name => name === 'Known' ? { slackId: 'U_KNOWN' } : null);

      const promise = engine.sendDailyDigests();
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSlack.dmUser).toHaveBeenCalledTimes(1);
      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_KNOWN', expect.anything());
    });

    it('filters out done tickets', async () => {
      vi.useFakeTimers();
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        {
          version: '4.2.0', state: 'stabilizing', jiraReleaseDate: future,
          tickets: [
            { key: 'DEV-1', summary: 'Done one', assignee: 'Alice', jiraStatus: 'Done' },
            { key: 'DEV-2', summary: 'Active', assignee: 'Alice', jiraStatus: 'In Progress' },
          ],
        },
      ]);

      mockPeople.resolveSlackId.mockReturnValue({ slackId: 'U_ALICE' });

      const promise = engine.sendDailyDigests();
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSlack.dmUser).toHaveBeenCalledTimes(1);
      const [, message] = mockSlack.dmUser.mock.calls[0];
      expect(message).toContain('DEV-2');
      expect(message).not.toContain('DEV-1');
    });

    it('respects user notification preferences (opt-out)', async () => {
      vi.useFakeTimers();
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        {
          version: '4.2.0', state: 'stabilizing', jiraReleaseDate: future,
          tickets: [{ key: 'DEV-1', summary: 'X', assignee: 'Alice', jiraStatus: 'In Progress' }],
        },
      ]);
      mockPeople.resolveSlackId.mockImplementation(name =>
        name === 'Alice' ? { slackId: 'U_ALICE' } : null);
      mockUserStore.listUsers.mockReturnValue([
        { email: 'alice@t.co', name: 'Alice', notificationPrefs: { dailyDigest: false } },
      ]);

      const promise = engine.sendDailyDigests();
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────
  // Send digest to single user
  // ────────────────────────────────────────────────────

  describe('sendDailyDigestToUser', () => {
    it('returns error when user has no tickets', async () => {
      mockReleases.list.mockReturnValue([]);
      const result = await engine.sendDailyDigestToUser('U_ALICE');
      expect(result.ok).toBe(false);
      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('sends DM only to targeted user', async () => {
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      mockReleases.list.mockReturnValue([
        {
          version: '4.2.0', state: 'stabilizing', jiraReleaseDate: future,
          tickets: [
            { key: 'DEV-1', summary: 'Alice work', assignee: 'Alice', jiraStatus: 'In Progress' },
            { key: 'DEV-2', summary: 'Bob work', assignee: 'Bob', jiraStatus: 'In Progress' },
          ],
        },
      ]);

      mockPeople.resolveSlackId.mockImplementation(name =>
        name === 'Alice' ? { slackId: 'U_ALICE' } :
        name === 'Bob' ? { slackId: 'U_BOB' } : null);

      const result = await engine.sendDailyDigestToUser('U_ALICE');

      expect(result.ok).toBe(true);
      expect(result.ticketCount).toBe(1);
      expect(mockSlack.dmUser).toHaveBeenCalledTimes(1);
      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_ALICE', expect.stringContaining('DEV-1'));
    });
  });

  // ────────────────────────────────────────────────────
  // Build transitions
  // ────────────────────────────────────────────────────

  describe('checkBuildTransitions', () => {
    it('does not alert on cold start (first observation)', async () => {
      const buildProjects = [
        { projectName: 'p1', latestStatus: 'FAILED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ];
      await engine.checkBuildTransitions(buildProjects);
      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('alerts on SUCCEEDED → FAILED transition', async () => {
      // First sync — cold start, no alerts
      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'SUCCEEDED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ]);

      mockReleases.get.mockReturnValue({
        version: '4.2.0',
        tickets: [{ key: 'DEV-1', summary: 'Bug', assignee: 'Alice' }],
      });
      mockPeople.resolveSlackId.mockReturnValue({ slackId: 'U_ALICE' });

      // Second sync — failure
      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'FAILED', jiraKeys: ['DEV-1'], version: '4.2.0',
          builds: [{ buildNumber: 47 }] },
      ]);

      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_ALICE', expect.stringContaining('failed'));
    });

    it('alerts on FAILED → SUCCEEDED transition (recovery)', async () => {
      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'FAILED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ]);

      mockReleases.get.mockReturnValue({
        version: '4.2.0',
        tickets: [{ key: 'DEV-1', summary: 'Bug', assignee: 'Alice' }],
      });
      mockPeople.resolveSlackId.mockReturnValue({ slackId: 'U_ALICE' });

      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'SUCCEEDED', jiraKeys: ['DEV-1'], version: '4.2.0',
          builds: [{ buildNumber: 48 }] },
      ]);

      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_ALICE', expect.stringContaining('recovered'));
    });

    it('does not alert when status unchanged', async () => {
      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'SUCCEEDED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ]);
      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'SUCCEEDED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ]);
      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('does not send if buildFailures toggle is off', async () => {
      mockSettings.get.mockImplementation(key => key !== 'buildFailures');

      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'SUCCEEDED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ]);
      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'FAILED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ]);

      expect(mockSlack.dmUser).not.toHaveBeenCalled();
    });

    it('DMs both dev and QA assignees', async () => {
      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'SUCCEEDED', jiraKeys: ['DEV-1'], version: '4.2.0' },
      ]);

      mockReleases.get.mockReturnValue({
        version: '4.2.0',
        tickets: [{ key: 'DEV-1', summary: 'Bug', assignee: 'Alice', qaAssignee: 'Bob' }],
      });
      mockPeople.resolveSlackId.mockImplementation(name =>
        name === 'Alice' ? { slackId: 'U_ALICE' } :
        name === 'Bob' ? { slackId: 'U_BOB' } : null);

      await engine.checkBuildTransitions([
        { projectName: 'p1', latestStatus: 'FAILED', jiraKeys: ['DEV-1'], version: '4.2.0',
          builds: [{ buildNumber: 1 }] },
      ]);

      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_ALICE', expect.anything());
      expect(mockSlack.dmUser).toHaveBeenCalledWith('U_BOB', expect.anything());
    });
  });

  // ────────────────────────────────────────────────────
  // Ticket change buffering
  // ────────────────────────────────────────────────────

  describe('bufferTicketChanges', () => {
    it('accumulates added tickets', () => {
      engine.bufferTicketChanges('4.2.0', {
        added: [{ key: 'DEV-1', summary: 'New ticket' }],
        removed: [],
      });
      engine.bufferTicketChanges('4.2.0', {
        added: [{ key: 'DEV-2', summary: 'Another' }],
        removed: [],
      });

      const buf = engine._ticketChanges.get('4.2.0');
      expect(buf.added.size).toBe(2);
      expect(buf.added.has('DEV-1')).toBe(true);
      expect(buf.added.has('DEV-2')).toBe(true);
    });

    it('accumulates removed tickets', () => {
      engine.bufferTicketChanges('4.2.0', {
        added: [],
        removed: [{ key: 'DEV-3', summary: 'Gone' }],
      });

      const buf = engine._ticketChanges.get('4.2.0');
      expect(buf.removed.size).toBe(1);
      expect(buf.removed.has('DEV-3')).toBe(true);
    });

    it('cancels out add+remove of same ticket', () => {
      engine.bufferTicketChanges('4.2.0', {
        added: [{ key: 'DEV-1', summary: 'Flip-flop' }],
        removed: [],
      });
      engine.bufferTicketChanges('4.2.0', {
        added: [],
        removed: [{ key: 'DEV-1', summary: 'Flip-flop' }],
      });

      const buf = engine._ticketChanges.get('4.2.0');
      expect(buf.added.has('DEV-1')).toBe(false);
      expect(buf.removed.has('DEV-1')).toBe(false);
    });

    it('cancels out remove+add of same ticket', () => {
      engine.bufferTicketChanges('4.2.0', {
        added: [],
        removed: [{ key: 'DEV-1', summary: 'Back' }],
      });
      engine.bufferTicketChanges('4.2.0', {
        added: [{ key: 'DEV-1', summary: 'Back' }],
        removed: [],
      });

      const buf = engine._ticketChanges.get('4.2.0');
      expect(buf.added.has('DEV-1')).toBe(false);
      expect(buf.removed.has('DEV-1')).toBe(false);
    });

    it('buffers per-version separately', () => {
      engine.bufferTicketChanges('4.2.0', { added: [{ key: 'A' }], removed: [] });
      engine.bufferTicketChanges('4.3.0', { added: [{ key: 'B' }], removed: [] });

      expect(engine._ticketChanges.get('4.2.0').added.size).toBe(1);
      expect(engine._ticketChanges.get('4.3.0').added.size).toBe(1);
    });
  });

  describe('sendTicketChangeDigests', () => {
    it('does nothing when buffer is empty', async () => {
      await engine.sendTicketChangeDigests();
      expect(mockSlack.postMessage).not.toHaveBeenCalled();
    });

    it('posts to release channel and drains buffer', async () => {
      engine.bufferTicketChanges('4.2.0', {
        added: [{ key: 'DEV-1', summary: 'New' }],
        removed: [{ key: 'DEV-2', summary: 'Gone' }],
      });

      await engine.sendTicketChangeDigests();

      expect(mockSlack.postMessage).toHaveBeenCalledWith(
        '#releases-4-2-0',
        expect.stringContaining('DEV-1')
      );
      expect(mockSlack.postMessage.mock.calls[0][1]).toContain('DEV-2');
      expect(engine._ticketChanges.size).toBe(0); // buffer drained
    });

    it('shows +N more cutoff when many tickets changed', async () => {
      const many = Array.from({ length: 10 }, (_, i) => ({ key: `DEV-${i}`, summary: `T${i}` }));
      engine.bufferTicketChanges('4.2.0', { added: many, removed: [] });

      await engine.sendTicketChangeDigests();

      const [, message] = mockSlack.postMessage.mock.calls[0];
      expect(message).toContain('+5 more'); // SHOW_LIMIT = 5
    });

    it('skips versions with only canceled-out changes', async () => {
      engine.bufferTicketChanges('4.2.0', { added: [{ key: 'DEV-1' }], removed: [] });
      engine.bufferTicketChanges('4.2.0', { added: [], removed: [{ key: 'DEV-1' }] });

      await engine.sendTicketChangeDigests();
      expect(mockSlack.postMessage).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────

  describe('stop', () => {
    it('stops cleanly when never started', () => {
      expect(() => engine.stop()).not.toThrow();
    });
  });
});
