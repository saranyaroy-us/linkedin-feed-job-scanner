import type { HiringIntent, JobClassification, Persona, RoleTitleSource } from '../domain/classification';
import type { RawPost } from '../domain/raw-post';
import { titleCandidates } from '../normalization/job-details';
import { isJobListingUrl } from '../normalization/job-links';

/**
 * Deterministic job-relevance classifier: is the post an actual opening (hiring
 * intent), and is the advertised ROLE one of the target functions? It reads the
 * normalized post only — never raw JSON, the author, or the search query that
 * found it — and the target function must appear in a role title (or "join our
 * <function> team"); a function named only as a duty or skill ("vendor
 * management experience") never makes a post relevant.
 *
 *   relevant      an opening whose role is Revenue Operations, Sales Operations or Vendor Management
 *   needs_review  an opening that may be one: a supporting technical role in the function (Salesforce
 *                 Administrator on a Sales Operations team), an expert/advisor gig, an adjacent title
 *                 (vendor, procurement, business operations), or a function named only near "hiring"
 *   unrelated     an opening for another role
 *   not_a_job     no vacancy: commentary, advice, talent-pool or staffing promotion
 *
 * Each label keeps the exact phrase it rests on (evidence_text) and a short reason.
 */

export type ClassifiablePost = Pick<
  RawPost,
  'text' | 'job_title' | 'job_title_source' | 'article_title' | 'article_url' | 'linkedin_job_url' | 'external_apply_url'
>;

type TargetPersona = Exclude<Persona, 'none'>;

const PERSONA_LABELS: Record<TargetPersona, string> = {
  revenue_operations: 'Revenue Operations',
  sales_operations: 'Sales Operations',
  vendor_manager: 'Vendor Management',
};

/* ---------- Target functions (matched in role titles) ---------- */

const TARGETS: ReadonlyArray<readonly [TargetPersona, RegExp]> = [
  ['revenue_operations', /\brev(?:enue)?[\s-]*ops\b|\brevenue\s+operations?\b/i],
  [
    'sales_operations',
    /\bsales[\s-]*op(?:eration)?s\b|\bsales\s+(?:strategy|planning)\s*(?:and|&)\s*op(?:eration)?s\b|\b(?:gtm|go[\s-]to[\s-]market)\s+op(?:eration)?s\b/i,
  ],
  [
    'vendor_manager',
    /\bvendor\s+(?:manager|management|relations(?:hip)?s?|governance|performance)\b|\bsupplier\s+(?:manager|management|relationships?)\b|\bthird[\s-]party\s+(?:risk\s+)?manag/i,
  ],
];
/** "Sales & Operations Manager": a combined sales and operations job, not the Sales Operations function. */
const COMBINED_SALES_AND_OPERATIONS = /\bsales\s*(?:&|and)\s*op(?:eration)?s\b/i;
const STRATEGY_AND_OPERATIONS = /\b(?:strategy|planning)\s*(?:and|&)\s*op/i;
/** Supporting technical roles: in the function's orbit, but not the function itself. */
const TECHNICAL_ROLE =
  /\b(?:administrator|admin|developer|engineer|architect|programmer|designer|salesforce|sfdc|hubspot|crm|cpq|systems?|data|analytics|bi|automation|devops|integrations?|database)\b/i;
/** Expert/advisor gigs that name a function without being a job in it. */
const GIG_ROLE = /\b(?:domain\s+expert|subject[\s-]matter\s+expert|sme|consultant|advisor|adviser|tutor|trainer|instructor|annotator|freelancer?)\b/i;
/** Titles next to the target functions, worth a human look. */
const ADJACENT_TITLE = /\bvendors?\b|\bsuppliers?\b|\bprocurement\b|\bbiz\s*ops\b|\bbusiness\s+op(?:eration)?s\b|\bcommercial\s+op(?:eration)?s\b|\brevenue\s+strategy\b/i;
/** Operations roles that, on a named target team, are that function ("an Analyst on our Sales Operations team"). */
const OPERATIONS_ROLE = /\b(?:analyst|manager|specialist|coordinator|lead|strategist|associate|director|head|partner|planner|vp)\b/i;
/** "join our Sales Operations team", "on the RevOps team". */
const TARGET_TEAM =
  /\b(?:join(?:ing)?|on|to|in)\s+(?:our|the|a|my)\s+((?:sales\s+op(?:eration)?s|revenue\s+op(?:eration)?s|rev\s*ops|vendor\s+management|procurement\s+and\s+vendor\s+management))\s+(?:team|function|org(?:anization)?)\b/i;

/** Duties that show a supporting role does the function's work (three distinct ones are required). */
const DUTIES: Record<TargetPersona, readonly RegExp[]> = {
  sales_operations: [
    /\bforecast/i, /\bterritor(?:y|ies)\b/i, /\bquotas?\b/i, /\b(?:sales\s+)?comp(?:ensation)?\s+plans?\b|\bcommissions?\b/i,
    /\bpipeline\s+(?:management|reporting|reviews?|hygiene|analysis)\b/i, /\bdeal\s+desk\b/i, /\bsales\s+(?:planning|process(?:es)?|cadence)\b/i,
  ],
  revenue_operations: [
    /\bforecast/i, /\bpipeline\s+(?:management|reporting|reviews?|hygiene|analysis)\b/i, /\b(?:revenue|funnel|gtm)\s+(?:reporting|metrics|analytics)\b/i,
    /\bterritor(?:y|ies)\b/i, /\bquotas?\b/i, /\bdeal\s+desk\b/i, /\b(?:lead|account)\s+routing\b/i,
  ],
  vendor_manager: [
    /\bvendor\s+(?:onboarding|selection|performance|risk|relationships?)\b/i, /\bslas?\b/i, /\bcontract\s+negotiations?\b/i,
    /\brf[pqi]s?\b/i, /\bscorecards?\b/i, /\b(?:supplier|third[\s-]party)\s+(?:performance|risk)\b/i, /\bprocurement\b/i,
  ],
};

function personaOf(title: string): TargetPersona | null {
  for (const [persona, pattern] of TARGETS) {
    if (!pattern.test(title)) continue;
    if (persona === 'sales_operations' && COMBINED_SALES_AND_OPERATIONS.test(title) && !STRATEGY_AND_OPERATIONS.test(title)) continue;
    return persona;
  }
  return null;
}

const dutiesOf = (persona: TargetPersona, text: string) => DUTIES[persona].filter((duty) => duty.test(text)).length;

/* ---------- Hiring intent ---------- */

/** Wording of an actual opening; two signals make the intent strong, one weak. */
const VACANCY_SIGNALS = [
  /\b(?:we(?:'|’)?re|we\s+are|i(?:'|’)?m|i\s+am|is|are|now|currently|actively)\s+hiring\b/i,
  /(?:^|\n)[^\p{L}\n]*#?(?:now\s*)?hiring\b\s*[:!\-–—]?\s*\p{L}/imu,
  /(?:^|\n)[^\p{L}\n]*(?:position(?:\s+title)?|role|job\s+title|title|opening|vacancy)\s*[:\-–—]/imu,
  /\bapply\s+(?:here|now|today|at|via|below|online)\b|\bhow\s+to\s+apply\b|\bto\s+apply\b/i,
  /\b(?:looking\s+for|seeking)\s+(?:an?|our|experienced)\b/i,
  /\bjoin\s+(?:our|the)\s+[^.\n]{0,40}\bteam\b/i,
  /\bnew\s+[^\n]{0,20}\bjob\s*:/i,
  /\b(?:job\s+description|responsibilities|requirements|qualifications)\s*:/i,
  /\bcandidates?\b[^.\n]{0,40}\b(?:will\s+be\s+considered|preferred|required|only)\b/i,
];
/** Talent pools, staffing promotion, advice and commentary about hiring. */
const COMMENTARY = [
  /\broles\s+we\s+(?:place|fill|recruit)\b/i,
  /\bsend\s+us\s+your\s+(?:resume|cv)\s+before\b/i,
  /\bconnecting\s+with\s+(?:experienced\s+)?[^.\n]{0,80}\bprofessionals\b/i,
  /\bhow\s+(?:you\s+can|to)\s+(?:save|hire|reduce|cut)\b/i,
  /\boutsourc/i,
  /\bhiring\s+(?:managers?\s+(?:should|want|look)|process|trends?|freeze|tips|mistakes?)\b/i,
  /\bif\s+you(?:'|’)?re\s+hiring\b|\bstop\s+hiring\b/i,
  /\bjoin\s+our\s+talent\s+(?:pool|network|community)\b/i,
];

function hiringIntent(post: ClassifiablePost, text: string): HiringIntent {
  // A job card, an attached job listing or a link to a job page is an opening by itself.
  if (
    post.job_title_source === 'job_card' ||
    post.job_title_source === 'listing' ||
    post.linkedin_job_url ||
    post.external_apply_url ||
    (post.article_title && isJobListingUrl(post.article_url))
  ) {
    return 'strong';
  }
  if (COMMENTARY.some((pattern) => pattern.test(text))) return 'commentary';
  const signals = VACANCY_SIGNALS.filter((pattern) => pattern.test(text)).length;
  return signals >= 2 ? 'strong' : signals === 1 ? 'weak' : 'none';
}

/* ---------- Classification ---------- */

/** Text as the rules read it: styled letters folded, "&amp;" artifacts decoded, markdown emphasis dropped. */
const readable = (text: string) =>
  text.normalize('NFKC').replace(/&amp;/g, '&').replace(/(^|\s)amp;(?=\s)/g, '$1&').replace(/[*_]{1,3}/g, '');
const evidence = (phrase: string) => phrase.replace(/\s+/g, ' ').trim().slice(0, 160);

interface RoleTitle {
  title: string;
  source: RoleTitleSource;
}

/** Role titles in order of trust: job card, job listing, then titles stated in the text. */
function roleTitles(post: ClassifiablePost, text: string): RoleTitle[] {
  const candidates = titleCandidates(text);
  const titles: RoleTitle[] = [];
  const add = (title: string | null, source: RoleTitleSource) => {
    if (title && !titles.some((t) => t.title.toLowerCase() === title.toLowerCase())) titles.push({ title, source });
  };
  if (post.job_title) {
    const fromText = candidates.find((c) => c.title.toLowerCase() === post.job_title!.toLowerCase());
    const source: RoleTitleSource =
      post.job_title_source === 'job_card' ? 'job_card' : post.job_title_source === 'listing' ? 'listing' : (fromText?.kind ?? 'header');
    add(post.job_title, source);
  }
  if (post.article_title && isJobListingUrl(post.article_url) && !/^https?:\/\//i.test(post.article_title)) add(post.article_title, 'listing');
  for (const candidate of candidates) add(candidate.title, candidate.kind);
  return titles;
}

export function classifyJobRelevance(post: ClassifiablePost): JobClassification {
  const text = readable(post.text ?? '');
  const intent = hiringIntent(post, text);
  const titles = roleTitles(post, text);
  const first = titles[0] ?? null;
  const base = { hiring_intent: intent, role_title: first?.title ?? null, title_source: first?.source ?? null };

  if (intent === 'commentary') {
    return { ...base, relevance: 'not_a_job', persona: 'none', evidence_text: null, reason: 'Talent-pool, staffing or commentary wording, no specific opening' };
  }
  if (intent === 'none') {
    return { ...base, relevance: 'not_a_job', persona: 'none', evidence_text: null, reason: 'No vacancy wording, job card or job link' };
  }

  // 1. The function is in a role title.
  for (const role of titles) {
    const persona = personaOf(role.title);
    if (!persona) continue;
    const found = { hiring_intent: intent, persona, role_title: role.title, title_source: role.source, evidence_text: evidence(role.title) };
    if (GIG_ROLE.test(role.title)) {
      return { ...found, relevance: 'needs_review', reason: `${PERSONA_LABELS[persona]} named in an expert or advisor role` };
    }
    if (TECHNICAL_ROLE.test(role.title)) {
      return dutiesOf(persona, text) >= 3
        ? { ...found, relevance: 'relevant', reason: `Technical ${PERSONA_LABELS[persona]} role whose duties are ${PERSONA_LABELS[persona]} work` }
        : { ...found, relevance: 'needs_review', reason: `Supporting technical role in ${PERSONA_LABELS[persona]}` };
    }
    return { ...found, relevance: 'relevant', reason: `Role title is ${PERSONA_LABELS[persona]}` };
  }

  // 2. A role on a named target team.
  const team = TARGET_TEAM.exec(text);
  const teamPersona = team ? personaOf(team[1]!) ?? (/vendor/i.test(team[1]!) ? 'vendor_manager' : null) : null;
  if (team && teamPersona) {
    const role = first?.title ?? null;
    const found = { hiring_intent: intent, persona: teamPersona, role_title: role, title_source: first?.source ?? 'team', evidence_text: evidence(team[0]) };
    if (role && OPERATIONS_ROLE.test(role) && !TECHNICAL_ROLE.test(role)) {
      return { ...found, relevance: 'relevant', reason: `Operations role on the ${PERSONA_LABELS[teamPersona]} team` };
    }
    if (dutiesOf(teamPersona, text) >= 3) {
      return { ...found, relevance: 'relevant', reason: `Role on the ${PERSONA_LABELS[teamPersona]} team doing ${PERSONA_LABELS[teamPersona]} work` };
    }
    return { ...found, relevance: 'needs_review', reason: `Supporting role on the ${PERSONA_LABELS[teamPersona]} team` };
  }

  // 3. A title next to the target functions.
  const adjacent = titles.find((role) => ADJACENT_TITLE.test(role.title) && !COMBINED_SALES_AND_OPERATIONS.test(role.title));
  if (adjacent) {
    return {
      hiring_intent: intent,
      persona: 'none',
      role_title: adjacent.title,
      title_source: adjacent.source,
      evidence_text: evidence(adjacent.title),
      relevance: 'needs_review',
      reason: 'Adjacent title (vendor, supplier, procurement or business operations)',
    };
  }
  if (first) return { ...base, relevance: 'unrelated', persona: 'none', evidence_text: evidence(first.title), reason: 'Role title is not a target function' };

  // 4. No title: only the function named right at the hiring statement is worth a look.
  const head = text.slice(0, 220);
  const headPersona = /hiring/i.test(head) ? personaOf(head) : null;
  if (headPersona) {
    const phrase = head.match(TARGETS.find(([p]) => p === headPersona)![1])?.[0] ?? null;
    return { ...base, relevance: 'needs_review', persona: headPersona, evidence_text: phrase && evidence(phrase), reason: `${PERSONA_LABELS[headPersona]} named near the hiring statement, no role title` };
  }
  return { ...base, relevance: 'unrelated', persona: 'none', evidence_text: null, reason: 'No role title and no target function at the hiring statement' };
}
