/**
 * raw_json (the full Apify item, ~4 KB per post) is kept this many days after a
 * post is stored, then set to NULL by the hourly cron in wrangler.jsonc.
 * Rows and their normalized columns are never deleted.
 */
export const RAW_JSON_RETENTION_DAYS = 7;
