import { describe, it, expect } from 'vitest';
const JiraClient = require('../src/integrations/jira');

describe('JiraClient.normalizeIssue', () => {
  function makeIssue(overrides = {}) {
    return {
      key: 'DEV-100',
      fields: {
        summary: 'Fix PTO accrual',
        status: { name: 'In Progress' },
        issuetype: { name: 'Bug' },
        assignee: { displayName: 'Nukul Bhasin' },
        reporter: { displayName: 'William Snieder' },
        fixVersions: [{ name: '4.3.0' }],
        labels: [],
        customfield_10594: [{ name: '4.3.0' }],
        customfield_10463: { value: 'Scheduling' },
        customfield_11056: [{ value: 'Bayada' }, { value: 'CK' }],
        customfield_10691: null,
        customfield_10466: { displayName: 'Prateek Ahluwalia' },
        customfield_10757: { displayName: 'Sarah Johnson' },
        customfield_10595: [{ value: 'staging' }],
        customfield_10992: null,
        customfield_10993: null,
        ...overrides,
      },
    };
  }

  it('normalizes assignee', () => {
    const result = JiraClient.normalizeIssue(makeIssue());
    expect(result.assignee).toBe('Nukul Bhasin');
  });

  it('normalizes reporter', () => {
    const result = JiraClient.normalizeIssue(makeIssue());
    expect(result.reporter).toBe('William Snieder');
  });

  it('normalizes qaAssignee', () => {
    const result = JiraClient.normalizeIssue(makeIssue());
    expect(result.qaAssignee).toBe('Prateek Ahluwalia');
  });

  it('normalizes productAssignee', () => {
    const result = JiraClient.normalizeIssue(makeIssue());
    expect(result.productAssignee).toBe('Sarah Johnson');
  });

  it('handles null reporter', () => {
    const result = JiraClient.normalizeIssue(makeIssue({ reporter: null }));
    expect(result.reporter).toBeNull();
  });

  it('handles null productAssignee', () => {
    const result = JiraClient.normalizeIssue(makeIssue({ customfield_10757: null }));
    expect(result.productAssignee).toBeNull();
  });

  it('handles null qaAssignee', () => {
    const result = JiraClient.normalizeIssue(makeIssue({ customfield_10466: null }));
    expect(result.qaAssignee).toBeNull();
  });

  it('handles null assignee', () => {
    const result = JiraClient.normalizeIssue(makeIssue({ assignee: null }));
    expect(result.assignee).toBeNull();
  });

  it('normalizes all four person fields together', () => {
    const result = JiraClient.normalizeIssue(makeIssue());
    expect(result).toMatchObject({
      assignee: 'Nukul Bhasin',
      reporter: 'William Snieder',
      qaAssignee: 'Prateek Ahluwalia',
      productAssignee: 'Sarah Johnson',
    });
  });

  it('normalizes basic fields', () => {
    const result = JiraClient.normalizeIssue(makeIssue());
    expect(result.key).toBe('DEV-100');
    expect(result.summary).toBe('Fix PTO accrual');
    expect(result.status).toBe('In Progress');
    expect(result.type).toBe('Bug');
    expect(result.fixVersions).toEqual(['4.3.0']);
    expect(result.targetFixVersions).toEqual(['4.3.0']);
    expect(result.component).toBe('Scheduling');
    expect(result.customerTags).toEqual(['Bayada', 'CK']);
    expect(result.deployedEnvironments).toEqual(['staging']);
  });
});

describe('JiraClient.parseZohoRef', () => {
  it('parses full agent URL', () => {
    const raw = 'https://support.vivtechnologies.com/agent/vivtechnologies/all/tickets/details/12345';
    const ref = JiraClient.parseZohoRef(raw);
    expect(ref.kind).toBe('url');
    expect(ref.id).toBe('12345');
    expect(ref.parseable).toBe(true);
    expect(ref.zohoUrl).toContain('12345');
  });

  it('parses #VHC-xxxx shorthand', () => {
    const ref = JiraClient.parseZohoRef('#VHC-4056');
    expect(ref.kind).toBe('ticketNumber');
    expect(ref.ticketNumber).toBe('VHC-4056');
    expect(ref.parseable).toBe(true);
  });

  it('returns unknown for garbage', () => {
    const ref = JiraClient.parseZohoRef('The user reported a scheduling bug');
    expect(ref.kind).toBe('unknown');
    expect(ref.parseable).toBe(false);
  });

  it('returns null for null input', () => {
    expect(JiraClient.parseZohoRef(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(JiraClient.parseZohoRef('')).toBeNull();
  });
});

describe('JiraClient.mapStatus', () => {
  it('maps cherry-picked status', () => {
    expect(JiraClient.mapStatus('Cherry Picked')).toBe('cherry-picked');
  });

  it('maps ready for testing', () => {
    expect(JiraClient.mapStatus('Ready for Testing')).toBe('ready-for-testing');
  });

  it('maps in progress', () => {
    expect(JiraClient.mapStatus('In Progress')).toBe('in-progress');
  });

  it('maps done', () => {
    expect(JiraClient.mapStatus('Done')).toBe('done');
  });

  it('maps open to pending', () => {
    expect(JiraClient.mapStatus('Open')).toBe('pending');
  });

  it('maps unknown to pending', () => {
    expect(JiraClient.mapStatus('Some Random Status')).toBe('pending');
  });
});

describe('NECTAR_FIELDS', () => {
  it('includes reporter', () => {
    expect(JiraClient.NECTAR_FIELDS).toContain('reporter');
  });

  it('includes productAssignee field', () => {
    expect(JiraClient.NECTAR_FIELDS).toContain('customfield_10757');
  });

  it('includes qaAssignee field', () => {
    expect(JiraClient.NECTAR_FIELDS).toContain('customfield_10466');
  });

  it('includes assignee', () => {
    expect(JiraClient.NECTAR_FIELDS).toContain('assignee');
  });

  it('includes priority, riskLevel, customerPriority fields', () => {
    expect(JiraClient.NECTAR_FIELDS).toContain('priority');
    expect(JiraClient.NECTAR_FIELDS).toContain('customfield_10650'); // Risk Level
    expect(JiraClient.NECTAR_FIELDS).toContain('customfield_11023'); // Customer Priority
  });

  describe('priority + risk + customer priority', () => {
    function makeWith(extras = {}) {
      return {
        key: 'DEV-100',
        fields: {
          summary: 'X', status: { name: 'Open' }, issuetype: { name: 'Bug' },
          assignee: null, reporter: null, fixVersions: [], labels: [],
          ...extras,
        },
      };
    }

    it('extracts built-in priority', () => {
      const r = JiraClient.normalizeIssue(makeWith({ priority: { name: 'High' } }));
      expect(r.priority).toBe('High');
    });

    it('handles missing priority', () => {
      const r = JiraClient.normalizeIssue(makeWith({}));
      expect(r.priority).toBeNull();
    });

    it('extracts riskLevel from customfield_10650', () => {
      const r = JiraClient.normalizeIssue(makeWith({ customfield_10650: { value: '3 - High Risk' } }));
      expect(r.riskLevel).toBe('3 - High Risk');
    });

    it('handles null riskLevel', () => {
      const r = JiraClient.normalizeIssue(makeWith({ customfield_10650: null }));
      expect(r.riskLevel).toBeNull();
    });

    it('handles riskLevel sentinel { value: null }', () => {
      const r = JiraClient.normalizeIssue(makeWith({ customfield_10650: { value: null } }));
      expect(r.riskLevel).toBeNull();
    });

    it('extracts customerPriority from customfield_11023', () => {
      const r = JiraClient.normalizeIssue(makeWith({ customfield_11023: { value: 'URGENT' } }));
      expect(r.customerPriority).toBe('URGENT');
    });

    it('handles null customerPriority', () => {
      const r = JiraClient.normalizeIssue(makeWith({ customfield_11023: null }));
      expect(r.customerPriority).toBeNull();
    });

    it('all three fields populated together', () => {
      const r = JiraClient.normalizeIssue(makeWith({
        priority: { name: 'Urgent' },
        customfield_10650: { value: '2 - Medium Risk' },
        customfield_11023: { value: 'High' },
      }));
      expect(r.priority).toBe('Urgent');
      expect(r.riskLevel).toBe('2 - Medium Risk');
      expect(r.customerPriority).toBe('High');
    });
  });
});
