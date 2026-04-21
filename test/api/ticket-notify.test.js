import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sendTicketNotification, sendStandupReminder, CANNED_MESSAGES } = require('../../src/api/ticket-notify');

// ── Mock helpers ────────────────────────────────────────

function createMockSlack() {
  return {
    isConfigured: () => true,
    dmUser: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function createMockServices(slack = createMockSlack()) {
  return {
    slack,
    releases: { list: () => [], getTickets: () => [] },
    peopleDirectory: {
      resolveSlackId: (name) => {
        const map = {
          'Alice Dev': { slackId: 'U001', name: 'Alice Dev' },
          'Bob QA': { slackId: 'U002', name: 'Bob QA' },
          'Carol Dev': { slackId: 'U003', name: 'Carol Dev' },
        };
        return map[name] || null;
      },
    },
    ticketStore: {
      get: (key) => {
        const tickets = {
          'DEV-100': { key: 'DEV-100', summary: 'Fix login bug', assignee: 'Alice Dev', qaAssignee: 'Bob QA', jiraStatus: 'In Progress' },
          'DEV-101': { key: 'DEV-101', summary: 'Update dashboard', assignee: 'Alice Dev', qaAssignee: 'Bob QA', jiraStatus: 'Ready For Testing' },
          'DEV-102': { key: 'DEV-102', summary: 'Refactor API', assignee: 'Carol Dev', qaAssignee: 'Bob QA', jiraStatus: 'Development In Progress' },
        };
        return tickets[key] || null;
      },
    },
  };
}

// ── Tests ───────────────────────────────────────────────

describe('CANNED_MESSAGES', () => {
  it('has expected message types', () => {
    const ids = CANNED_MESSAGES.map(m => m.id);
    expect(ids).toContain('cherry-pick');
    expect(ids).toContain('status-update');
    expect(ids).toContain('release-blocker');
    expect(ids).toContain('custom');
  });

  it('each message has id, label, and text', () => {
    for (const msg of CANNED_MESSAGES) {
      expect(msg.id).toBeDefined();
      expect(msg.label).toBeDefined();
      expect(typeof msg.text).toBe('string');
    }
  });
});

describe('sendTicketNotification', () => {
  describe('DM mode', () => {
    it('sends DM to dev assignee', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Can you cherry-pick this?',
      }, services);

      expect(result.sent).toBe(1);
      expect(result.recipients).toContain('Alice Dev');
      expect(services.slack.dmUser).toHaveBeenCalledWith('U001', expect.stringContaining('DEV-100'));
      expect(services.slack.dmUser).toHaveBeenCalledWith('U001', expect.stringContaining('cherry-pick'));
    });

    it('sends DM to QA assignee', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100'],
        recipientType: 'qa',
        channel: 'dm',
        message: 'Please test this.',
      }, services);

      expect(result.sent).toBe(1);
      expect(result.recipients).toContain('Bob QA');
      expect(services.slack.dmUser).toHaveBeenCalledWith('U002', expect.stringContaining('DEV-100'));
    });

    it('sends DM to both dev and QA', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100'],
        recipientType: 'both',
        channel: 'dm',
        message: 'Status update please.',
      }, services);

      expect(result.sent).toBe(2);
      expect(result.recipients).toContain('Alice Dev');
      expect(result.recipients).toContain('Bob QA');
    });

    it('groups multiple tickets to same recipient into one DM', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100', 'DEV-101'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Can you cherry-pick these?',
      }, services);

      // Both tickets share Alice Dev as assignee — should be 1 DM
      expect(result.sent).toBe(1);
      expect(services.slack.dmUser).toHaveBeenCalledTimes(1);
      const msgText = services.slack.dmUser.mock.calls[0][1];
      expect(msgText).toContain('DEV-100');
      expect(msgText).toContain('DEV-101');
    });

    it('sends separate DMs to different recipients', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100', 'DEV-102'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Status update please.',
      }, services);

      // DEV-100 → Alice, DEV-102 → Carol
      expect(result.sent).toBe(2);
      expect(result.recipients).toContain('Alice Dev');
      expect(result.recipients).toContain('Carol Dev');
    });

    it('includes version context when provided', async () => {
      const services = createMockServices();
      await sendTicketNotification({
        ticketKeys: ['DEV-100'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Cherry-pick please.',
        version: '4.2.0',
      }, services);

      const msgText = services.slack.dmUser.mock.calls[0][1];
      expect(msgText).toContain('4.2.0');
    });

    it('does not include attribution line', async () => {
      const services = createMockServices();
      await sendTicketNotification({
        ticketKeys: ['DEV-100'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Please fix.',
        senderName: 'Nukul',
      }, services);

      const msgText = services.slack.dmUser.mock.calls[0][1];
      expect(msgText).not.toContain('via Nectar');
    });

    it('reports error for unresolvable Slack IDs', async () => {
      const services = createMockServices();
      services.ticketStore.get = () => ({ key: 'DEV-999', summary: 'Test', assignee: 'Unknown Person', qaAssignee: null, jiraStatus: 'Open' });

      const result = await sendTicketNotification({
        ticketKeys: ['DEV-999'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Test',
      }, services);

      expect(result.sent).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Unknown Person');
    });
  });

  describe('release channel mode', () => {
    it('posts to release channel', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100', 'DEV-101'],
        recipientType: 'dev',
        channel: 'release',
        message: 'Please cherry-pick these.',
        version: '4.2.0',
      }, services);

      expect(result.sent).toBe(1);
      expect(services.slack.postMessage).toHaveBeenCalledWith(
        '#releases-4-2-0',
        expect.stringContaining('DEV-100')
      );
      const msgText = services.slack.postMessage.mock.calls[0][1];
      expect(msgText).toContain('DEV-101');
      expect(msgText).toContain('Release 4.2.0');
      // Should use Slack @mentions instead of plain names
      expect(msgText).toContain('<@U001>'); // Alice Dev
      expect(msgText).toContain('<@U002>'); // Bob QA
      expect(msgText).not.toContain('via Nectar');
    });

    it('requires version for release channel', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100'],
        recipientType: 'dev',
        channel: 'release',
        message: 'Test',
        // no version
      }, services);

      expect(result.sent).toBe(0);
      expect(result.errors[0]).toContain('Version required');
    });
  });

  describe('edge cases', () => {
    it('returns error when Slack not configured', async () => {
      const slack = { isConfigured: () => false };
      const services = createMockServices(slack);
      const result = await sendTicketNotification({
        ticketKeys: ['DEV-100'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Test',
      }, services);

      expect(result.sent).toBe(0);
      expect(result.errors[0]).toContain('Slack not configured');
    });

    it('returns error for empty ticket keys', async () => {
      const services = createMockServices();
      const result = await sendTicketNotification({
        ticketKeys: [],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Test',
      }, services);

      expect(result.sent).toBe(0);
      expect(result.errors[0]).toContain('No tickets');
    });

    it('falls back gracefully for unknown tickets', async () => {
      const services = createMockServices();
      services.ticketStore.get = () => null; // ticket not in store

      const result = await sendTicketNotification({
        ticketKeys: ['DEV-999'],
        recipientType: 'dev',
        channel: 'dm',
        message: 'Test',
      }, services);

      // No assignee on fallback ticket → no recipients → no sends
      expect(result.sent).toBe(0);
    });
  });
});

describe('sendStandupReminder', () => {
  it('sends DM with ticket buckets', async () => {
    const services = createMockServices();
    const standupData = {
      totalItems: 3,
      buckets: {
        releaseCritical: [{ key: 'DEV-100', summary: 'Fix login', jiraStatus: 'Blocked' }],
        awaitingCherryPick: [],
        reviewChangesRequested: [],
        reviewApproved: [],
        blocked: [],
        pendingTesting: [{ key: 'DEV-101', summary: 'Dashboard', jiraStatus: 'Ready For Testing' }],
        inDev: [{ key: 'DEV-102', summary: 'API refactor', jiraStatus: 'In Progress' }],
      },
    };

    const result = await sendStandupReminder(
      { personName: 'Alice Dev', message: 'Standup check-in', senderName: 'Nukul' },
      standupData,
      services
    );

    expect(result.sent).toBe(true);
    expect(services.slack.dmUser).toHaveBeenCalledWith('U001', expect.stringContaining('DEV-100'));
    const msgText = services.slack.dmUser.mock.calls[0][1];
    expect(msgText).toContain('Standup check-in');
    expect(msgText).toContain('Release-Critical');
    expect(msgText).toContain('Pending Testing');
    expect(msgText).toContain('In Development');
    expect(msgText).toContain('3 items');
    expect(msgText).not.toContain('via Nectar');
  });

  it('works without custom message', async () => {
    const services = createMockServices();
    const standupData = {
      totalItems: 1,
      buckets: {
        releaseCritical: [],
        awaitingCherryPick: [],
        reviewChangesRequested: [],
        reviewApproved: [],
        blocked: [],
        pendingTesting: [],
        inDev: [{ key: 'DEV-100', summary: 'Fix', jiraStatus: 'In Progress' }],
      },
    };

    const result = await sendStandupReminder(
      { personName: 'Alice Dev' },
      standupData,
      services
    );

    expect(result.sent).toBe(true);
    const msgText = services.slack.dmUser.mock.calls[0][1];
    expect(msgText).not.toContain('💬'); // no custom message block
  });

  it('returns error for unknown person', async () => {
    const services = createMockServices();
    const result = await sendStandupReminder(
      { personName: 'Unknown Person' },
      { totalItems: 0, buckets: {} },
      services
    );

    expect(result.sent).toBe(false);
    expect(result.error).toContain('Unknown Person');
  });
});
