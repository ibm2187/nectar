import { describe, it, expect, beforeEach, vi } from 'vitest';

const SlackNotifier = require('../../src/integrations/slack');

/**
 * Create a SlackNotifier with mocked app.client so we can exercise
 * validateChannel and postAlert without a real Slack connection.
 *
 * @param {object} mocks - per-method mock implementations (or overrides)
 * @param {object} settings - notification settings (for redirectChannel etc)
 */
function makeSlack(mocks = {}, settings = {}) {
  const slack = new SlackNotifier({});
  slack.ready = true;
  slack.notificationSettings = {
    redirectChannel: settings.redirectChannel || null,
    redirectDM: settings.redirectDM || null,
  };

  const postMessage = mocks.postMessage || vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000100' });
  const conversationsList = mocks.conversationsList || vi.fn().mockResolvedValue({ channels: [], response_metadata: {} });
  const conversationsInfo = mocks.conversationsInfo || vi.fn().mockResolvedValue({ channel: { id: 'C1', name: 'x', is_member: true } });

  slack.app = {
    client: {
      chat: { postMessage },
      conversations: { list: conversationsList, info: conversationsInfo },
    },
  };

  return { slack, postMessage, conversationsList, conversationsInfo };
}

describe('SlackNotifier.validateChannel', () => {
  it('returns not_connected when Slack not ready', async () => {
    const slack = new SlackNotifier({});
    slack.ready = false;
    const res = await slack.validateChannel('#alerts-prod');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_connected');
  });

  it('returns empty when no channel is given', async () => {
    const { slack } = makeSlack();
    const res = await slack.validateChannel('');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('empty');
  });

  it('validates a channel by name (resolves via conversations.list)', async () => {
    const { slack, conversationsList, conversationsInfo } = makeSlack({
      conversationsList: vi.fn().mockResolvedValue({
        channels: [{ id: 'C123', name: 'alerts-prod' }],
        response_metadata: {},
      }),
      conversationsInfo: vi.fn().mockResolvedValue({
        channel: { id: 'C123', name: 'alerts-prod', is_member: true },
      }),
    });
    const res = await slack.validateChannel('#alerts-prod');
    expect(res.ok).toBe(true);
    expect(res.inChannel).toBe(true);
    expect(res.channelId).toBe('C123');
    expect(res.name).toBe('alerts-prod');
    expect(conversationsList).toHaveBeenCalled();
    expect(conversationsInfo).toHaveBeenCalledWith({ channel: 'C123' });
  });

  it('accepts bare channel names (strips leading #)', async () => {
    const { slack } = makeSlack({
      conversationsList: vi.fn().mockResolvedValue({
        channels: [{ id: 'C1', name: 'alerts-prod' }],
      }),
      conversationsInfo: vi.fn().mockResolvedValue({
        channel: { id: 'C1', name: 'alerts-prod', is_member: true },
      }),
    });
    const res = await slack.validateChannel('alerts-prod');
    expect(res.ok).toBe(true);
  });

  it('treats a channel ID (C-prefixed) as-is, skipping list lookup', async () => {
    const listMock = vi.fn();
    const { slack } = makeSlack({
      conversationsList: listMock,
      conversationsInfo: vi.fn().mockResolvedValue({
        channel: { id: 'C1234567', name: 'resolved', is_member: true },
      }),
    });
    const res = await slack.validateChannel('C1234567');
    expect(res.ok).toBe(true);
    expect(res.channelId).toBe('C1234567');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns channel_not_found when name is not in any list page', async () => {
    const { slack } = makeSlack({
      conversationsList: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
    });
    const res = await slack.validateChannel('#never-existed');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('channel_not_found');
  });

  it('returns not_in_channel when the bot is not a member', async () => {
    const { slack } = makeSlack({
      conversationsList: vi.fn().mockResolvedValue({
        channels: [{ id: 'C1', name: 'alerts-prod' }],
      }),
      conversationsInfo: vi.fn().mockResolvedValue({
        channel: { id: 'C1', name: 'alerts-prod', is_member: false },
      }),
    });
    const res = await slack.validateChannel('#alerts-prod');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_in_channel');
    expect(res.error).toMatch(/invite/i);
  });

  it('returns is_archived when channel is archived', async () => {
    const { slack } = makeSlack({
      conversationsList: vi.fn().mockResolvedValue({
        channels: [{ id: 'C1', name: 'alerts-prod' }],
      }),
      conversationsInfo: vi.fn().mockResolvedValue({
        channel: { id: 'C1', name: 'alerts-prod', is_archived: true, is_member: true },
      }),
    });
    const res = await slack.validateChannel('#alerts-prod');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('is_archived');
  });

  it('surfaces Slack API error codes', async () => {
    const err = new Error('An API error');
    err.data = { error: 'invalid_auth' };
    const { slack } = makeSlack({
      conversationsInfo: vi.fn().mockRejectedValue(err),
    });
    const res = await slack.validateChannel('C1234567');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('invalid_auth');
  });
});

describe('SlackNotifier.postAlert', () => {
  it('posts to each channel and returns per-channel results', async () => {
    const { slack, postMessage } = makeSlack();
    const results = await slack.postAlert({
      channels: ['#a', '#b'],
      text: 'alert text',
    });
    expect(results).toHaveLength(2);
    expect(results[0].channel).toBe('#a');
    expect(results[0].ok).toBe(true);
    expect(results[0].ts).toBeTruthy();
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('prefixes with mention when provided', async () => {
    const { slack, postMessage } = makeSlack();
    await slack.postAlert({ channels: ['#a'], text: 'hello', mention: '@here' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '@here hello' })
    );
  });

  it('passes Block Kit blocks through', async () => {
    const { slack, postMessage } = makeSlack();
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }];
    await slack.postAlert({ channels: ['#a'], text: 'x', blocks });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ blocks })
    );
  });

  it('threads posts when threadTs is set', async () => {
    const { slack, postMessage } = makeSlack();
    await slack.postAlert({ channels: ['#a'], text: 'reply', threadTs: '1.2' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1.2' })
    );
  });

  it('respects redirectChannel setting', async () => {
    const { slack, postMessage } = makeSlack({}, { redirectChannel: '#test-alerts' });
    await slack.postAlert({ channels: ['#alerts-prod'], text: 'hi' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: '#test-alerts',
        text: expect.stringContaining('[-> #alerts-prod]'),
      })
    );
  });

  it('returns error results when slack not connected', async () => {
    const slack = new SlackNotifier({});
    slack.ready = false;
    const res = await slack.postAlert({ channels: ['#a'], text: 'x' });
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toMatch(/not connected/i);
  });

  it('marks channel as bad on not_in_channel error, skips retries', async () => {
    const err = new Error('failed');
    err.data = { error: 'not_in_channel' };
    const postMessage = vi.fn().mockRejectedValue(err);
    const { slack } = makeSlack({ postMessage });
    const first = await slack.postAlert({ channels: ['#bad'], text: 'hi' });
    expect(first[0].ok).toBe(false);
    expect(first[0].error).toBe('not_in_channel');

    // Second post to same bad channel — should short-circuit without calling Slack
    postMessage.mockClear();
    const second = await slack.postAlert({ channels: ['#bad'], text: 'again' });
    expect(second[0].ok).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('SlackNotifier.postReply', () => {
  it('posts as a threaded reply', async () => {
    const { slack, postMessage } = makeSlack();
    const res = await slack.postReply({ channel: '#a', ts: '1.2', text: 'reply' });
    expect(res.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: '#a',
        thread_ts: '1.2',
        text: 'reply',
      })
    );
  });

  it('returns error when channel or ts missing', async () => {
    const { slack } = makeSlack();
    const r1 = await slack.postReply({ ts: '1', text: 'x' });
    expect(r1.ok).toBe(false);
    const r2 = await slack.postReply({ channel: '#a', text: 'x' });
    expect(r2.ok).toBe(false);
  });
});
