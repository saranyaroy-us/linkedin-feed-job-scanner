import * as z from 'zod';

export const POST_SOURCE = 'apify_linkedin_post_search' as const;

export const WORK_MODES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const TaggedCompanySchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  linkedin_url: z.string().nullable(),
});

export type TaggedCompany = z.infer<typeof TaggedCompanySchema>;

const count = z.number().int().nonnegative().nullable();

export const RawPostSchema = z.object({
  source: z.literal(POST_SOURCE),
  source_id: z.string().min(1),
  linkedin_post_id: z.string().nullable(),
  entity_id: z.string().nullable(),
  text: z.string().nullable(),

  author_name: z.string().nullable(),
  author_type: z.enum(['profile', 'company']).nullable(),
  author_profile_url: z.url({ protocol: /^https?$/ }).nullable(),
  author_headline: z.string().nullable(),

  /** Actor `linkedinUrl` (falls back to `shareLinkedinUrl`); null if the item has neither. */
  url: z.url({ protocol: /^https?$/ }).nullable(),
  posted_at: z.iso.datetime().nullable(),

  search_query: z.string().nullable(),
  apify_run_id: z.string().nullable(),

  repost_id: z.string().nullable(),

  article_title: z.string().nullable(),
  article_url: z.url({ protocol: /^https?$/ }).nullable(),

  /** Job details (src/normalization/job-details.ts); null when the post does not state them. */
  job_title: z.string().max(200).nullable(),
  /** Where job_title came from; null without a title and for posts stored before migration 0008. */
  job_title_source: z.enum(['job_card', 'listing', 'text']).nullable(),
  company_name: z.string().max(200).nullable(),
  /** The company's LinkedIn page, https://www.linkedin.com/company/<slug>/. */
  company_linkedin_url: z.url({ protocol: /^https$/ }).nullable(),
  /** "unknown" when the post does not say; null for posts stored before job details existed. */
  work_mode: z.enum(WORK_MODES).nullable(),

  /** Canonical LinkedIn Jobs listing (https://www.linkedin.com/jobs/view/<id>/), never an external apply link. */
  linkedin_job_url: z.url({ protocol: /^https$/ }).nullable(),
  /** Application link outside LinkedIn (ATS, career page, job board, or an lnkd.in link introduced by "apply"). */
  external_apply_url: z.url({ protocol: /^https?$/ }).nullable(),
  /** Where the job is, as found by the US-job filter: the job card's location or the US evidence in the text. */
  job_location_text: z.string().nullable(),
  /** "US" for every post stored since the US-job filter; null for older posts. */
  job_country: z.literal('US').nullable(),
  location_source: z.enum(['job', 'article', 'post_text']).nullable(),

  likes: count,
  comments: count,
  shares: count,

  /** JSON array of TaggedCompany, or null when the item had no contentAttributes. */
  tagged_companies_json: z.string().nullable(),

  /**
   * The full original Actor item, so a post can be re-normalized without
   * refetching. Always set on insert; D1 keeps it for RAW_JSON_RETENTION_DAYS.
   */
  raw_json: z.string().min(2),

  fetched_at: z.iso.datetime(),
});

export type RawPost = z.infer<typeof RawPostSchema>;

/** A row of `raw_posts` as read for the dashboard and API: every column except raw_json. */
export interface StoredRawPost extends Omit<RawPost, 'raw_json'> {
  id: number;
  created_at: string;
}

/**
 * A full `raw_posts` row. raw_json is the original Actor item for
 * RAW_JSON_RETENTION_DAYS after the post is stored, then NULL; the row and its
 * normalized columns are kept indefinitely.
 */
export interface StoredRawPostWithRaw extends StoredRawPost {
  raw_json: string | null;
}
