/** Project settings the operator scripts need, read from wrangler.jsonc so they are never duplicated. */
import { readFileSync } from 'node:fs';

const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const setting = (name) => {
  const value = wrangler.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1];
  if (!value) throw new Error(`${name} not found in wrangler.jsonc`);
  return value;
};

export const APIFY_TASK_ID = setting('APIFY_TASK_ID');
export const D1_DATABASE = setting('database_name');

/** APIFY_TOKEN from the git-ignored .env (never printed). */
export function apifyToken() {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const token = env.match(/^APIFY_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (!token) throw new Error('APIFY_TOKEN is missing in .env');
  return token;
}
