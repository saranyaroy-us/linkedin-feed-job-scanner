import { isJobListingUrl } from '../normalization/job-links';
import { AMBIGUOUS_STATE_NAMES, NON_US_PLACES, US_CITIES, US_PHRASES, US_STATES } from './location-data';

/**
 * The hard US-job filter: where is the JOB (never the author)? Sources, in order:
 *   1. the structured job card (`job.location`, LinkedIn's "City, ST" or
 *      "City, Region, Country" format),
 *   2. an attached article that is a job listing (title, subtitle, description),
 *   3. the post text.
 * The first source that gives an answer wins. A source answers "us" when it has
 * US evidence and no non-US evidence, "non_us" for the reverse; no evidence or
 * both kinds is no answer. Evidence that counts as US:
 *   - "United States", "USA", "U.S.", "U.S.A." and US-remote wording ("US Remote",
 *     "Remote, US", "(US)", "US-based", "in the US", "US citizens"…),
 *   - a known city followed by one of its states ("Austin, TX", "Austin, Texas"),
 *   - a full state name (except Georgia and Washington, which need a city or "State"),
 *   - a few US metro names ("NYC", "San Francisco Bay Area", "Silicon Valley"…),
 *     and "SF" next to a work-place word ("Hybrid SF", "SF-based", "in SF").
 * A two-letter state code on its own never counts ("IN", "OR", "ME" are words),
 * except right after the comma of a structured job location. Matching is
 * case-insensitive and Unicode-normalized (styled letters and accents folded).
 *
 * Free text (sources 2 and 3) says more than where the job is, so before
 * matching it drops URLs and email addresses ("…@acme.co.uk", "…/job/us/…"),
 * travel ("monthly travel to Calgary"), headquarters ("HQ in Austin, TX") and
 * the author's own story ("as an Australian based in New York", "I live in
 * Denver"); and a place does not count where it describes something other than
 * the workplace ("U.S. healthcare clients", "US market", "Pacific Time (US)",
 * "customers across the U.S.", "a NYC-based company").
 */

export type LocationVerdict = 'us' | 'non_us' | 'unknown';
export type LocationSource = 'job' | 'article' | 'post_text';

export interface JobLocation {
  verdict: LocationVerdict;
  /** For US jobs: the job card's location (without "(Remote)"-style work mode), or the US evidence found ("Austin, TX"). */
  text: string | null;
  source: LocationSource | null;
}

const UNKNOWN: JobLocation = { verdict: 'unknown', text: null, source: null };
const MAX_PHRASE_WORDS = 4;

/** Lowercase, accent-free, compatibility-folded text with U.S./U.K./D.C. collapsed into words. */
function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\bu\.s\.a\b\.?/g, ' usa ')
    .replace(/\bu\.s\b\.?/g, ' usa ')
    .replace(/\bu\.k\b\.?/g, ' uk ')
    .replace(/\bd\.c\b\.?/g, ' dc ');
}

const words = (normalized: string) => normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const key = (name: string) => words(normalize(name)).join(' ');

/* ---------- Free-text clean-up ---------- */

/**
 * Email addresses and links, including bare domains such as "acme-london.com" or "lnkd.in/abc".
 * The lookbehind starts an address only where its local part starts (without it every word is retried
 * letter by letter, ~3 ms of a page's 10 ms CPU budget); LINK is ASCII, so it needs no `u` flag.
 */
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const LINK =
  /(?:\bhttps?:\/\/|\bwww\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|co|us|uk|in|ca|au|de|jobs|app|dev|me|info|biz|careers|work|gov|edu|xyz)\b(?:\/\S*)?/gi;
/** The rest of a clause: up to a sentence end, a separator or a bracket (commas stay, as in "Austin, TX"). */
const CLAUSE = String.raw`[^.;!?|()\[\]\n•]*`;
/** Places someone travels to, not where they work. */
const TRAVEL = new RegExp(
  String.raw`\b(?:travel(?:s|ing|ling|ed|led)?|trips?|visits?|visiting|commut(?:e|es|ing))\b(?:[\s-]+[\p{L}\p{N}%]+){0,3}?[\s-]+(?:to|across|around|within|throughout|in|into|between)\b${CLAUSE}`,
  'gu',
);
/** Where the employer is headquartered, not where the job is. */
const HEADQUARTERS = new RegExp(String.raw`\b(?:headquartered|headquarters|hq|head[\s-]office)\b${CLAUSE}`, 'gu');
/**
 * The author's own story: "as an Australian based in New York" (a nationality,
 * not "as a hybrid role based in…"), "I'm based in Denver", "I moved to Austin".
 */
const ANECDOTE = new RegExp(
  String.raw`\b(?:as an?\s+(?:[\p{L}-]+(?:ian|an|ese|ish|ch|ino|i)|expat|immigrant|native)\s+(?:based|living|who lives|now living)\s+in|i(?:['’]m|\s+am|\s+was|\s+have been|['’]ve been)?\s+(?:currently\s+|now\s+)?(?:based|living|located|settled|staying)\s+in|i\s+(?:live|lived|moved|relocated|grew up|was born|was raised)\s+(?:in|to))\b${CLAUSE}`,
  'gu',
);

/** Free text with links, emails, travel, headquarters and the author's story replaced by a separator. */
function prepareFreeText(text: string): string {
  const withoutEmails = text.includes('@') ? text.replace(EMAIL, ' | ') : text;
  return normalize(withoutEmails.replace(LINK, ' | '))
    .replace(TRAVEL, ' | ')
    .replace(HEADQUARTERS, ' | ')
    .replace(ANECDOTE, ' | ');
}

/* ---------- Context of a match ---------- */

interface Token {
  word: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  return tokens;
}

/** Punctuation that separates a place from the words around it. */
const SEPARATOR = /[.,;:!?|()[\]{}\n•"“”–—]/u;
const SENTENCE_END = /[.;!?|\n•]/u;
/** What a place may describe other than the workplace ("U.S. healthcare clients", "US market", "Texas customers"). */
const INCIDENTAL = new Set([
  'market', 'markets', 'client', 'clients', 'customer', 'customers', 'consumer', 'consumers', 'patient', 'patients',
  'healthcare', 'health', 'medical', 'insurance', 'mortgage', 'operations', 'ops', 'account', 'accounts', 'business',
  'businesses', 'payroll', 'tax', 'taxes', 'taxation', 'gaap', 'accounting', 'regulation', 'regulations', 'regulatory',
  'compliance', 'law', 'laws', 'legal', 'standards', 'time', 'timezone', 'timezones', 'zone', 'zones', 'hours', 'shift',
  'shifts', 'holiday', 'holidays', 'english', 'economy', 'government', 'federal', 'stock', 'stocks', 'equities',
  'companies', 'firms', 'brands', 'partners', 'stakeholders', 'investors', 'audience', 'users', 'entity', 'entities',
  'subsidiary', 'expansion', 'presence', 'rcm', 'billing', 'teams',
]);
/** "<place>-based company": where the employer is, not the job. */
const EMPLOYER = new Set([
  'company', 'companies', 'startup', 'startups', 'firm', 'firms', 'business', 'agency', 'agencies', 'brand', 'brands',
  'organization', 'organisation', 'org', 'client', 'clients', 'customer', 'customers',
]);
/** Time-zone words just before a place: "Pacific Time (US)", "EST (US)". */
const TIME_WORDS = new Set([
  'time', 'timezone', 'zone', 'hours', 'shift', 'pst', 'pdt', 'est', 'edt', 'cst', 'cdt', 'mst', 'mdt', 'pt', 'et', 'ct',
  'mt', 'eastern', 'pacific', 'central', 'mountain',
]);
const PREPOSITIONS = new Set(['in', 'across', 'within', 'throughout', 'for', 'from']);
/** Words that make "SF" a workplace: "Hybrid SF", "in SF", "SF-based", "SF office". */
const SF_BEFORE = new Set(['hybrid', 'onsite', 'office', 'in', 'located', 'based']);
const SF_AFTER = new Set(['based', 'office', 'hq']);

class Context {
  constructor(
    private readonly text: string,
    readonly tokens: readonly Token[],
  ) {}

  word(i: number): string | undefined {
    return this.tokens[i]?.word;
  }

  /** Nothing but spaces or hyphens between token a and the next token b. */
  joined(a: number, b: number): boolean {
    const left = this.tokens[a];
    const right = this.tokens[b];
    return !!left && !!right && !SEPARATOR.test(this.text.slice(left.end, right.start));
  }

  private sameSentence(a: number, b: number): boolean {
    const left = this.tokens[a];
    const right = this.tokens[b];
    return !!left && !!right && !SENTENCE_END.test(this.text.slice(left.end, right.start));
  }

  /** True when the place at tokens first..last describes something other than the workplace. */
  incidental(first: number, last: number): boolean {
    // Followed by what it qualifies: "U.S. healthcare clients", "US market", "NYC-based company".
    for (let k = last + 1; k <= last + 2 && this.joined(k - 1, k); k++) {
      const word = this.word(k)!;
      if (word === 'based') return this.joined(k, k + 1) && EMPLOYER.has(this.word(k + 1) ?? '');
      if (word === 'full' || word === 'part') return false; // "United States full-time"
      if (INCIDENTAL.has(word)) return true;
    }
    // Right after a time-zone word: "Pacific Time (US)", but not "full-time (US)".
    const before = this.word(first - 1);
    if (before && TIME_WORDS.has(before) && this.sameSentence(first - 1, first)) {
      const twoBefore = this.word(first - 2);
      if (!(before === 'time' && (twoBefore === 'full' || twoBefore === 'part'))) return true;
    }
    // "clients in the US", "operations across Texas".
    let k = first - 1;
    if (this.word(k) === 'the' && this.joined(k, k + 1)) k--;
    return (
      PREPOSITIONS.has(this.word(k) ?? '') && this.joined(k, k + 1) && this.joined(k - 1, k) && INCIDENTAL.has(this.word(k - 1) ?? '')
    );
  }

  /** "SF" as a workplace. */
  isSanFrancisco(i: number): boolean {
    if (this.word(i) !== 'sf') return false;
    const before = this.word(i - 1);
    if (before && this.joined(i - 1, i) && SF_BEFORE.has(before)) return true;
    if (before === 'site' && this.word(i - 2) === 'on' && this.joined(i - 1, i)) return true;
    const after = this.word(i + 1);
    return !!after && this.joined(i, i + 1) && SF_AFTER.has(after);
  }

  /** First and last token overlapping the characters start..end-1 (e.g. just "us" for "(us)"). */
  tokensIn(start: number, end: number): { first: number; last: number } {
    return { first: this.tokens.findIndex((t) => t.end > start), last: this.tokens.findLastIndex((t) => t.start < end) };
  }
}

/* ---------- Phrase tables ---------- */

/** Phrase table keyed by word sequence, with the set of possible first words for a quick reject. */
class Phrases<T> {
  private readonly map = new Map<string, T>();
  private readonly firsts = new Set<string>();
  set(name: string, value: T): void {
    const k = key(name);
    this.map.set(k, value);
    this.firsts.add(k.split(' ')[0]!);
  }
  /** Longest phrase starting at `start` that uses no consumed word. */
  longest(tokens: readonly string[], start: number, consumed: readonly boolean[]): { length: number; value: T } | null {
    if (!this.firsts.has(tokens[start]!)) return null;
    let best: { length: number; value: T } | null = null;
    let phrase = '';
    for (let n = 1; n <= MAX_PHRASE_WORDS && start + n <= tokens.length && !consumed[start + n - 1]; n++) {
      phrase = n === 1 ? tokens[start]! : `${phrase} ${tokens[start + n - 1]}`;
      const value = this.map.get(phrase);
      if (value !== undefined) best = { length: n, value };
    }
    return best;
  }
}

const STATE_CODES = new Map(Object.keys(US_STATES).map((code) => [code.toLowerCase(), code]));
const STATE_NAMES = new Phrases<string>();
const CITIES = new Phrases<{ name: string; states: ReadonlySet<string> }>();
const US_SIGNALS = new Phrases<string>();
const NON_US = new Phrases<string>();

for (const [code, name] of Object.entries(US_STATES)) {
  STATE_NAMES.set(name, code);
  if (!AMBIGUOUS_STATE_NAMES.has(key(name))) US_SIGNALS.set(name, name);
}
for (const [name, states] of Object.entries(US_CITIES)) CITIES.set(name, { name, states: new Set(states.split(',')) });
for (const [phrase, label] of Object.entries(US_PHRASES)) US_SIGNALS.set(phrase, label);
for (const place of NON_US_PLACES) NON_US.set(place, place);
const NON_US_CITY_NAMES = new Set(NON_US_PLACES);

/** "us" is also a pronoun, so on its own it only counts in these patterns. */
const US_REMOTE =
  /\bus[\s-]*remote\b|\bremote[\s,:;|/()\-–—]*us\b|\(\s*us\s*\)|\bus[\s-]+(?:based|only)\b|\b(?:in|within|across|throughout) the us\b|\bus citizens?\b/g;

/** "City, ST" — LinkedIn's format for US job locations. Only trusted in the structured field. */
const STRUCTURED_CITY_STATE = /^[^,]+,\s*([a-z]{2})\s*(?:\(|,|$)/;

interface Evidence {
  us: string[];
  nonUs: string[];
}

function stateAt(tokens: readonly string[], index: number, consumed: readonly boolean[]): { code: string; length: number } | null {
  const token = tokens[index];
  if (token === undefined || consumed[index]) return null;
  const code = STATE_CODES.get(token);
  if (code) return { code, length: 1 };
  const name = STATE_NAMES.longest(tokens, index, consumed);
  return name ? { code: name.value, length: name.length } : null;
}

function evidence(text: string, structured: boolean): Evidence {
  // A structured location is only a place; free text is cleaned and its places checked in context.
  const prepared = structured ? normalize(text) : prepareFreeText(text);
  const context = new Context(prepared, tokenize(prepared));
  const tokens = context.tokens.map((t) => t.word);
  const consumed = tokens.map(() => false);
  const us: string[] = [];
  const nonUs: string[] = [];
  /** Uses up tokens from..from+length-1; records the place unless free text shows it is not the workplace. */
  const take = (list: string[], label: string, from: number, length: number) => {
    consumed.fill(true, from, from + length);
    if (structured || !context.incidental(from, from + length - 1)) list.push(label);
  };

  // 1. Known city + one of its states ("austin tx", "atlanta georgia", "washington dc").
  for (let i = 0; i < tokens.length; i++) {
    const city = CITIES.longest(tokens, i, consumed);
    if (!city) continue;
    const state = stateAt(tokens, i + city.length, consumed);
    if (state && city.value.states.has(state.code)) {
      take(us, `${city.value.name}, ${state.code}`, i, city.length + state.length);
      i += city.length + state.length - 1;
    }
  }

  // 2. Other US and non-US names; the longest phrase wins ("new mexico" over "mexico").
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const usMatch = US_SIGNALS.longest(tokens, i, consumed);
    // A structured location may name a US city without its state ("Greater Boston").
    const cityMatch = structured ? CITIES.longest(tokens, i, consumed) : null;
    const nonUsMatch = NON_US.longest(tokens, i, consumed);
    const usLength = Math.max(usMatch?.length ?? 0, cityMatch && !NON_US_CITY_NAMES.has(key(cityMatch.value.name)) ? cityMatch.length : 0);
    const nonUsLength = nonUsMatch?.length ?? 0;
    if (usLength === 0 && nonUsLength === 0) {
      if (!structured && context.isSanFrancisco(i)) take(us, 'San Francisco', i, 1);
      continue;
    }
    if (usLength >= nonUsLength) {
      take(us, usMatch && usMatch.length === usLength ? usMatch.value : cityMatch!.value.name, i, usLength);
      i += usLength - 1;
    } else {
      take(nonUs, nonUsMatch!.value, i, nonUsLength);
      i += nonUsLength - 1;
    }
  }

  for (const match of prepared.matchAll(US_REMOTE)) {
    const { first, last } = context.tokensIn(match.index, match.index + match[0].length);
    if (structured || !context.incidental(first, last)) us.push('United States');
  }
  if (structured && us.length === 0) {
    const code = prepared.match(STRUCTURED_CITY_STATE)?.[1];
    if (code && STATE_CODES.has(code)) us.push(text.trim());
  }
  return { us, nonUs };
}

/** Verdict of one source's text; mixed or missing evidence is "unknown". */
export function classifyLocationText(text: string, options: { structured?: boolean } = {}): {
  verdict: LocationVerdict;
  evidence: string[];
} {
  const { us, nonUs } = evidence(text, options.structured ?? false);
  if (us.length && !nonUs.length) return { verdict: 'us', evidence: [...new Set(us)] };
  if (nonUs.length && !us.length) return { verdict: 'non_us', evidence: [...new Set(nonUs)] };
  return { verdict: 'unknown', evidence: [] };
}

const asObject = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asText = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/** LinkedIn appends the work mode to a job card's location: "Dallas, TX (On-site)". work_mode keeps it. */
const WORK_MODE_SUFFIX = /\s*\((?:remote|hybrid|on[\s-]?site)\)\s*$/i;

/** Where the job is, per the source order above. The author's profile is never read. */
export function jobLocation(item: unknown): JobLocation {
  const post = asObject(item);
  if (!post) return UNKNOWN;

  const structured = asText(asObject(post.job)?.location);
  if (structured) {
    const result = classifyLocationText(structured, { structured: true });
    const text = structured.trim().replace(WORK_MODE_SUFFIX, '') || structured.trim();
    if (result.verdict !== 'unknown') return { verdict: result.verdict, text, source: 'job' };
  }

  // An attached article counts as a job card only when it links to a job listing.
  const article = asObject(post.article);
  if (article && isJobListingUrl(article.link)) {
    const text = [article.title, article.subtitle, article.description].map(asText).filter(Boolean).join('\n');
    const result = classifyLocationText(text);
    if (result.verdict !== 'unknown') return { verdict: result.verdict, text: summary(result.evidence), source: 'article' };
  }

  const content = asText(post.content);
  if (content) {
    const result = classifyLocationText(content);
    if (result.verdict !== 'unknown') return { verdict: result.verdict, text: summary(result.evidence), source: 'post_text' };
  }
  return UNKNOWN;
}

/** Up to three places; plain "United States" only when nothing more specific was found. */
const summary = (evidence: string[]) => {
  const specific = evidence.filter((place) => place !== 'United States');
  return (specific.length ? specific : evidence).slice(0, 3).join('; ');
};
