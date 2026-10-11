import { classifyJobRelevance } from '../classification/job-relevance';
import { CLASSIFIER_VERSION, type JobClassification, type Relevance } from '../domain/classification';
import type { RawPost } from '../domain/raw-post';
import { jobCompany, jobTitleWithSource, workMode } from '../normalization/job-details';

/**
 * Backfill for posts stored before the current job-detail rules and classifier
 * (scripts/backfill/cli.mjs runs it; dry run unless told otherwise).
 *   - Job details are re-derived from raw_json while it is kept (7 days): only
 *     job_title, job_title_source, company_name, company_linkedin_url and
 *     work_mode. Location, links and every other column stay as stored.
 *   - Posts with no classification, or one from an older classifier version,
 *     are (re)classified from their (updated) normalized columns.
 * The plan is plain SQL so an operator can review it; every statement is
 * idempotent (UPDATEs are keyed by id and source_id, classifications upsert and
 * never replace a newer version), so a rerun after a partial failure finishes the job.
 */

/** The stored columns a plan reads (after migration 0008). */
export const BACKFILL_SELECT = `SELECT p.id, p.source_id, p.raw_json, p.text, p.job_title, p.job_title_source, p.company_name,
  p.company_linkedin_url, p.work_mode, p.article_title, p.article_url, p.linkedin_job_url, p.external_apply_url,
  c.classifier_version, c.relevance
FROM raw_posts AS p LEFT JOIN post_classifications AS c ON c.post_id = p.id
WHERE p.job_country = 'US' ORDER BY p.id`;

/** The same before migration 0008 (no job_title_source, no classifications): dry runs only. */
export const BACKFILL_SELECT_BEFORE_0008 = `SELECT p.id, p.source_id, p.raw_json, p.text, p.job_title, NULL AS job_title_source,
  p.company_name, p.company_linkedin_url, p.work_mode, p.article_title, p.article_url, p.linkedin_job_url,
  p.external_apply_url, NULL AS classifier_version, NULL AS relevance
FROM raw_posts AS p WHERE p.job_country = 'US' ORDER BY p.id`;

const DETAIL_FIELDS = ['job_title', 'job_title_source', 'company_name', 'company_linkedin_url', 'work_mode'] as const;
type DetailField = (typeof DETAIL_FIELDS)[number];

export type BackfillRow = Pick<
  RawPost,
  | 'source_id'
  | 'text'
  | DetailField
  | 'article_title'
  | 'article_url'
  | 'linkedin_job_url'
  | 'external_apply_url'
> & {
  id: number;
  raw_json: string | null;
  classifier_version: number | null;
  relevance: Relevance | null;
};

export interface BackfillChange {
  id: number;
  source_id: string;
  /** Job details that change, with their stored values. */
  fields: Partial<Record<DetailField, { from: string | null; to: string | null }>>;
  /** The new classification, or null when the stored one is current. */
  classification: JobClassification | null;
  previousRelevance: Relevance | null;
  /** Whether job details could be re-derived (raw_json still kept). */
  fromRawJson: boolean;
}

export interface BackfillPlan {
  posts: number;
  changes: BackfillChange[];
  statements: string[];
  summary: {
    postsWithRawJson: number;
    detailChanges: Record<DetailField, number>;
    classify: number;
    relevanceBefore: Record<Relevance | 'unclassified', number>;
    relevanceAfter: Record<Relevance | 'unclassified', number>;
  };
}

/** A SQL literal (single quotes doubled; NUL removed, which SQL text cannot carry). */
const literal = (value: string | number | null): string =>
  value === null ? 'NULL' : typeof value === 'number' ? String(Math.trunc(value)) : `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`;

const emptyTally = (): Record<Relevance | 'unclassified', number> => ({ relevant: 0, needs_review: 0, unrelated: 0, not_a_job: 0, unclassified: 0 });

/** Re-derived job details of an Actor item (null when raw_json is gone or unreadable). */
function detailsFrom(rawJson: string | null): Pick<RawPost, DetailField> | null {
  if (!rawJson) return null;
  let item: unknown;
  try {
    item = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const title = jobTitleWithSource(record);
  const company = jobCompany(record);
  return {
    job_title: title.title,
    job_title_source: title.source,
    company_name: company.name,
    company_linkedin_url: company.linkedinUrl,
    work_mode: workMode(record),
  };
}

/**
 * The plan for these rows. It is deterministic — the database sets classified_at when the plan runs — so a
 * dry run and the execution that follows produce the same statements and the same confirm code.
 */
export function planBackfill(rows: readonly BackfillRow[]): BackfillPlan {
  const changes: BackfillChange[] = [];
  const statements: string[] = [];
  const summary: BackfillPlan['summary'] = {
    postsWithRawJson: 0,
    detailChanges: { job_title: 0, job_title_source: 0, company_name: 0, company_linkedin_url: 0, work_mode: 0 },
    classify: 0,
    relevanceBefore: emptyTally(),
    relevanceAfter: emptyTally(),
  };

  for (const row of rows) {
    summary.relevanceBefore[row.relevance ?? 'unclassified']++;
    const derived = detailsFrom(row.raw_json);
    if (derived) summary.postsWithRawJson++;

    const fields: BackfillChange['fields'] = {};
    for (const field of DETAIL_FIELDS) {
      if (derived && derived[field] !== row[field]) {
        fields[field] = { from: row[field], to: derived[field] };
        summary.detailChanges[field]++;
      }
    }
    const post = { ...row, ...(derived ?? {}) };
    const stale = row.relevance === null || (row.classifier_version ?? 0) < CLASSIFIER_VERSION;
    const classification = stale ? classifyJobRelevance(post) : null;
    summary.relevanceAfter[classification?.relevance ?? row.relevance ?? 'unclassified']++;
    if (!Object.keys(fields).length && !classification) continue;

    if (classification) summary.classify++;
    changes.push({ id: row.id, source_id: row.source_id, fields, classification, previousRelevance: row.relevance, fromRawJson: !!derived });

    const assignments = Object.entries(fields).map(([field, change]) => `${field} = ${literal(change!.to)}`);
    if (assignments.length) {
      statements.push(`UPDATE raw_posts SET ${assignments.join(', ')} WHERE id = ${literal(row.id)} AND source_id = ${literal(row.source_id)};`);
    }
    if (classification) {
      const c = classification;
      const values = [row.id, CLASSIFIER_VERSION, c.relevance, c.persona, c.hiring_intent, c.role_title, c.title_source, c.evidence_text, c.reason];
      statements.push(
        `INSERT INTO post_classifications (post_id, classifier_version, relevance, persona, hiring_intent, role_title, title_source, evidence_text, reason, classified_at) ` +
          `VALUES (${values.map(literal).join(', ')}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ` +
          `ON CONFLICT (post_id) DO UPDATE SET classifier_version = excluded.classifier_version, relevance = excluded.relevance, ` +
          `persona = excluded.persona, hiring_intent = excluded.hiring_intent, role_title = excluded.role_title, ` +
          `title_source = excluded.title_source, evidence_text = excluded.evidence_text, reason = excluded.reason, ` +
          `classified_at = excluded.classified_at WHERE post_classifications.classifier_version <= excluded.classifier_version;`,
      );
    }
  }
  return { posts: rows.length, changes, statements, summary };
}

/** SHA-256 (hex) of the statements: the operator confirms an execution with its first 12 characters. */
export async function planFingerprint(statements: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(statements.join('\n')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
