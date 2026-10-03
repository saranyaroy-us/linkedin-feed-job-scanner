/**
 * Time-zone helpers built on Intl only (no dependencies). D1 stores UTC ISO
 * timestamps; the dashboard shows and filters by the configured display zone.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** Constructing Intl.DateTimeFormat is expensive; one formatter per zone is reused. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Returns `timeZone` if the runtime knows it, otherwise UTC. */
export function resolveTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    formatter(timeZone);
    return timeZone;
  } catch {
    return 'UTC';
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** Offset of `timeZone` from UTC at `date`, in minutes (e.g. +330 for Asia/Kolkata). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar date (YYYY-MM-DD) of `date` in `timeZone`. */
export function dateInZone(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

const MIN_YEAR = 1970;
const MAX_YEAR = 9998;

/** True for a real calendar date in YYYY-MM-DD form within a sane year range. */
export function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const STEP_MS = 15 * 60_000; // every real-world UTC offset is a multiple of 15 minutes

/**
 * UTC ISO instant of the first moment of `ymd` (YYYY-MM-DD) in `timeZone`.
 * Handles zones where midnight is skipped or repeated by a DST change.
 */
export function startOfDayUtc(ymd: string, timeZone: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let instant = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  instant = guess - offsetMinutes(new Date(instant), timeZone) * 60_000;
  // Midnight skipped (DST starts at 00:00): the estimate lands on the previous day.
  for (let i = 0; i < 16 && dateInZone(new Date(instant), timeZone) < ymd; i++) instant += STEP_MS;
  // Midnight repeated: walk back to the earliest instant still on `ymd`.
  for (let i = 0; i < 16 && dateInZone(new Date(instant - STEP_MS), timeZone) === ymd; i++) instant -= STEP_MS;
  return new Date(instant).toISOString();
}

/** UTC ISO instant of the first moment after `ymd` ends in `timeZone`. */
export function endOfDayUtc(ymd: string, timeZone: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextYmd = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  return startOfDayUtc(nextYmd, timeZone);
}

/** "2026-10-03 09:05" in `timeZone`, or "—" for missing/invalid input. */
export function formatInZone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
