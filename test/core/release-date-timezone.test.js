import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const JiraSync = require('../../src/core/jira-sync');
const CustomerStore = require('../../src/core/customer-store');
const { computeReleaseStatus } = require('../../src/core/release-status');
const { createTestDb } = require('../../src/core/db');

/**
 * Regression tests for mavencare/nectar#1:
 * JIRA date-only strings ("2026-04-10") were parsed as UTC midnight via
 * `new Date("2026-04-10")`, which shifted the date back one day when
 * interpreted in US Eastern timezone.
 *
 * The fix appends 'T00:00:00' so JS treats the string as local midnight.
 */

describe('JIRA release date timezone handling', () => {
  describe('jira-sync candidate filtering', () => {
    let audit, releases, jiraSync, db, customerStore, mockJira;

    const config = {
      jira: { project: 'DEV', maxVersionsPerSync: 50 },
      polling: { jiraSync: 60000 },
      repos: [
        { name: 'webplatform', github: 'mavencare/webplatform', jiraProject: 'DEV' },
      ],
    };

    beforeEach(() => {
      db = createTestDb();
      audit = new Audit({ db });
      releases = new ReleaseManager(audit, { db });
      customerStore = new CustomerStore({ db });
      mockJira = {
        isConfigured: () => true,
        getVersionsSummary: vi.fn(),
        getIssuesForVersion: vi.fn(),
      };
      jiraSync = new JiraSync(releases, mockJira, config);
      jiraSync.setCustomerStore(customerStore);
    });

    it('treats release dates as local midnight, not UTC (no off-by-one at date boundary)', async () => {
      // A version released "today" in local time should be included.
      // If parsed as UTC, a release date of today could appear as yesterday
      // to the filtering logic, potentially excluding it.
      const today = new Date();
      const todayStr = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0'),
      ].join('-');

      mockJira.getVersionsSummary.mockResolvedValue([
        { id: '1', name: '4.5.0', released: true, archived: false, releaseDate: todayStr },
      ]);
      mockJira.getIssuesForVersion.mockResolvedValue([]);

      const results = await jiraSync.run();

      // Should be included (released today = within 14 days)
      expect(results.versions.synced).toBe(1);
    });

    it('correctly includes version at the 14-day released boundary', async () => {
      // A version released exactly 13 days ago should be included.
      // With UTC parsing, this could be off by a day and excluded.
      const thirteenDaysAgo = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
      const dateStr = [
        thirteenDaysAgo.getFullYear(),
        String(thirteenDaysAgo.getMonth() + 1).padStart(2, '0'),
        String(thirteenDaysAgo.getDate()).padStart(2, '0'),
      ].join('-');

      mockJira.getVersionsSummary.mockResolvedValue([
        { id: '2', name: '4.4.0', released: true, archived: false, releaseDate: dateStr },
      ]);
      mockJira.getIssuesForVersion.mockResolvedValue([]);

      const results = await jiraSync.run();
      expect(results.versions.synced).toBe(1);
    });
  });

  describe('release-status date comparison', () => {
    it('does not misclassify a same-day release as overdue', () => {
      // If jiraReleaseDate is "2026-04-18" and now is Apr 18 in ET,
      // the status should be "in-flight" (daysUntil === 0), not "overdue".
      const now = new Date('2026-04-18T14:00:00-04:00'); // 2 PM Eastern
      const release = {
        version: '4.5.0',
        jiraReleaseDate: '2026-04-18',
        jiraReleased: false,
        state: 'planning',
      };

      const result = computeReleaseStatus(release, [], now);
      expect(result.status).not.toBe('overdue');
      expect(result.status).toBe('in-flight');
      expect(result.daysUntil).toBe(0);
    });

    it('correctly marks a future release as upcoming', () => {
      const now = new Date('2026-04-10T20:00:00-04:00'); // 8 PM ET = midnight UTC
      const release = {
        version: '4.6.0',
        jiraReleaseDate: '2026-04-25',
        jiraReleased: false,
        state: 'planning',
      };

      const result = computeReleaseStatus(release, [], now);
      expect(result.status).toBe('upcoming');
      expect(result.daysUntil).toBe(15);
    });

    it('correctly marks a past release as overdue', () => {
      const now = new Date('2026-04-18T10:00:00-04:00');
      const release = {
        version: '4.3.0',
        jiraReleaseDate: '2026-04-10',
        jiraReleased: false,
        state: 'planning',
      };

      const result = computeReleaseStatus(release, [], now);
      expect(result.status).toBe('overdue');
      expect(result.daysOverdue).toBe(8);
    });

    it('handles release date at UTC midnight boundary without off-by-one', () => {
      // This is the exact scenario from the bug: at 8 PM ET (midnight UTC),
      // a release scheduled for "today" should NOT flip to overdue.
      const now = new Date('2026-04-18T00:00:00Z'); // midnight UTC = 8 PM ET Apr 17
      const release = {
        version: '4.5.0',
        jiraReleaseDate: '2026-04-18',
        jiraReleased: false,
        state: 'planning',
      };

      const result = computeReleaseStatus(release, [], now);
      // At 8 PM ET on Apr 17, Apr 18 is tomorrow (daysUntil=1) → in-flight
      expect(result.status).toBe('in-flight');
      expect(result.daysUntil).toBe(1);
    });
  });
});
