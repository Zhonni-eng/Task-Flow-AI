import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, addMonths, daysFromToday, isSameDay, isValidDateKey, parseDateKey, toDateKey } from '../../src/utils/date.js';
import { FIXED_TODAY } from '../helpers/fixtures.js';

describe('date helpers', () => {
  afterEach(() => vi.useRealTimers());

  it('round-trips local date keys', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toDateKey(parseDateKey('2026-12-31'))).toBe('2026-12-31');
  });

  it('rejects impossible or malformed dates', () => {
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('2026-1-5')).toBeNull();
    expect(isValidDateKey(null)).toBe(false);
    expect(isValidDateKey('tomorrow')).toBe(false);
  });

  it('adds days and months across boundaries', () => {
    expect(toDateKey(addDays(new Date(2026, 11, 31), 1))).toBe('2027-01-01');
    expect(toDateKey(addMonths(new Date(2026, 0, 31), 1))).toBe('2026-02-01');
    expect(isSameDay(new Date(2026, 4, 1, 23), new Date(2026, 4, 1, 1))).toBe(true);
  });

  it('counts whole days from a controlled "today"', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_TODAY);
    expect(daysFromToday(parseDateKey('2026-10-21'))).toBe(0);
    expect(daysFromToday(parseDateKey('2026-10-20'))).toBe(-1);
    expect(daysFromToday(parseDateKey('2026-11-21'))).toBe(31);
  });
});
