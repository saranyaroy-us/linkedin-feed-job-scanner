/**
 * Display-only preview for the posts table: the words around the first
 * "hiring" (any case, also inside a word such as #WeAreHiring), or the opening
 * words when the post never says it. The stored text is never changed; the
 * table keeps the full text behind "Show full text".
 */

const TERM = /hiring/i;
const TERM_LENGTH = 'hiring'.length;

/** Words shown on each side of the match. */
export const SNIPPET_CONTEXT_WORDS = 18;
/** Words shown when the post does not mention the term. */
export const SNIPPET_FALLBACK_WORDS = 36;

export interface PostSnippet {
  /** Text before the match (or the whole preview when nothing matched), "…" where words were left out. */
  before: string;
  /** The matched term as written in the post, or null when the post does not contain it. */
  match: string | null;
  after: string;
  /** True when words were left out, so the full text is worth expanding. */
  truncated: boolean;
}

/** Up to `limit` whitespace-separated words from the start of `text`. */
const leadingWords = (text: string, limit: number) => text.trim().split(/\s+/, limit).filter(Boolean);
const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

export function postSnippet(text: string): PostSnippet {
  const at = text.search(TERM);
  if (at < 0) {
    const words = leadingWords(text, SNIPPET_FALLBACK_WORDS + 1);
    const truncated = words.length > SNIPPET_FALLBACK_WORDS;
    const shown = words.slice(0, SNIPPET_FALLBACK_WORDS).join(' ');
    return { before: truncated ? `${shown}…` : shown, match: null, after: '', truncated };
  }

  // The whitespace-separated word holding the match, e.g. "#WeAreHiring!".
  let start = at;
  while (start > 0 && !isSpace(text[start - 1])) start--;
  let end = at + TERM_LENGTH;
  while (end < text.length && !isSpace(text[end])) end++;

  const wordsBefore = text.slice(0, start).split(/\s+/).filter(Boolean);
  const wordsAfter = leadingWords(text.slice(end), SNIPPET_CONTEXT_WORDS + 1);
  const cutBefore = wordsBefore.length > SNIPPET_CONTEXT_WORDS;
  const cutAfter = wordsAfter.length > SNIPPET_CONTEXT_WORDS;
  const shownBefore = wordsBefore.slice(-SNIPPET_CONTEXT_WORDS).map((word) => `${word} `).join('');
  const shownAfter = wordsAfter.slice(0, SNIPPET_CONTEXT_WORDS).map((word) => ` ${word}`).join('');

  return {
    before: `${cutBefore ? '…' : ''}${shownBefore}${text.slice(start, at)}`,
    match: text.slice(at, at + TERM_LENGTH),
    after: `${text.slice(at + TERM_LENGTH, end)}${shownAfter}${cutAfter ? '…' : ''}`,
    truncated: cutBefore || cutAfter,
  };
}
