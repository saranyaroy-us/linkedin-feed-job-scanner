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

describe('job details — labeled fields, job alerts and digests', () => {
  it('reads "Position Title:", "Job:" and emoji-prefixed labels, and stops a title before "Apply here"', () => {
    expect(jobTitle(item('#hiring Sales and Operations Management Trainee Apply here: https://lnkd.in/x\nPosition Title: Sales and Operations Management Trainee'))).toBe(
      'Sales and Operations Management Trainee',
    );
    expect(jobTitle(item('🚀 New role!\n💼 Position: Revenue Operations Analyst 🏢 Company: Acme Corp 📍 Austin, TX'))).toBe('Revenue Operations Analyst');
    expect(jobTitle(item('Job: Vendor Manager\nLocation: Remote, US'))).toBe('Vendor Manager');
  });

  it('keeps "and" inside one title, but not between two complete roles', () => {
    expect(jobTitle(item('Position: Vertical Sales Strategy and Operations'))).toBe('Vertical Sales Strategy and Operations');
    expect(jobTitle(item('We are hiring a Sales Manager and Recruiter for our Austin office'))).toBe('Sales Manager');
  });

  it('keeps a spaced dash inside an explicitly labeled title', () => {
    expect(jobTitle(item('Position: Airframe Vendor Maintenance - Program Manager\nCompany: Example Air'))).toBe(
      'Airframe Vendor Maintenance - Program Manager',
    );
    // Unlabeled running text still stops at the dash.
    expect(jobTitle(item('We are hiring a Program Manager - Austin, TX'))).toBe('Program Manager');
  });

  it('decodes "&amp;" artifacts of the source text', () => {
    expect(jobTitle(item('🚨 NO H1B – HIRING: Technical Business Analyst / ITSM amp; Vendor Management Lead ❌ 🚨'))).toBe(
      'Technical Business Analyst / ITSM & Vendor Management Lead',
    );
  });

  it('reads job alerts: "New … Job: <title> at <Company>"', () => {
    const alert = item('New FDE Job: Vertical Sales Strategy and Operations at ElevenLabs — United States: details follow', {
      author: { ...(sampleItem(3).author as object), type: 'company', name: 'FDE Engineers', linkedinUrl: 'https://www.linkedin.com/company/fde-engineers/' },
    });
    expect(jobTitle(alert)).toBe('Vertical Sales Strategy and Operations');
    // The employer the alert names beats the alert account that posted it.
    expect(jobCompany(alert)).toEqual({ name: 'ElevenLabs', linkedinUrl: null });
  });

  it('leaves the title empty for a digest of several jobs (two or more hiring headers)', () => {
    const digest = item('#NOWHIRING: Business Ops & Strategy PM\nDetails…\n---\nHIRING: Founding GTM Engineer\nDetails…\n---\nHIRING: Founding Product Engineer');
    expect(jobTitle(digest)).toBeNull();
    // One header plus its own labeled title is not a digest.
    expect(jobTitle(item('HIRING: Revenue Operations Manager\nRole: Revenue Operations Manager'))).toBe('Revenue Operations Manager');
  });

  it('takes the employer from "Company:" / "Employer:" lines before tags and the posting company', () => {
    const agencyPost = item('Defense Unicorns is hiring!\n💼 Role: Mission Associate\n🏢 Company: Defense Unicorns\n📍 Location: Remote', {
      author: { ...(sampleItem(3).author as object), type: 'company', name: 'Chakrie', linkedinUrl: 'https://www.linkedin.com/company/chakrie/' },
    });
    expect(jobCompany(agencyPost)).toEqual({ name: 'Defense Unicorns', linkedinUrl: null });
    expect(jobCompany(item('Hiring!\n🏢 Employer: Cincinnatus LLC 🤖 Opportunity shared via a marketplace'))).toEqual({ name: 'Cincinnatus LLC', linkedinUrl: null });
    // A labeled name keeps the LinkedIn page of a tagged company with that exact name.
    expect(jobCompany(item('Company: Acme Corp', { contentAttributes: [companyTag('Acme Corp', 'acme-corp')] }))).toEqual({
      name: 'Acme Corp',
      linkedinUrl: 'https://www.linkedin.com/company/acme-corp/',
    });
  });

  it('never stores placeholders, descriptions or markdown as the employer', () => {
    for (const label of ['Confidential', 'Well Reputed Organization', 'IT Sector', 'Leading Fintech Company', 'Our Client', 'Dallas Jobs']) {
      expect(jobCompany(item(`Hiring a Sales Ops Analyst\nCompany: ${label}`)).name).toBeNull();
    }
    expect(jobCompany(item('Company: **HDB Financial Services Ltd**')).name).toBe('HDB Financial Services Ltd');
  });

  it('reads the work mode from labeled lines, even when the label itself says "Remote"', () => {
    expect(workMode(item('Position: Program Manager\n📍Remote Option: Hybrid\n#Hybrid'))).toBe('hybrid');
    expect(workMode(item('Work Mode: Onsite – Mossville, IL'))).toBe('onsite');
    expect(workMode(item('Work Arrangement: In-Office'))).toBe('onsite');
    // Labels that disagree say nothing; the rest of the text is then read as before.
    expect(workMode(item('Work Mode: Remote\nWorkplace type: Hybrid'))).toBe('unknown');
  });

  it('records where the title came from', async () => {
    const fromCard = await normalizePost(item('We are hiring', { job: jobCard() }), CONTEXT);
    expect([fromCard.job_title, fromCard.job_title_source]).toEqual(['Director, Revenue Operations', 'job_card']);
    const fromListing = await normalizePost(item('Apply below', { article: listing('Sales Operations Analyst | Acme Careers') }), CONTEXT);
    expect([fromListing.job_title, fromListing.job_title_source]).toEqual(['Sales Operations Analyst', 'listing']);
    const fromText = await normalizePost(item("We're hiring a Vendor Manager to run our supplier programs"), CONTEXT);
    expect([fromText.job_title, fromText.job_title_source]).toEqual(['Vendor Manager', 'text']);
    const none = await normalizePost(item('Great article about operations'), CONTEXT);
    expect([none.job_title, none.job_title_source]).toEqual([null, null]);
  });
});
