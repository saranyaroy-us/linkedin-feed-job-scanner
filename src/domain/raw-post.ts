import * as z from 'zod';

export const POST_SOURCE = 'apify_linkedin_post_search' as const;

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
