import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobClassification } from '../../src/domain/classification';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { ClassificationsRepository } from '../../src/storage/classifications.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { asUsPosts, CONTEXT, manyItems, resetDb } from '../helpers';

const NOW = '2026-10-11T10:00:00.000Z';
const label = (relevance: JobClassification['relevance']): JobClassification => ({
  relevance,
  persona: relevance === 'relevant' ? 'sales_operations' : 'none',
  hiring_intent: 'strong',
  role_title: 'Sales Operations Analyst',
  title_source: 'job_card',
  evidence_text: 'Sales Operations Analyst',
  reason: 'Role title is Sales Operations',
});
const counts = () => new ClassificationsRepository(env.DB).counts();
const rows = async () =>
  (await env.DB.prepare('SELECT p.source_id, c.relevance FROM post_classifications c JOIN raw_posts p ON p.id = c.post_id ORDER BY p.source_id').all()).results;

async function storePosts(count: number, runId = CONTEXT.apifyRunId, prefix = '77000000000') {
  const { posts } = await normalizePosts(manyItems(count, prefix), { ...CONTEXT, apifyRunId: runId });
  await new PostsRepository(env.DB).insertMany(asUsPosts(posts));
  return posts;
}

beforeEach(() => resetDb());

describe('ClassificationsRepository', () => {
  it('classifies the posts a run first stored, in one statement, and keeps per-label counts', async () => {
    const posts = await storePosts(3);
    const repo = new ClassificationsRepository(env.DB);
    const statement = repo.insertForRunStatement(
      posts.map((p, i) => ({ source_id: p.source_id, ...label(i === 0 ? 'needs_review' : 'relevant') })),
      CONTEXT.apifyRunId,
      NOW,
    )!;
    await env.DB.batch([statement]);
    expect(await counts()).toEqual({ relevant: 2, needs_review: 1, unrelated: 0, not_a_job: 0 });
    expect((await rows()).map((r) => r.relevance)).toEqual(['needs_review', 'relevant', 'relevant']);
    // A redelivered page changes nothing.
    await env.DB.batch([statement]);
    expect(await counts()).toEqual({ relevant: 2, needs_review: 1, unrelated: 0, not_a_job: 0 });
  });

  it('never labels posts that an earlier run stored (they keep their own label)', async () => {
    const earlier = await storePosts(2, 'RunEarlier0000001');
    const repo = new ClassificationsRepository(env.DB);
    await env.DB.batch([repo.insertForRunStatement(earlier.map((p) => ({ source_id: p.source_id, ...label('unrelated') })), 'RunEarlier0000001', NOW)!]);
    // A later run sees the same posts again: its labels are ignored.
    await env.DB.batch([repo.insertForRunStatement(earlier.map((p) => ({ source_id: p.source_id, ...label('relevant') })), CONTEXT.apifyRunId, NOW)!]);
    expect(await counts()).toEqual({ relevant: 0, needs_review: 0, unrelated: 2, not_a_job: 0 });
    expect(repo.insertForRunStatement([], CONTEXT.apifyRunId, NOW)).toBeNull();
  });

  it('keeps counts right when a label changes or a post is deleted (cascade)', async () => {
    const posts = await storePosts(2);
    const repo = new ClassificationsRepository(env.DB);
    await env.DB.batch([repo.insertForRunStatement(posts.map((p) => ({ source_id: p.source_id, ...label('relevant') })), CONTEXT.apifyRunId, NOW)!]);
    await env.DB.prepare(`UPDATE post_classifications SET relevance = 'needs_review' WHERE post_id = (SELECT MIN(post_id) FROM post_classifications)`).run();
    expect(await counts()).toEqual({ relevant: 1, needs_review: 1, unrelated: 0, not_a_job: 0 });
    await env.DB.prepare('DELETE FROM raw_posts WHERE source_id = ?').bind(posts[1]!.source_id).run();
    expect(await rows()).toHaveLength(1);
    expect(Object.values(await counts()).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('rejects labels and personas outside the allowed values', async () => {
    const [p] = await storePosts(1);
    const insert = (relevance: string, persona: string) =>
      env.DB.prepare(
        `INSERT INTO post_classifications (post_id, classifier_version, relevance, persona, hiring_intent, reason, classified_at)
         SELECT id, 1, ?, ?, 'strong', 'r', ? FROM raw_posts WHERE source_id = ?`,
      )
        .bind(relevance, persona, NOW, p!.source_id)
        .run();
    await expect(insert('maybe', 'none')).rejects.toThrow();
    await expect(insert('relevant', 'marketing_operations')).rejects.toThrow();
  });
});
