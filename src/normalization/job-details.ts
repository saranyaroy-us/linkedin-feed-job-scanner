import type { WorkMode } from '../domain/raw-post';
import { isJobListingUrl } from './job-links';

/**
 * Job details of a post, each from the most structured source that has it.
 * Nothing is guessed: unknown values stay null (work_mode "unknown").
 *
 * job_title: the job card's title; else the title of an attached job listing
 *   (an article linking to a job page); else an explicit title in the post
 *   text ("We're hiring a Sales Operations Manager", "Role: Vendor Manager").
 *   Listing and text titles must read as one role: they end in a role word
 *   (Manager, Analyst, Lead…) or start with one ("Head of …", "Director, …").
 * company_name / company_linkedin_url: the job card's "Job by <Company>"; else
 *   the one company tagged in the post; else the company that posted it; else
 *   the employer named in a job listing's title ("… at Acme", "… | Acme Careers").
 *   Job boards and recruiters ("Dallas Jobs", "… Staffing") are skipped, except
 *   on the job card. The URL is the company's LinkedIn page when the post links
 *   it. People mentioned in the post and the author's headline are never read.
 * work_mode: remote, hybrid or onsite when the job card, a job listing or the
 *   post text says so unambiguously; otherwise unknown.
 */

type Obj = Record<string, unknown>;

const asObject = (value: unknown): Obj | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null;

/** Unicode-folded (styled letters → plain), single-spaced, trimmed text; null when empty. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text || null;
}

/* ---------- Job title ---------- */

const ROLE_WORDS = new Set([
  'manager', 'analyst', 'director', 'lead', 'leader', 'head', 'specialist', 'coordinator', 'associate', 'administrator',
  'admin', 'partner', 'consultant', 'engineer', 'architect', 'executive', 'representative', 'rep', 'officer', 'strategist',
  'supervisor', 'owner', 'generalist', 'planner', 'scientist', 'developer', 'designer', 'recruiter', 'sourcer',
  'accountant', 'controller', 'intern', 'assistant', 'advisor', 'adviser', 'president', 'vp', 'svp', 'evp', 'avp',
  'principal', 'sdr', 'bdr', 'expert', 'agent', 'buyer', 'trainee', 'apprentice', 'operator', 'technician', 'auditor',
  'programmer', 'writer', 'editor', 'producer', 'marketer', 'cro', 'coo', 'cfo', 'ceo', 'cmo', 'cto', 'gm', 'liaison',
  'merchandiser', 'estimator', 'clerk', 'secretary', 'counsel', 'attorney', 'paralegal', 'economist', 'trainer', 'pm',
  'tpm',
]);
/** "Head of Revenue Operations", "Director, Sales Operations", "VP of RevOps"… */
const LEADING_ROLE =
  /^(?:(?:senior|sr\.?|junior|jr\.?|associate|assistant|deputy|interim|acting|global|regional|group|executive)\s+)*(?:head|director|vp|svp|evp|avp|vice president|president|manager|chief|lead|gm|general manager)\s*(?:of\b|,|[-–—]\s|for\b)\s*\S/i;
/** A title that names several jobs, or a listing page rather than one job. */
const LISTING_WORDS = /\b(?:jobs|careers|vacancies|openings|opportunities|positions|roles|hiring)\b/i;
/** Words that cannot be part of a role title found in running text. */
const SENTENCE_WORDS = new Set([
  'we', 'i', 'you', 'our', 'my', 'your', 'us', 'me', 'is', 'are', 'am', 'be', 'was', 'were', 'will', 'join', 'looking',
  'seeking', 'need', 'needs', 'want', 'help', 'can', 'this', 'that', 'these', 'those', 'here', 'there', 'please', 'dm',
  'apply', 'hiring',
]);
const isRoleWord = (word: string) => ROLE_WORDS.has(word) || (word.endsWith('s') && ROLE_WORDS.has(word.slice(0, -1)));
/** A title after an explicit label ("Position: Vertical Sales Strategy and Operations") may end in the function itself. */
const FUNCTION_WORDS = new Set(['operations', 'ops', 'strategy', 'management', 'enablement', 'planning', 'procurement', 'sourcing']);

/** One role: ends in a role word (before any ", …" or "(…)" detail and a level such as "II"), or starts with one. */
function isJobTitle(title: string, minWords: number, labeled = false): boolean {
  if (title.length < 3 || title.length > 100 || /:\/\/|www\.|@/.test(title) || LISTING_WORDS.test(title)) return false;
  const words = title.split(' ');
  if (words.length < minWords || words.length > 12) return false;
  const head = title
    .replace(/\s*[([].*$/, '')
    .split(',')[0]!
    .trim()
    .replace(/\s+(?:i{1,3}|iv|v|[1-5])$/i, '');
  const last = (head.split(' ').at(-1) ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '');
  return isRoleWord(last) || LEADING_ROLE.test(title) || (labeled && FUNCTION_WORDS.has(last));
}

/** Title (and employer) of a job listing's page title, e.g. "RevOps Analyst | Acme Careers", "… at Acme". */
function parseListingTitle(value: unknown): { title: string | null; company: string | null } {
  let text = clean(value);
  if (!text || /^https?:\/\//i.test(text)) return { title: null, company: null };
  text = text.replace(/(?:\s+#[\p{L}\p{N}_]+)+$/u, '');
  const [first = '', second] = text.split(/\s+[|•]\s+/);
  let company = second?.match(/^(.+?)\s*[-–—]?\s*careers?$/i)?.[1] ?? null;
  text = first.replace(/^job application for\s+/i, '').replace(/\s+jobs?\s+in\s+.*$/i, '');
  const at = text.match(/^(.+)\s+at\s+(.+)$/i);
  if (at) {
    text = at[1]!;
    company ??= at[2]!;
  }
  const beforeDash = text.split(/\s+[-–—]\s+/)[0]!;
  const title = [beforeDash, text].find((candidate) => isJobTitle(candidate, 1)) ?? null;
  return { title, company: title ? clean(company) : null };
}

/** Stop words after which a title found in running text cannot continue. */
const TITLE_STOP_WORDS = String.raw`\s(?:in|at|for|to|with|who|that|which|based|located|on|from|join|joining|needed|wanted|required|is|are|will|you|we|our|your|this|position|role|opportunity|job|opening|here|now|asap|today|apply)\b`;
const TITLE_STOP_MARKS = String.raw`[,;:!?()[\]|•…*_"“”#@\p{Extended_Pictographic}\p{So}]|(?<!\b(?:sr|jr|mgr|st))\.(?:\s|$)`;
/** Where a title may stop in running text (punctuation, emoji, a dash, a preposition or verb…). */
const TITLE_END = new RegExp(String.raw`\s*(?:${TITLE_STOP_MARKS}|\s[-–—]\s|[–—]|${TITLE_STOP_WORDS})`, 'iu');
/** After an explicit label a spaced dash may be part of the title ("Airframe Vendor Maintenance - Program Manager"). */
const LABELED_TITLE_END = new RegExp(String.raw`\s*(?:${TITLE_STOP_MARKS}|[–—]|${TITLE_STOP_WORDS})`, 'iu');
/** "and"/"or" end a lowercase title; in a capitalized one the run of capitals already stops there. */
const LOWERCASE_TITLE_END = /\s(?:and|or)\b/i;
const LEADING_FILLER =
  /^(?:(?:for|a|an|another|the|our|my|their|its|now|urgently|immediately|actively|currently|again|multiple|several|two|three|four|five|new|next|role of|position of|of)\b[\s:\-–—]*)+/i;
/** "Role: …", "Job title - …", "Position Title: …", "Job: …" at the start of a line (after any emoji). */
const LABELED_TITLE =
  /(?:^|[\n|•])[^\p{L}\n]*(?:job\s+title|position\s+title|position|role|title|job|opening|vacancy)\s*[*_]*\s*[:\-–—]\s*([^\n|•]+)/giu;
/** Job-alert posts: "New FDE Job: <title> at <Company> — …". */
const NEW_JOB = /\bnew\b[^\n:]{0,30}?\bjob\s*:\s*([^\n]+?)\s+at\s+([^\n—–|•·:()]+)/iu;
/** "hiring", then the title on the same line ("We're hiring a …", "Hiring: …", "Now hiring! …", "#NOWHIRING: …"). */
const HIRING_TITLE = /\b(?:now)?hiring\b[!:\-–—| \t*_]*([^\n]+)/giu;
/** A header line that announces a job: "HIRING: …", "#NOWHIRING: …", "We're hiring! …". */
const HIRING_HEADER = /hiring\s*[:!\-–—]/i;

const cutAt = (text: string, end: RegExp) => {
  const index = text.search(end);
  return (index === -1 ? text : text.slice(0, index)).trim();
};
const CONNECTOR = /^(?:of|&|\/|-)$/;

/**
 * A role title at the start of `text`: the run of capitalized words (after up
 * to three lowercase ones, as in "experienced HR Manager"), else the lowercase
 * phrase up to a stop word. Inside the run "and" joins two capitalized words
 * only while the words before it are not yet a whole title ("Sales and
 * Operations Trainee", but not "Sales Manager and Recruiter"). An explicitly
 * labeled title may keep a spaced dash and end in the function itself.
 */
function titleAt(text: string, labeled = false): string | null {
  const rest = text.replace(/^[\s*_]+/, '').replace(LEADING_FILLER, '');
  if (!rest || rest.startsWith('#')) return null;
  const phrases = labeled ? [cutAt(rest, LABELED_TITLE_END), cutAt(rest, TITLE_END)] : [cutAt(rest, TITLE_END)];
  const isCapital = (word: string) => /^[\p{Lu}\p{N}]/u.test(word);
  for (const phrase of [...new Set(phrases)]) {
    const words = phrase.split(/\s+/);
    const first = words.findIndex(isCapital);
    const capitalized: string[] = [];
    const run = first >= 0 && first <= 3 ? words.slice(first) : [];
    for (const [i, word] of run.entries()) {
      const joinsAnd = word.toLowerCase() === 'and' && isCapital(run[i + 1] ?? '') && !isJobTitle(capitalized.join(' '), 1);
      if (isCapital(word) || (capitalized.length > 0 && (CONNECTOR.test(word) || joinsAnd))) capitalized.push(word);
      else break;
    }
    while (capitalized.length && (CONNECTOR.test(capitalized.at(-1)!) || capitalized.at(-1)!.toLowerCase() === 'and')) capitalized.pop();
    for (const candidate of [capitalized.join(' '), cutAt(phrase, LOWERCASE_TITLE_END)]) {
      const title = candidate.replace(/[*_]+/g, '').trim();
      const lower = title.toLowerCase().split(' ');
      if (isJobTitle(title, 2, labeled) && !lower.some((word) => SENTENCE_WORDS.has(word))) return title;
    }
  }
  return null;
}

/** Post text as matched for job details: styled letters folded, "&amp;" artifacts of the source decoded. */
const detailText = (content: string) => content.normalize('NFKC').replace(/&amp;/g, '&').replace(/(^|\s)amp;(?=\s)/g, '$1&');

export interface TitleCandidate {
  title: string;
  /** "labeled": after "Position:", "Role:"…; "header": after "hiring". */
  kind: 'labeled' | 'header';
  /** Line of the post text it was found on (0-based). */
  line: number;
}

/** Every role title stated in the post text, labeled ones first, without repeats. */
export function titleCandidates(content: string): TitleCandidate[] {
  const text = detailText(content);
  const lineOf = (index: number) => text.slice(0, index).split('\n').length - 1;
  const found: TitleCandidate[] = [];
  const add = (raw: string, kind: TitleCandidate['kind'], index: number) => {
    const title = titleAt(raw, kind === 'labeled');
    if (title && !found.some((c) => c.title.toLowerCase() === title.toLowerCase())) found.push({ title, kind, line: lineOf(index) });
  };
  for (const match of text.matchAll(LABELED_TITLE)) add(match[1]!, 'labeled', match.index);
  const alert = NEW_JOB.exec(text);
  if (alert) add(alert[1]!, 'labeled', alert.index);
  for (const match of text.matchAll(HIRING_TITLE)) add(match[1]!, 'header', match.index);
  return found;
}

/**
 * The post text's title, or null when there is none or when it is a digest of
 * several jobs (two or more hiring headers naming different titles).
 */
function titleFromText(content: string): string | null {
  const candidates = titleCandidates(content);
  if (!candidates.length) return null;
  const lines = detailText(content).split('\n');
  const headerLines = new Set(candidates.filter((c) => c.kind === 'header' && HIRING_HEADER.test(lines[c.line] ?? '')).map((c) => c.line));
  if (headerLines.size > 1) return null;
  return candidates[0]!.title;
}

/** The attached article when it links to a job listing (on LinkedIn Jobs or elsewhere). */
function jobListing(item: Obj): Obj | null {
  const article = asObject(item.article);
  return article && isJobListingUrl(article.link) ? article : null;
}

export type JobTitleSource = 'job_card' | 'listing' | 'text';

/** The job title and where it came from: the job card, an attached job listing, or the post text. */
export function jobTitleWithSource(item: Obj): { title: string | null; source: JobTitleSource | null } {
  const fromCard = clean(asObject(item.job)?.title);
  if (fromCard) return { title: fromCard, source: 'job_card' };
  const fromListing = parseListingTitle(jobListing(item)?.title).title;
  if (fromListing) return { title: fromListing, source: 'listing' };
  const fromText = typeof item.content === 'string' ? titleFromText(item.content) : null;
  return fromText ? { title: fromText, source: 'text' } : { title: null, source: null };
}

export function jobTitle(item: Obj): string | null {
  return jobTitleWithSource(item).title;
}

/* ---------- Company ---------- */

export interface JobCompany {
  name: string | null;
  linkedinUrl: string | null;
}

/** https://www.linkedin.com/company/<slug>/ (or /showcase/<slug>/) for a LinkedIn company page link, else null. */
export function canonicalCompanyUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || !/(?:^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const page = url.pathname.match(/^\/(company|showcase)\/([^/]+)/i);
    return page ? `https://www.linkedin.com/${page[1]!.toLowerCase()}/${page[2]}/` : null;
  } catch {
    return null;
  }
}

/**
 * Job boards and recruiters ("Dallas Jobs", "Get9to5Jobs.com", "Acme Careers",
 * "… Staffing", "… Talent") post and tag jobs of other employers, so they are never the company.
 */
const JOB_BOARD_NAME = /jobs?\b|careers?\b|hiring|hire\b|vacanc|recruit|staffing|placement|\btalent\b|\broles\b/i;
const isEmployerName = (name: string | null): name is string => !!name && !JOB_BOARD_NAME.test(name);

/** Companies tagged in the post (LinkedIn company pages only, not schools), without repeats. */
function taggedCompanies(contentAttributes: unknown): { name: string; linkedinUrl: string }[] {
  if (!Array.isArray(contentAttributes)) return [];
  const companies = new Map<string, { name: string; linkedinUrl: string }>();
  for (const attribute of contentAttributes) {
    const company = asObject(asObject(attribute)?.company);
    const name = clean(company?.name);
    const linkedinUrl = canonicalCompanyUrl(company?.linkedinUrl);
    if (isEmployerName(name) && linkedinUrl && !companies.has(linkedinUrl)) companies.set(linkedinUrl, { name, linkedinUrl });
  }
  return [...companies.values()];
}

const NO_COMPANY: JobCompany = { name: null, linkedinUrl: null };

/** "Company: …", "Employer: …", "Hiring company: …" at the start of a line (after any emoji). */
const LABELED_COMPANY = /(?:^|[\n|•])[^\p{L}\n]*(?:hiring\s+company|company|employer|organi[sz]ation)\s*[*_]*\s*:\s*([^\n|•]+)/giu;
const COMPANY_END = /\s*(?:[|•·;!?()[\]"“”#@\p{Extended_Pictographic}\p{So}]|\s[-–—]\s|[–—]|\s{2,})/u;
/** Placeholders and descriptions that name no employer ("Confidential", "Well Reputed Organization", "IT Sector"). */
const NOT_A_COMPANY = [
  /^(?:confidential|undisclosed|stealth(?:\s+startup)?|n\/?a|tbd|tba|various|multiple|our\s+client|a\s+client|client)$/i,
  /\b(?:reputed|reputable|leading|well[\s-]?known|renowned|prestigious|mnc|confidential|undisclosed)\b/i,
  /^(?:[\p{L}&]+\s+)?(?:sector|industry|organi[sz]ation|company|firm|startup|client)$/iu,
];

/** The employer the post names explicitly: a "Company:" line or a job alert's "… Job: <title> at <Company>". */
function namedEmployer(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const text = detailText(content);
  const names = [...text.matchAll(LABELED_COMPANY)].map((m) => m[1]!);
  const alert = NEW_JOB.exec(text);
  if (alert) names.push(alert[2]!);
  for (const raw of names) {
    const name = clean(cutAt(raw.replace(/^[\s*_]+/, ''), COMPANY_END).replace(/[\s*_.,:]+$/, ''));
    if (isEmployerName(name) && !NOT_A_COMPANY.some((re) => re.test(name)) && name.length <= 80 && name.split(' ').length <= 8) {
      return name;
    }
  }
  return null;
}

export function jobCompany(item: Obj): JobCompany {
  const tagged = taggedCompanies(item.contentAttributes);
  const author = asObject(item.author);
  const authorName = author?.type === 'company' ? clean(author.name) : null;
  const poster = isEmployerName(authorName) ? { name: authorName, linkedinUrl: canonicalCompanyUrl(author!.linkedinUrl) } : null;
  /** A name from text gets the LinkedIn page of a tagged company or the posting company with that exact name. */
  const named = (name: string): JobCompany => {
    const same = [...tagged, ...(poster ? [poster] : [])].find((c) => c.name.toLowerCase() === name.toLowerCase());
    return { name, linkedinUrl: same?.linkedinUrl ?? null };
  };

  const fromCard = clean(asObject(item.job)?.subtitle)?.match(/^job by\s+(.+)$/i)?.[1];
  if (fromCard) return named(fromCard);
  // An employer the text names outright beats tags and the poster (often a job-alert account or agency).
  const explicit = namedEmployer(item.content);
  if (explicit) return named(explicit);
  if (tagged.length === 1) return tagged[0]!;
  if (poster) return poster;
  const fromListing = parseListingTitle(jobListing(item)?.title).company;
  return isEmployerName(fromListing) ? named(fromListing) : NO_COMPANY;
}

/* ---------- Work mode ---------- */

/** "remote" or "hybrid" about the job, not about teams, cloud set-ups and the like. */
const REMOTE =
  /\b(?:remote(?![\s-]+(?:control|access|monitoring|sensing)\b)(?![\s-]+(?:[a-z&-]+\s+){0,2}(?:teams?|employees|workers|workforce|staff)\b)|wfh|work(?:ing)?[\s-]from[\s-]home)\b/;
const NOT_REMOTE = /\b(?:not|no|non)[\s-]+remote\b/g;
const HYBRID = /\bhybrid\b(?![\s-]+(?:cloud|cars?|vehicles?|approach|solutions?)\b)/;
const ONSITE = /\bon[\s-]?site\b(?![\s-]+interviews?)|\bin[\s-]office\b|\boffice[\s-]based\b/;

/** The mode a text states, or null when it states none or several ("remote or hybrid"). Days in the office fit hybrid. */
function modeIn(text: string | null): Exclude<WorkMode, 'unknown'> | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const remote = REMOTE.test(lower.replace(NOT_REMOTE, ' '));
  const hybrid = HYBRID.test(lower);
  const onsite = ONSITE.test(lower);
  if (hybrid) return remote ? null : 'hybrid';
  if (remote !== onsite) return remote ? 'remote' : 'onsite';
  return null;
}

/** "Remote Option: Hybrid", "Work Mode: Onsite", "Work Arrangement: In-Office": the labeled value is the mode. */
const LABELED_MODE =
  /(?:^|[\n|•])[^\p{L}\n]*(?:remote\s+option|work\s*mode|work\s+model|work\s+arrangement|workplace(?:\s+type)?|work\s+setting|work\s+style)\s*[*_]*\s*[:\-–—]\s*([^\n|•]+)/giu;
const MODE_VALUE_END = /\s*(?:[|•;()[\]"“”#\p{Extended_Pictographic}\p{So}]|\s[-–—]\s|[–—])/u;

/** The one mode the labeled lines of a text state, or null (no label, or labels that disagree). */
function labeledMode(content: unknown): Exclude<WorkMode, 'unknown'> | null {
  if (typeof content !== 'string') return null;
  const modes = new Set([...content.normalize('NFKC').matchAll(LABELED_MODE)].map((m) => modeIn(cutAt(m[1]!, MODE_VALUE_END))));
  modes.delete(null);
  return modes.size === 1 ? [...modes][0]! : null;
}

export function workMode(item: Obj): WorkMode {
  const card = asObject(item.job);
  const listing = jobListing(item);
  const sources = [
    card ? [card.title, card.location].map(clean).filter(Boolean).join('\n') : null,
    listing ? [listing.title, listing.subtitle, listing.description].map(clean).filter(Boolean).join('\n') : null,
  ];
  for (const source of sources) {
    const mode = modeIn(source);
    if (mode) return mode;
  }
  return labeledMode(item.content) ?? modeIn(clean(item.content)) ?? 'unknown';
}
