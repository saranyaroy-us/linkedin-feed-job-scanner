import { describe, expect, it } from 'vitest';
import { canonicalCompanyUrl, jobCompany, jobTitle, workMode } from '../../src/normalization/job-details';
import { normalizePost } from '../../src/normalization/post-normalizer';
import { CONTEXT, sampleItem } from '../helpers';

/** A fixture clone (profile author, no job card, article or tags) with this text. */
function item(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = sampleItem(3);
  delete base.job;
  delete base.article;
  base.contentAttributes = [];
  return { ...base, content, ...extra };
}

/** The Actor's structured job card, shaped like the ones in production datasets. */
const jobCard = (fields: Record<string, unknown> = {}) => ({
  title: 'Director, Revenue Operations  ',
  linkedinUrl: 'https://www.linkedin.com/jobs/view/4450502529/?refId=a&trackingId=a',
  location: 'Dallas, TX (On-site)',
  subtitle: 'Job by Acme Corp',
  logoUrl: 'https://media.licdn.com/dms/image/example-logo',
  buttonText: 'View job',
  buttonTip: 'View job',
  ...fields,
});

const companyTag = (name: string, slug: string, id = '30000001') => ({
  start: 0,
  length: name.length,
  type: 'COMPANY_NAME',
  hyperlink: `https://www.linkedin.com/company/${slug}/`,
  textLink: null,
  company: { id, name, linkedinUrl: `https://www.linkedin.com/company/${slug}/` },
});
const profileMention = (first: string, last: string) => ({
  start: 0,
  length: first.length + last.length + 1,
  type: 'PROFILE_MENTION',
  hyperlink: 'https://www.linkedin.com/in/ACoAASAMPLEMENTION',
  textLink: null,
  profile: { id: 'ACoAASAMPLEMENTION', firstName: first, lastName: last, linkedinUrl: 'https://www.linkedin.com/in/sample-mention', publicIdentifier: 'sample-mention' },
});
const listing = (title: string, link = 'https://jobs.lever.co/acme/0f5a7c1e') => ({ title, subtitle: new URL(link).hostname, link, linkLabel: `Open article: ${title}`, description: null });

describe('jobTitle', () => {
  it('takes the job card title first (trimmed), over the article and the text', () => {
    const post = item('We are hiring a Sales Operations Analyst', { job: jobCard(), article: listing('RevOps Lead') });
    expect(jobTitle(post)).toBe('Director, Revenue Operations');
  });

  it('then the title of an attached job listing', () => {
    expect(jobTitle(item('We are hiring a Sales Operations Analyst', { article: listing('Revenue Operations Manager') }))).toBe(
      'Revenue Operations Manager',
    );
    for (const [title, expected] of [
      ['RevOps Analyst | AgentSync Careers', 'RevOps Analyst'],
      ['Revenue Operations Specialist (SaaS) | Apply on Job', 'Revenue Operations Specialist (SaaS)'],
      ['Job Application for Sales Operations Manager at Acme', 'Sales Operations Manager'],
      ['Sr. Director, Revenue Operations Planning and Execution at impact.com', 'Sr. Director, Revenue Operations Planning and Execution'],
      ['Revenue Strategy & Readiness Director - 11913', 'Revenue Strategy & Readiness Director'],
      ['Customer Support Specialist Job in Austin, Texas - Jobstreet', 'Customer Support Specialist'],
    ]) {
      expect(jobTitle(item('Hiring!', { article: listing(title!) })), title).toBe(expected);
    }
  });

  it('never uses an unrelated article headline, a listing page or a URL as the title', () => {
    const blog = { title: 'Why every Revenue Operations Manager needs a playbook', link: 'https://example.com/blog/revops-playbook' };
    expect(jobTitle(item('Hiring soon, more below', { article: blog }))).toBeNull();
    for (const title of ['Remote Jobs in the United States', 'https://jobsrmine.com/job/us/admissions-coordinator/3189419261', 'Job Description', 'Careers @ Acme']) {
      expect(jobTitle(item('Hiring!', { article: listing(title) })), title).toBeNull();
    }
  });

  it('then an explicit title in the post text', () => {
    for (const [text, expected] of [
      ["We're hiring a Sales Operations Manager in Austin, TX", 'Sales Operations Manager'],
      ['Hiring Revenue Operations Manager — Austin, Texas', 'Revenue Operations Manager'],
      ['I am hiring an experienced Vendor Manager to join my team', 'Vendor Manager'],
      ['#Hiring: Head of Revenue Operations (Remote, US)', 'Head of Revenue Operations'],
      ['We are #hiring a Sr. Sales Ops Analyst!', 'Sr. Sales Ops Analyst'],
      ['Acme is hiring for a RevOps Lead 🚀', 'RevOps Lead'],
      ["we're hiring a sales operations analyst to own our CRM", 'sales operations analyst'],
      ['Big news!\nRole: Vendor Management Specialist\nLocation: Remote, US', 'Vendor Management Specialist'],
      ['𝗪𝗲 𝗮𝗿𝗲 𝗵𝗶𝗿𝗶𝗻𝗴: 𝗦𝗮𝗹𝗲𝘀 𝗢𝗽𝗲𝗿𝗮𝘁𝗶𝗼𝗻𝘀 𝗠𝗮𝗻𝗮𝗴𝗲𝗿', 'Sales Operations Manager'],
    ]) {
      expect(jobTitle(item(text!)), text).toBe(expected);
    }
    // Sanitized real posts.
    expect(jobTitle(sampleItem(4))).toBe('FACILITY OFFICER');
    expect(jobTitle(sampleItem(3))).toBe('Principal System & App Admin');
  });

  it('returns null when the post names no single role', () => {
    for (const text of [
      'Hiring Sales Operations', // no role word
      'Hiring RevOps - Remote',
      "We're hiring! DM me for details",
      'Hiring managers often skip the RevOps interview',
      'The hiring process at Acme is changing',
      '#hiring #revops #salesops',
      'We are hiring across sales and marketing',
      'Hiring\nSales Operations Manager', // the title must follow on the same line
    ]) {
      expect(jobTitle(item(text)), text).toBeNull();
    }
    expect(jobTitle({})).toBeNull();
  });
});

describe('jobCompany', () => {
  it('takes the job card employer first, with its LinkedIn page when the post tags it', () => {
    expect(jobCompany(item('Hiring', { job: jobCard() }))).toEqual({ name: 'Acme Corp', linkedinUrl: null });
    const tagged = item('Hiring at Acme Corp', { job: jobCard(), contentAttributes: [companyTag('Acme Corp', 'acme-corp')] });
    expect(jobCompany(tagged)).toEqual({ name: 'Acme Corp', linkedinUrl: 'https://www.linkedin.com/company/acme-corp/' });
    const other = item('Hiring', { job: jobCard(), contentAttributes: [companyTag('Beta Inc', 'beta')] });
    expect(jobCompany(other)).toEqual({ name: 'Acme Corp', linkedinUrl: null });
  });

  it('then the one company tagged in the post (contentAttributes[].company)', () => {
    const post = item('Join @Beta Inc — we are hiring a RevOps Analyst', { contentAttributes: [companyTag('Beta Inc', 'beta-inc')] });
    expect(jobCompany(post)).toEqual({ name: 'Beta Inc', linkedinUrl: 'https://www.linkedin.com/company/beta-inc/' });
    // Two different tagged companies are ambiguous.
    const two = item('Hiring', { contentAttributes: [companyTag('Beta Inc', 'beta-inc'), companyTag('Gamma LLC', 'gamma', '30000002')] });
    expect(jobCompany(two)).toEqual({ name: null, linkedinUrl: null });
    // The same company tagged twice is still one.
    const twice = item('Hiring', { contentAttributes: [companyTag('Beta Inc', 'beta-inc'), companyTag('Beta Inc', 'beta-inc')] });
    expect(jobCompany(twice).name).toBe('Beta Inc');
  });

  it('then the company that posted it (sanitized company author), with a canonical page URL', () => {
    const post = sampleItem(1);
    post.contentAttributes = [];
    expect(jobCompany(post)).toEqual({ name: 'Example Data Co', linkedinUrl: 'https://www.linkedin.com/company/example-data-co/' });
  });

  it('then the employer named in a job listing title', () => {
    expect(jobCompany(item('Hiring!', { article: listing('RevOps Analyst | AgentSync Careers', 'https://ats.rippling.com/agentsync/jobs/1') }))).toEqual({
      name: 'AgentSync',
      linkedinUrl: null,
    });
    expect(jobCompany(item('Hiring!', { article: listing('Job Application for Sales Operations Manager at Acme') })).name).toBe('Acme');
  });

  it('never reads people mentioned in the post, the author headline or job boards', () => {
    // Sanitized profile author whose headline names a company ("CEO @ Example Ops").
    const post = sampleItem(0);
    post.contentAttributes = [profileMention('Sample', 'Mention')];
    expect(jobCompany(post)).toEqual({ name: null, linkedinUrl: null });
    const board = sampleItem(1);
    board.contentAttributes = [];
    (board.author as Record<string, unknown>).name = 'Dallas Jobs';
    expect(jobCompany(board).name).toBeNull();
    expect(jobCompany(item('Hiring', { contentAttributes: [companyTag('Get9to5Jobs.com', 'get9to5jobs')] })).name).toBeNull();
    expect(jobCompany(item('Hiring', { contentAttributes: [companyTag('XLRI Jamshedpur', 'xlri')].map((tag) => ({ ...tag, company: { ...tag.company, linkedinUrl: 'https://www.linkedin.com/school/xlri/' } })) })).name).toBeNull();
  });

  it('canonicalizes LinkedIn company page URLs and rejects others', () => {
    expect(canonicalCompanyUrl('https://www.linkedin.com/company/example-data-co/posts?trk=x')).toBe('https://www.linkedin.com/company/example-data-co/');
    expect(canonicalCompanyUrl('https://linkedin.com/showcase/acme-labs')).toBe('https://www.linkedin.com/showcase/acme-labs/');
    expect(canonicalCompanyUrl('https://www.linkedin.com/school/xlri/')).toBeNull();
    expect(canonicalCompanyUrl('https://www.linkedin.com/in/sample-author/')).toBeNull();
    expect(canonicalCompanyUrl('https://linkedin.com.example.net/company/acme/')).toBeNull();
    expect(canonicalCompanyUrl(null)).toBeNull();
  });
});

describe('workMode', () => {
  it("reads LinkedIn's work mode on the job card first", () => {
    expect(workMode(item('Fully remote team!', { job: jobCard({ location: 'Dallas, TX (On-site)' }) }))).toBe('onsite');
    expect(workMode(item('Hiring', { job: jobCard({ location: 'United States (Remote)' }) }))).toBe('remote');
    expect(workMode(item('Hiring', { job: jobCard({ location: 'Austin, TX (Hybrid)' }) }))).toBe('hybrid');
    // A card without one falls through to the text.
    expect(workMode(item('This role is fully remote', { job: jobCard({ location: 'Plano, Texas, United States' }) }))).toBe('remote');
  });

  it('then a job listing, then the post text', () => {
    expect(workMode(item('On-site in Austin', { article: listing('RevOps Analyst (Remote)') }))).toBe('remote');
    for (const [text, mode] of [
      ['Hiring RevOps - US Remote', 'remote'],
      ['100% remote, work from home', 'remote'],
      ['Hybrid role in Chicago, 3 days in office', 'hybrid'],
      ['On-site in Austin, TX', 'onsite'],
      ['This is an in-office role in New York, NY', 'onsite'],
    ]) {
      expect(workMode(item(text!)), text).toBe(mode);
    }
  });

  it('is unknown when the post says nothing clear', () => {
    for (const text of [
      'Hiring a Sales Operations Manager',
      'Remote or hybrid, your choice', // several modes
      'Remote with occasional on-site visits',
      'You will support our remote sales teams',
      'This role is not remote',
      'Final round is an on-site interview',
      'Experience with hybrid cloud deployments',
    ]) {
      expect(workMode(item(text)), text).toBe('unknown');
    }
    expect(workMode({})).toBe('unknown');
  });
});

describe('normalizePost — job details', () => {
  it('stores title, company, work mode and links from the job card', async () => {
    const post = await normalizePost(item('We are hiring!', { job: jobCard() }), CONTEXT);
    expect(post).toMatchObject({
      job_title: 'Director, Revenue Operations',
      company_name: 'Acme Corp',
      company_linkedin_url: null,
      work_mode: 'onsite',
      linkedin_job_url: 'https://www.linkedin.com/jobs/view/4450502529/',
      external_apply_url: null,
    });
  });

  it('leaves unknown details null (work mode "unknown")', async () => {
    const post = await normalizePost(sampleItem(0), CONTEXT);
    expect(post).toMatchObject({
      job_title: null,
      company_name: null,
      company_linkedin_url: null,
      work_mode: 'unknown',
      linkedin_job_url: null,
      external_apply_url: null,
    });
  });
});
