import { describe, it, expect } from 'vitest';

// Only test static methods — no network calls
const JiraClient = require('../../src/integrations/jira');

describe('JiraClient static methods', () => {

  describe('normalizeIssue', () => {
    it('normalizes a full JIRA issue', () => {
      const result = JiraClient.normalizeIssue({
        key: 'DEV-100',
        fields: {
          summary: 'Fix payment flow',
          status: { name: 'In Progress' },
          issuetype: { name: 'Bug' },
          assignee: { displayName: 'Jane Smith' },
          fixVersions: [{ name: '4.2.0' }],
          labels: ['urgent'],
          customfield_10594: [{ name: '4.3.0' }],
          customfield_10463: 'RCM - Billing',
          customfield_11056: [{ value: 'Bayada' }, { value: 'CK' }],
          customfield_10691: '#VHC-1234',
        },
      });

      expect(result.key).toBe('DEV-100');
      expect(result.summary).toBe('Fix payment flow');
      expect(result.status).toBe('In Progress');
      expect(result.type).toBe('Bug');
      expect(result.assignee).toBe('Jane Smith');
      expect(result.fixVersions).toEqual(['4.2.0']);
      expect(result.targetFixVersions).toEqual(['4.3.0']);
      expect(result.component).toBe('RCM - Billing');
      expect(result.customerTags).toEqual(['Bayada', 'CK']);
      expect(result.zohoRef).not.toBeNull();
      expect(result.zohoRef.kind).toBe('ticketNumber');
    });

    it('handles minimal issue with missing fields', () => {
      const result = JiraClient.normalizeIssue({ key: 'DEV-1', fields: {} });
      expect(result.key).toBe('DEV-1');
      expect(result.summary).toBe('');
      expect(result.status).toBe('Unknown');
      expect(result.assignee).toBeNull();
      expect(result.fixVersions).toEqual([]);
      expect(result.targetFixVersions).toEqual([]);
      expect(result.component).toBeNull();
      expect(result.customerTags).toEqual([]);
      expect(result.zohoRef).toBeNull();
      expect(result.platforms).toEqual([]);
    });

    it('infers platforms from fixVersion prefixes', () => {
      const ios = JiraClient.normalizeIssue({
        key: 'DEV-I', fields: { fixVersions: [{ name: 'iOS 2026.4.0' }] },
      });
      expect(ios.fixVersions).toEqual(['2026.4.0']);
      expect(ios.platforms).toEqual(['ios']);

      const android = JiraClient.normalizeIssue({
        key: 'DEV-A', fields: { fixVersions: [{ name: 'Android 2026.4.0' }] },
      });
      expect(android.platforms).toEqual(['android']);

      const web = JiraClient.normalizeIssue({
        key: 'DEV-W', fields: { fixVersions: [{ name: '4.2.1' }] },
      });
      expect(web.platforms).toEqual(['web']);

      const both = JiraClient.normalizeIssue({
        key: 'DEV-B',
        fields: { fixVersions: [{ name: 'iOS 2026.4.0' }, { name: 'Android 2026.4.0' }] },
      });
      expect(both.platforms.sort()).toEqual(['android', 'ios']);
    });

    it('derives platforms from targetFixVersions when fixVersions is empty', () => {
      const t = JiraClient.normalizeIssue({
        key: 'DEV-T',
        fields: { customfield_10594: [{ name: 'iOS 2026.4.0' }] },
      });
      expect(t.platforms).toEqual(['ios']);
    });
  });

  describe('extractPlatform', () => {
    it('matches known prefixes case-insensitively', () => {
      expect(JiraClient.extractPlatform('iOS 2026.4.0')).toBe('ios');
      expect(JiraClient.extractPlatform('ios 3.2.0')).toBe('ios');
      expect(JiraClient.extractPlatform('Android 2026.4.0')).toBe('android');
      expect(JiraClient.extractPlatform('ANDROID 1.0')).toBe('android');
      expect(JiraClient.extractPlatform('4.2.0')).toBe('web');
      expect(JiraClient.extractPlatform('')).toBeNull();
      expect(JiraClient.extractPlatform(null)).toBeNull();
    });
  });

  describe('parseZohoRef', () => {
    it('parses Zoho agent URL', () => {
      const result = JiraClient.parseZohoRef(
        'https://support.vivtechnologies.com/support/ShowHomePage.do#Cases/details/123456'
      );
      expect(result.kind).toBe('url');
      expect(result.id).toBe('123456');
      expect(result.parseable).toBe(true);
      expect(result.zohoUrl).toContain('/dv/123456');
    });

    it('parses #VHC-xxxx shorthand', () => {
      const result = JiraClient.parseZohoRef('#VHC-1234');
      expect(result.kind).toBe('ticketNumber');
      expect(result.ticketNumber).toBe('VHC-1234');
      expect(result.parseable).toBe(true);
    });

    it('parses VHC-xxxx without hash', () => {
      const result = JiraClient.parseZohoRef('VHC-5678');
      expect(result.kind).toBe('ticketNumber');
      expect(result.ticketNumber).toBe('VHC-5678');
    });

    it('returns unknown for garbage text', () => {
      const result = JiraClient.parseZohoRef('Customer is complaining about login issues');
      expect(result.kind).toBe('unknown');
      expect(result.parseable).toBe(false);
    });

    it('returns null for null/undefined', () => {
      expect(JiraClient.parseZohoRef(null)).toBeNull();
      expect(JiraClient.parseZohoRef(undefined)).toBeNull();
    });

    it('unwraps array form', () => {
      const result = JiraClient.parseZohoRef(['#VHC-1234']);
      expect(result.kind).toBe('ticketNumber');
    });

    it('unwraps { value: "..." } form', () => {
      const result = JiraClient.parseZohoRef({ value: '#VHC-9999' });
      expect(result.kind).toBe('ticketNumber');
    });

    it('handles empty string', () => {
      expect(JiraClient.parseZohoRef('')).toBeNull();
      expect(JiraClient.parseZohoRef('  ')).toBeNull();
    });
  });

  describe('extractVersionNames', () => {
    it('extracts from version objects', () => {
      expect(JiraClient.extractVersionNames([{ name: '4.2.0', id: '1' }])).toEqual(['4.2.0']);
    });

    it('extracts from string array', () => {
      expect(JiraClient.extractVersionNames(['4.2.0', '4.3.0'])).toEqual(['4.2.0', '4.3.0']);
    });

    it('unwraps { value: [...] } envelope', () => {
      expect(JiraClient.extractVersionNames({ value: ['4.2.0'] })).toEqual(['4.2.0']);
    });

    it('handles null/undefined', () => {
      expect(JiraClient.extractVersionNames(null)).toEqual([]);
      expect(JiraClient.extractVersionNames(undefined)).toEqual([]);
    });

    it('handles single version object', () => {
      expect(JiraClient.extractVersionNames({ name: '4.2.0' })).toEqual(['4.2.0']);
    });
  });

  describe('extractFieldString', () => {
    it('returns string directly', () => {
      expect(JiraClient.extractFieldString('hello')).toBe('hello');
    });

    it('unwraps { value: "..." }', () => {
      expect(JiraClient.extractFieldString({ value: 'test' })).toBe('test');
    });

    it('returns null for null/undefined', () => {
      expect(JiraClient.extractFieldString(null)).toBeNull();
      expect(JiraClient.extractFieldString(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(JiraClient.extractFieldString('')).toBeNull();
    });
  });

  describe('extractStringArray', () => {
    it('returns plain string array', () => {
      expect(JiraClient.extractStringArray(['a', 'b'])).toEqual(['a', 'b']);
    });

    it('unwraps { value: [...] }', () => {
      expect(JiraClient.extractStringArray({ value: ['a', 'b'] })).toEqual(['a', 'b']);
    });

    it('unwraps [{ value: "a" }, { value: "b" }]', () => {
      expect(JiraClient.extractStringArray([{ value: 'a' }, { value: 'b' }])).toEqual(['a', 'b']);
    });

    it('handles [{ name: "a" }]', () => {
      expect(JiraClient.extractStringArray([{ name: 'a' }])).toEqual(['a']);
    });

    it('returns empty for null', () => {
      expect(JiraClient.extractStringArray(null)).toEqual([]);
    });

    it('wraps single non-array value', () => {
      expect(JiraClient.extractStringArray('solo')).toEqual(['solo']);
    });
  });

  describe('mapStatus', () => {
    it('maps known statuses', () => {
      expect(JiraClient.mapStatus('Cherry Picked')).toBe('cherry-picked');
      expect(JiraClient.mapStatus('Ready for Testing')).toBe('ready-for-testing');
      expect(JiraClient.mapStatus('In Progress')).toBe('in-progress');
      expect(JiraClient.mapStatus('Done')).toBe('done');
      expect(JiraClient.mapStatus('Closed')).toBe('done');
      expect(JiraClient.mapStatus('To Do')).toBe('pending');
      expect(JiraClient.mapStatus('Open')).toBe('pending');
    });

    it('returns pending for unknown status', () => {
      expect(JiraClient.mapStatus('Something Custom')).toBe('pending');
      expect(JiraClient.mapStatus(null)).toBe('pending');
      expect(JiraClient.mapStatus('')).toBe('pending');
    });

    it('is case-insensitive', () => {
      expect(JiraClient.mapStatus('IN PROGRESS')).toBe('in-progress');
      expect(JiraClient.mapStatus('ready for qa')).toBe('ready-for-testing');
    });
  });

  describe('NECTAR_FIELDS', () => {
    it('exports NECTAR_FIELDS array', () => {
      expect(JiraClient.NECTAR_FIELDS).toBeDefined();
      expect(Array.isArray(JiraClient.NECTAR_FIELDS)).toBe(true);
      expect(JiraClient.NECTAR_FIELDS).toContain('summary');
      expect(JiraClient.NECTAR_FIELDS).toContain('customfield_10594');
    });
  });
});
