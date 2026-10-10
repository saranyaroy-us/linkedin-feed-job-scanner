/**
 * Links to a post's job. Nothing is fetched or expanded, and no id is guessed.
 *
 * linkedin_job_url — the LinkedIn Jobs listing, canonicalized to
 * https://www.linkedin.com/jobs/view/<JOB_ID>/. Sources, in order: the job
 * card's `linkedinUrl`, the attached article's link, the first LinkedIn Jobs
 * URL in the post text. Only linkedin.com/jobs URLs with a numeric job id count.
 *
 * external_apply_url — an application link outside LinkedIn (applicant-tracking
 * system, career page, job board). Sources, in order: the attached article's
 * link, the first job link in the post text, then — only when the post has no
 * other application link, LinkedIn's included — an lnkd.in short link that the
 * text introduces with "apply" ("Apply here: https://lnkd.in/…"), kept as is.
 */

type Obj = Record<string, unknown>;

const asObject = (value: unknown): Obj | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null;

/** linkedin.com or a subdomain such as www. or uk. — never a look-alike host. */
const LINKEDIN_HOST = /(?:^|\.)linkedin\.com$/i;
/** /jobs/view/<id>/ or /jobs/view/<title-slug>-<id>/ */
const VIEW_PATH = /^\/jobs\/view\/(?:[^/]*-)?(\d{6,20})\/?$/i;
const JOB_ID = /^\d{6,20}$/;

/**
 * URLs in free text: http(s) links, plus LinkedIn Jobs and lnkd.in links
 * written without a scheme — never part of a longer word or host name.
 */
const TEXT_URL =
  /(?<![\w.@/-])(?:https?:\/\/[^\s<>"'()[\]{}]+|(?:[a-z0-9-]+\.)*linkedin\.com\/jobs\/[^\s<>"'()[\]{}]+|lnkd\.in\/[^\s<>"'()[\]{}]+)/gi;
/** Sentence punctuation and markdown that often follows a URL in a post. */
const TRAILING = /[.,;:!?*'"’”…]+$/;

/** Applicant-tracking systems and job boards (a page on them is a job page). */
const JOB_BOARD_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'smartrecruiters.com',
  'icims.com', 'jobvite.com', 'bamboohr.com', 'workable.com', 'breezy.hr', 'teamtailor.com', 'recruitee.com',
  'personio.de', 'personio.com', 'applytojob.com', 'jazzhr.com', 'ats.rippling.com', 'paylocity.com', 'ultipro.com',
  'taleo.net', 'successfactors.com', 'successfactors.eu', 'workforcenow.adp.com', 'pinpointhq.com', 'wellfound.com',
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'dice.com', 'builtin.com', 'monster.com', 'simplyhired.com',
];
/** Host labels of job sites: jobs.example.com, careers.example.com, apply.workable.com, job-boards.… */
const JOB_HOST_LABELS = new Set(['job', 'jobs', 'career', 'careers', 'apply', 'recruiting', 'hiring']);
/** Whole path segments of job pages: example.com/careers/…, /jobs/123, /apply/… */
const JOB_PATH_SEGMENTS = new Set([
  'job', 'jobs', 'career', 'careers', 'karriere', 'apply', 'application', 'applications', 'vacancy', 'vacancies',
  'opening', 'openings', 'position', 'positions', 'posting', 'postings', 'requisition', 'requisitions', 'recruiting',
  'recruitment', 'hiring', 'join-us', 'joinus', 'work-with-us',
]);

/** "apply" just before a short link: "Apply here 👉", "Link to apply:", "Application link -". */
const APPLY_CONTEXT = /\bappl(?:y|ying|ication)\b/i;
const APPLY_CONTEXT_CHARS = 60;

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(TRAILING, '');
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const isLinkedin = (url: URL) => LINKEDIN_HOST.test(url.hostname);
const isShortLink = (url: URL) => url.hostname.toLowerCase() === 'lnkd.in';

/** The canonical Jobs URL for a LinkedIn Jobs listing link, or null for anything else. */
export function canonicalLinkedinJobUrl(value: unknown): string | null {
  const url = parseUrl(value);
  if (!url || !isLinkedin(url)) return null;
  // Query strings (trackingId, refId…) and fragments are dropped; only the job id is kept.
  const fromPath = url.pathname.match(VIEW_PATH)?.[1];
  const fromQuery = url.pathname.startsWith('/jobs/') ? url.searchParams.get('currentJobId') : null;
  const id = fromPath ?? (fromQuery && JOB_ID.test(fromQuery) ? fromQuery : null);
  return id ? `https://www.linkedin.com/jobs/view/${id}/` : null;
}

/** A page of an applicant-tracking system, job board or career site — never a site's home page. */
function isJobPage(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.toLowerCase().split('/').filter(Boolean);
  if (segments.length === 0 && url.search.length <= 1) return false;
  if (JOB_BOARD_HOSTS.some((board) => host === board || host.endsWith(`.${board}`))) return true;
  if (host.split(/[.-]/).some((label) => JOB_HOST_LABELS.has(label))) return true;
  return segments.some((segment) => JOB_PATH_SEGMENTS.has(segment));
}

/** True for a link to a job listing or application, on LinkedIn Jobs or elsewhere. */
export function isJobListingUrl(value: unknown): boolean {
  const url = parseUrl(value);
  if (!url) return false;
  if (isLinkedin(url)) return canonicalLinkedinJobUrl(url.href) !== null;
  return !isShortLink(url) && isJobPage(url);
}

/** The link itself (trimmed) when it is a job page outside LinkedIn; null otherwise. */
function externalJobUrl(value: unknown): string | null {
  const url = parseUrl(value);
  return url && !isLinkedin(url) && !isShortLink(url) && isJobPage(url) ? url.href : null;
}

/** URLs in the post text, in order, each with the text before it on its line. */
function textUrls(item: Obj): { url: string; before: string }[] {
  if (typeof item.content !== 'string') return [];
  const content = item.content;
  return [...content.matchAll(TEXT_URL)].map((match) => {
    const line = content.slice(Math.max(0, match.index - APPLY_CONTEXT_CHARS), match.index);
    return { url: match[0], before: line.slice(line.lastIndexOf('\n') + 1) };
  });
}

export function linkedinJobUrl(item: Obj): string | null {
  const fromJob = canonicalLinkedinJobUrl(asObject(item.job)?.linkedinUrl);
  if (fromJob) return fromJob;
  const fromArticle = canonicalLinkedinJobUrl(asObject(item.article)?.link);
  if (fromArticle) return fromArticle;
  for (const { url } of textUrls(item)) {
    const canonical = canonicalLinkedinJobUrl(url);
    if (canonical) return canonical;
  }
  return null;
}

/** `linkedinJob` is the post's linkedin_job_url: with one, an lnkd.in link is not the only way to apply. */
export function externalApplyUrl(item: Obj, linkedinJob: string | null): string | null {
  const fromArticle = externalJobUrl(asObject(item.article)?.link);
  if (fromArticle) return fromArticle;
  const urls = textUrls(item);
  for (const { url } of urls) {
    const external = externalJobUrl(url);
    if (external) return external;
  }
  if (linkedinJob) return null;
  for (const { url, before } of urls) {
    const short = parseUrl(url);
    if (short && isShortLink(short) && short.pathname.length > 1 && APPLY_CONTEXT.test(before)) return short.href;
  }
  return null;
}
