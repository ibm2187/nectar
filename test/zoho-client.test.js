import { describe, it, expect } from 'vitest';
const ZohoClient = require('../src/integrations/zoho');

describe('ZohoClient.normalizeTicket', () => {
  function makeTicket(overrides = {}) {
    return {
      id: '1078812000011893017',
      ticketNumber: 'VHC-4056',
      subject: 'Visit mysteriously showing up in current week',
      status: 'Waiting for Viv Response',
      statusType: 'Open',
      priority: 'High',
      category: 'Scheduling',
      subCategory: 'Scheduling - Central Schedule',
      channel: 'Web',
      departmentId: '1078812000000503059',
      contactId: '1078812000000410387',
      email: 'mark@comfortkeepers.com',
      createdTime: '2026-04-09T18:37:53.000Z',
      modifiedTime: '2026-04-13T15:43:01.000Z',
      closedTime: null,
      webUrl: 'https://support.vivtechnologies.com/support/vivtechnologies/ShowHomePage.do#Cases/dv/1078812000011893017',
      cf: {
        cf_associated_jira_issues: 'DEV-44056',
        cf_associated_jira_issues_count: '1',
        cf_if_uat_which_release: '4.3.0',
        cf_ticket_type: 'Bug Report',
      },
      ...overrides,
    };
  }

  it('normalizes basic fields', () => {
    const result = ZohoClient.normalizeTicket(makeTicket());
    expect(result.id).toBe('1078812000011893017');
    expect(result.ticketNumber).toBe('VHC-4056');
    expect(result.subject).toBe('Visit mysteriously showing up in current week');
    expect(result.status).toBe('Waiting for Viv Response');
    expect(result.priority).toBe('High');
    expect(result.category).toBe('Scheduling');
    expect(result.departmentId).toBe('1078812000000503059');
    expect(result.webUrl).toContain('1078812000011893017');
  });

  it('extracts associated JIRA issues from cf fields', () => {
    const result = ZohoClient.normalizeTicket(makeTicket());
    expect(result.associatedJiraIssues).toBe('DEV-44056');
    expect(result.associatedJiraCount).toBe('1');
  });

  it('extracts UAT release field', () => {
    const result = ZohoClient.normalizeTicket(makeTicket());
    expect(result.uatRelease).toBe('4.3.0');
  });

  it('extracts ticket type', () => {
    const result = ZohoClient.normalizeTicket(makeTicket());
    expect(result.ticketType).toBe('Bug Report');
  });

  it('handles missing cf fields gracefully', () => {
    const result = ZohoClient.normalizeTicket(makeTicket({ cf: {} }));
    expect(result.associatedJiraIssues).toBeNull();
    expect(result.associatedJiraCount).toBeNull();
    expect(result.uatRelease).toBeNull();
  });

  it('falls back to customFields when cf is missing', () => {
    const result = ZohoClient.normalizeTicket(makeTicket({
      cf: undefined,
      customFields: {
        'Associated Jira Issues': 'DEV-45000',
        'Associated Jira Issues Count': '2',
        'If UAT, which release?': '4.4.0',
        'Ticket Type': 'Feature Request',
      },
    }));
    expect(result.associatedJiraIssues).toBe('DEV-45000');
    expect(result.associatedJiraCount).toBe('2');
    expect(result.uatRelease).toBe('4.4.0');
    expect(result.ticketType).toBe('Feature Request');
  });

  it('handles null ticket', () => {
    const result = ZohoClient.normalizeTicket({});
    expect(result.id).toBeUndefined();
    expect(result.subject).toBe('');
    expect(result.status).toBe('Unknown');
    expect(result.associatedJiraIssues).toBeNull();
  });
});

describe('ZohoClient configuration', () => {
  it('isConfigured returns false when no credentials', () => {
    const client = new ZohoClient();
    // Without env vars set, should be false
    const orig = { ...process.env };
    delete process.env.ZOHO_DESK_ORG_ID;
    delete process.env.ZOHO_DESK_API_TOKEN;
    delete process.env.ZOHO_DESK_CLIENT_ID;
    const freshClient = new ZohoClient();
    expect(freshClient.isConfigured()).toBe(false);
    // Restore
    Object.assign(process.env, orig);
  });
});
