import { isHistoricalRun, type IngestRun } from '../domain/ingest-run';
import type { IconName, Tone } from './layout';

/** Hard-filter counters did not exist for historical runs: null (shown as "—"), never a misleading 0. */
const filterCount = (count: (run: IngestRun) => number) => (run: IngestRun) => (isHistoricalRun(run) ? null : count(run));

/**
 * A run's counters, in display order, with compact labels and tooltips. Every
 * fetched item lands in exactly one of them other than "Fetched".
 */
export const RUN_COUNTERS: readonly {
  label: string;
  title: string;
  tone: Tone;
  icon: IconName;
  value: (run: IngestRun) => number | null;
}[] = [
  { label: 'Fetched', title: 'Items Apify returned', tone: 'cyan', icon: 'download', value: (r) => r.fetched },
  { label: 'New', title: 'Posts stored for the first time', tone: 'emerald', icon: 'sparkle', value: (r) => r.new },
  { label: 'Duplicates', title: 'Posts already stored', tone: 'amber', icon: 'copy', value: (r) => r.already_seen },
  { label: 'No hiring', title: 'No hiring keyword', tone: 'neutral', icon: 'filter', value: filterCount((r) => r.dropped_no_hiring) },
  { label: 'Non-US', title: 'Job located outside the US', tone: 'purple', icon: 'globe', value: filterCount((r) => r.dropped_non_us) },
  {
    label: 'Loc. unknown',
    title: 'Job location missing or ambiguous',
    tone: 'teal',
    icon: 'pin',
    value: filterCount((r) => r.dropped_location_unknown),
  },
  { label: 'Out of range', title: 'Posted outside the date range', tone: 'blue', icon: 'calendar', value: (r) => r.out_of_range },
  { label: 'Invalid', title: 'Items that could not be read', tone: 'red', icon: 'alert', value: (r) => r.invalid },
];
