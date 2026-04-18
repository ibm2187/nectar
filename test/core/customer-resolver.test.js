import { describe, it, expect } from 'vitest';

const {
  resolveTargetCustomers,
  parseDescriptionOverride,
  parseSuffix,
} = require('../../src/core/customer-resolver');

const KNOWN_IDS = ['bayada', 'ck', 'tribute', 'haven', 'lumen', 'qualitycare', 'viv'];

describe('customer-resolver', () => {
  describe('parseDescriptionOverride', () => {
    it('returns null for null/empty description', () => {
      expect(parseDescriptionOverride(null)).toBeNull();
      expect(parseDescriptionOverride('')).toBeNull();
    });

    it('returns null when no @customers tag present', () => {
      expect(parseDescriptionOverride('Some release notes')).toBeNull();
    });

    it('parses single customer', () => {
      expect(parseDescriptionOverride('@customers:bayada')).toEqual(['bayada']);
    });

    it('parses multiple customers', () => {
      expect(parseDescriptionOverride('@customers:ck,tribute')).toEqual(['ck', 'tribute']);
    });

    it('handles spaces around commas', () => {
      expect(parseDescriptionOverride('@customers: ck , tribute , bayada')).toEqual(['ck', 'tribute', 'bayada']);
    });

    it('handles space after colon', () => {
      expect(parseDescriptionOverride('@customers: ck,tribute')).toEqual(['ck', 'tribute']);
    });

    it('is case-insensitive', () => {
      expect(parseDescriptionOverride('@Customers:CK,Tribute')).toEqual(['ck', 'tribute']);
    });

    it('parses tag embedded in longer description', () => {
      expect(parseDescriptionOverride('Hotfix for billing. @customers:bayada,ck. Urgent.')).toEqual(['bayada', 'ck']);
    });
  });

  describe('parseSuffix', () => {
    it('returns null for version without suffix', () => {
      expect(parseSuffix('4.3.0', KNOWN_IDS)).toBeNull();
    });

    it('parses single customer suffix', () => {
      expect(parseSuffix('4.1.0.5-ck', KNOWN_IDS)).toEqual(['ck']);
    });

    it('parses single customer suffix (bayada)', () => {
      expect(parseSuffix('4.2.1-bayada', KNOWN_IDS)).toEqual(['bayada']);
    });

    it('parses compound suffix (cktribute)', () => {
      expect(parseSuffix('4.2.0-cktribute', KNOWN_IDS)).toEqual(['ck', 'tribute']);
    });

    it('parses compound suffix (tributeck)', () => {
      expect(parseSuffix('4.2.0-tributeck', KNOWN_IDS)).toEqual(['tribute', 'ck']);
    });

    it('parses three customers', () => {
      expect(parseSuffix('4.2.0-ckbayadalumen', KNOWN_IDS)).toEqual(['ck', 'bayada', 'lumen']);
    });

    it('returns null for unrecognized suffix', () => {
      expect(parseSuffix('4.1.0-rc1', KNOWN_IDS)).toBeNull();
    });

    it('returns null for partial match with leftover', () => {
      expect(parseSuffix('4.1.0-ckfoo', KNOWN_IDS)).toBeNull();
    });

    it('handles 4-part versions', () => {
      expect(parseSuffix('4.1.0.5-tribute', KNOWN_IDS)).toEqual(['tribute']);
    });

    it('prefers longest match (qualitycare over partial)', () => {
      expect(parseSuffix('4.1.0-qualitycare', KNOWN_IDS)).toEqual(['qualitycare']);
    });
  });

  describe('resolveTargetCustomers', () => {
    it('returns empty array (all customers) for plain version', () => {
      const result = resolveTargetCustomers('4.3.0', null, KNOWN_IDS);
      expect(result).toEqual({ customers: [], source: 'default' });
    });

    it('returns suffix customers for suffixed version', () => {
      const result = resolveTargetCustomers('4.1.0.5-ck', null, KNOWN_IDS);
      expect(result).toEqual({ customers: ['ck'], source: 'suffix' });
    });

    it('returns compound suffix customers', () => {
      const result = resolveTargetCustomers('4.2.0-cktribute', null, KNOWN_IDS);
      expect(result).toEqual({ customers: ['ck', 'tribute'], source: 'suffix' });
    });

    it('description override beats suffix', () => {
      const result = resolveTargetCustomers('4.1.0-ck', '@customers:bayada,tribute', KNOWN_IDS);
      expect(result).toEqual({ customers: ['bayada', 'tribute'], source: 'description' });
    });

    it('description override beats default', () => {
      const result = resolveTargetCustomers('4.3.0', '@customers:ck', KNOWN_IDS);
      expect(result).toEqual({ customers: ['ck'], source: 'description' });
    });

    it('falls through to suffix when description has no @customers tag', () => {
      const result = resolveTargetCustomers('4.1.0-bayada', 'Some notes without tag', KNOWN_IDS);
      expect(result).toEqual({ customers: ['bayada'], source: 'suffix' });
    });

    it('ignores unknown customer IDs in description override', () => {
      const result = resolveTargetCustomers('4.3.0', '@customers:unknown,ck', KNOWN_IDS);
      expect(result).toEqual({ customers: ['ck'], source: 'description' });
    });

    it('falls through to default when description override has only unknown IDs', () => {
      const result = resolveTargetCustomers('4.3.0', '@customers:unknown,fake', KNOWN_IDS);
      expect(result).toEqual({ customers: [], source: 'default' });
    });

    it('returns default when knownCustomerIds is empty', () => {
      const result = resolveTargetCustomers('4.1.0-ck', null, []);
      expect(result).toEqual({ customers: [], source: 'default' });
    });
  });

  describe('edge cases', () => {
    it('parseSuffix handles trailing dash with no suffix', () => {
      expect(parseSuffix('4.3.0-', KNOWN_IDS)).toBeNull();
    });

    it('parseSuffix returns duplicate customer in compound suffix', () => {
      // "ckck" matches ck twice — this is valid greedy behavior
      expect(parseSuffix('4.3.0-ckck', KNOWN_IDS)).toEqual(['ck', 'ck']);
    });

    it('parseDescriptionOverride handles whitespace-only entries', () => {
      expect(parseDescriptionOverride('@customers:  ,  ')).toBeNull();
    });

    it('parseDescriptionOverride handles mixed valid and whitespace entries', () => {
      expect(parseDescriptionOverride('@customers: ck , , tribute')).toEqual(['ck', 'tribute']);
    });
  });
});
