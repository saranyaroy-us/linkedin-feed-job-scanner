import { REQUIRED_KEYWORD } from '../config/search-config';

/**
 * The hard ingestion filter. A dataset item is kept only when its post text
 * (`content`, the field normalization stores as `text`) contains "hiring" after
 * Unicode compatibility normalization (NFKC maps styled letters such as 𝗛𝗶𝗿𝗶𝗻𝗴
 * to plain ones) and lowercasing — also inside words, e.g. #WeAreHiring. It runs
 * on the raw item, before normalization, so a dropped item costs no
 * normalization, dedupe or D1 work.
 */
export function mentionsHiring(item: unknown): boolean {
  const text = typeof item === 'object' && item !== null ? (item as { content?: unknown }).content : undefined;
  return typeof text === 'string' && text.normalize('NFKC').toLowerCase().includes(REQUIRED_KEYWORD);
}
