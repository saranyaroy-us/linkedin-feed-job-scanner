import { describe, expect, it } from 'vitest';
import { RawPostSchema } from '../../src/domain/raw-post';
import {
  deriveSourceId,
  extractTaggedCompanies,
  normalizePost,
  normalizePostUrl,
  normalizePosts,
  stripQuery,
} from '../../src/normalization/post-normalizer';
import { APIFY_RUN_ID, CONTEXT, FETCHED_AT, loadSampleItems, sampleItem } from '../helpers';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('normalizePost — sanitized real-structure fixture', () => {
  it('normalizes every fixture item into a valid RawPost', async () => {
    const { posts, invalid } = await normalizePosts(loadSampleItems(), CONTEXT);
    expect(invalid).toEqual([]);
    expect(posts).toHaveLength(6);
    for (const post of posts) expect(RawPostSchema.safeParse(post).success).toBe(true);
  });

  it('normal post: maps every field', async () => {
    const post = await normalizePost(sampleItem(4), CONTEXT);
    expect(post).toMatchObject({
      source: 'apify_linkedin_post_search',
      source_id: 'li:7500000000000000501',
      linkedin_post_id: '7500000000000000501',
      entity_id: '7500000000000000501',
      author_name: 'Sample Author Five',
      author_type: 'profile',
      author_profile_url: 'https://www.linkedin.com/in/sample-author-five',
      author_headline: 'Senior HR Consultant',
      url: 'https://www.linkedin.com/posts/sample-author-five_we-are-hiring-facility-officer-activity-7500000000000000501-TuVw',
      posted_at: '2026-10-02T16:34:39.688Z',
      search_query: '"Vendor Manager" OR "Vendor Management"',
      apify_run_id: APIFY_RUN_ID,
      repost_id: null,
      article_title: null,
      article_url: null,
      likes: 2,
      comments: 1,
      shares: 0,
      tagged_companies_json: '[]',
      fetched_at: FETCHED_AT,
    });
    expect(post.text).toMatch(/^\*WE ARE HIRING: FACILITY OFFICER\*/);
    expect(JSON.parse(post.raw_json)).toEqual(sampleItem(4));
  });

  it('repost: outer id is the identity, outer content is the text, nested id saved as repost_id', async () => {
    const post = await normalizePost(sampleItem(0), CONTEXT);
    expect(post.source_id).toBe('li:7500000000000000101');
    expect(post.repost_id).toBe('7500000000000000102');
    expect(post.text).toMatch(/^Replace "role play"/);
    expect(post.author_name).toBe('Sample Author One');
    expect(post.likes).toBe(4); // outer engagement, not the original's 34
    expect(JSON.parse(post.raw_json).repost.id).toBe('7500000000000000102'); // nested object preserved
  });

  it('repost and its nested original get different identities (never deduplicated together)', async () => {
    const repost = sampleItem(0) as { repost: Record<string, unknown>; query: unknown };
    const outer = await normalizePost(repost, CONTEXT);
    const original = await normalizePost({ ...repost.repost, query: repost.query }, CONTEXT);
    expect(outer.source_id).not.toBe(original.source_id);
    expect(original.source_id).toBe('li:7500000000000000102');
    expect(original.repost_id).toBeNull();
  });

  it('company author', async () => {
    const post = await normalizePost(sampleItem(1), CONTEXT);
    expect(post.author_type).toBe('company');
    expect(post.author_name).toBe('Example Data Co');
    expect(post.author_profile_url).toBe('https://www.linkedin.com/company/example-data-co/posts');
    expect(post.author_headline).toBe('179 followers');
  });

  it('article post', async () => {
    const post = await normalizePost(sampleItem(2), CONTEXT);
    expect(post.article_title).toBe('Product Marketing Manager');
    expect(post.article_url).toBe('https://jobs.example.com/acme-bio/product-marketing-manager');
    expect(post.text).toContain('Associate, Sales Operations');
  });

  it('ugcPost: identity comes from id, never from engagement.id', async () => {
    const item = sampleItem(3) as { id: string; engagement: { id: string } };
    expect(item.engagement.id).not.toBe(item.id);
    const post = await normalizePost(item, CONTEXT);
    expect(post.source_id).toBe('li:7500000000000000401');
    expect(post.source_id).not.toContain(item.engagement.id);
    expect(post.likes).toBe(2);
  });

  it('unrelated job and career-update posts are stored as plain raw posts (no classification yet)', async () => {
    const career = await normalizePost(sampleItem(5), CONTEXT);
    expect(career.text).toMatch(/started a new chapter/);
    expect(career).not.toHaveProperty('is_job_post');
    expect(career).not.toHaveProperty('persona');
  });

  it('uses postedAt.date for posted_at', async () => {
    const post = await normalizePost(sampleItem(1), CONTEXT);
    expect(post.posted_at).toBe('2026-10-02T16:42:26.288Z');
  });
});

describe('normalizePost — missing optional values', () => {
  const minimal = {
    id: '7500000000000009999',
    linkedinUrl: 'https://www.linkedin.com/posts/someone_activity-7500000000000009999-abcd',
  };

  it('accepts an item with only id + linkedinUrl; every unknown value is null', async () => {
    const post = await normalizePost(minimal, CONTEXT);
    expect(post).toMatchObject({
      source_id: 'li:7500000000000009999',
      entity_id: null,
      text: null,
      author_name: null,
      author_type: null,
      author_profile_url: null,
      author_headline: null,
      posted_at: null,
      search_query: null,
      repost_id: null,
      article_title: null,
      article_url: null,
      likes: null,
      comments: null,
      shares: null,
      tagged_companies_json: null,
    });
  });

  it('ignores job, article, repost, engagement and contentAttributes when absent or malformed', async () => {
    const post = await normalizePost(
      {
        ...minimal,
        job: 'weird',
        article: 'not an object',
        repost: [],
        engagement: { likes: -1, comments: 'x', shares: 1.5 },
        contentAttributes: 'nope',
        author: 'not an object',
      },
      CONTEXT,
    );
    expect(post).toMatchObject({
      article_title: null,
      repost_id: null,
      tagged_companies_json: null,
      likes: null,
      comments: null,
      shares: null,
      author_name: null,
    });
  });

  it('keeps an item that has an id but no usable URL (url stays null, never invented)', async () => {
    const post = await normalizePost({ id: '5', linkedinUrl: 'ftp://example.com/x' }, CONTEXT);
    expect(post.source_id).toBe('li:5');
    expect(post.url).toBeNull();
  });

  it('falls back to shareLinkedinUrl for url when linkedinUrl is absent', async () => {
    const post = await normalizePost(
      { id: '1', shareLinkedinUrl: 'https://www.linkedin.com/feed/update/urn:li:share:1' },
      CONTEXT,
    );
    expect(post.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:1');
  });

  it('falls back to postedAt.timestamp when postedAt.date is missing or unparseable', async () => {
    const post = await normalizePost({ ...minimal, postedAt: { date: 'garbage', timestamp: 1790958959771 } }, CONTEXT);
    expect(post.posted_at).toBe('2026-10-02T16:35:59.771Z');
  });
});

describe('normalizePosts — malformed items', () => {
  it('skips unusable items without failing the batch and reports their index', async () => {
    const good = { id: '7500000000000009999' };
    const { posts, invalid } = await normalizePosts(
      [null, 'string', 42, [], {}, { content: 'no identity' }, good],
      CONTEXT,
    );
    expect(posts.map((p) => p.source_id)).toEqual(['li:7500000000000009999']);
    expect(invalid.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(invalid.every((i) => i.reason.length > 0)).toBe(true);
  });
});

describe('deriveSourceId', () => {
  const url = 'https://www.linkedin.com/posts/someone_activity-123-abcd';

  it('1. prefers li:<id>', async () => {
    expect(await deriveSourceId({ id: '111', entityId: '222', linkedinUrl: url })).toBe('li:111');
  });

  it('2. falls back to li:<entityId>', async () => {
    expect(await deriveSourceId({ entityId: '222', linkedinUrl: url })).toBe('li:222');
  });

  it('3. falls back to url:<sha256(normalized linkedinUrl)>', async () => {
    const expected = `url:${await sha256Hex(url)}`;
    expect(await deriveSourceId({ linkedinUrl: url })).toBe(expected);
    // Query string, fragment and trailing slash do not change the identity.
    expect(await deriveSourceId({ linkedinUrl: `${url}/?utm_source=share#comments` })).toBe(expected);
  });

  it('never uses engagement.id and never invents an id', async () => {
    expect(await deriveSourceId({ engagement: { id: '999' } })).toBeNull();
    expect(await deriveSourceId({})).toBeNull();
  });

  it('is deterministic for the same item', async () => {
    const item = sampleItem(3);
    expect(await deriveSourceId(item)).toBe(await deriveSourceId(structuredClone(item)));
  });
});

describe('URL normalization', () => {
  it('normalizePostUrl strips query and fragment and keeps the stable post path', () => {
    expect(normalizePostUrl('https://www.linkedin.com/posts/a_activity-1-x?trk=1#c')).toBe(
      'https://www.linkedin.com/posts/a_activity-1-x',
    );
    expect(normalizePostUrl('https://WWW.LinkedIn.com/feed/update/urn:li:activity:1/')).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:1',
    );
  });

  it('stripQuery removes the miniProfileUrn query from author profile URLs', () => {
    expect(
      stripQuery('https://www.linkedin.com/in/sample-author-one?miniProfileUrn=urn%3Ali%3Afsd_profile%3AABC'),
    ).toBe('https://www.linkedin.com/in/sample-author-one');
  });

  it('stripQuery removes fragments and leaves clean URLs alone', () => {
    expect(stripQuery('https://www.linkedin.com/company/x/posts#top')).toBe('https://www.linkedin.com/company/x/posts');
    expect(stripQuery('https://www.linkedin.com/in/clean')).toBe('https://www.linkedin.com/in/clean');
  });

  it('stripQuery rejects non-http values', () => {
    expect(stripQuery('javascript:alert(1)')).toBeNull();
    expect(stripQuery(undefined)).toBeNull();
  });

  it('every normalized fixture profile URL has no query string', async () => {
    const { posts } = await normalizePosts(loadSampleItems(), CONTEXT);
    for (const post of posts) expect(post.author_profile_url).not.toContain('?');
  });
});

describe('extractTaggedCompanies', () => {
  it('extracts companies tagged in contentAttributes', async () => {
    const post = await normalizePost(sampleItem(1), CONTEXT);
    expect(JSON.parse(post.tagged_companies_json ?? 'null')).toEqual([
      { id: '20000001', name: 'Example Data Co', linkedin_url: 'https://www.linkedin.com/company/example-data-co/' },
    ]);
  });

  it('dedupes, skips non-company attributes, returns [] for none and null when absent', () => {
    const company = { id: '1', name: 'Acme', linkedinUrl: 'https://www.linkedin.com/company/acme/' };
    expect(
      extractTaggedCompanies([{ type: 'COMPANY_NAME', company }, { type: 'COMPANY_NAME', company }, { type: 'HASHTAG' }]),
    ).toEqual([{ id: '1', name: 'Acme', linkedin_url: 'https://www.linkedin.com/company/acme/' }]);
    expect(extractTaggedCompanies([])).toEqual([]);
    expect(extractTaggedCompanies(undefined)).toBeNull();
  });
});
