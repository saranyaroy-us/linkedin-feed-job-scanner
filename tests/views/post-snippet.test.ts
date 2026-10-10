import { describe, expect, it } from 'vitest';
import { postSnippet, SNIPPET_CONTEXT_WORDS, SNIPPET_FALLBACK_WORDS } from '../../src/views/post-snippet';

/** `count` distinct words: b1 b2 … */
const words = (prefix: string, count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `${prefix}${from + i}`);
const join = (...parts: string[][]) => parts.flat().join(' ');

describe('postSnippet — match', () => {
  it('shows 18 words before and after a lowercase "hiring", with ellipses where words were left out', () => {
    expect(SNIPPET_CONTEXT_WORDS).toBe(18);
    const snippet = postSnippet(join(words('b', 25), ['hiring'], words('a', 25)));
    expect(snippet).toEqual({
      before: `…${join(words('b', 18, 8))} `,
      match: 'hiring',
      after: ` ${join(words('a', 18))}…`,
      truncated: true,
    });
  });

  it('matches an uppercase "HIRING" and keeps its casing', () => {
    const snippet = postSnippet(join(words('b', 20), ['HIRING'], words('a', 20)));
    expect(snippet.match).toBe('HIRING');
    expect(snippet.before).toBe(`…${join(words('b', 18, 3))} `);
    expect(snippet.after).toBe(` ${join(words('a', 18))}…`);
  });

  it('matches a mixed-case "Hiring"', () => {
    const snippet = postSnippet(join(words('b', 19), ['Hiring'], words('a', 19)));
    expect(snippet.match).toBe('Hiring');
    expect(snippet.truncated).toBe(true);
  });

  it('near the beginning: shows the few words before it, without a leading ellipsis', () => {
    const snippet = postSnippet(join(['We', 'are'], ['hiring'], words('a', 30)));
    expect(snippet.before).toBe('We are ');
    expect(snippet.after).toBe(` ${join(words('a', 18))}…`);
    expect(snippet.truncated).toBe(true);
  });

  it('near the end: shows the few words after it, without a trailing ellipsis', () => {
    const snippet = postSnippet(join(words('b', 30), ['hiring'], ['now.']));
    expect(snippet.before).toBe(`…${join(words('b', 18, 13))} `);
    expect(snippet.after).toBe(' now.');
    expect(snippet.truncated).toBe(true);
  });

  it('uses the first of several occurrences', () => {
    const snippet = postSnippet(join(['Now'], ['Hiring:'], words('m', 25), ['#hiring'], ['again']));
    expect(snippet.match).toBe('Hiring');
    expect(snippet.before).toBe('Now ');
    expect(snippet.after).toBe(`: ${join(words('m', 18))}…`);
  });

  it('shows every word, untruncated, when there are fewer than 18 on each side', () => {
    expect(postSnippet('We are hiring a RevOps lead.')).toEqual({
      before: 'We are ',
      match: 'hiring',
      after: ' a RevOps lead.',
      truncated: false,
    });
  });

  it('highlights the term inside a word, keeping the rest of the word and its punctuation', () => {
    expect(postSnippet('Big news: #WeAreHiring! Apply today.')).toEqual({
      before: 'Big news: #WeAre',
      match: 'Hiring',
      after: '! Apply today.',
      truncated: false,
    });
  });

  it('collapses line breaks and repeated whitespace, keeping punctuation readable', () => {
    const text = "  We're\n\n   #Hiring!\tJoin   us,\r\n  please.\n";
    expect(postSnippet(text)).toEqual({
      before: "We're #",
      match: 'Hiring',
      after: '! Join us, please.',
      truncated: false,
    });
  });
});

describe('postSnippet — no match', () => {
  it('falls back to the first 36 words', () => {
    expect(SNIPPET_FALLBACK_WORDS).toBe(36);
    expect(postSnippet(join(words('n', 50)))).toEqual({
      before: `${join(words('n', 36))}…`,
      match: null,
      after: '',
      truncated: true,
    });
  });

  it('shows a short post whole, with whitespace collapsed', () => {
    expect(postSnippet('Thoughts on\n\nRevOps   tooling.')).toEqual({
      before: 'Thoughts on RevOps tooling.',
      match: null,
      after: '',
      truncated: false,
    });
    expect(postSnippet(join(words('n', 36))).truncated).toBe(false);
  });

  it('handles an empty post', () => {
    expect(postSnippet('')).toEqual({ before: '', match: null, after: '', truncated: false });
    expect(postSnippet(' \n ')).toEqual({ before: '', match: null, after: '', truncated: false });
  });

  it('does not match "hire" or "hired"', () => {
    expect(postSnippet('We hired two people and will hire more.').match).toBeNull();
  });
});
