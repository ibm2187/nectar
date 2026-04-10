import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const JiraSync = require('../../src/core/jira-sync');

describe('JiraSync', () => {
  let audit, releases, jiraSync;
  let mockJira;

  const config = {
    jira: { project: 'DEV', maxVersionsPerSync: 50 },
    polling: { jiraSync: 60000 },
    repos: [
      { name: 'webplatform', github: 'mavencare/webplatform', jiraProject: 'DEV' },
      { name: 'bluesummit', github: 'mavencare/bluesummit', jiraProject: 'DEV', sharesVersionsWith: 'webplatform' },
      { name: 'android', github: 'mavencare/android', jiraProject: 'DEV' },
    ],
  };

  beforeEach(() => {
    audit = new Audit();
    releases = new ReleaseManager(audit);
    releases.releases.clear();
    audit.entries = [];

    mockJira = {
      isConfigured: () => true,
      getVersionsSummary: vi.fn(),
      getIssuesForVersion: vi.fn(),
    };

    jiraSync = new JiraSync(releases, mockJira, config);
  });

  describe('_parseVersionName', () => {
    it('parses bare version as webplatform', () => {
      expect(jiraSync._parseVersionName('4.2.3')).toEqual({
        repo: 'webplatform',
        cleanVersion: '4.2.3',
      });
    });

    it('parses iOS prefix', () => {
      expect(jiraSync._parseVersionName('iOS 2026.4.0')).toEqual({
        repo: 'ios',
        cleanVersion: '2026.4.0',
      });
    });

    it('parses Android prefix', () => {
      expect(jiraSync._parseVersionName('Android 3.9.0')).toEqual({
        repo: 'android',
        cleanVersion: '3.9.0',
      });
    });

    it('parses customer-suffixed versions as webplatform', () => {
      expect(jiraSync._parseVersionName('4.1.0.4-ck')).toEqual({
        repo: 'webplatform',
        cleanVersion: '4.1.0.4-ck',
      });
    });
  });

  describe('_getVersionSharingRepos', () => {
    it('returns repos that share versions with webplatform', () => {
      const sharing = jiraSync._getVersionSharingRepos('webplatform');
      expect(sharing).toEqual(['bluesummit']);
    });

    it('returns empty for repos without sharers', () => {
      expect(jiraSync._getVersionSharingRepos('android')).toEqual([]);
      expect(jiraSync._getVersionSharingRepos('bluesummit')).toEqual([]);
    });
  });

  describe('_syncVersionMeta', () => {
    it('creates a webplatform release from bare version', () => {
      jiraSync._syncVersionMeta({
        id: '123',
        name: '4.2.3',
        released: false,
        archived: false,
        releaseDate: '2026-04-29',
      });

      const release = releases.get('4.2.3', 'webplatform');
      expect(release).not.toBeNull();
      expect(release.jiraVersionId).toBe('123');
      expect(release.jiraReleaseDate).toBe('2026-04-29');
    });

    it('propagates JIRA metadata to sharing repos', () => {
      // Pre-create a bluesummit release (as discovery would)
      releases.create({ repo: 'bluesummit', version: '4.2.3', branch: 'VIV/4.2.3' });

      jiraSync._syncVersionMeta({
        id: '123',
        name: '4.2.3',
        released: false,
        archived: false,
        releaseDate: '2026-04-29',
      });

      const bsRelease = releases.get('4.2.3', 'bluesummit');
      expect(bsRelease.jiraVersionId).toBe('123');
      expect(bsRelease.jiraReleaseDate).toBe('2026-04-29');
    });

    it('does not create sharing repo release if it does not exist', () => {
      // No bluesummit release pre-created
      jiraSync._syncVersionMeta({
        id: '123',
        name: '4.2.3',
        released: false,
        archived: false,
      });

      // Only webplatform should exist
      expect(releases.get('4.2.3', 'webplatform')).not.toBeNull();
      expect(releases.get('4.2.3', 'bluesummit')).toBeNull();
    });
  });

  describe('_syncVersionTickets with sharing', () => {
    it('syncs tickets to both primary and sharing repos', async () => {
      // Create both releases
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      releases.create({ repo: 'bluesummit', version: '4.2.3', branch: 'VIV/4.2.3' });

      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-100',
          fields: {
            summary: 'Fix payment',
            status: { name: 'Done' },
            issuetype: { name: 'Bug' },
            assignee: null,
            fixVersions: [{ name: '4.2.3' }],
            labels: [],
          },
        },
      ]);

      await jiraSync._syncVersionTickets('4.2.3');

      // Both releases should have the ticket
      const wpRelease = releases.get('4.2.3', 'webplatform');
      const bsRelease = releases.get('4.2.3', 'bluesummit');

      expect(wpRelease.tickets.some(t => t.key === 'DEV-100')).toBe(true);
      expect(bsRelease.tickets.some(t => t.key === 'DEV-100')).toBe(true);
    });

    it('does not fail if sharing repo has no release for this version', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      // No bluesummit release

      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-200',
          fields: {
            summary: 'Add feature',
            status: { name: 'In Progress' },
            issuetype: { name: 'Story' },
            assignee: null,
            fixVersions: [{ name: '4.2.3' }],
            labels: [],
          },
        },
      ]);

      const result = await jiraSync._syncVersionTickets('4.2.3');
      expect(result.tickets).toBe(1);

      const wpRelease = releases.get('4.2.3', 'webplatform');
      expect(wpRelease.tickets).toHaveLength(1);
    });
  });

  describe('_transitionPath', () => {
    it('returns path from planning to done', () => {
      const path = jiraSync._transitionPath('planning', 'done');
      expect(path).toEqual(['cutting', 'stabilizing', 'approved', 'deploying', 'done']);
    });

    it('returns empty for same state', () => {
      expect(jiraSync._transitionPath('done', 'done')).toEqual([]);
    });

    it('returns empty for backward transition', () => {
      expect(jiraSync._transitionPath('done', 'planning')).toEqual([]);
    });
  });
});
