import { POST_SOURCE, RawPostSchema, type RawPost, type TaggedCompany } from '../domain/raw-post';
import { jobCompany, jobTitle, workMode } from './job-details';
import { externalApplyUrl, linkedinJobUrl } from './job-links';

export interface NormalizeContext {
  fetchedAt: string;
  apifyRunId: string | null;
}

export interface InvalidItem {
  index: number;
  reason: string;
}

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asObject = (value: unknown): Obj | null => (isObject(value) ? value : null);

/** Non-empty trimmed string; numeric ids are accepted as strings. */
function asString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function asHttpUrl(value: unknown): string | null {
  const str = asString(value);
  if (!str) return null;
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:' ? str : null;
  } catch {
    return null;
  }
}

/** Drops the query string and fragment (e.g. LinkedIn's `?miniProfileUrn=...`). */
export function stripQuery(value: unknown): string | null {
  const str = asHttpUrl(value);
  if (!str) return null;
  const url = new URL(str);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Canonical form of a post URL, used only for hashing into a fallback source_id. */
export function normalizePostUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic identity. Priority: `li:<id>`, `li:<entityId>`,
 * `url:<sha256(normalized linkedinUrl)>`. `engagement.id` is never used: it can
 * differ from the post id (ugcPost items).
 */
export async function deriveSourceId(item: Obj): Promise<string | null> {
  const id = asString(item.id);
  if (id) return `li:${id}`;
  const entityId = asString(item.entityId);
  if (entityId) return `li:${entityId}`;
  const url = asHttpUrl(item.linkedinUrl);
  if (url) return `url:${await sha256Hex(normalizePostUrl(url))}`;
  return null;
}

function toIso(value: string | number): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parsePostedAt(postedAt: Obj | null): string | null {
  if (!postedAt) return null;
  const date = asString(postedAt.date);
  const fromDate = date ? toIso(date) : null;
  if (fromDate) return fromDate;
  const timestamp = postedAt.timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? toIso(timestamp) : null;
}

/** Companies LinkedIn tagged in the post text. Null when contentAttributes is absent. */
export function extractTaggedCompanies(contentAttributes: unknown): TaggedCompany[] | null {
  if (!Array.isArray(contentAttributes)) return null;
  const seen = new Set<string>();
  const companies: TaggedCompany[] = [];
  for (const attribute of contentAttributes) {
    const company = asObject(asObject(attribute)?.company);
    if (!company) continue;
    const entry: TaggedCompany = {
      id: asString(company.id),
      name: asString(company.name),
      linkedin_url: asHttpUrl(company.linkedinUrl),
    };
    if (!entry.id && !entry.name) continue;
    const key = entry.id ?? `name:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push(entry);
  }
  return companies;
}

function authorType(value: unknown): RawPost['author_type'] {
  return value === 'profile' || value === 'company' ? value : null;
}

/** Normalizes one Actor dataset item. Throws if it cannot produce a valid RawPost. */
export async function normalizePost(item: unknown, context: NormalizeContext): Promise<RawPost> {
  if (!isObject(item)) throw new Error('item is not an object');

  const sourceId = await deriveSourceId(item);
  if (!sourceId) throw new Error('item has no id, entityId or linkedinUrl');

  const url = asHttpUrl(item.linkedinUrl) ?? asHttpUrl(item.shareLinkedinUrl);

  const author = asObject(item.author);
  const article = asObject(item.article);
  const engagement = asObject(item.engagement);
  const query = asObject(item.query);
  const repost = asObject(item.repost);
  const taggedCompanies = extractTaggedCompanies(item.contentAttributes);
  const company = jobCompany(item);
  const jobUrl = linkedinJobUrl(item);

  const candidate: RawPost = {
    source: POST_SOURCE,
    source_id: sourceId,
    linkedin_post_id: asString(item.id),
    entity_id: asString(item.entityId),
    text: asString(item.content),

    author_name: asString(author?.name),
    author_type: authorType(author?.type),
    author_profile_url: stripQuery(author?.linkedinUrl),
    author_headline: asString(author?.info),

    url,
    posted_at: parsePostedAt(asObject(item.postedAt)),

    search_query: asString(query?.search),
    apify_run_id: context.apifyRunId,

    repost_id: asString(repost?.id) ?? asString(item.repostId),

    article_title: asString(article?.title),
    article_url: asHttpUrl(article?.link),

    job_title: jobTitle(item),
    company_name: company.name,
    company_linkedin_url: company.linkedinUrl,
    work_mode: workMode(item),
    linkedin_job_url: jobUrl,
    external_apply_url: externalApplyUrl(item, jobUrl),
    // Set by ingestion's US-job filter (src/ingestion/job-location.ts) for the posts it keeps.
    job_location_text: null,
    job_country: null,
    location_source: null,

    likes: asCount(engagement?.likes),
    comments: asCount(engagement?.comments),
    shares: asCount(engagement?.shares),

    tagged_companies_json: taggedCompanies === null ? null : JSON.stringify(taggedCompanies),

    raw_json: JSON.stringify(item),

    fetched_at: context.fetchedAt,
  };

  const result = RawPostSchema.safeParse(candidate);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`invalid field(s): ${fields.join(', ')}`);
  }
  return result.data;
}

/** Normalizes a batch. A malformed item is reported, never fatal. */
export async function normalizePosts(
  items: readonly unknown[],
  context: NormalizeContext,
): Promise<{ posts: RawPost[]; invalid: InvalidItem[] }> {
  const posts: RawPost[] = [];
  const invalid: InvalidItem[] = [];
  for (const [index, item] of items.entries()) {
    try {
      posts.push(await normalizePost(item, context));
    } catch (error) {
      invalid.push({ index, reason: error instanceof Error ? error.message : 'unknown error' });
    }
  }
  return { posts, invalid };
}
