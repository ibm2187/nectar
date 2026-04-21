import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createTestDb } = require('../../src/core/db');
const NotificationSettings = require('../../src/core/notification-settings');
const SlackNotifier = require('../../src/integrations/slack');

/**
 * Create a SlackNotifier with mocked postMessage and ready = true,
 * wired to a real NotificationSettings backed by in-memory SQLite.
 */
function createMockSlack(db) {
  const orig = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const settings = new NotificationSettings({ db });
  process.env.NODE_ENV = orig;

  const slack = new SlackNotifier({});
  slack.ready = true;
  slack.notificationSettings = settings;

  const postMessageMock = vi.fn().mockResolvedValue({ ok: true });
  slack.app = { client: { chat: { postMessage: postMessageMock } } };

  return { slack, settings, postMessageMock };
}

describe('Notification integration tests', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // ── Release lifecycle → channel ──────────────────────

  describe('release lifecycle → channel', () => {
    it('notifyTransition posts to the correct release channel', async () => {
      const { slack, postMessageMock } = createMockSlack(db);
      const release = { version: '4.2.0' };
      await slack.notifyTransition(release, 'planning', 'cutting');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ channel: '#releases-4-2-0' })
      );
    });

    it('notifyReleaseCut posts to the correct release channel', async () => {
      const { slack, postMessageMock } = createMockSlack(db);
      const release = { version: '4.2.0', branch: 'release/4.2.0' };
      await slack.notifyReleaseCut(release);
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: '#releases-4-2-0',
          text: expect.stringContaining('has been cut'),
        })
      );
    });

    it('notifyDeployFailed posts failure message to release channel', async () => {
      const { slack, postMessageMock } = createMockSlack(db);
      const release = { version: '4.2.0' };
      const deployment = { customer: 'ck', env: 'ck-uat' };
      await slack.notifyDeployFailed(release, deployment);
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: '#releases-4-2-0',
          text: expect.stringContaining('FAILED'),
        })
      );
    });
  });

  // ── Redirect overrides ───────────────────────────────

  describe('redirect overrides', () => {
    it('channel redirect routes all channel posts to override channel', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.update({ redirectChannel: '#test-notifications' });

      await slack.notifyTransition({ version: '4.2.0' }, 'planning', 'cutting');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: '#test-notifications',
          text: expect.stringContaining('[-> #releases-4-2-0]'),
        })
      );
    });

    it('DM redirect routes all DMs to override user', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.update({ redirectDM: 'UOVERRIDE' });

      await slack.dmUser('U12345678', 'Hello');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'UOVERRIDE',
          text: expect.stringContaining('[-> DM U12345678]'),
        })
      );
    });

    it('notifyReleaseDeployment uses channel redirect', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.update({ redirectChannel: '#test-notifications' });

      await slack.notifyReleaseDeployment('4.2.0', 'ck-uat', 'ComfortKeepers', '4.1.0');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: '#test-notifications',
          text: expect.stringContaining('[-> #releases-4-2-0]'),
        })
      );
    });

    it('notifyCherryPickConflict DM uses DM redirect', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.update({ redirectDM: 'UOVERRIDE' });

      const release = { version: '4.2.0' };
      const cherryPick = { pr: 123, ticket: 'DEV-12345' };
      await slack.notifyCherryPickConflict(release, cherryPick, 'U99999999');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'UOVERRIDE',
          text: expect.stringContaining('[-> DM U99999999]'),
        })
      );
    });
  });

  // ── Settings gating via NotificationEngine ───────────

  describe('settings gating', () => {
    it('build alert fires when buildFailures is enabled', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      const NotificationEngine = require('../../src/core/notification-engine');
      const mockPeople = {
        resolveSlackId: () => ({ slackId: 'U12345678' }),
      };
      const mockUserStore = { listUsers: () => [] };
      const tickets = [{ key: 'DEV-123', summary: 'Fix bug', assignee: 'Test User' }];
      const mockReleases = {
        list: () => [],
        get: () => ({ tickets }),
        getTickets: () => tickets,
      };
      const engine = new NotificationEngine({
        slack,
        releases: mockReleases,
        releaseNotifier: {},
        peopleDirectory: mockPeople,
        userStore: mockUserStore,
        notificationSettings: settings,
        config: {},
      });

      // Seed baseline then trigger failure
      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'SUCCEEDED', version: '4.2.0', jiraKeys: ['DEV-123'] },
      ]);
      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'FAILED', version: '4.2.0', jiraKeys: ['DEV-123'], builds: [{ buildNumber: 42 }] },
      ]);

      expect(postMessageMock).toHaveBeenCalled();
    });

    it('build alert does NOT fire when buildFailures is disabled', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.set('buildFailures', false);

      const NotificationEngine = require('../../src/core/notification-engine');
      const engine = new NotificationEngine({
        slack,
        releases: { list: () => [], get: () => null },
        releaseNotifier: {},
        peopleDirectory: { resolveSlackId: () => null },
        userStore: { listUsers: () => [] },
        notificationSettings: settings,
        config: {},
      });

      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'SUCCEEDED', version: '4.2.0', jiraKeys: ['DEV-123'] },
      ]);
      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'FAILED', version: '4.2.0', jiraKeys: ['DEV-123'], builds: [{ buildNumber: 42 }] },
      ]);

      expect(postMessageMock).not.toHaveBeenCalled();
    });

    it('build alert does NOT fire when developerAlerts group is disabled', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.setGroup('developerAlerts', false);

      const NotificationEngine = require('../../src/core/notification-engine');
      const engine = new NotificationEngine({
        slack,
        releases: { list: () => [], get: () => null },
        releaseNotifier: {},
        peopleDirectory: { resolveSlackId: () => null },
        userStore: { listUsers: () => [] },
        notificationSettings: settings,
        config: {},
      });

      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'SUCCEEDED', version: '4.2.0', jiraKeys: ['DEV-123'] },
      ]);
      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'FAILED', version: '4.2.0', jiraKeys: ['DEV-123'], builds: [{ buildNumber: 42 }] },
      ]);

      expect(postMessageMock).not.toHaveBeenCalled();
    });

    it('build alert uses DM redirect when set', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.update({ redirectDM: 'UOVERRIDE' });

      const NotificationEngine = require('../../src/core/notification-engine');
      const mockPeople = {
        resolveSlackId: () => ({ slackId: 'U12345678' }),
      };
      const tickets = [{ key: 'DEV-123', summary: 'Fix bug', assignee: 'Test User' }];
      const mockReleases = {
        list: () => [],
        get: () => ({ tickets }),
        getTickets: () => tickets,
      };
      const engine = new NotificationEngine({
        slack,
        releases: mockReleases,
        releaseNotifier: {},
        peopleDirectory: mockPeople,
        userStore: { listUsers: () => [] },
        notificationSettings: settings,
        config: {},
      });

      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'SUCCEEDED', version: '4.2.0', jiraKeys: ['DEV-123'] },
      ]);
      await engine.checkBuildTransitions([
        { projectName: 'proj', latestStatus: 'FAILED', version: '4.2.0', jiraKeys: ['DEV-123'], builds: [{ buildNumber: 42 }] },
      ]);

      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'UOVERRIDE',
          text: expect.stringContaining('[-> DM U12345678]'),
        })
      );
    });
  });

  // ── ReleaseNotifier with settings ────────────────────

  describe('ReleaseNotifier with settings', () => {
    it('notifyRelease posts to release channel', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      const ReleaseNotifier = require('../../src/core/release-notifier');
      const mockReleases = { list: () => [], getTickets: () => [] };
      const notifier = new ReleaseNotifier(mockReleases, slack, {}, settings);

      const release = {
        version: '4.2.0',
        state: 'stabilizing',
        jiraReleaseDate: '2026-04-18',
        tickets: [],
      };
      await notifier.notifyRelease(release);
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ channel: '#releases-4-2-0' })
      );
    });

    it('notifyRelease uses channel redirect when set', async () => {
      const { slack, settings, postMessageMock } = createMockSlack(db);
      settings.update({ redirectChannel: '#test-notifications' });

      const ReleaseNotifier = require('../../src/core/release-notifier');
      const notifier = new ReleaseNotifier({ list: () => [], getTickets: () => [] }, slack, {}, settings);

      const release = {
        version: '4.2.0',
        state: 'stabilizing',
        jiraReleaseDate: '2026-04-18',
        tickets: [],
      };
      await notifier.notifyRelease(release);
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: '#test-notifications',
          text: expect.stringContaining('[-> #releases-4-2-0]'),
        })
      );
    });
  });
});
