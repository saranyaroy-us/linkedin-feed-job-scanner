import type { RawPost, StoredRawPost, StoredRawPostWithRaw, WorkMode } from '../domain/raw-post';
import { endOfDayUtc, startOfDayUtc } from '../lib/time';

/** Dashboard / API filters. `from` and `to` are YYYY-MM-DD in the display time zone. */
export interface PostFilters {
  /** Exact search_query. */
  query?: string;
  /** Case-insensitive substring of company_name. */
  company?: string;
  /** Exact work_mode (indexed). */
  workMode?: WorkMode;
  /** Case-insensitive substring of author_name. */
  author?: string;
  authorType?: 'profile' | 'company';
  from?: string;
  /** With `from`: also match posts whose posted_at is unknown (used by the implicit search window). */
  fromIncludesUndated?: boolean;
  to?: string;
  /** Case-insensitive substring of text, author headline or article title. */
  text?: string;
}

export interface SearchOptions {
  limit: number;
  offset: number;
  timeZone: string;
  includeRawJson?: boolean;
}

export interface QueryCount {
  /** null for posts stored without a search query. */
  search_query: string | null;
  posts: number;
}

/** Normalized columns, in insert order. raw_json is listed last so reads can skip it. */
const POST_COLUMNS = [
  'source',
  'source_id',
  'linkedin_post_id',
  'entity_id',
  'text',
  'author_name',
  'author_type',
  'author_profile_url',
  'author_headline',
  'url',
  'posted_at',
  'search_query',
  'apify_run_id',
  'repost_id',
  'article_title',
  'article_url',
  'job_title',
  'company_name',
  'company_linkedin_url',
  'work_mode',
  'linkedin_job_url',
  'external_apply_url',
  'job_location_text',
  'job_country',
  'location_source',
  'likes',
  'comments',
  'shares',
  'tagged_companies_json',
  'fetched_at',
  'raw_json',
] as const satisfies readonly (keyof RawPost)[];

const READ_COLUMNS = ['id', ...POST_COLUMNS.filter((c) => c !== 'raw_json'), 'created_at'].join(', ');

/**
 * Posts are inserted as one JSON array per statement, unpacked with json_each:
 * one bound parameter instead of one per column per row (D1 allows 100 per statement), and
 * one statement per chunk instead of one per row. A chunk stays well under
 * D1's 2 MB value limit. Only the (source, source_id) conflict is tolerated, so
 * a CHECK/NOT NULL violation still fails loudly instead of being skipped.
 * RETURNING reports exactly the inserted rows (meta.changes would also count
 * the counter-trigger writes).
 */
const INSERT_SQL = `
INSERT INTO raw_posts (${POST_COLUMNS.join(', ')})
SELECT ${POST_COLUMNS.map((c) => `json_extract(value, '$.${c}')`).join(', ')}
FROM json_each(?1)
WHERE true
ON CONFLICT (source, source_id) DO NOTHING
RETURNING id`;

const MAX_CHUNK_BYTES = 900_000;

/**
 * Retention: clears raw_json on the oldest ?2 posts stored before ?1. INDEXED BY
 * pins the partial index of posts that still have raw_json (migration 0002), so
 * the statement reads only the rows it clears — never posts cleared earlier —
 * and fails loudly instead of falling back to a table scan if the index is gone.
 */
const CLEAR_RAW_JSON_SQL = `
UPDATE raw_posts SET raw_json = NULL
WHERE id IN (
  SELECT id FROM raw_posts INDEXED BY idx_raw_posts_raw_json_pending
  WHERE raw_json IS NOT NULL AND created_at < ?1
  ORDER BY created_at
  LIMIT ?2
)`;

/**
 * Case-insensitive substring match. instr() is used instead of LIKE because D1
 * caps LIKE patterns at 50 bytes, and it needs no wildcard escaping.
 */
const contains = (column: string) => `instr(lower(${column}), lower(?)) > 0`;

export class PostsRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Statements that insert `posts`, skipping any (source, source_id) already
   * stored. Returned rather than executed so callers can batch them with other
   * writes in one transaction.
   */
  insertStatements(posts: readonly RawPost[]): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    let chunk: string[] = [];
    let bytes = 2;
    const flush = () => {
      if (chunk.length) statements.push(this.db.prepare(INSERT_SQL).bind(`[${chunk.join(',')}]`));
      chunk = [];
      bytes = 2;
    };
    for (const post of posts) {
      const json = JSON.stringify(Object.fromEntries(POST_COLUMNS.map((c) => [c, post[c]])));
      if (chunk.length && bytes + json.length + 1 > MAX_CHUNK_BYTES) flush();
      chunk.push(json);
      bytes += json.length + 1;
    }
    flush();
    return statements;
  }

  /** Inserts posts in one transaction; returns how many were new. */
  async insertMany(posts: readonly RawPost[]): Promise<number> {
    const statements = this.insertStatements(posts);
    if (!statements.length) return 0;
    const results = await this.db.batch(statements);
    return results.reduce((sum, result) => sum + result.results.length, 0);
  }

  async findBySourceId(source: string, sourceId: string): Promise<StoredRawPostWithRaw | null> {
    return this.db
      .prepare('SELECT * FROM raw_posts WHERE source = ? AND source_id = ?')
      .bind(source, sourceId)
      .first<StoredRawPostWithRaw>();
  }

  /**
   * Sets raw_json = NULL on up to `limit` posts stored before `cutoff` (ISO time),
   * oldest first, keeping the row and its normalized columns. Idempotent: a
   * cleared post no longer matches. raw_posts has no UPDATE trigger, so
   * meta.changes is exactly the number of posts cleared.
   */
  async clearRawJsonStoredBefore(cutoff: string, limit: number): Promise<{ cleared: number; rowsRead: number }> {
    const { meta } = await this.db.prepare(CLEAR_RAW_JSON_SQL).bind(cutoff, limit).run();
    return { cleared: meta.changes, rowsRead: meta.rows_read };
  }

  /** Posts first stored by the given Apify run. */
  async countForRun(apifyRunId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM raw_posts WHERE apify_run_id = ?')
      .bind(apifyRunId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Per-query totals from the trigger-maintained counter table (no table scan). */
  async queryCounts(): Promise<QueryCount[]> {
    const { results } = await this.db
      .prepare(
        `SELECT NULLIF(search_query, '') AS search_query, posts FROM post_query_counts
         WHERE posts > 0 ORDER BY posts DESC, search_query`,
      )
      .all<QueryCount>();
    return results;
  }

  async countCreatedSince(isoTimestamp: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM raw_posts WHERE created_at >= ?')
      .bind(isoTimestamp)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * US job posts, newest first. Fetches limit + 1 rows to report `hasMore`
   * without a COUNT(*) scan. Unfiltered and query-only views use indexes, so
   * D1 rows-read stays close to the page size.
   * Only posts that passed the US-job filter (job_country 'US') are listed, so
   * older or unclassified rows can never appear in the dashboard or the API.
   */
  async search(
    filters: PostFilters,
    options: SearchOptions,
  ): Promise<{ posts: (StoredRawPost & { raw_json?: string | null })[]; hasMore: boolean }> {
    const where: string[] = ["job_country = 'US'"];
    const params: (string | number)[] = [];

    if (filters.query) {
      where.push('search_query = ?');
      params.push(filters.query);
    }
    if (filters.company) {
      where.push(contains('company_name'));
      params.push(filters.company);
    }
    if (filters.workMode) {
      where.push('work_mode = ?');
      params.push(filters.workMode);
    }
    if (filters.author) {
      where.push(contains('author_name'));
      params.push(filters.author);
    }
    if (filters.authorType) {
      where.push('author_type = ?');
      params.push(filters.authorType);
    }
    if (filters.from) {
      where.push(filters.fromIncludesUndated ? '(posted_at >= ? OR posted_at IS NULL)' : 'posted_at >= ?');
      params.push(startOfDayUtc(filters.from, options.timeZone));
    }
    if (filters.to) {
      where.push('posted_at < ?');
      params.push(endOfDayUtc(filters.to, options.timeZone));
    }
    if (filters.text) {
      where.push(`(${contains('text')} OR ${contains('author_headline')} OR ${contains('article_title')})`);
      params.push(filters.text, filters.text, filters.text);
    }

    const columns = options.includeRawJson ? `${READ_COLUMNS}, raw_json` : READ_COLUMNS;
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const { results } = await this.db
      .prepare(
        `SELECT ${columns} FROM raw_posts ${whereSql}
         ORDER BY posted_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...params, options.limit + 1, options.offset)
      .all<StoredRawPost & { raw_json?: string | null }>();

    return { posts: results.slice(0, options.limit), hasMore: results.length > options.limit };
  }
}
