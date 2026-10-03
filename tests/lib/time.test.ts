import { describe, expect, it } from 'vitest';
import {
  dateInZone,
  endOfDayUtc,
  formatInZone,
  isYmd,
  offsetMinutes,
  resolveTimeZone,
  startOfDayUtc,
} from '../../src/lib/time';

describe('time helpers (Asia/Kolkata = UTC+05:30, no DST)', () => {
  const tz = 'Asia/Kolkata';

  it('computes the zone offset', () => {
    expect(offsetMinutes(new Date('2026-10-03T00:00:00Z'), tz)).toBe(330);
    expect(offsetMinutes(new Date('2026-10-03T00:00:00Z'), 'UTC')).toBe(0);
  });

  it('local day boundaries in UTC', () => {
    expect(startOfDayUtc('2026-10-03', tz)).toBe('2026-10-02T18:30:00.000Z');
    expect(endOfDayUtc('2026-10-03', tz)).toBe('2026-10-03T18:30:00.000Z');
    expect(startOfDayUtc('2026-10-03', 'UTC')).toBe('2026-10-03T00:00:00.000Z');
  });

  it('handles DST zones', () => {
    // New York switches to EDT (UTC-4) on 2026-03-08.
    expect(startOfDayUtc('2026-03-09', 'America/New_York')).toBe('2026-03-09T04:00:00.000Z');
    expect(startOfDayUtc('2026-03-07', 'America/New_York')).toBe('2026-03-07T05:00:00.000Z');
  });

  it('returns the first instant of the day even where DST skips midnight', () => {
    // Havana and Santiago move clocks forward at 00:00, so those days start at 01:00.
    const cases: [string, string][] = [
      ['America/Havana', '2026-03-08'],
      ['America/Santiago', '2026-09-06'],
      ['America/Havana', '2026-11-01'],
      ['America/Santiago', '2026-04-05'],
    ];
    for (const [zone, day] of cases) {
      const start = new Date(startOfDayUtc(day, zone));
      expect(dateInZone(start, zone)).toBe(day);
      expect(dateInZone(new Date(start.getTime() - 60_000), zone) < day).toBe(true);
    }
  });

  it('local calendar date of an instant', () => {
    expect(dateInZone(new Date('2026-10-02T18:29:00Z'), tz)).toBe('2026-10-02');
    expect(dateInZone(new Date('2026-10-02T18:30:00Z'), tz)).toBe('2026-10-03');
  });

  it('formats timestamps in the zone', () => {
    expect(formatInZone('2026-10-03T03:30:00.000Z', tz)).toBe('2026-10-03 09:00');
    expect(formatInZone(null, tz)).toBe('—');
    expect(formatInZone('not a date', tz)).toBe('—');
  });

  it('validates YYYY-MM-DD dates within a sane year range', () => {
    expect(isYmd('2026-10-03')).toBe(true);
    expect(isYmd('2026-02-30')).toBe(false);
    expect(isYmd('03-10-2026')).toBe(false);
    expect(isYmd('9999-12-31')).toBe(false);
    expect(isYmd('0001-01-01')).toBe(false);
    expect(isYmd('9998-12-31')).toBe(true);
    expect(() => endOfDayUtc('9998-12-31', tz)).not.toThrow();
    expect(endOfDayUtc('2026-12-31', 'UTC')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('falls back for unknown zones', () => {
    expect(resolveTimeZone(undefined)).toBe('Asia/Kolkata');
    expect(resolveTimeZone('Not/AZone')).toBe('UTC');
    expect(resolveTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });
});
