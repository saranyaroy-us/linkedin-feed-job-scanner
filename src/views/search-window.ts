import type { SearchRun, SearchWindow } from '../domain/search-run';
import { dateInZone } from '../lib/time';

/** Labels of the Run Search options. */
export const WINDOW_LABELS: Record<SearchWindow, string> = {
  '24h': 'Past 24 hours',
  week: '7 days',
  month: '30 days',
  range: 'Date Range',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 1" from YYYY-MM-DD, with the year when asked. */
function shortDate(ymd: string, withYear: boolean): string {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  return `${MONTHS[month - 1]} ${day}${withYear ? `, ${year}` : ''}`;
}

type SearchWindowFields = Pick<SearchRun, 'search_window' | 'requested_from' | 'requested_to'>;

/** First and last day (YYYY-MM-DD in `timeZone`) of a date-range search. */
export function rangeDays(search: SearchWindowFields, timeZone: string): { from: string; to: string } {
  return {
    from: dateInZone(new Date(search.requested_from), timeZone),
    // requested_to is exclusive: the range's last day is the day before it.
    to: dateInZone(new Date(Date.parse(search.requested_to) - 1), timeZone),
  };
}

/** "Past 24 hours", "7 days", "30 days", or the range's days in `timeZone`, e.g. "Oct 1 – Oct 4". */
export function searchWindowLabel(search: SearchWindowFields, timeZone: string): string {
  if (search.search_window !== 'range') return WINDOW_LABELS[search.search_window];
  const { from, to } = rangeDays(search, timeZone);
  if (from === to) return shortDate(from, false);
  const withYear = from.slice(0, 4) !== to.slice(0, 4);
  return `${shortDate(from, withYear)} – ${shortDate(to, withYear)}`;
}

const POSTED_LIMIT_LABELS = new Map<unknown, string>([
  ['24h', WINDOW_LABELS['24h']],
  ['week', WINDOW_LABELS.week],
  ['month', WINDOW_LABELS.month],
]);

/** Window of a run with no search record (started before Run Search existed), from its Actor input. */
export function inputWindowLabel(queryConfigJson: string | null): string {
  try {
    return POSTED_LIMIT_LABELS.get(JSON.parse(queryConfigJson ?? 'null')?.postedLimit) ?? '—';
  } catch {
    return '—';
  }
}
