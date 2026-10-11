import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLASSIFIER_VERSION } from '../../src/domain/classification';
import { BACKFILL_SELECT, planBackfill, planFingerprint, type BackfillRow } from '../../src/maintenance/backfill';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { ClassificationsRepository } from '../../src/storage/classifications.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { asUsPosts, CONTEXT, resetDb, sampleItem } from '../helpers';

/** A fixture clone (no job card, article or tags) with this id and text; synthetic text only. */
function item(id: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = sampleItem(3);
  delete base.job;
  delete base.article;
  base.contentAttributes = [];
  return { ...base, id, entityId: id, linkedinUrl: `https://www.linkedin.com/posts/example_activity-${id}-x`, content, ...extra };
}
const AGGREGATOR = { ...(sampleItem(3).author as object), type: 'company', name: 'FDE Engineers', linkedinUrl: 'https://www.linkedin.com/company/fde-engineers/' };

/** Stores posts as the pre-0008 code did: no job_title_source, no classification, older job details. */
async function storeLegacy(items: Record<string, unknown>[], stale: Record<string, Record<string, unknown>> = {}) {
  const { posts } = await normalizePosts(items, CONTEXT);
  await new PostsRepository(env.DB).insertMany(asUsPosts(posts.map((p) => ({ ...p, job_title_source: null, ...(stale[p.source_id] ?? {}) }))));
}
const readRows = async () => (await env.DB.prepare(BACKFILL_SELECT).all<BackfillRow>()).results;
const run = async (statements: string[]) => {
  if (statements.length) await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
};
const stored = (sourceId: string) =>
  env.DB.prepare(
    `SELECT p.job_title, p.job_title_source, p.company_name, p.company_linkedin_url, p.work_mode, c.relevance, c.persona, c.classifier_version
     FROM raw_posts p LEFT JOIN post_classifications c ON c.post_id = p.id WHERE p.source_id = ?`,
  )
    .bind(sourceId)
    .first<Record<string, unknown>>();

beforeEach(() => resetDb());

describe('backfill plan', () => {
  it('re-derives job details from raw_json, classifies every post, and is idempotent once executed', async () => {
    await storeLegacy(
      [
        item('7700000000000000001', '#hiring Revenue Operations Analyst Apply here: https://example.com/job\nPosition Title: Revenue Operations Analyst\nLocation: Austin, TX'),
        item('7700000000000000002', 'New FDE Job: Sales Strategy and Operations Lead at Example Labs — United States: details', { author: AGGREGATOR }),
        item('7700000000000000003', 'How you can save 70% on hiring: outsourcing your sales operations. #hiring'),
      ],
      // What the older extraction stored.
      { 'li:7700000000000000001': { job_title: null }, 'li:7700000000000000002': { job_title: null } },
    );

    const plan = planBackfill(await readRows());
    expect(plan.posts).toBe(3);
    expect(plan.summary.relevanceBefore.unclassified).toBe(3);
    expect(plan.summary.relevanceAfter).toMatchObject({ relevant: 2, not_a_job: 1, unclassified: 0 });
    const first = plan.changes.find((c) => c.source_id === 'li:7700000000000000001')!;
    expect(first.fields.job_title).toEqual({ from: null, to: 'Revenue Operations Analyst' });
    expect(first.fields.job_title_source).toEqual({ from: null, to: 'text' });

    await run(plan.statements);
    expect(await stored('li:7700000000000000001')).toMatchObject({
      job_title: 'Revenue Operations Analyst',
      job_title_source: 'text',
      relevance: 'relevant',
      persona: 'revenue_operations',
      classifier_version: CLASSIFIER_VERSION,
    });
    // The alert's employer replaces the aggregator account that posted it.
    expect(await stored('li:7700000000000000002')).toMatchObject({
      job_title: 'Sales Strategy and Operations Lead',
      company_name: 'Example Labs',
      company_linkedin_url: null,
      relevance: 'relevant',
      persona: 'sales_operations',
    });
    expect(await stored('li:7700000000000000003')).toMatchObject({ relevance: 'not_a_job' });
    expect(await new ClassificationsRepository(env.DB).counts()).toEqual({ relevant: 2, needs_review: 0, unrelated: 0, not_a_job: 1 });

    // Running it again finds nothing to do.
    const again = planBackfill(await readRows());
    expect(again.changes).toEqual([]);
    expect(again.statements).toEqual([]);
  });

  it('classifies posts whose raw_json is gone from their stored columns, without touching those columns', async () => {
    await storeLegacy([item('7700000000000000011', 'We are hiring a Vendor Manager. Apply now: https://example.com/apply')]);
    await env.DB.prepare(`UPDATE raw_posts SET raw_json = NULL, job_title = 'Vendor Manager', company_name = 'Kept Co'`).run();
    const plan = planBackfill(await readRows());
    expect(plan.summary.postsWithRawJson).toBe(0);
    expect(plan.changes[0]!.fields).toEqual({});
    expect(plan.statements.some((s) => s.startsWith('UPDATE raw_posts'))).toBe(false);
    await run(plan.statements);
    expect(await stored('li:7700000000000000011')).toMatchObject({ job_title: 'Vendor Manager', company_name: 'Kept Co', relevance: 'relevant', persona: 'vendor_manager' });
  });

  it('skips current classifications and re-labels older versions, keeping the counts right', async () => {
    await storeLegacy([
      item('7700000000000000021', 'HIRING: Sales Operations Manager\nApply here: https://example.com'),
      item('7700000000000000022', 'HIRING: Revenue Operations Manager\nApply here: https://example.com'),
    ]);
    await run(planBackfill(await readRows()).statements);
    // Pretend one label came from an older classifier that called it unrelated.
    await env.DB.prepare(
      `UPDATE post_classifications SET classifier_version = 0, relevance = 'unrelated' WHERE post_id = (SELECT id FROM raw_posts WHERE source_id = 'li:7700000000000000022')`,
    ).run();
    expect(await new ClassificationsRepository(env.DB).counts()).toMatchObject({ relevant: 1, unrelated: 1 });
    const plan = planBackfill(await readRows());
    expect(plan.changes.map((c) => c.source_id)).toEqual(['li:7700000000000000022']);
    await run(plan.statements);
    expect(await new ClassificationsRepository(env.DB).counts()).toMatchObject({ relevant: 2, unrelated: 0 });
  });

  it('quotes values safely in the generated SQL', async () => {
    await storeLegacy([item('7700000000000000031', "HIRING: Sales Operations Analyst\nCompany: O'Brien & Sons\nApply here: https://example.com")], {
      'li:7700000000000000031': { company_name: null },
    });
    const plan = planBackfill(await readRows());
    expect(plan.statements[0]).toContain("company_name = 'O''Brien & Sons'");
    await run(plan.statements);
    expect(await stored('li:7700000000000000031')).toMatchObject({ company_name: "O'Brien & Sons", relevance: 'relevant' });
  });

  it('plans the same statements on every run (the database sets classified_at), so the confirm code is stable', async () => {
    await storeLegacy([item('7700000000000000041', 'HIRING: Sales Operations Manager\nApply here: https://example.com')]);
    const [a, b] = [planBackfill(await readRows()), planBackfill(await readRows())];
    expect(a.statements).toEqual(b.statements);
    expect(await planFingerprint(a.statements)).toBe(await planFingerprint(b.statements));
    await run(a.statements);
    const row = await env.DB.prepare('SELECT classified_at FROM post_classifications').first<{ classified_at: string }>();
    expect(row!.classified_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('ties the confirm code to the exact plan', async () => {
    const a = await planFingerprint(['UPDATE raw_posts SET work_mode = NULL WHERE id = 1;']);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await planFingerprint(['UPDATE raw_posts SET work_mode = NULL WHERE id = 1;'])).toBe(a);
    expect(await planFingerprint(['UPDATE raw_posts SET work_mode = NULL WHERE id = 2;'])).not.toBe(a);
  });
});
