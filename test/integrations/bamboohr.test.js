import { describe, it, expect } from 'vitest';

const bamboohr = require('../../src/integrations/bamboohr');

describe('BambooHR iCal parser', () => {
  describe('_parseIcal', () => {
    it('parses a simple event', () => {
      const text = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:abc123',
        'SUMMARY:Alice (Vacation)',
        'DTSTART;VALUE=DATE:20260401',
        'DTEND;VALUE=DATE:20260405',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\n');
      const events = bamboohr._parseIcal(text);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        UID: 'abc123',
        SUMMARY: 'Alice (Vacation)',
        DTSTART: '20260401',
        DTEND: '20260405',
      });
    });

    it('unfolds continuation lines', () => {
      // Line folding: continuation lines start with a space
      const text = [
        'BEGIN:VEVENT',
        'SUMMARY:Piyush Puri (Vac - Curr YR (recoverable if unaccrued and take',
        ' n) - 4 days)',
        'END:VEVENT',
      ].join('\n');
      const events = bamboohr._parseIcal(text);
      expect(events[0].SUMMARY).toBe('Piyush Puri (Vac - Curr YR (recoverable if unaccrued and taken) - 4 days)');
    });

    it('parses multiple events', () => {
      const text = [
        'BEGIN:VEVENT', 'UID:1', 'SUMMARY:A', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:2', 'SUMMARY:B', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:3', 'SUMMARY:C', 'END:VEVENT',
      ].join('\n');
      expect(bamboohr._parseIcal(text)).toHaveLength(3);
    });
  });

  describe('_parsePersonName', () => {
    it('strips the parenthetical suffix', () => {
      expect(bamboohr._parsePersonName('Piyush Puri (Vac - Curr YR)')).toBe('Piyush Puri');
    });

    it('returns the full string when no parenthesis', () => {
      expect(bamboohr._parsePersonName('Jane Doe')).toBe('Jane Doe');
    });

    it('handles null/empty', () => {
      expect(bamboohr._parsePersonName(null)).toBeNull();
      expect(bamboohr._parsePersonName('')).toBeNull();
    });
  });

  describe('_parseHolidayName', () => {
    it('strips "Company Holiday - " prefix and country suffix', () => {
      const { name, countries } = bamboohr._parseHolidayName('Company Holiday - Good Friday - CDN');
      expect(name).toBe('Good Friday');
      expect(countries).toEqual(['CDN']);
    });

    it('parses multi-country suffix', () => {
      const { name, countries } = bamboohr._parseHolidayName('Company Holiday - Labour/Labor Day - CDN & USA');
      expect(name).toBe('Labour/Labor Day');
      expect(countries).toEqual(['CDN', 'USA']);
    });

    it('handles no country suffix', () => {
      const { name, countries } = bamboohr._parseHolidayName('Company Holiday - Generic Holiday');
      expect(name).toBe('Generic Holiday');
      expect(countries).toEqual([]);
    });
  });

  describe('_toIsoDate', () => {
    it('converts YYYYMMDD to YYYY-MM-DD', () => {
      expect(bamboohr._toIsoDate('20260401')).toBe('2026-04-01');
    });

    it('returns null for bad input', () => {
      expect(bamboohr._toIsoDate(null)).toBeNull();
      expect(bamboohr._toIsoDate('')).toBeNull();
    });
  });

  describe('_subtractOneDay', () => {
    it('subtracts one day from iCal DTEND (exclusive) to get inclusive end', () => {
      expect(bamboohr._subtractOneDay('2026-04-05')).toBe('2026-04-04');
    });

    it('handles month boundary', () => {
      expect(bamboohr._subtractOneDay('2026-04-01')).toBe('2026-03-31');
    });
  });
});
