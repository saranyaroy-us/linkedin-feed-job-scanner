import type { RawPost } from '../domain/raw-post';
import { normalizePost, type NormalizeContext } from '../normalization/post-normalizer';
import { mentionsHiring } from './hiring-filter';
import { jobLocation } from './job-location';

export interface ScreenedItems {
  /** Items that passed both hard filters, normalized and tagged with their US job location. */
  posts: RawPost[];
  /** Text lacks "hiring". */
  droppedNoHiring: number;
  /** The job is outside the US. */
  droppedNonUs: number;
  /** The job's location is missing or ambiguous. */
  droppedLocationUnknown: number;
  /** Passed the filters but could not be normalized. */
  invalid: number;
}

/**
 * The hard filters, in order, for each item of a dataset page: no "hiring" →
 * dropped; job not confidently in the US → dropped (non-US or location
 * unknown); otherwise normalized (invalid if that fails). A dropped item is
 * never normalized, deduplicated or stored, and each item is counted once.
 */
export async function screenItems(items: readonly unknown[], context: NormalizeContext): Promise<ScreenedItems> {
  const screened: ScreenedItems = { posts: [], droppedNoHiring: 0, droppedNonUs: 0, droppedLocationUnknown: 0, invalid: 0 };
  for (const item of items) {
    if (!mentionsHiring(item)) {
      screened.droppedNoHiring++;
      continue;
    }
    const location = jobLocation(item);
    if (location.verdict !== 'us') {
      if (location.verdict === 'non_us') screened.droppedNonUs++;
      else screened.droppedLocationUnknown++;
      continue;
    }
    try {
      const post = await normalizePost(item, context);
      screened.posts.push({ ...post, job_location_text: location.text, job_country: 'US', location_source: location.source });
    } catch {
      screened.invalid++;
    }
  }
  return screened;
}
