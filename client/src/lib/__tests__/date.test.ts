import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { toLocalDateKey, todayLocal } from '../date'

describe('date helpers', () => {
  describe('toLocalDateKey', () => {
    it('formats a date in local TZ as YYYY-MM-DD', () => {
      const d = new Date(2026, 3, 24, 21, 30) // Apr 24 2026 9:30pm local
      expect(toLocalDateKey(d)).toBe('2026-04-24')
    })

    it('zero-pads month and day', () => {
      const d = new Date(2026, 0, 5, 12, 0) // Jan 5 2026 noon local
      expect(toLocalDateKey(d)).toBe('2026-01-05')
    })

    it('returns local date even when UTC has rolled over', () => {
      // 9pm ET on Apr 24 = 01:00 UTC Apr 25 (during EDT). Build a Date that
      // .toISOString() would slice to "2026-04-25", but local wall-clock is
      // still Apr 24. We construct via local components to guarantee that.
      const local = new Date(2026, 3, 24, 21, 0) // Apr 24 9pm local
      // Sanity: confirm the test would have failed under the old approach
      // when local TZ is east of UTC at this hour. We don't assert on
      // toISOString here (it depends on the runner's TZ), just on the helper.
      expect(toLocalDateKey(local)).toBe('2026-04-24')
    })
  })

  describe('todayLocal', () => {
    beforeAll(() => {
      vi.useFakeTimers()
    })
    afterAll(() => {
      vi.useRealTimers()
    })

    it('returns the local date string for "now"', () => {
      vi.setSystemTime(new Date(2026, 3, 24, 21, 0)) // Apr 24 9pm local
      expect(todayLocal()).toBe('2026-04-24')
    })

    it('rolls to next day at local midnight, not UTC midnight', () => {
      vi.setSystemTime(new Date(2026, 3, 25, 0, 1)) // Apr 25 12:01am local
      expect(todayLocal()).toBe('2026-04-25')
    })
  })
})
