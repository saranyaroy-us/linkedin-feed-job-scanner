import { CLASSIFIER_VERSION, type JobClassification, type Relevance } from '../domain/classification';
import { POST_SOURCE } from '../domain/raw-post';

/** A classification for the post with this source_id. */
export interface ClassifiedPost extends JobClassification {
  source_id: string;
}

const CLASSIFICATION_COLUMNS = ['relevance', 'persona', 'hiring_intent', 'role_title', 'title_source', 'evidence_text', 'reason'] as const;

/**
 * Classifications of the posts a run has just stored, as one json_each
 * statement batched with the posts' insert. Only posts first stored by this
 * run (apify_run_id ?4) are classified, so a post seen again later keeps its
 * label, and ON CONFLICT makes a redelivered page harmless.
 */
const INSERT_FOR_RUN_SQL = `
INSERT INTO post_classifications (post_id, classifier_version, ${CLASSIFICATION_COLUMNS.join(', ')}, classified_at)
SELECT p.id, ?2, ${CLASSIFICATION_COLUMNS.map((c) => `json_extract(j.value, '$.${c}')`).join(', ')}, ?3
FROM json_each(?1) AS j
JOIN raw_posts AS p ON p.source = ?5 AND p.source_id = json_extract(j.value, '$.source_id')
WHERE p.apify_run_id = ?4
ON CONFLICT (post_id) DO NOTHING`;

export class ClassificationsRepository {
  constructor(private readonly db: D1Database) {}

  /** The statement that stores `classified` for posts first stored by `apifyRunId`; null when there are none. */
  insertForRunStatement(classified: readonly ClassifiedPost[], apifyRunId: string, now: string): D1PreparedStatement | null {
    if (!classified.length) return null;
    const rows = classified.map((c) => ({ source_id: c.source_id, ...Object.fromEntries(CLASSIFICATION_COLUMNS.map((k) => [k, c[k]])) }));
    return this.db.prepare(INSERT_FOR_RUN_SQL).bind(JSON.stringify(rows), CLASSIFIER_VERSION, now, apifyRunId, POST_SOURCE);
  }

  /** Posts per label, from the trigger-maintained relevance_counts (no scan). */
  async counts(): Promise<Record<Relevance, number>> {
    const { results } = await this.db.prepare('SELECT relevance, posts FROM relevance_counts').all<{ relevance: Relevance; posts: number }>();
    const counts: Record<Relevance, number> = { relevant: 0, needs_review: 0, unrelated: 0, not_a_job: 0 };
    for (const row of results) counts[row.relevance] = Math.max(0, row.posts);
    return counts;
  }
}
