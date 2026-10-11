import { describe, expect, it } from 'vitest';
import { classifyJobRelevance, type ClassifiablePost } from '../../src/classification/job-relevance';

/** A normalized post with this text and no job card, listing or links (synthetic text, never real posts). */
const post = (text: string, extra: Partial<ClassifiablePost> = {}): ClassifiablePost => ({
  text,
  job_title: null,
  job_title_source: null,
  article_title: null,
  article_url: null,
  linkedin_job_url: null,
  external_apply_url: null,
  ...extra,
});
const card = (title: string, text = "We're #hiring a new role. Apply today or share this post with your network.") =>
  post(text, { job_title: title, job_title_source: 'job_card', linkedin_job_url: 'https://www.linkedin.com/jobs/view/4400000001/' });
const label = (p: ClassifiablePost) => {
  const c = classifyJobRelevance(p);
  return [c.relevance, c.persona];
};

describe('classifyJobRelevance — relevant openings', () => {
  it('labels a target-function role title from the job card, a listing or the text as relevant, with its persona', () => {
    expect(label(card('Senior Vice President Sales Operations'))).toEqual(['relevant', 'sales_operations']);
    expect(label(card('Director, Revenue Operations'))).toEqual(['relevant', 'revenue_operations']);
    expect(
      label(post('Apply below', { job_title: 'Vendor Manager', job_title_source: 'listing', article_title: 'Vendor Manager | Acme Careers', article_url: 'https://jobs.lever.co/acme/1' })),
    ).toEqual(['relevant', 'vendor_manager']);
    expect(label(post('#hiring Revenue Operations Specialist Apply here: https://example.com/job\nLocation: Tampa, FL'))).toEqual(['relevant', 'revenue_operations']);
    expect(label(post("We're hiring a RevOps Lead to own our forecast. Apply now."))).toEqual(['relevant', 'revenue_operations']);
  });

  it('recognizes variations and seniority: Sales Ops, Sales Strategy and Operations, Vendor Management Lead', () => {
    expect(label(post('HIRING: Sales Ops Analyst\nApply here: https://example.com'))).toEqual(['relevant', 'sales_operations']);
    expect(label(post('💼 Position: Vertical Sales Strategy and Operations\n🏢 Company: Example Labs\nApply here: https://example.com'))).toEqual([
      'relevant',
      'sales_operations',
    ]);
    expect(label(post('🚨 HIRING: Technical Business Analyst / ITSM amp; Vendor Management Lead ❌\nLocation: Mossville, IL – Onsite'))).toEqual([
      'relevant',
      'vendor_manager',
    ]);
  });

  it('keeps the exact evidence (the role title) and where it came from', () => {
    const c = classifyJobRelevance(card('Senior Vice President Sales Operations'));
    expect(c).toMatchObject({
      relevance: 'relevant',
      hiring_intent: 'strong',
      role_title: 'Senior Vice President Sales Operations',
      title_source: 'job_card',
      evidence_text: 'Senior Vice President Sales Operations',
      reason: 'Role title is Sales Operations',
    });
  });
});

describe('classifyJobRelevance — supporting technical roles need review', () => {
  const SALESFORCE_ADMIN =
    "Our team is hiring! We're looking for a Salesforce Administrator to join our Sales Operations team. If you love building Flows, this role is for you.";

  it('labels a Salesforce Administrator on a Sales Operations team as needs_review', () => {
    const c = classifyJobRelevance(card('Salesforce Administrator', SALESFORCE_ADMIN));
    expect(c).toMatchObject({ relevance: 'needs_review', persona: 'sales_operations', evidence_text: 'join our Sales Operations team' });
  });

  it('labels technical roles that name the function in the title as needs_review too', () => {
    expect(label(card('Sales Operations Salesforce Administrator'))).toEqual(['needs_review', 'sales_operations']);
    expect(label(card('Revenue Operations Systems Analyst'))).toEqual(['needs_review', 'revenue_operations']);
  });

  it('upgrades a supporting role to relevant only when the post lists three or more of the function’s duties', () => {
    const duties = `${SALESFORCE_ADMIN} You will own forecasting, territory design, quota setting and the deal desk.`;
    expect(label(card('Salesforce Administrator', duties))).toEqual(['relevant', 'sales_operations']);
    expect(label(card('Salesforce Administrator', `${SALESFORCE_ADMIN} You will support forecasting.`))).toEqual(['needs_review', 'sales_operations']);
  });

  it('labels an operations role on a named target team as relevant', () => {
    expect(label(card('Senior Analyst', "We're hiring a Senior Analyst to join our Revenue Operations team."))).toEqual(['relevant', 'revenue_operations']);
  });

  it('labels expert or advisor gigs that name the function as needs_review', () => {
    expect(label(post('📢 WE’RE HIRING: Business & Sales Operations Domain Expert | $60–$100 per hour\nLocation: Bay Area, California'))).toEqual([
      'needs_review',
      'sales_operations',
    ]);
  });
});

describe('classifyJobRelevance — adjacent, unrelated and non-job posts', () => {
  it('labels adjacent titles (vendor, procurement, business operations) as needs_review without a persona', () => {
    expect(label(post('💼 Position: Airframe Vendor Maintenance - Program Manager\n🏢 Company: Example Air\nApply here: https://example.com'))).toEqual([
      'needs_review',
      'none',
    ]);
    expect(label(card('Procurement Manager'))).toEqual(['needs_review', 'none']);
    expect(label(post('#NOWHIRING: Business Ops & Strategy PM\n---\nHIRING: Founding GTM Engineer\n---\nHIRING: Founding Product Engineer'))).toEqual([
      'needs_review',
      'none',
    ]);
  });

  it('never makes a post relevant because the function is only a duty or skill', () => {
    const text = "We're hiring a Sr. Controls Engineer. • 9+ years of general project or vendor management experience. Apply here: https://example.com";
    expect(label(post(text))).toEqual(['unrelated', 'none']);
    expect(label(post('#hiring Radiation Oncology Medical Physics Manager Apply here\nDuties: budgeting and vendor management for physics.'))).toEqual([
      'unrelated',
      'none',
    ]);
  });

  it('treats combined "Sales & Operations" jobs, revenue-cycle and billing roles as unrelated', () => {
    expect(label(card('Sales & Operations Manager'))).toEqual(['unrelated', 'none']);
    expect(label(post('#hiring Sales and Operations Management Trainee Apply here\nPosition Title: Sales and Operations Management Trainee'))).toEqual([
      'unrelated',
      'none',
    ]);
    expect(label(card('Vice President of Revenue Cycle Management'))).toEqual(['unrelated', 'none']);
    expect(label(card('Billing Revenue & Operations Project Manager'))).toEqual(['unrelated', 'none']);
  });

  it('ignores the function when it only describes a manager or the employer', () => {
    expect(label(post('Example Co is hiring!\n💼 Role: Mission Associate\nReports to: Director of Revenue Operations\nApply by: 30 Oct'))).toEqual([
      'unrelated',
      'none',
    ]);
  });

  it('labels commentary, staffing promotion and talent outreach as not_a_job', () => {
    expect(
      label(post('How you can save 70% cost on an employee. Hiring full-time employees in the US can be expensive. Outsourcing helps with sales operations.')),
    ).toEqual(['not_a_job', 'none']);
    expect(
      label(post('Roles we place: revenue operations leads and billing analysts. US-based. Send us your resume before we have the requisition. #Hiring')),
    ).toEqual(['not_a_job', 'none']);
    expect(label(post('SEEKING LEADERS: we are connecting with experienced Supply Chain and Procurement professionals for senior opportunities. #Hiring'))).toEqual([
      'not_a_job',
      'none',
    ]);
    expect(label(post('Five lessons from a decade in Revenue Operations.'))).toEqual(['not_a_job', 'none']);
  });

  it('flags a target function named right at the hiring statement, without a title, for review', () => {
    const c = classifyJobRelevance(post('#hiring RevOps folks for a seed-stage startup, DM me'));
    expect(c).toMatchObject({ relevance: 'needs_review', persona: 'revenue_operations', evidence_text: 'RevOps' });
  });

  it('keeps evidence short and never returns the post text', () => {
    const long = `HIRING: Revenue Operations Manager\n${'Responsibilities include many things. '.repeat(40)}`;
    const c = classifyJobRelevance(post(long));
    expect(c.evidence_text).toBe('Revenue Operations Manager');
    for (const p of [post(long), post('Roles we place: things. Send us your resume before we have the requisition.')]) {
      expect((classifyJobRelevance(p).evidence_text ?? '').length).toBeLessThanOrEqual(160);
    }
  });
});
