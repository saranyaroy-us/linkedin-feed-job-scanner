import { describe, expect, it } from 'vitest';
import { mentionsHiring } from '../../src/ingestion/hiring-filter';

const post = (content: unknown) => ({ id: '7500000000000000999', content });

describe('mentionsHiring — the hard ingestion filter', () => {
  it.each(['hiring', 'Hiring', 'HIRING', '#hiring', '#Hiring', '𝗛𝗶𝗿𝗶𝗻𝗴', 'WeAreHiring'])('keeps a post containing %s', (word) => {
    expect(mentionsHiring(post(`Big news from the team: ${word} today.`))).toBe(true);
    expect(mentionsHiring(post(word))).toBe(true);
  });

  it('normalizes Unicode compatibility forms (NFKC) before matching', () => {
    expect(mentionsHiring(post('𝐇𝐈𝐑𝐈𝐍𝐆 now'))).toBe(true); // mathematical bold capitals
    expect(mentionsHiring(post('ｈｉｒｉｎｇ'))).toBe(true); // fullwidth letters
    expect(mentionsHiring(post('We are\nhiring\tfor RevOps'))).toBe(true);
  });

  it.each(['We are recruiting', 'Open role available', 'Join our team', 'Now accepting applications'])(
    'drops "%s" unless it also says hiring',
    (text) => {
      expect(mentionsHiring(post(text))).toBe(false);
      expect(mentionsHiring(post(`${text} — we are hiring!`))).toBe(true);
    },
  );

  it('does not treat related words as the keyword', () => {
    expect(mentionsHiring(post('We hired two analysts and will hire more'))).toBe(false);
    expect(mentionsHiring(post('Hir ing'))).toBe(false);
  });

  it('drops items without post text', () => {
    for (const item of [null, undefined, 'hiring', 42, [], {}, post(null), post(42), post({ text: 'hiring' })]) {
      expect(mentionsHiring(item)).toBe(false);
    }
  });

  it('reads only the post text, not other fields', () => {
    expect(mentionsHiring({ content: 'Great quarter', author: { info: 'Hiring manager' }, article: { title: 'Hiring tips' } })).toBe(false);
  });
});
