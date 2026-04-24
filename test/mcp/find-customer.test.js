import { describe, it, expect } from 'vitest';

const { findCustomer } = require('../../src/mcp/server');

const CUSTOMERS = [
  { id: 'lumen', name: 'Help at Home', shortName: 'Lumen' },
  { id: 'ck', name: 'Comfort Keepers', shortName: 'CK' },
  { id: 'bayada', name: 'Bayada', shortName: 'Bayada' },
  { id: 'qualitycare', name: 'Quality Care', shortName: 'Quality Care' },
];

describe('findCustomer', () => {
  it('matches by canonical id', () => {
    expect(findCustomer(CUSTOMERS, 'lumen').id).toBe('lumen');
  });

  it('matches by id case-insensitively', () => {
    expect(findCustomer(CUSTOMERS, 'LUMEN').id).toBe('lumen');
    expect(findCustomer(CUSTOMERS, 'Lumen').id).toBe('lumen');
  });

  it('matches by shortName', () => {
    expect(findCustomer(CUSTOMERS, 'Lumen').id).toBe('lumen');
    expect(findCustomer(CUSTOMERS, 'CK').id).toBe('ck');
  });

  it('matches by shortName case-insensitively', () => {
    expect(findCustomer(CUSTOMERS, 'ck').id).toBe('ck');
    expect(findCustomer(CUSTOMERS, 'cK').id).toBe('ck');
  });

  it('matches by full name', () => {
    expect(findCustomer(CUSTOMERS, 'Help at Home').id).toBe('lumen');
    expect(findCustomer(CUSTOMERS, 'Comfort Keepers').id).toBe('ck');
  });

  it('matches by full name case-insensitively', () => {
    expect(findCustomer(CUSTOMERS, 'help at home').id).toBe('lumen');
    expect(findCustomer(CUSTOMERS, 'HELP AT HOME').id).toBe('lumen');
  });

  it('trims whitespace from the needle', () => {
    expect(findCustomer(CUSTOMERS, '  lumen  ').id).toBe('lumen');
    expect(findCustomer(CUSTOMERS, '\tHelp at Home\n').id).toBe('lumen');
  });

  it('handles shortName with internal whitespace as a single token', () => {
    expect(findCustomer(CUSTOMERS, 'Quality Care').id).toBe('qualitycare');
    expect(findCustomer(CUSTOMERS, 'quality care').id).toBe('qualitycare');
  });

  it('returns null when no customer matches', () => {
    expect(findCustomer(CUSTOMERS, 'nonexistent')).toBeNull();
    expect(findCustomer(CUSTOMERS, 'help')).toBeNull(); // partial name, not a full match
  });

  it('returns null for empty or invalid needles', () => {
    expect(findCustomer(CUSTOMERS, '')).toBeNull();
    expect(findCustomer(CUSTOMERS, '   ')).toBeNull();
    expect(findCustomer(CUSTOMERS, null)).toBeNull();
    expect(findCustomer(CUSTOMERS, undefined)).toBeNull();
    expect(findCustomer(CUSTOMERS, 123)).toBeNull();
  });

  it('handles customers missing optional fields', () => {
    const sparse = [
      { id: 'foo' }, // no name or shortName
      { id: 'bar', shortName: 'Bar' }, // no name
      { id: 'baz', name: 'Baz Co' }, // no shortName
    ];
    expect(findCustomer(sparse, 'foo').id).toBe('foo');
    expect(findCustomer(sparse, 'Bar').id).toBe('bar');
    expect(findCustomer(sparse, 'Baz Co').id).toBe('baz');
    expect(findCustomer(sparse, 'anything-else')).toBeNull();
  });

  it('returns the first match when multiple customers share a name', () => {
    const dupes = [
      { id: 'first', shortName: 'Same' },
      { id: 'second', shortName: 'Same' },
    ];
    expect(findCustomer(dupes, 'same').id).toBe('first');
  });

  it('returns null for an empty customer list', () => {
    expect(findCustomer([], 'lumen')).toBeNull();
  });
});
