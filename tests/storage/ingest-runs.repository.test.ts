import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { IngestRunsRepository } from '../../src/storage/ingest-runs.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { loadSampleItems, resetDb } from '../helpers';

const RUN = 'RunClaim000000001';
const claimInput = (now: string, staleBefore = '2000-01-01T00:00:00.000Z') => ({
  apifyRunId: RUN,
  datasetId: 'DsClaim0000000001',
  queryConfigJson: '{"maxPosts":100}',
  pageSize: 50,
  now,
  staleBefore,
});

let runs: IngestRunsRepository;

beforeEach(async () => {
  await resetDb();
  runs = new IngestRunsRepository(env.DB);
});

describe('IngestRunsRepository.claim — idempotent run ownership', () => {
  it('creates a processing run on first delivery, with the page count still unknown', async () => {
    const run = await runs.claim(claimInput('2026-10-03T03:31:00.000Z'));
    expect(run).toMatchObject({
      apify_run_id: RUN,
      dataset_id: 'DsClaim0000000001',
      query_config_json: '{"maxPosts":100}',
      status: 'processing',
      pages_total: 0,
      started_at: '2026-10-03T03:31:00.000Z',
      completed_at: null,
      fetched: 0,
    });
  });

  it('does not hand out a run that is already processing (not stale)', async () => {
    await runs.claim(claimInput('2026-10-03T03:31:00.000Z'));
    expect(await runs.claim(claimInput('2026-10-03T03:32:00.000Z', '2026-10-03T03:01:00.000Z'))).toBeNull();
  });

  it('takes over a stale processing run', async () => {
    await runs.claim(claimInput('2026-10-03T03:31:00.000Z'));
    const again = await runs.claim(claimInput('2026-10-03T05:00:00.000Z', '2026-10-03T04:30:00.000Z'));
    expect(again?.started_at).toBe('2026-10-03T05:00:00.000Z');
  });

  it('restarts a failed run, clearing the error but keeping recorded pages and the page count', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    await env.DB.batch([
      runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 3, invalid: 0 }),
      runs.setPagesTotalStatement(run.id, 1),
    ]);
    await runs.markFailed(run.id, 'boom', '2026-10-03T03:32:00.000Z');
    expect((await runs.findById(run.id))?.status).toBe('failed');
    const again = await runs.claim(claimInput('2026-10-03T03:40:00.000Z'));
    expect(again).toMatchObject({ id: run.id, status: 'processing', error: null, completed_at: null, pages_total: 1 });
    expect(await runs.findPage(run.id, 0)).toEqual({ fetched: 3, invalid: 0 });
  });

  it('keeps the original page size and partial totals when a failed run is restarted', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    expect(run.page_size).toBe(50);
    await env.DB.batch([runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 50, invalid: 2 })]);
    await runs.markFailed(run.id, 'boom', '2026-10-03T03:32:00.000Z');
    const again = await runs.claim({ ...claimInput('2026-10-03T03:40:00.000Z'), pageSize: 100 });
    expect(again).toMatchObject({ page_size: 50, fetched: 50, invalid: 2, status: 'processing' });
  });

  it('never restarts a succeeded run and keeps one history row per Apify run', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    await env.DB.batch([
      runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 0, invalid: 0 }),
      runs.setPagesTotalStatement(run.id, 1),
    ]);
    expect(await runs.finalizeIfComplete(run.id, '2026-10-03T03:31:05.000Z')).not.toBeNull();
    expect(await runs.claim(claimInput('2026-10-03T09:00:00.000Z', '2026-10-03T08:30:00.000Z'))).toBeNull();
    expect(await runs.list()).toHaveLength(1);
  });
});

describe('IngestRunsRepository — pages and completion', () => {
  it('finalizes only once the last page is known and every page is recorded, with exact totals', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    const posts = new PostsRepository(env.DB);
    const { posts: normalized } = await normalizePosts(loadSampleItems(), {
      fetchedAt: '2026-10-03T03:31:01.000Z',
      apifyRunId: RUN,
    });

    // Page 0: 4 items, all valid. One of them already existed from an earlier run.
    await posts.insertMany([{ ...normalized[0]!, apify_run_id: 'EarlierRun0000001' }]);
    await env.DB.batch([
      ...posts.insertStatements(normalized.slice(0, 4)),
      runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 4, invalid: 0 }),
    ]);
    // The last page is not known yet, so the run cannot finish.
    expect(await runs.finalizeIfComplete(run.id, '2026-10-03T03:31:02.000Z')).toBeNull();

    // Page 1 (the last): 3 items, one malformed.
    await env.DB.batch([
      ...posts.insertStatements(normalized.slice(4, 6)),
      runs.recordPageStatement({ ingestRunId: run.id, offset: 50, fetched: 3, invalid: 1 }),
      runs.setPagesTotalStatement(run.id, 2),
    ]);
    const done = await runs.finalizeIfComplete(run.id, '2026-10-03T03:31:03.000Z');
    expect(done).toMatchObject({
      status: 'succeeded',
      completed_at: '2026-10-03T03:31:03.000Z',
      pages_total: 2,
      fetched: 7,
      invalid: 1,
      new: 5,
      already_seen: 1,
    });
  });

  it('waits for an earlier page that is still missing even when the last page is known', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    await env.DB.batch([
      runs.recordPageStatement({ ingestRunId: run.id, offset: 50, fetched: 10, invalid: 0 }),
      runs.setPagesTotalStatement(run.id, 2),
    ]);
    expect(await runs.finalizeIfComplete(run.id, '2026-10-03T03:31:02.000Z')).toBeNull();
  });

  it('records a page once even if processed twice', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    await env.DB.batch([runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 4, invalid: 0 })]);
    await env.DB.batch([runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 99, invalid: 9 })]);
    expect(await runs.findPage(run.id, 0)).toEqual({ fetched: 4, invalid: 0 });
    expect(await runs.findPage(run.id, 50)).toBeNull();
  });

  it('marks a run failed with the partial totals of the pages that were stored', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    const posts = new PostsRepository(env.DB);
    const { posts: normalized } = await normalizePosts(loadSampleItems(), {
      fetchedAt: '2026-10-03T03:31:01.000Z',
      apifyRunId: RUN,
    });
    await env.DB.batch([
      ...posts.insertStatements(normalized.slice(0, 3)),
      runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 4, invalid: 1 }),
    ]);
    await runs.markFailed(run.id, 'page at offset 50 failed', '2026-10-03T03:31:09.000Z');
    expect(await runs.findById(run.id)).toMatchObject({
      status: 'failed',
      error: 'page at offset 50 failed',
      completed_at: '2026-10-03T03:31:09.000Z',
      fetched: 4,
      invalid: 1,
      new: 3,
      already_seen: 0,
    });
  });

  it('does not finalize a failed run', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    await runs.markFailed(run.id, 'boom', '2026-10-03T03:31:01.000Z');
    await env.DB.batch([
      runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 0, invalid: 0 }),
      runs.setPagesTotalStatement(run.id, 1),
    ]);
    expect(await runs.finalizeIfComplete(run.id, '2026-10-03T03:31:02.000Z')).toBeNull();
  });

  it('truncates long failure reasons', async () => {
    const run = (await runs.claim(claimInput('2026-10-03T03:31:00.000Z')))!;
    await runs.markFailed(run.id, 'x'.repeat(1000), '2026-10-03T03:31:01.000Z');
    expect((await runs.findById(run.id))?.error).toHaveLength(300);
  });

  it('lists runs newest first', async () => {
    await runs.claim(claimInput('2026-10-03T03:31:00.000Z'));
    await runs.claim({ ...claimInput('2026-10-03T15:31:00.000Z'), apifyRunId: 'RunClaim000000002' });
    expect((await runs.list()).map((r) => r.apify_run_id)).toEqual(['RunClaim000000002', RUN]);
    expect((await runs.latest())?.apify_run_id).toBe('RunClaim000000002');
  });
});
