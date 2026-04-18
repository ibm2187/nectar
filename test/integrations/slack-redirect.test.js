import { describe, it, expect, beforeEach, vi } from 'vitest';

const SlackNotifier = require('../../src/integrations/slack');

function createSlack(settings = {}) {
  const slack = new SlackNotifier({});
  slack.ready = true;
  slack.notificationSettings = {
    redirectChannel: settings.redirectChannel || null,
    redirectDM: settings.redirectDM || null,
    getAll() { return this; },
  };

  const postMessageMock = vi.fn().mockResolvedValue({ ok: true });
  slack.app = { client: { chat: { postMessage: postMessageMock } } };

  return { slack, postMessageMock };
}

describe('Slack redirect support', () => {
  describe('postMessage', () => {
    it('posts to original channel when no redirect is set', async () => {
      const { slack, postMessageMock } = createSlack();
      await slack.postMessage('#releases-4-2-0', 'Hello');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ channel: '#releases-4-2-0', text: 'Hello' })
      );
    });

    it('redirects to override channel when set, prefixing text', async () => {
      const { slack, postMessageMock } = createSlack({ redirectChannel: '#test-notifications' });
      await slack.postMessage('#releases-4-2-0', 'Hello');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: '#test-notifications',
          text: expect.stringContaining('[-> #releases-4-2-0]'),
        })
      );
    });
  });

  describe('dmUser', () => {
    it('DMs original user when no redirect is set', async () => {
      const { slack, postMessageMock } = createSlack();
      await slack.dmUser('U12345678', 'Hello DM');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'U12345678', text: 'Hello DM' })
      );
    });

    it('redirects to override user when set, prefixing text', async () => {
      const { slack, postMessageMock } = createSlack({ redirectDM: 'UOVERRIDE' });
      await slack.dmUser('U12345678', 'Hello DM');
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'UOVERRIDE',
          text: expect.stringContaining('[-> DM U12345678]'),
        })
      );
    });
  });
});
