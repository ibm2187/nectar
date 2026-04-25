import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const JiraSync = require('../../src/core/jira-sync');
const CustomerStore = require('../../src/core/customer-store');
const { createTestDb } = require('../../src/core/db');
const TicketStore = require('../../src/core/ticket-store');
describe('JiraSync', () => {
  let audit, releases, jiraSync, db, customerStore;
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
    db = createTestDb();
    audit = new Audit({ db });
    releases = new ReleaseManager(audit, { db });
    customerStore = new CustomerStore({ db });

    // Seed known customers
    customerStore.upsertCustomer({ id: 'ck', name: 'Comfort Keepers', active: true });
    customerStore.upsertCustomer({ id: 'bayada', name: 'Bayada', active: true });
    customerStore.upsertCustomer({ id: 'tribute', name: 'Tribute', active: true });
    customerStore.upsertCustomer({ id: 'lumen', name: 'Lumen', active: true });

    mockJira = {
      isConfigured: () => true,
      getVersionsSummary: vi.fn(),
      getIssuesForVersion: vi.fn(),
    };

    const ticketStore = new TicketStore({ db });
    releases.setTicketStore(ticketStore);

    jiraSync = new JiraSync(releases, mockJira, config);
    jiraSync.setTicketStore(ticketStore);
    jiraSync.setCustomerStore(customerStore);
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

    it('persists JIRA metadata to the DB (survives ReleaseManager reload)', () => {
      jiraSync._syncVersionMeta({
        id: '999',
        name: '4.2.7.1-lumen',
        released: false,
        archived: false,
        releaseDate: '2026-04-27',
      });

      // Rebuild ReleaseManager from the same DB to simulate a server restart.
      const reloaded = new ReleaseManager(audit, { db });
      const release = reloaded.get('4.2.7.1-lumen', 'webplatform');
      expect(release).not.toBeNull();
      expect(release.jiraVersionId).toBe('999');
      expect(release.jiraVersionName).toBe('4.2.7.1-lumen');
      expect(release.jiraReleaseDate).toBe('2026-04-27');
    });

    it('persists JIRA metadata to sharing repos across reload', () => {
      // Pre-create a bluesummit release (as discovery would)
      releases.create({ repo: 'bluesummit', version: '4.2.3', branch: 'VIV/4.2.3' });

      jiraSync._syncVersionMeta({
        id: '321',
        name: '4.2.3',
        released: false,
        archived: false,
        releaseDate: '2026-05-01',
      });

      const reloaded = new ReleaseManager(audit, { db });
      const bsRelease = reloaded.get('4.2.3', 'bluesummit');
      expect(bsRelease).not.toBeNull();
      expect(bsRelease.jiraVersionId).toBe('321');
      expect(bsRelease.jiraVersionName).toBe('4.2.3');
      expect(bsRelease.jiraReleaseDate).toBe('2026-05-01');
    });

    it('sets targetCustomers to empty (all) for plain version', () => {
      jiraSync._syncVersionMeta({
        id: '200', name: '4.3.0', released: false, archived: false,
        releaseDate: null, description: null,
      });

      const release = releases.get('4.3.0', 'webplatform');
      expect(release.targetCustomers).toEqual([]);
      expect(release.targetCustomerSource).toBe('default');
    });

    it('sets targetCustomers from version suffix', () => {
      jiraSync._syncVersionMeta({
        id: '201', name: '4.1.0.5-ck', released: false, archived: false,
        releaseDate: null, description: null,
      });

      const release = releases.get('4.1.0.5-ck', 'webplatform');
      expect(release.targetCustomers).toEqual(['ck']);
      expect(release.targetCustomerSource).toBe('suffix');
    });

    it('sets targetCustomers from compound suffix', () => {
      jiraSync._syncVersionMeta({
        id: '202', name: '4.2.0-cktribute', released: false, archived: false,
        releaseDate: null, description: null,
      });

      const release = releases.get('4.2.0-cktribute', 'webplatform');
      expect(release.targetCustomers).toEqual(['ck', 'tribute']);
      expect(release.targetCustomerSource).toBe('suffix');
    });

    it('description @customers overrides suffix', () => {
      jiraSync._syncVersionMeta({
        id: '203', name: '4.1.0-ck', released: false, archived: false,
        releaseDate: null, description: 'Hotfix. @customers:bayada,tribute',
      });

      const release = releases.get('4.1.0-ck', 'webplatform');
      expect(release.targetCustomers).toEqual(['bayada', 'tribute']);
      expect(release.targetCustomerSource).toBe('description');
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

      expect(releases.getTickets(wpRelease).some(t => t.key === 'DEV-100')).toBe(true);
      // bluesummit shares the same version — ticket is found via TicketStore query
      expect(releases.getTickets(bsRelease).some(t => t.key === 'DEV-100')).toBe(true);
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
      expect(releases.getTickets(wpRelease)).toHaveLength(1);
    });
  });

  describe('ticket pruning', () => {
    it('removes tickets that JIRA no longer returns for a version', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      // Simulate a prior sync that added DEV-100 and DEV-200
      releases.addTicket('webplatform:4.2.3', { key: 'DEV-100', summary: 'Old', source: 'jira', fixVersions: ['4.2.3'] });
      releases.addTicket('webplatform:4.2.3', { key: 'DEV-200', summary: 'Removed', source: 'jira', fixVersions: ['4.2.3'] });

      // Now JIRA only returns DEV-100 (DEV-200 had its fixVersion removed)
      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-100',
          fields: {
            summary: 'Old',
            status: { name: 'Done' },
            issuetype: { name: 'Bug' },
            assignee: null,
            fixVersions: [{ name: '4.2.3' }],
            labels: [],
          },
        },
      ]);

      await jiraSync._syncVersionTickets('4.2.3');

      const release = releases.get('4.2.3', 'webplatform');
      expect(releases.getTickets(release)).toHaveLength(1);
      expect(releases.getTickets(release)[0].key).toBe('DEV-100');
    });

    it('also prunes stale tickets from sharing repos', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      releases.create({ repo: 'bluesummit', version: '4.2.3', branch: 'VIV/4.2.3' });

      // Simulate prior sync
      releases.addTicket('bluesummit:4.2.3', { key: 'DEV-300', summary: 'Stale', source: 'jira', fixVersions: ['4.2.3'] });

      // JIRA returns empty for this version
      mockJira.getIssuesForVersion.mockResolvedValue([]);

      await jiraSync._syncVersionTickets('4.2.3');

      const bsRelease = releases.get('4.2.3', 'bluesummit');
      expect(releases.getTickets(bsRelease).filter(t => t.source === 'jira')).toHaveLength(0);
    });
  });

  describe('sync:version-tickets event', () => {
    it('emits with added tickets when new tickets appear', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });

      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-500', fields: {
            summary: 'Brand new ticket', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
      ]);

      const events = [];
      jiraSync.on('sync:version-tickets', (version, data) => events.push({ version, data }));

      await jiraSync._syncVersionTickets('4.2.3');

      expect(events).toHaveLength(1);
      expect(events[0].version).toBe('4.2.3');
      expect(events[0].data.added).toHaveLength(1);
      expect(events[0].data.added[0].key).toBe('DEV-500');
      expect(events[0].data.added[0].summary).toBe('Brand new ticket');
      expect(events[0].data.removed).toHaveLength(0);
    });

    it('emits with removed tickets when tickets are pruned', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      releases.addTicket('webplatform:4.2.3', {
        key: 'DEV-600', summary: 'Going away', source: 'jira', fixVersions: ['4.2.3'],
      });

      // JIRA no longer returns this ticket
      mockJira.getIssuesForVersion.mockResolvedValue([]);

      const events = [];
      jiraSync.on('sync:version-tickets', (version, data) => events.push({ version, data }));

      await jiraSync._syncVersionTickets('4.2.3');

      expect(events).toHaveLength(1);
      expect(events[0].data.added).toHaveLength(0);
      expect(events[0].data.removed).toHaveLength(1);
      expect(events[0].data.removed[0].key).toBe('DEV-600');
      expect(events[0].data.removed[0].summary).toBe('Going away');
    });

    it('emits with both added and removed in same sync', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      releases.addTicket('webplatform:4.2.3', {
        key: 'DEV-700', summary: 'Old', source: 'jira', fixVersions: ['4.2.3'],
      });

      // New ticket replaces old one
      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-800', fields: {
            summary: 'New', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
      ]);

      const events = [];
      jiraSync.on('sync:version-tickets', (version, data) => events.push({ version, data }));

      await jiraSync._syncVersionTickets('4.2.3');

      expect(events).toHaveLength(1);
      expect(events[0].data.added.map(t => t.key)).toEqual(['DEV-800']);
      expect(events[0].data.removed.map(t => t.key)).toEqual(['DEV-700']);
    });

    it('does not emit when nothing changed', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      releases.addTicket('webplatform:4.2.3', {
        key: 'DEV-900', summary: 'Same', source: 'jira', fixVersions: ['4.2.3'],
      });

      // Same ticket still in JIRA — no add or remove
      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-900', fields: {
            summary: 'Same', status: { name: 'In Progress' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
      ]);

      const events = [];
      jiraSync.on('sync:version-tickets', (version, data) => events.push({ version, data }));

      await jiraSync._syncVersionTickets('4.2.3');

      expect(events).toHaveLength(0);
    });

    it('includes the repo in event data', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });

      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-1000', fields: {
            summary: 'X', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
      ]);

      const events = [];
      jiraSync.on('sync:version-tickets', (version, data) => events.push({ version, data }));

      await jiraSync._syncVersionTickets('4.2.3');

      expect(events[0].data.repo).toBe('webplatform');
    });
  });

  describe('_transitionPath', () => {
    it('returns path from planning to done', () => {
      const path = jiraSync._transitionPath('planning', 'done');
      expect(path).toEqual(['cutting', 'stabilizing', 'approved', 'deploying', 'done']);
    });

    it('returns path from stabilizing to done', () => {
      const path = jiraSync._transitionPath('stabilizing', 'done');
      expect(path).toEqual(['approved', 'deploying', 'done']);
    });

    it('returns single step for adjacent states', () => {
      expect(jiraSync._transitionPath('planning', 'cutting')).toEqual(['cutting']);
    });

    it('returns empty for same state', () => {
      expect(jiraSync._transitionPath('done', 'done')).toEqual([]);
    });

    it('returns empty for backward transition', () => {
      expect(jiraSync._transitionPath('done', 'planning')).toEqual([]);
    });

    it('returns empty for invalid states', () => {
      expect(jiraSync._transitionPath('invalid', 'done')).toEqual([]);
      expect(jiraSync._transitionPath('planning', 'invalid')).toEqual([]);
    });
  });

  describe('_mapVersionState', () => {
    it('returns done for archived versions', () => {
      expect(jiraSync._mapVersionState({ archived: true, released: false })).toBe('done');
    });

    it('returns done for released versions', () => {
      expect(jiraSync._mapVersionState({ archived: false, released: true })).toBe('done');
    });

    it('returns stabilizing for unreleased non-archived versions', () => {
      expect(jiraSync._mapVersionState({ archived: false, released: false })).toBe('stabilizing');
    });
  });

  describe('_syncVersionMeta state transition', () => {
    it('transitions release to done when JIRA version is released', () => {
      // Create a release at planning state
      releases.create({ repo: 'webplatform', version: '4.0.0' });

      jiraSync._syncVersionMeta({
        id: '100',
        name: '4.0.0',
        released: true,
        archived: false,
        releaseDate: '2026-01-01',
      });

      const release = releases.get('4.0.0', 'webplatform');
      expect(release.state).toBe('done');
    });

    it('does not regress a done release', () => {
      releases.create({ repo: 'webplatform', version: '3.9.0' });
      // Transition to done manually
      releases.transition('3.9.0', 'cutting');
      releases.transition('3.9.0', 'stabilizing');
      releases.transition('3.9.0', 'approved');
      releases.transition('3.9.0', 'deploying');
      releases.transition('3.9.0', 'done');

      jiraSync._syncVersionMeta({
        id: '50',
        name: '3.9.0',
        released: false,
        archived: false,
      });

      // Should still be done (mapVersionState returns stabilizing, but
      // the code only updates if jiraState === 'done' and release.state !== 'done')
      const release = releases.get('3.9.0', 'webplatform');
      expect(release.state).toBe('done');
    });
  });

  describe('candidate filtering', () => {
    it('excludes archived versions from candidates', async () => {
      mockJira.getVersionsSummary.mockResolvedValue([
        { name: '4.2.0', released: false, archived: true, releaseDate: null },
        { name: '4.3.0', released: false, archived: false, releaseDate: null },
      ]);
      mockJira.getIssuesForVersion.mockResolvedValue([]);

      const results = await jiraSync.run();

      // Only 4.3.0 should be synced (not archived 4.2.0)
      // Both will have syncVersionMeta called but only non-archived candidates get ticket sync
      expect(results.versions.synced).toBe(1);
    });

    it('excludes released versions older than 14 days', async () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      mockJira.getVersionsSummary.mockResolvedValue([
        { name: '4.1.0', released: true, archived: false, releaseDate: oldDate },
        { name: '4.2.0', released: false, archived: false, releaseDate: null },
      ]);
      mockJira.getIssuesForVersion.mockResolvedValue([]);

      const results = await jiraSync.run();
      expect(results.versions.synced).toBe(1); // Only 4.2.0
    });

    it('includes recently released versions (within 14 days)', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      mockJira.getVersionsSummary.mockResolvedValue([
        { name: '4.1.0', released: true, archived: false, releaseDate: recentDate },
      ]);
      mockJira.getIssuesForVersion.mockResolvedValue([]);

      const results = await jiraSync.run();
      expect(results.versions.synced).toBe(1);
    });
  });

  describe('full run()', () => {
    it('creates releases and syncs tickets end-to-end', async () => {
      mockJira.getVersionsSummary.mockResolvedValue([
        { id: '100', name: '4.3.0', released: false, archived: false, releaseDate: null },
      ]);
      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-500',
          fields: {
            summary: 'New feature',
            status: { name: 'In Progress' },
            issuetype: { name: 'Story' },
            assignee: { displayName: 'Dev' },
            fixVersions: [{ name: '4.3.0' }],
            labels: [],
          },
        },
      ]);

      const results = await jiraSync.run();

      expect(results.versions.total).toBe(1);
      expect(results.versions.synced).toBe(1);
      expect(results.tickets.total).toBe(1);

      const release = releases.get('4.3.0', 'webplatform');
      expect(release).not.toBeNull();
      expect(releases.getTickets(release)).toHaveLength(1);
      expect(releases.getTickets(release)[0].key).toBe('DEV-500');
    });

    it('skips concurrent runs', async () => {
      mockJira.getVersionsSummary.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([]), 50))
      );

      const run1 = jiraSync.run();
      const run2 = jiraSync.run();

      const [result1, result2] = await Promise.all([run1, run2]);

      expect(result1).toBeDefined();
      expect(result2).toBeNull(); // returns lastResults which was null
    });

    it('emits sync events', async () => {
      const events = [];
      jiraSync.on('sync:started', () => events.push('started'));
      jiraSync.on('sync:completed', () => events.push('completed'));

      mockJira.getVersionsSummary.mockResolvedValue([]);
      await jiraSync.run();

      expect(events).toEqual(['started', 'completed']);
    });

    it('updates lastRun and lastResults after run', async () => {
      expect(jiraSync.lastRun).toBeNull();
      expect(jiraSync.lastResults).toBeNull();

      mockJira.getVersionsSummary.mockResolvedValue([]);
      await jiraSync.run();

      expect(jiraSync.lastRun).not.toBeNull();
      expect(jiraSync.lastResults).not.toBeNull();
      expect(jiraSync.lastResults.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getStatus', () => {
    it('returns sync status', () => {
      const status = jiraSync.getStatus();
      expect(status.running).toBe(false);
      expect(status.lastRun).toBeNull();
      expect(status.configured).toBe(true);
    });
  });

  describe('batch persistence (performance)', () => {
    it('persists once per version, not per ticket', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });

      // Spy on persist to count calls
      const persistSpy = vi.spyOn(releases, 'persist');

      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-1', fields: {
            summary: 'A', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
        {
          key: 'DEV-2', fields: {
            summary: 'B', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
        {
          key: 'DEV-3', fields: {
            summary: 'C', status: { name: 'Done' },
            issuetype: { name: 'Story' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
      ]);

      await jiraSync._syncVersionTickets('4.2.3');

      // No persist calls — tickets go to TicketStore, not release.tickets[]
      expect(persistSpy).toHaveBeenCalledTimes(0);

      // All tickets should still be present
      const release = releases.get('4.2.3', 'webplatform');
      expect(releases.getTickets(release)).toHaveLength(3);
      expect(releases.getTickets(release).map(t => t.key).sort()).toEqual(['DEV-1', 'DEV-2', 'DEV-3']);

      persistSpy.mockRestore();
    });

    it('persists once for sharing repos too', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      releases.create({ repo: 'bluesummit', version: '4.2.3', branch: 'VIV/4.2.3' });

      const persistSpy = vi.spyOn(releases, 'persist');

      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-10', fields: {
            summary: 'X', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
        {
          key: 'DEV-11', fields: {
            summary: 'Y', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
      ]);

      await jiraSync._syncVersionTickets('4.2.3');

      // No persist calls — tickets go to TicketStore, not release.tickets[]
      expect(persistSpy).toHaveBeenCalledTimes(0);

      const bsRelease = releases.get('4.2.3', 'bluesummit');
      expect(releases.getTickets(bsRelease)).toHaveLength(2);

      persistSpy.mockRestore();
    });

    it('JIRA sync is authoritative — prunes manually-added tickets not in JIRA', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.3' });
      // Add a ticket manually
      releases.addTicket('webplatform:4.2.3', {
        key: 'DEV-MANUAL', summary: 'Manually added', jiraStatus: 'Open',
        fixVersions: ['4.2.3'], targetFixVersions: [],
      });

      mockJira.getIssuesForVersion.mockResolvedValue([
        {
          key: 'DEV-50', fields: {
            summary: 'From JIRA', status: { name: 'Open' },
            issuetype: { name: 'Bug' }, assignee: null, fixVersions: [{ name: '4.2.3' }], labels: [],
          },
        },
      ]);

      await jiraSync._syncVersionTickets('4.2.3');

      const release = releases.get('4.2.3', 'webplatform');
      const tickets = releases.getTickets(release);
      // Only JIRA-returned ticket survives — manual ticket pruned (version removed from fixVersions)
      expect(tickets).toHaveLength(1);
      expect(tickets[0].key).toBe('DEV-50');
    });
  });
});
