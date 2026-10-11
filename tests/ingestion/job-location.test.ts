import { describe, expect, it } from 'vitest';
import { classifyLocationText, jobLocation } from '../../src/ingestion/job-location';
import { sampleItem } from '../helpers';

const post = (content: string, extra: Record<string, unknown> = {}) => ({ id: '7500000000000000999', content, ...extra });

/** The Actor's structured job card, shaped like the ones in production datasets. */
const jobCard = (location: string) => ({
  title: 'Revenue Operations Manager',
  linkedinUrl: 'https://www.linkedin.com/jobs/view/4400000001/?refId=abc%3D%3D&trackingId=abc%3D%3D',
  location,
  subtitle: 'Job by Example Co',
  buttonText: 'View job',
});

const UNKNOWN = { verdict: 'unknown', text: null, source: null };

describe('jobLocation — the hard US-job filter', () => {
  it.each([
    ['Hiring Sales Operations Analyst - New York, NY', 'New York, NY'],
    ['Hiring Revenue Operations Manager — Austin, Texas', 'Austin, TX'],
    ['Hiring RevOps - US Remote', 'United States'],
    ['Hiring Vendor Manager - Remote, United States', 'United States'],
  ])('accepts "%s" (location from the post text)', (text, evidence) => {
    expect(jobLocation(post(text))).toEqual({ verdict: 'us', text: evidence, source: 'post_text' });
  });

  it('accepts a structured job card located in the US and keeps its location as written', () => {
    expect(jobLocation(post('We are hiring!', { job: jobCard('San Francisco, CA') }))).toEqual({
      verdict: 'us',
      text: 'San Francisco, CA',
      source: 'job',
    });
    expect(jobLocation(post('We are hiring!', { job: jobCard('Plano, Texas, United States') }))).toEqual({
      verdict: 'us',
      text: 'Plano, Texas, United States',
      source: 'job',
    });
    // LinkedIn's work-mode suffix is stored as work_mode, not as part of the location.
    expect(jobLocation(post('We are hiring!', { job: jobCard('Dallas, TX (On-site)') }))).toEqual({ verdict: 'us', text: 'Dallas, TX', source: 'job' });
    expect(jobLocation(post('We are hiring!', { job: jobCard('United States (Remote)') }))).toEqual({ verdict: 'us', text: 'United States', source: 'job' });
  });

  it('keeps the most specific US places found in the text', () => {
    expect(jobLocation(post('Hiring a Storeroom Representative in Connecticut, United States'))).toMatchObject({ text: 'Connecticut' });
    expect(jobLocation(post('Hiring in Austin, TX and Denver, CO (US-based)'))).toMatchObject({ text: 'Austin, TX; Denver, CO' });
  });

  it.each([
    'Hiring Sales Operations Manager - London, UK',
    'Hiring RevOps Analyst - Toronto, Canada',
    'Hiring Vendor Manager - Bangalore, India',
    'Hiring Sales Ops - Berlin, Germany',
  ])('drops "%s" as non-US', (text) => {
    expect(jobLocation(post(text))).toMatchObject({ verdict: 'non_us', source: 'post_text' });
  });

  it.each(['Hiring Sales Operations Manager', 'Hiring RevOps - Remote', "We're hiring! DM me for details"])(
    'drops "%s" as location unknown',
    (text) => {
      expect(jobLocation(post(text))).toEqual(UNKNOWN);
    },
  );

  it.each([
    'United States',
    'United States of America',
    'USA',
    'U.S.',
    'U.S.A.',
    'Remote - United States',
    'Remote, United States',
    'US Remote',
    'U.S. Remote',
    'Remote US',
    'Remote USA',
    'Remote (US)',
    'US-based',
    'anywhere in the US',
  ])('accepts the US wording "%s"', (wording) => {
    expect(jobLocation(post(`Hiring a RevOps Analyst - ${wording}`)).verdict).toBe('us');
  });

  it('prefers the structured job card over the article and the post text', () => {
    // A US job card wins over a non-US place in the text…
    expect(jobLocation(post('Hiring for London, UK too', { job: jobCard('Austin, TX') }))).toEqual({
      verdict: 'us',
      text: 'Austin, TX',
      source: 'job',
    });
    // …and a non-US job card over a US place in the text.
    expect(jobLocation(post('Hiring! Our HQ is in New York, NY', { job: jobCard('London, England, United Kingdom') }))).toMatchObject({
      verdict: 'non_us',
      source: 'job',
    });
    const article = { title: 'RevOps Lead', subtitle: 'Toronto, Ontario', link: 'https://www.linkedin.com/jobs/view/4400000002/' };
    expect(jobLocation(post('We are hiring', { job: jobCard('Chicago, IL'), article }))).toMatchObject({ verdict: 'us', source: 'job' });
    // A job card without a usable location falls through to the next source.
    expect(jobLocation(post('Hiring RevOps - Chicago, IL', { job: jobCard('Remote') }))).toEqual({
      verdict: 'us',
      text: 'Chicago, IL',
      source: 'post_text',
    });
    expect(jobLocation(post('Hiring RevOps - Chicago, IL', { job: { title: 'RevOps Analyst' } }))).toMatchObject({
      verdict: 'us',
      source: 'post_text',
    });
  });

  it('reads the location of an attached job listing (article / job card metadata) before the post text', () => {
    const listing = { title: 'Sales Operations Manager', subtitle: 'Example Co · Denver, CO (Hybrid)', link: 'https://www.linkedin.com/jobs/view/4400000002/' };
    expect(jobLocation(post("We're hiring! Details below.", { article: listing }))).toEqual({
      verdict: 'us',
      text: 'Denver, CO',
      source: 'article',
    });
    const external = { title: 'Vendor Manager - Toronto, Ontario', link: 'https://boards.greenhouse.io/example/jobs/4400000003' };
    expect(jobLocation(post("We're hiring in New York, NY!", { article: external }))).toMatchObject({ verdict: 'non_us', source: 'article' });
    // An article that is not a job listing is ignored: the post text decides.
    const blog = { title: 'Why RevOps matters in London, UK', link: 'https://example.com/blog/revops' };
    expect(jobLocation(post("We're hiring in New York, NY!", { article: blog }))).toMatchObject({ verdict: 'us', source: 'post_text' });
    expect(jobLocation(post("We're hiring!", { article: blog }))).toEqual(UNKNOWN);
  });

  it("never uses the author's location", () => {
    const item = sampleItem(3);
    delete item.job;
    delete item.article;
    item.content = "We're hiring a Sales Operations Manager";
    (item.author as Record<string, unknown>).info = 'Talent Partner | New York, NY | Austin, Texas';
    expect(jobLocation(item)).toEqual(UNKNOWN);
  });

  it('does not treat two-letter words such as IN, OR and ME as states', () => {
    for (const text of [
      'Hiring! Apply IN person OR message ME',
      'Hiring RevOps - Remote, OR hybrid',
      'We are hiring: DM me or comment below',
      'Hiring a Sales Ops lead based in or near Austin', // a city on its own is not a location either
    ]) {
      expect(jobLocation(post(text))).toEqual(UNKNOWN);
    }
    // A known city with its state code, or a full state name, is.
    expect(jobLocation(post('Hiring in Portland, OR'))).toMatchObject({ verdict: 'us', text: 'Portland, OR' });
    expect(jobLocation(post('Hiring in Portland, ME'))).toMatchObject({ verdict: 'us', text: 'Portland, ME' });
    expect(jobLocation(post('Hiring in Indianapolis, IN'))).toMatchObject({ verdict: 'us', text: 'Indianapolis, IN' });
    expect(jobLocation(post('Hiring a RevOps lead in Oregon'))).toMatchObject({ verdict: 'us', text: 'Oregon' });
  });

  it('needs a city or "State" for Georgia and Washington (also a country and a surname)', () => {
    expect(jobLocation(post('Hiring in Tbilisi, Georgia'))).toEqual(UNKNOWN);
    expect(jobLocation(post('Hiring - ask Washington for details'))).toEqual(UNKNOWN);
    expect(jobLocation(post('Hiring in Atlanta, Georgia'))).toMatchObject({ verdict: 'us', text: 'Atlanta, GA' });
    expect(jobLocation(post('Hiring in Seattle, Washington'))).toMatchObject({ verdict: 'us', text: 'Seattle, WA' });
    expect(jobLocation(post('Hiring in Washington State'))).toMatchObject({ verdict: 'us', text: 'Washington' });
    expect(jobLocation(post('Hiring in Washington, D.C.'))).toMatchObject({ verdict: 'us', text: 'Washington, DC' });
  });

  it('prefers the longest place name (New Mexico is a state; Mexico City is not in the US)', () => {
    expect(jobLocation(post('Hiring in New Mexico'))).toMatchObject({ verdict: 'us', text: 'New Mexico' });
    expect(jobLocation(post('Hiring in Albuquerque, New Mexico'))).toMatchObject({ verdict: 'us', text: 'Albuquerque, NM' });
    expect(jobLocation(post('Hiring in Mexico City'))).toMatchObject({ verdict: 'non_us' });
    expect(jobLocation(post('Hiring in New South Wales'))).toMatchObject({ verdict: 'non_us' });
    expect(jobLocation(post('Hiring in Vancouver, WA'))).toMatchObject({ verdict: 'us', text: 'Vancouver, WA' });
    expect(jobLocation(post('Hiring in Vancouver, BC'))).toMatchObject({ verdict: 'non_us' });
  });

  it('treats a mix of US and non-US places as unknown', () => {
    expect(jobLocation(post('Hiring Sales Ops for our New York, NY and London, UK offices'))).toEqual(UNKNOWN);
    expect(jobLocation(post('Hiring', { job: jobCard('Ontario, CA') }))).toEqual(UNKNOWN);
  });

  it('trusts "City, ST" with any city only in the structured job location', () => {
    expect(jobLocation(post('We are hiring', { job: jobCard('Hauppauge, NY') }))).toEqual({
      verdict: 'us',
      text: 'Hauppauge, NY',
      source: 'job',
    });
    expect(jobLocation(post('We are hiring in Hauppauge, NY'))).toEqual(UNKNOWN);
    expect(jobLocation(post('We are hiring', { job: jobCard('Greater Boston') }))).toMatchObject({ verdict: 'us', source: 'job' });
    expect(jobLocation(post('We are hiring', { job: jobCard('Toronto, ON') }))).toMatchObject({ verdict: 'non_us', source: 'job' });
  });

  it('matches case-insensitively and folds styled letters and accents', () => {
    expect(jobLocation(post('HIRING - AUSTIN, TEXAS'))).toMatchObject({ verdict: 'us', text: 'Austin, TX' });
    expect(jobLocation(post('𝗛𝗶𝗿𝗶𝗻𝗴 𝗶𝗻 𝗦𝗮𝗻 𝗙𝗿𝗮𝗻𝗰𝗶𝘀𝗰𝗼, 𝗖𝗔'))).toMatchObject({ verdict: 'us', text: 'San Francisco, CA' });
    expect(jobLocation(post('Hiring in Montréal, Québec'))).toMatchObject({ verdict: 'non_us' });
    expect(jobLocation(post('Hiring in São Paulo'))).toMatchObject({ verdict: 'non_us' });
  });

  it('answers unknown for items without text or a job card', () => {
    for (const item of [null, undefined, 'Austin, TX', 42, [], {}, post(''), { content: 42, job: 'Austin, TX' }]) {
      expect(jobLocation(item)).toEqual(UNKNOWN);
    }
  });
});

describe('jobLocation — free text says more than where the job is (regression)', () => {
  const verdict = (text: string, extra: Record<string, unknown> = {}) => jobLocation(post(text, extra)).verdict;

  it('ignores URLs and email addresses', () => {
    // A UK email domain must not turn a US job into an ambiguous one.
    expect(jobLocation(post('Hiring a RevOps Manager - Austin, TX. Send your CV to talent@acme.co.uk'))).toEqual({
      verdict: 'us',
      text: 'Austin, TX',
      source: 'post_text',
    });
    // A "/us/" path or a company website is not location evidence.
    expect(verdict('Hiring! Apply: https://jobsrmine.com/job/us/sales-operations-analyst/3187077631')).toBe('unknown');
    expect(verdict('Hiring a RevOps lead. Learn more at www.acme-london.com')).toBe('unknown');
    expect(verdict('Hiring a RevOps lead - New York, NY. More at acme-london.com/about')).toBe('us');
    expect(verdict('Hiring a RevOps lead (Remote). Questions? recruiting@acme.in')).toBe('unknown');
    // An address right after punctuation, with dots, hyphens or a "+" in it, is removed whole.
    expect(verdict('Hiring (Remote). Email:hr.team+revops@acme-london.co.uk or (jobs@acme.us)')).toBe('unknown');
    expect(verdict('Hiring in Denver, CO — CVs to “talent.uk@acme.co.uk”')).toBe('us');
    // A long post without any address is still read normally.
    expect(verdict(`${'Sales operations '.repeat(150)}Hiring in Austin, TX`)).toBe('us');
    // The original post text is never changed.
    const item = post('Hiring - Austin, TX. Apply at https://jobs.lever.co/acme/1 or jobs@acme.co.uk');
    jobLocation(item);
    expect(item.content).toBe('Hiring - Austin, TX. Apply at https://jobs.lever.co/acme/1 or jobs@acme.co.uk');
  });

  it.each([
    'Hiring a Team Leader to support U.S. healthcare clients. Remote.',
    'Hiring a Sales Ops Analyst for the US market',
    'Hiring a Sales Ops Analyst for the U.S. market',
    'Hiring! Shift: Pacific Time (US)',
    'Hiring. Experience working with US customers',
    'Hiring. Experience working with U.S. customers',
    'Hiring an analyst. Supporting United States operations',
    'Hiring a RevOps lead to grow our clients across the U.S.',
    'Hiring - Remote (US time zones)',
  ])('does not treat an incidental US mention as the job location: "%s"', (text) => {
    expect(verdict(text)).toBe('unknown');
  });

  it('keeps the real job location next to an incidental US mention', () => {
    expect(verdict('Hiring a RevOps Analyst in Bangalore, supporting U.S. healthcare clients')).toBe('non_us');
    expect(verdict('Location: Cairo. Shift: Pacific Time (US)')).toBe('non_us');
    // Geographic eligibility still counts.
    expect(verdict('Hiring - open to candidates in the United States')).toBe('us');
    expect(verdict('Hiring: open to US citizens only')).toBe('us');
    expect(verdict('Hiring - Full-time, Remote (US)')).toBe('us');
  });

  it('ignores travel destinations', () => {
    expect(jobLocation(post('CRO role. Hybrid SF, monthly travel to Calgary'))).toEqual({
      verdict: 'us',
      text: 'San Francisco',
      source: 'post_text',
    });
    expect(verdict('Hiring RevOps - London based, occasional travel to New York')).toBe('non_us');
    expect(verdict('Hiring RevOps - Remote, travel across the United States')).toBe('unknown');
    expect(verdict('Hiring RevOps - Austin, TX with quarterly trips to London, UK')).toBe('us');
  });

  it('recognizes SF only as a workplace, and the usual US formats', () => {
    for (const text of ['Hiring - Hybrid SF', 'Hiring a SF-based RevOps Manager', 'Hiring a RevOps lead in SF', 'Hiring - San Francisco, CA', 'Hiring - Remote - United States', 'Hiring - New York, NY']) {
      expect(verdict(text), text).toBe('us');
    }
    expect(verdict('Hiring! Ping SF for details')).toBe('unknown');
  });

  it('does not infer the job location from the employer HQ, the author or their story', () => {
    expect(verdict('Acme is headquartered in Austin, TX. We are hiring a remote RevOps Analyst.')).toBe('unknown');
    expect(verdict('Hiring a remote Sales Ops lead. HQ: Austin, TX')).toBe('unknown');
    expect(verdict('A NYC-based company is hiring a remote Sales Ops lead')).toBe('unknown');
    expect(verdict('Plus, as an Australian based in New York I love to travel. I am hiring a Revenue Operations Lead.')).toBe('unknown');
    expect(verdict('I am based in Denver and hiring a remote RevOps Analyst')).toBe('unknown');
    expect(verdict('I moved to Austin, TX last year. Now hiring a remote Vendor Manager!')).toBe('unknown');
    // …while a job described as based somewhere still counts.
    expect(verdict('Hiring a Sales Ops Analyst as a hybrid role based in Austin, TX')).toBe('us');
    expect(verdict('Onsite at our Austin, TX HQ - hiring a RevOps Analyst')).toBe('us');
  });

  it('rejects conflicting evidence and plain Remote', () => {
    expect(verdict('Hiring in New York, NY and London, UK')).toBe('unknown');
    expect(verdict('Hiring RevOps - Remote')).toBe('unknown');
  });

  it('applies the same rules to a job listing article, but not to the structured job card', () => {
    const listing = { title: 'RevOps Lead - supporting U.S. clients', link: 'https://jobs.lever.co/acme/1' };
    expect(jobLocation(post('We are hiring', { article: listing }))).toEqual(UNKNOWN);
    expect(jobLocation(post('We are hiring', { job: { location: 'United States (Remote)' } }))).toMatchObject({ verdict: 'us', source: 'job' });
  });
});

describe('classifyLocationText — the CPU-optimized scans keep every result (regression)', () => {
  const verdict = (text: string) => classifyLocationText(text).verdict;

  it('ignores emails and links whatever whitespace or punctuation surrounds them', () => {
    expect(verdict('Hiring – Austin, TX.\u00a0CV to jobs@acme.co.uk')).toBe('us');
    expect(verdict('Remote role.\u3000Details: www.acme-london.com')).toBe('unknown');
    expect(verdict('Hiring (details: lnkd.in/abc.uk) in Denver, CO')).toBe('us');
    expect(verdict('Hiring in Denver, CO\u2028Email:ops@acme-london.co.uk')).toBe('us');
    expect(verdict('Apply at https://jobs.example.com/job/us/123 or acme.in/careers')).toBe('unknown');
  });

  it('folds accents, combining marks and styled letters before matching places', () => {
    expect(verdict('Hiring in Zu\u0308rich')).toBe('non_us');
    expect(verdict('Hiring in Sa\u0303o Paulo')).toBe('non_us');
    expect(verdict('𝗛𝗶𝗿𝗶𝗻𝗴 in 𝗔𝘂𝘀𝘁𝗶𝗻, 𝗧𝗫 🚀')).toBe('us');
  });

  it('still finds US-remote wording in every form, and nothing in words that merely contain "us"', () => {
    for (const text of ['Role: usremote', 'Role: remoteus', 'Remote-US only', 'Location: Remote / US', 'Open to US citizens', '(US) Remote']) {
      expect(verdict(text)).toBe('us');
    }
    expect(verdict('Focus on business users; join us to use our tools')).toBe('unknown');
  });
});
