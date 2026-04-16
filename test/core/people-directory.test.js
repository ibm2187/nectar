import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PeopleDirectory = require('../../src/core/people-directory');

describe('PeopleDirectory', () => {
  let dir;
  let tmpFile;
  let originalSlackIdsPath;

  beforeEach(() => {
    originalSlackIdsPath = process.env.SLACK_IDS_PATH;
    tmpFile = path.join(os.tmpdir(), `slack-ids-test-${Date.now()}-${Math.random()}.json`);
    process.env.SLACK_IDS_PATH = tmpFile;
    dir = new PeopleDirectory();
  });

  afterEach(() => {
    if (originalSlackIdsPath === undefined) {
      delete process.env.SLACK_IDS_PATH;
    } else {
      process.env.SLACK_IDS_PATH = originalSlackIdsPath;
    }
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    vi.restoreAllMocks();
  });

  function writeFixture(users) {
    fs.writeFileSync(tmpFile, JSON.stringify({ users }));
  }

  describe('load', () => {
    it('returns 0 when file does not exist', () => {
      expect(dir.load()).toBe(0);
      expect(dir.isLoaded()).toBe(false);
    });

    it('loads all users from valid JSON', () => {
      writeFixture({
        aaron: { name: 'Aaron Lal', id: 'U04PC87EU' },
        adam: { name: 'Adam Blackman', id: 'U03T4AUJP' },
      });
      expect(dir.load()).toBe(2);
      expect(dir.isLoaded()).toBe(true);
      expect(dir.getAll()).toHaveLength(2);
    });

    it('skips entries missing id or name', () => {
      writeFixture({
        good: { name: 'Good User', id: 'U001' },
        badNoId: { name: 'No ID' },
        badNoName: { id: 'U002' },
      });
      expect(dir.load()).toBe(1);
    });

    it('returns 0 on invalid JSON', () => {
      fs.writeFileSync(tmpFile, 'not valid json');
      expect(dir.load()).toBe(0);
    });
  });

  describe('resolveSlackId — exact match', () => {
    beforeEach(() => {
      writeFixture({
        nukulb: { name: 'Nukul Bhasin', id: 'U123' },
        aaron: { name: 'Aaron Lal', id: 'U456' },
      });
      dir.load();
    });

    it('matches exact display name', () => {
      const result = dir.resolveSlackId('Nukul Bhasin');
      expect(result.slackId).toBe('U123');
      expect(result.match).toBe('exact');
    });

    it('matches case-insensitively', () => {
      const result = dir.resolveSlackId('nukul bhasin');
      expect(result.slackId).toBe('U123');
    });

    it('returns null for unknown name', () => {
      expect(dir.resolveSlackId('Someone Else')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(dir.resolveSlackId('')).toBeNull();
      expect(dir.resolveSlackId(null)).toBeNull();
    });
  });

  describe('resolveSlackId — normalized match', () => {
    beforeEach(() => {
      writeFixture({
        eric: { name: 'eric fang', id: 'U001' },
      });
      dir.load();
    });

    it('handles case variations', () => {
      expect(dir.resolveSlackId('Eric Fang').slackId).toBe('U001');
      expect(dir.resolveSlackId('ERIC FANG').slackId).toBe('U001');
    });

    it('handles extra whitespace', () => {
      expect(dir.resolveSlackId('  Eric   Fang  ').slackId).toBe('U001');
    });
  });

  describe('resolveSlackId — first name + last initial', () => {
    beforeEach(() => {
      writeFixture({
        piyush: { name: 'Piyyush Puri', id: 'U001' },
      });
      dir.load();
    });

    it('matches when spelling differs slightly', () => {
      const result = dir.resolveSlackId('Piyush Puri');
      expect(result).not.toBeNull();
      expect(result.slackId).toBe('U001');
      // Match strategy could be either firstLastInitial or lastNameInitial depending on typo
      expect(['firstLastInitial', 'lastNameInitial', 'fuzzy']).toContain(result.match);
    });
  });

  describe('resolveSlackId — overrides', () => {
    beforeEach(() => {
      writeFixture({
        known: { name: 'Known Person', id: 'U001' },
      });
      dir.load();
    });

    it('applies manual override before other strategies', () => {
      dir.addOverride('Unknown Jira Person', 'U999');
      const result = dir.resolveSlackId('Unknown Jira Person');
      expect(result.slackId).toBe('U999');
      expect(result.match).toBe('override');
    });

    it('override is case-insensitive on JIRA name', () => {
      dir.addOverride('Case Sensitive', 'U999');
      expect(dir.resolveSlackId('case sensitive').slackId).toBe('U999');
      expect(dir.resolveSlackId('CASE SENSITIVE').slackId).toBe('U999');
    });
  });

  describe('unresolved tracking', () => {
    beforeEach(() => {
      writeFixture({ known: { name: 'Known Person', id: 'U001' } });
      dir.load();
    });

    it('tracks names that could not be matched', () => {
      dir.resolveSlackId('Unknown Person');
      const unresolved = dir.getUnresolved();
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].name).toBe('Unknown Person');
      expect(unresolved[0].queryCount).toBe(1);
    });

    it('increments query count on repeated lookup', () => {
      dir.resolveSlackId('Missing Guy');
      dir.resolveSlackId('Missing Guy');
      dir.resolveSlackId('Missing Guy');
      const unresolved = dir.getUnresolved();
      const entry = unresolved.find(u => u.name === 'Missing Guy');
      expect(entry.queryCount).toBe(3);
    });

    it('sorts unresolved by query count descending', () => {
      dir.resolveSlackId('Once');
      dir.resolveSlackId('Twice');
      dir.resolveSlackId('Twice');
      dir.resolveSlackId('Thrice');
      dir.resolveSlackId('Thrice');
      dir.resolveSlackId('Thrice');
      const unresolved = dir.getUnresolved();
      expect(unresolved[0].name).toBe('Thrice');
      expect(unresolved[0].queryCount).toBe(3);
      expect(unresolved[2].name).toBe('Once');
    });

    it('does not track resolved names as unresolved', () => {
      dir.resolveSlackId('Known Person');
      expect(dir.getUnresolved()).toHaveLength(0);
    });
  });

  describe('reload', () => {
    it('picks up new entries from file', () => {
      writeFixture({ a: { name: 'A Person', id: 'U001' } });
      dir.load();
      expect(dir.getAll()).toHaveLength(1);

      writeFixture({
        a: { name: 'A Person', id: 'U001' },
        b: { name: 'B Person', id: 'U002' },
      });
      dir.reload();
      expect(dir.getAll()).toHaveLength(2);
    });

    it('removes deleted entries on reload', () => {
      writeFixture({
        a: { name: 'A Person', id: 'U001' },
        b: { name: 'B Person', id: 'U002' },
      });
      dir.load();
      expect(dir.getAll()).toHaveLength(2);

      writeFixture({ a: { name: 'A Person', id: 'U001' } });
      dir.reload();
      expect(dir.getAll()).toHaveLength(1);
    });
  });

  describe('resolveAll', () => {
    beforeEach(() => {
      writeFixture({
        a: { name: 'Alice Anderson', id: 'U001' },
        b: { name: 'Bob Brown', id: 'U002' },
      });
      dir.load();
    });

    it('returns a Map of results', () => {
      const results = dir.resolveAll(['Alice Anderson', 'Unknown', 'Bob Brown']);
      expect(results.size).toBe(3);
      expect(results.get('Alice Anderson').slackId).toBe('U001');
      expect(results.get('Unknown')).toBeNull();
      expect(results.get('Bob Brown').slackId).toBe('U002');
    });
  });
});
