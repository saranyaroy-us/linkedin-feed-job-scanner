import { describe, expect, it } from 'vitest';
import { canonicalLinkedinJobUrl, externalApplyUrl, isJobListingUrl, linkedinJobUrl } from '../../src/normalization/job-links';
import { normalizePost } from '../../src/normalization/post-normalizer';
import { CONTEXT, sampleItem } from '../helpers';

const JOB = 'https://www.linkedin.com/jobs/view/4474331394/';

/** A fixture clone without a job card or article, with this text. */
function item(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = sampleItem(3);
  delete base.job;
  delete base.article;
  return { ...base, content, ...extra };
}

describe('canonicalLinkedinJobUrl', () => {
  it('canonicalizes LinkedIn Jobs listing URLs to https://www.linkedin.com/jobs/view/<id>/', () => {
    for (const url of [
      JOB,
      'https://www.linkedin.com/jobs/view/4474331394',
      'http://linkedin.com/jobs/view/4474331394/',
      'https://uk.linkedin.com/jobs/view/4474331394/',
      'https://WWW.LINKEDIN.COM/jobs/view/4474331394/',
      'https://www.linkedin.com/jobs/view/revenue-operations-manager-at-example-co-4474331394/',
      'linkedin.com/jobs/view/4474331394',
      'https://www.linkedin.com/jobs/search/?currentJobId=4474331394&keywords=revops',
      'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4474331394',
      `  ${JOB}.  `,
    ]) {
      expect(canonicalLinkedinJobUrl(url), url).toBe(JOB);
    }
  });

  it('strips tracking parameters and fragments', () => {
    expect(canonicalLinkedinJobUrl(`${JOB}?refId=8oRvAUICT6uYT7n%2Be23v2w%3D%3D&trackingId=8oRvAUICT6uYT7n%2Be23v2w%3D%3D`)).toBe(JOB);
    expect(canonicalLinkedinJobUrl(`${JOB}?trk=public_jobs&eBP=abc`)).toBe(JOB);
    expect(canonicalLinkedinJobUrl(`${JOB}#apply`)).toBe(JOB);
    expect(canonicalLinkedinJobUrl(`${JOB}?trackingId=x#section`)).toBe(JOB);
  });

  it('ignores external job boards and career pages', () => {
    for (const url of [
      'https://boards.greenhouse.io/example/jobs/4474331394',
      'https://job-boards.greenhouse.io/example/jobs/4474331394',
      'https://jobs.lever.co/example/0f5a7c1e-4474-3313-94aa-123456789abc',
      'https://jobs.ashbyhq.com/example/4474331394',
      'https://example.wd5.myworkdayjobs.com/en-US/careers/job/New-York/RevOps_4474331394',
      'https://careers.example.com/jobs/view/4474331394/',
      'https://www.indeed.com/viewjob?jk=4474331394',
    ]) {
      expect(canonicalLinkedinJobUrl(url), url).toBeNull();
    }
  });

  it('ignores other LinkedIn pages, short links and look-alike hosts', () => {
    for (const url of [
      'https://www.linkedin.com/posts/sample-author_we-are-hiring-activity-7500000000000000101-AbCd',
      'https://www.linkedin.com/feed/update/urn:li:activity:7500000000000000101/',
      'https://www.linkedin.com/company/example-co/jobs/',
      'https://www.linkedin.com/in/sample-author/',
      'https://lnkd.in/gAbCdEf',
      'https://linkedin.com.example.net/jobs/view/4474331394/',
      'https://notlinkedin.com/jobs/view/4474331394/',
      'ftp://www.linkedin.com/jobs/view/4474331394/',
    ]) {
      expect(canonicalLinkedinJobUrl(url), url).toBeNull();
    }
  });

  it('ignores malformed Jobs URLs instead of guessing an id', () => {
    for (const url of [
      'https://www.linkedin.com/jobs/view/',
      'https://www.linkedin.com/jobs/view/abc/',
      'https://www.linkedin.com/jobs/view/12345/', // too short to be a job id
      'https://www.linkedin.com/jobs/view/4474331394/apply/',
      'https://www.linkedin.com/jobs/search/?currentJobId=abc',
      'https://www.linkedin.com/jobs/',
      'https://www.linkedin.com/jobs/view/4474331394x/',
      'not a url',
      '',
    ]) {
      expect(canonicalLinkedinJobUrl(url), url).toBeNull();
    }
    for (const value of [null, undefined, 4474331394, {}, []]) expect(canonicalLinkedinJobUrl(value)).toBeNull();
  });
});

describe('linkedinJobUrl — sources in priority order', () => {
  it('takes the structured job card URL first', () => {
    const job = { title: 'RevOps Analyst', linkedinUrl: `${JOB}?refId=a&trackingId=b`, location: 'Austin, TX' };
    const article = { title: 'Another job', link: 'https://www.linkedin.com/jobs/view/4400000002/' };
    expect(linkedinJobUrl(item('Hiring! https://www.linkedin.com/jobs/view/4400000003/', { job, article }))).toBe(JOB);
  });

  it('then an attached article / job card that links to a LinkedIn job', () => {
    const article = { title: 'Revenue Operations Manager', subtitle: 'Example Co · Austin, TX', link: `${JOB}?trackingId=abc` };
    expect(linkedinJobUrl(item('Hiring! https://www.linkedin.com/jobs/view/4400000003/', { article }))).toBe(JOB);
    // A job card without a LinkedIn URL does not stop the search.
    expect(linkedinJobUrl(item('Hiring!', { job: { title: 'RevOps', location: 'Austin, TX' }, article }))).toBe(JOB);
  });

  it('then the first LinkedIn Jobs URL in the post text', () => {
    expect(linkedinJobUrl(item(`We're hiring! Apply here: ${JOB}?trackingId=xyz. Questions? DM me.`))).toBe(JOB);
    expect(linkedinJobUrl(item('Hiring (https://www.linkedin.com/jobs/view/4474331394/) - apply today'))).toBe(JOB);
    expect(linkedinJobUrl(item('Hiring: linkedin.com/jobs/view/4474331394'))).toBe(JOB);
    expect(
      linkedinJobUrl(item('Hiring: https://www.linkedin.com/jobs/view/oops/ or https://www.linkedin.com/jobs/view/4474331394/')),
    ).toBe(JOB);
  });

  it('ignores Greenhouse, Lever and other external links in the article and the text', () => {
    const greenhouse = { title: 'RevOps Lead', link: 'https://boards.greenhouse.io/example/jobs/4474331394' };
    expect(linkedinJobUrl(item('Hiring! Apply: https://jobs.lever.co/example/abc-123', { article: greenhouse }))).toBeNull();
  });

  it('ignores normal LinkedIn post URLs', () => {
    const { linkedinUrl } = sampleItem(3);
    expect(linkedinJobUrl(item(`Hiring! Read more: ${String(linkedinUrl)}`))).toBeNull();
  });

  it('is null when there is no job URL', () => {
    expect(linkedinJobUrl(item("We're hiring! DM me for details"))).toBeNull();
    expect(linkedinJobUrl({})).toBeNull();
    expect(linkedinJobUrl({ content: 42, job: 'https://www.linkedin.com/jobs/view/4474331394/' })).toBeNull();
  });
});

describe('normalizePost — linkedin_job_url', () => {
  it('stores the canonical job URL and keeps the article URL as it was', async () => {
    const article = { title: 'Revenue Operations Manager', link: `${JOB}?trackingId=abc#top` };
    const post = await normalizePost(item('We are hiring', { article }), CONTEXT);
    expect(post.linkedin_job_url).toBe(JOB);
    expect(post.article_url).toBe(`${JOB}?trackingId=abc#top`);
    expect(post.url).toBe(sampleItem(3).linkedinUrl);
  });

  it('leaves it null for posts without a LinkedIn job link (external article URLs stay in article_url)', async () => {
    const post = await normalizePost(sampleItem(2), CONTEXT);
    expect(post.linkedin_job_url).toBeNull();
    expect(post.article_url).toBe('https://jobs.example.com/acme-bio/product-marketing-manager');
  });
});

describe('externalApplyUrl — application links outside LinkedIn', () => {
  const article = (link: string, title = 'Revenue Operations Manager') => ({ title, subtitle: new URL(link).hostname, link });

  it('takes the attached article when it links to a job page', () => {
    for (const link of [
      'https://boards.greenhouse.io/acme/jobs/4474331394', // Greenhouse
      'https://job-boards.greenhouse.io/acme/jobs/4474331394',
      'https://jobs.lever.co/acme/0f5a7c1e-4474-3313-94aa-123456789abc', // Lever
      'https://jobs.ashbyhq.com/acme/0f5a7c1e-4474-3313-94aa-123456789abc', // Ashby
      'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Revenue-Operations-Manager_R123', // Workday
      'https://careers.acme.com/revenue-operations-manager', // career site
      'https://www.acme.com/careers/jobs?gh_jid=5436796008', // career page on the company site
      'https://www.acme.com/company/careers/revops-manager',
      'https://apply.workable.com/acme/j/ABC123/',
      'https://jobs.micro1.ai/post/2752b340-47ec-4cfa-8197-999460c07a6e?referralCode=x', // job board, kept as linked
    ]) {
      expect(externalApplyUrl(item('We are hiring!', { article: article(link) }), null), link).toBe(link);
    }
  });

  it('then a job link in the post text', () => {
    expect(externalApplyUrl(item('We are hiring a RevOps Analyst. Apply: https://jobs.ashbyhq.com/acme/123abc.'), null)).toBe(
      'https://jobs.ashbyhq.com/acme/123abc',
    );
    // The article wins over the text.
    const listing = article('https://boards.greenhouse.io/acme/jobs/1');
    expect(externalApplyUrl(item('Apply: https://jobs.lever.co/acme/2', { article: listing }), null)).toBe(
      'https://boards.greenhouse.io/acme/jobs/1',
    );
  });

  it('ignores unrelated articles, home pages and LinkedIn pages', () => {
    for (const link of [
      'https://example.com/blog/why-revops-matters',
      'https://medium.com/@someone/how-i-got-my-dream-job-4474331394',
      'https://www.acme.com/',
      'https://hotjobs.example.com/',
      'https://www.youtube.com/watch?v=abc',
      'https://www.linkedin.com/posts/sample-author_we-are-hiring-activity-7500000000000000101-AbCd', // LinkedIn social post
      'https://www.linkedin.com/pulse/hiring-tips-sample-author',
      'https://www.linkedin.com/company/acme/jobs/',
    ]) {
      expect(externalApplyUrl(item('We are hiring!', { article: article(link, 'Why RevOps matters') }), null), link).toBeNull();
    }
  });

  it('never repeats the LinkedIn job URL', () => {
    const linkedin = article(`${JOB}?trackingId=abc`);
    const post = item(`We're hiring! ${JOB}`, { article: linkedin });
    expect(linkedinJobUrl(post)).toBe(JOB);
    expect(externalApplyUrl(post, JOB)).toBeNull();
  });

  it('keeps an lnkd.in link introduced by "apply" only when it is the only application link', () => {
    expect(externalApplyUrl(item('Hiring a Sales Ops Analyst. Apply here 👉 https://lnkd.in/gAbCdEf'), null)).toBe(
      'https://lnkd.in/gAbCdEf',
    );
    expect(externalApplyUrl(item('Hiring!\nLink to apply: lnkd.in/gAbCdEf'), null)).toBe('https://lnkd.in/gAbCdEf');
    // Not when the post links the LinkedIn job, has a direct apply link, or does not say "apply".
    expect(externalApplyUrl(item('Hiring! Apply here: https://lnkd.in/gAbCdEf'), JOB)).toBeNull();
    expect(
      externalApplyUrl(item('Apply here: https://lnkd.in/gAbCdEf or at https://jobs.lever.co/acme/2'), null),
    ).toBe('https://jobs.lever.co/acme/2');
    expect(externalApplyUrl(item('Hiring! More about us: https://lnkd.in/gAbCdEf'), null)).toBeNull();
    expect(externalApplyUrl(item('Apply today!\nOur story: https://lnkd.in/gAbCdEf'), null)).toBeNull(); // "apply" on another line
  });

  it('is null when there is no application link', () => {
    expect(externalApplyUrl(item("We're hiring! DM me for details"), null)).toBeNull();
    expect(externalApplyUrl({}, null)).toBeNull();
    expect(externalApplyUrl({ content: 42, article: 'https://jobs.lever.co/acme/1' }, null)).toBeNull();
  });
});

describe('isJobListingUrl', () => {
  it('accepts LinkedIn Jobs listings and job pages elsewhere, nothing else', () => {
    expect(isJobListingUrl(JOB)).toBe(true);
    expect(isJobListingUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe(true);
    expect(isJobListingUrl('https://careers.acme.com/job/123')).toBe(true);
    expect(isJobListingUrl('https://www.linkedin.com/feed/update/urn:li:activity:7500000000000000101/')).toBe(false);
    expect(isJobListingUrl('https://lnkd.in/gAbCdEf')).toBe(false);
    expect(isJobListingUrl('https://example.com/blog/revops')).toBe(false);
    expect(isJobListingUrl('not a url')).toBe(false);
    expect(isJobListingUrl(null)).toBe(false);
  });
});

describe('normalizePost — external_apply_url', () => {
  it('stores the job article link, or an lnkd.in link introduced by "apply"', async () => {
    expect((await normalizePost(sampleItem(2), CONTEXT)).external_apply_url).toBe(
      'https://jobs.example.com/acme-bio/product-marketing-manager',
    );
    expect((await normalizePost(sampleItem(3), CONTEXT)).external_apply_url).toBe('https://lnkd.in/example4');
    expect((await normalizePost(sampleItem(4), CONTEXT)).external_apply_url).toBeNull();
  });
});
