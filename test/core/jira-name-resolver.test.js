import { describe, it, expect } from 'vitest';
const { resolveJiraName } = require('../../src/core/jira-name-resolver');

const jiraNames = ['Eric Fang', 'Nukul Bhasin', 'Dinith Perera', 'Sophia Alvarez', 'Marco Rossi'];

describe('resolveJiraName', () => {
  it('returns null when inputs are empty', () => {
    expect(resolveJiraName('', jiraNames)).toBeNull();
    expect(resolveJiraName('Eric', [])).toBeNull();
  });

  it('matches exact display name', () => {
    expect(resolveJiraName('Eric Fang', jiraNames)).toBe('Eric Fang');
  });

  it('is case- and accent-insensitive', () => {
    expect(resolveJiraName('eric fang', jiraNames)).toBe('Eric Fang');
    expect(resolveJiraName('Sóphia Álvarez', jiraNames)).toBe('Sophia Alvarez');
  });

  it('matches first name + last initial', () => {
    expect(resolveJiraName('Eric F', jiraNames)).toBe('Eric Fang');
    expect(resolveJiraName('Dinith P', jiraNames)).toBe('Dinith Perera');
  });

  it('returns null when two candidates tie at the same tier', () => {
    // Two "Marco"s both match "Marco R" at first+last-initial tier → ambiguous
    const ambiguous = ['Marco Rossi', 'Marco Reyes'];
    expect(resolveJiraName('Marco R', ambiguous)).toBeNull();
  });

  it('returns null when ambiguity is high and no good match', () => {
    expect(resolveJiraName('John Doe', jiraNames)).toBeNull();
  });
});
