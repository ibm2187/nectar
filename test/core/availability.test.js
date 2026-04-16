import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Availability = require('../../src/core/availability');
const bamboohr = require('../../src/integrations/bamboohr');

describe('Availability store', () => {
  let availability;
  let originalWhosOut, originalHolidays;

  beforeEach(() => {
    originalWhosOut = process.env.BAMBOOHR_WHOSOUT_URL;
    originalHolidays = process.env.BAMBOOHR_HOLIDAYS_URL;
    process.env.BAMBOOHR_WHOSOUT_URL = 'http://test-whosout';
    process.env.BAMBOOHR_HOLIDAYS_URL = 'http://test-holidays';
    availability = new Availability();
  });

  afterEach(() => {
    if (availability) availability.stop();
    if (originalWhosOut === undefined) delete process.env.BAMBOOHR_WHOSOUT_URL;
    else process.env.BAMBOOHR_WHOSOUT_URL = originalWhosOut;
    if (originalHolidays === undefined) delete process.env.BAMBOOHR_HOLIDAYS_URL;
    else process.env.BAMBOOHR_HOLIDAYS_URL = originalHolidays;
    vi.restoreAllMocks();
  });

  async function seedWith({ out = [], holidays = [] } = {}) {
    vi.spyOn(bamboohr, 'fetchWhosOut').mockResolvedValue(out);
    vi.spyOn(bamboohr, 'fetchHolidays').mockResolvedValue(holidays);
    await availability.refresh();
  }

  describe('refresh', () => {
    it('loads events and marks as loaded', async () => {
      await seedWith({
        out: [{ name: 'Alice', startDate: '2026-04-01', endDate: '2026-04-05', summary: 'Vac' }],
        holidays: [{ date: '2026-04-03', name: 'Good Friday', countries: ['CDN'], summary: 'x' }],
      });
      expect(availability.isLoaded()).toBe(true);
      expect(availability.lastRefreshedAt()).toBeTruthy();
    });

    it('skips when no URLs are configured', async () => {
      delete process.env.BAMBOOHR_WHOSOUT_URL;
      delete process.env.BAMBOOHR_HOLIDAYS_URL;
      const result = await availability.refresh();
      expect(result.outCount).toBe(0);
      expect(availability.isLoaded()).toBe(false);
    });
  });

  describe('isPersonOut', () => {
    beforeEach(async () => {
      await seedWith({
        out: [
          { name: 'Alice', startDate: '2026-04-01', endDate: '2026-04-05', summary: 'Vac' },
          { name: 'Bob', startDate: '2026-04-10', endDate: '2026-04-10', summary: 'Sick' },
        ],
      });
    });

    it('is true during the range', () => {
      expect(availability.isPersonOut('Alice', '2026-04-01')).toBe(true);
      expect(availability.isPersonOut('Alice', '2026-04-03')).toBe(true);
      expect(availability.isPersonOut('Alice', '2026-04-05')).toBe(true);
    });

    it('is false outside the range', () => {
      expect(availability.isPersonOut('Alice', '2026-03-31')).toBe(false);
      expect(availability.isPersonOut('Alice', '2026-04-06')).toBe(false);
    });

    it('handles single-day out', () => {
      expect(availability.isPersonOut('Bob', '2026-04-10')).toBe(true);
      expect(availability.isPersonOut('Bob', '2026-04-11')).toBe(false);
    });

    it('returns false for unknown person', () => {
      expect(availability.isPersonOut('Carol', '2026-04-03')).toBe(false);
    });
  });

  describe('fuzzy name matching', () => {
    it('matches on first-initial + last-name when spelling differs', async () => {
      await seedWith({
        out: [{ name: 'Piyyush Puri', startDate: '2026-04-01', endDate: '2026-04-05', summary: 'Vac' }],
      });
      // JIRA has "Piyush Puri" (one y) — fuzzy match should find it
      expect(availability.isPersonOut('Piyush Puri', '2026-04-03')).toBe(true);
    });

    it('case-insensitive', async () => {
      await seedWith({
        out: [{ name: 'Jane Doe', startDate: '2026-04-01', endDate: '2026-04-05', summary: 'Vac' }],
      });
      expect(availability.isPersonOut('JANE DOE', '2026-04-03')).toBe(true);
    });
  });

  describe('getPersonOutInRange', () => {
    beforeEach(async () => {
      await seedWith({
        out: [{ name: 'Alice', startDate: '2026-04-10', endDate: '2026-04-15', summary: 'Vac' }],
      });
    });

    it('detects overlap when range starts during OOO', () => {
      const r = availability.getPersonOutInRange('Alice', '2026-04-12', '2026-04-20');
      expect(r).not.toBeNull();
    });

    it('detects overlap when range ends during OOO', () => {
      const r = availability.getPersonOutInRange('Alice', '2026-04-05', '2026-04-10');
      expect(r).not.toBeNull();
    });

    it('returns null when no overlap', () => {
      expect(availability.getPersonOutInRange('Alice', '2026-04-20', '2026-04-25')).toBeNull();
    });
  });

  describe('holidays + business days', () => {
    beforeEach(async () => {
      await seedWith({
        holidays: [
          { date: '2026-04-03', name: 'Good Friday', countries: ['CDN'], summary: '' },
          { date: '2026-05-18', name: 'Victoria Day', countries: ['CDN'], summary: '' },
        ],
      });
    });

    it('isHoliday is true for listed dates', () => {
      expect(availability.isHoliday('2026-04-03')).toBe(true);
      expect(availability.isHoliday('2026-04-04')).toBe(false);
    });

    it('isBusinessDay is false for holidays', () => {
      expect(availability.isBusinessDay('2026-04-03')).toBe(false);
    });

    it('isBusinessDay is false for weekends', () => {
      // April 4 2026 is a Saturday
      expect(availability.isBusinessDay('2026-04-04')).toBe(false);
      expect(availability.isBusinessDay('2026-04-05')).toBe(false);
    });

    it('isBusinessDay is true for normal weekdays', () => {
      expect(availability.isBusinessDay('2026-04-02')).toBe(true); // Thu
      expect(availability.isBusinessDay('2026-04-06')).toBe(true); // Mon
    });

    it('nextBusinessDays skips weekends and holidays', () => {
      // From Wed Apr 1 2026: next 2 business days should skip Fri (Good Friday) AND weekend
      const biz = availability.nextBusinessDays(2, '2026-04-01');
      expect(biz).toEqual(['2026-04-02', '2026-04-06']); // Thu (skip Fri holiday + Sat/Sun)
    });

    it('nextBusinessDays skips weekends from Friday', () => {
      // From Thu Apr 2 2026: should get Mon + Tue (skip Fri holiday + weekend)
      const biz = availability.nextBusinessDays(2, '2026-04-02');
      expect(biz).toEqual(['2026-04-06', '2026-04-07']);
    });
  });

  describe('listCurrentlyOut', () => {
    it('returns people currently out', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      await seedWith({
        out: [
          { name: 'Alice', startDate: yesterday, endDate: tomorrow, summary: 'Vac' },
          { name: 'Bob', startDate: '2020-01-01', endDate: '2020-01-05', summary: 'Past' },
        ],
      });
      const outNow = availability.listCurrentlyOut();
      expect(outNow.map(o => o.name)).toEqual(['Alice']);
    });
  });

  describe('snapshot', () => {
    it('returns loaded state + currentlyOut + upcomingHolidays', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await seedWith({
        out: [{ name: 'Alice', startDate: today, endDate: today, summary: 'Vac' }],
        holidays: [{ date: '2099-01-01', name: 'Future', countries: [], summary: '' }],
      });
      const snap = availability.snapshot();
      expect(snap.loaded).toBe(true);
      expect(snap.currentlyOut).toHaveLength(1);
      expect(snap.upcomingHolidays).toHaveLength(1);
    });
  });
});
