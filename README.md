# LinkedIn Job Signal Scanner

A cloud-only pipeline that collects LinkedIn posts mentioning **Revenue Operations**, **Sales Operations** and **Vendor Manager / Vendor Management**, stores them deduplicated in Cloudflare D1, and shows them on a small dashboard. A later milestone will classify which posts are real, active hiring opportunities and for which persona.

Nothing runs on your laptop: Apify runs the search on a schedule, and a Cloudflare Worker ingests the results and serves the dashboard. Cloudflare usage fits the free tier.

## Architecture

```
Apify Task: harvestapi/linkedin-post-search        (scheduled 09:00 + 21:00 Asia/Kolkata)
   │  ACTOR.RUN.SUCCEEDED webhook  (header X-Apify-Webhook-Secret)
   ▼
Cloudflare Worker  POST /webhooks/apify
   │  checks the secret, re-fetches the run from the Apify API (must be your
   │  account, the right Actor, status SUCCEEDED), records an ingest run,
   │  queues the first 25-item dataset page
   ▼
Cloudflare Queue  linkedin-ingest-pages  →  same Worker, one page per invocation
   │  fetch page → normalize → INSERT … ON CONFLICT DO NOTHING → record page
   │  → a full page queues the next one; a short (or empty) page is the last
   │  → when every page is in, the run is marked succeeded with its totals
   ▼
Cloudflare D1  linkedin-job-scanner   (raw_posts, ingest_runs, …)
   ▼
Hono dashboard on the same Worker:  /   /runs   /api/posts   (HTTP Basic auth)

Cron Trigger on the same Worker, hourly:  raw_json → NULL once a post is older than 7 days
```

Why a queue? The Workers Free plan allows **10 ms of CPU per invocation**. Parsing and storing a whole run (up to ~1,800 posts, ~7 MB of JSON) in the webhook request would exceed that. Splitting it into 25-item pages gives each page its own invocation and CPU budget, plus automatic retries. (50-item pages measured 10–13 ms of CPU in production, so the page size was halved.)

Why follow pages instead of counting them first? Apify's dataset item count can lag for a few seconds after a run finishes. Sizing the run from that count could silently drop the last posts, so the Worker keeps reading pages until one comes back short.

### Idempotency

Apify delivers webhooks at least once and retries failures for about 32 hours, and the 09:00 and 21:00 runs overlap on purpose. Duplicates are harmless:

- Each post is stored once, keyed by `(source, source_id)`. `source_id` is `li:<id>`, then `li:<entityId>`, then `url:<sha256(normalized linkedinUrl)>`. `engagement.id` is never used.
- Each Apify run has exactly one `ingest_runs` row (`apify_run_id` is UNIQUE). A redelivered webhook is a no-op if the run succeeded, gets `409` (Apify retries later) while it is still processing, and restarts it if it failed.
- Each dataset page is recorded in the same transaction as its posts, so a redelivered queue message is skipped. The "queue next page" step is repeated on redelivery, so a lost message cannot break the chain.
- Failed pages retry with backoff (30 s, 1, 2, 4 min). After 5 attempts, or a non-retryable Apify error, the run is marked `failed` with partial totals. Nothing is lost: re-sending the webhook resumes it (see Recovery).
- A run's **new** count is the number of posts that run stored first. **Already seen** is the run's valid posts minus new.

## Apify Actor and schedule

- **Actor:** `harvestapi/linkedin-post-search` (id `buIWk2uOUzTmcLsuB`). It is the only LinkedIn source.
- **Task input:** source of truth is [`src/config/search-config.ts`](src/config/search-config.ts).

  ```json
  {
    "searchQueries": [
      "\"Revenue Operations\" OR RevOps",
      "\"Sales Operations\" OR \"Sales Ops\"",
      "\"Vendor Manager\" OR \"Vendor Management\""
    ],
    "maxPosts": 600,
    "postedLimit": "24h",
    "sortBy": "date",
    "profileScraperMode": "short",
    "scrapeReactions": false,
    "scrapeComments": false,
    "postNestedReactions": false,
    "postNestedComments": false
  }
  ```

  No `contentType: "jobs"` and no "hiring" keyword: retrieval is deliberately broad, and the future classifier decides what is a hiring post.
- **Coverage:** `maxPosts` is per query, newest first. LinkedIn returns only ~190–230 results per search (187, 228 and 203 in production), so 600 means "everything available". On 2026-10-03 a run reached back 4.4 h for Sales Ops, 6 h for Vendor Management and 13.5 h for RevOps. A higher `maxPosts` cannot extend that; only more frequent runs or narrower queries can.
- **Schedule:** cron `0 9,21 * * *`, timezone `Asia/Kolkata`.
- **Cost:** about $0.002 per post. A run returned ~615 posts (~$1.23); the most it could return is 1,800 (~$3.60). The Task's max total charge of $5 is a safety cap.

## Data model (D1)

The schema is in [`migrations/`](migrations/): `0001_initial.sql` and `0002_raw_json_retention.sql`.

| Table | Purpose |
| --- | --- |
| `raw_posts` | One normalized post per LinkedIn activity. `UNIQUE(source, source_id)`, `source` is always `apify_linkedin_post_search`. Keeps `raw_json` (the full Actor item) for 7 days so a post can be re-normalized; after that `raw_json` is `NULL`. Rows and normalized fields are kept indefinitely. |
| `ingest_runs` | One row per Apify run: started/completed time, Apify run id, dataset id, the run's actual input, fetched / new / already seen / invalid (filled when the run succeeds, or with partial totals when it fails), status (`processing`, `succeeded` or `failed`), error, `pages_total` (0 until the last short or empty page is read) and `page_size`. |
| `ingest_run_pages` | Pages of a run that have been processed (makes queue redelivery safe). |
| `post_query_counts` | Per-query post totals kept up to date by triggers, so the dashboard never scans the whole table. |

Normalized post fields: `source`, `source_id`, `linkedin_post_id`, `entity_id`, `text`, `author_name`, `author_type` (`profile` or `company`), `author_profile_url` (query string stripped), `author_headline`, `url` (`linkedinUrl`), `posted_at` (`postedAt.date`), `search_query`, `apify_run_id`, `repost_id` (nested `repost.id`; the outer post stays the identity), `article_title`, `article_url`, `likes`, `comments`, `shares`, `tagged_companies_json`, `raw_json` (7 days, then `null`) and `fetched_at`. Unknown values are `null`. A malformed item is counted as invalid and never fails the run.

**raw_json retention.** An hourly Cron Trigger on the same Worker sets `raw_json = NULL` on posts stored (`created_at`) more than 7 days ago, at most 2,000 per run, oldest first. Nothing else changes and no row is deleted. A partial index (`0002_raw_json_retention.sql`) holds only the posts that still have `raw_json`, so each run reads just the rows it clears. Running it again, or twice at once, does nothing.

## Dashboard and API

All pages require HTTP Basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`), because the data contains LinkedIn posts.

- **`/`**: stored posts, posts added today, last ingestion time, and the last run's fetched / new / duplicates / invalid counts. Also shows posts per query and a filterable, newest-first post table with posted time, query, author, author type, text, engagement, article, repost marker and LinkedIn link. Filters: search query, author, author type, date from/to and free text. Author and free-text searches cover the last 90 days unless "Posted from" is set, since they cannot use an index and would otherwise scan the whole table.
- **`/runs`**: the 60 most recent ingest runs, newest first. Each shows started and completed time, status (with the error for failed runs), Apify run id (linked to Apify Console), fetched, new, already seen, invalid, and the run's actual input. Counts show "…" while a run is processing.
- **`/api/posts`**: normalized posts as JSON. Same filters (`query`, `author`, `author_type`, `from`, `to`, `q`) plus `limit` (≤ 100) and `offset`. `raw_json` is only included with `include_raw=1` (≤ 20 per page), and is `null` once a post is older than 7 days. `search_window_from` is set when an author or text search was limited to the last 90 days.
- **`/health`**: public liveness check that returns no data.

Times and date filters use `DISPLAY_TIMEZONE` (default `Asia/Kolkata`).

## Configuration

**Secrets** are set with `npx wrangler secret put <NAME>`. For local `wrangler dev`, put them in `.env` (git-ignored; copy `.env.example`).

| Secret | Purpose |
| --- | --- |
| `APIFY_TOKEN` | Apify API token; the Worker reads runs and datasets with it |
| `APIFY_WEBHOOK_SECRET` | Long random string; Apify sends it in the `X-Apify-Webhook-Secret` header |
| `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` | Dashboard / API login |

**Vars** are set in `wrangler.jsonc`:

| Var | Purpose |
| --- | --- |
| `DISPLAY_TIMEZONE` | Display time zone (default `Asia/Kolkata`) |
| `APIFY_TASK_ID` | Optional. When set, only runs of this Apify Task are ingested |

**Bindings** are set in `wrangler.jsonc`: `DB` is the D1 database `linkedin-job-scanner`, and `INGEST_QUEUE` is the Queue `linkedin-ingest-pages`.

**Cron Trigger** in `wrangler.jsonc`: `0 * * * *` (hourly, UTC) runs the raw_json retention. Retention length is `RAW_JSON_RETENTION_DAYS` in [`src/config/retention.ts`](src/config/retention.ts).

## Local development

Requires Node.js 22+. Local mode is for coding and testing only; production runs on Cloudflare.

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

- `npm test` runs Vitest inside the Workers runtime (workerd) against a local D1 with the real migrations. It never calls Apify: outbound network is blocked, and tests use the sanitized fixture [`tests/fixtures/apify-posts.sample.json`](tests/fixtures/apify-posts.sample.json).
- `npm run typecheck` generates runtime types (`wrangler types`) and runs `tsc`.
- `npm run build` is a Wrangler dry run that bundles and validates without uploading.

To run the Worker locally with a local D1:

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

## Deployment

### Cloudflare (one-time)

1. Log in.

   ```bash
   npx wrangler login
   ```

2. Create the D1 database, then copy the printed `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`).

   ```bash
   npx wrangler d1 create linkedin-job-scanner
   ```

3. Apply the schema.

   ```bash
   npx wrangler d1 migrations apply linkedin-job-scanner --remote
   ```

4. Create the ingest queue.

   ```bash
   npx wrangler queues create linkedin-ingest-pages
   ```

5. Deploy, and note the Worker URL it prints (`https://linkedin-job-scanner.<your-subdomain>.workers.dev`).

   ```bash
   npx wrangler deploy
   ```

6. Set the secrets. Each command prompts for the value.

   ```bash
   npx wrangler secret put APIFY_TOKEN
   ```

   ```bash
   npx wrangler secret put APIFY_WEBHOOK_SECRET
   ```

   ```bash
   npx wrangler secret put DASHBOARD_USERNAME
   ```

   ```bash
   npx wrangler secret put DASHBOARD_PASSWORD
   ```

   One way to generate a webhook secret:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

7. Check `https://<worker>/health` returns `{"status":"ok"}`, then open `https://<worker>/` and log in.

Later deploys only need `npx wrangler deploy`. New migrations need `npx wrangler d1 migrations apply linkedin-job-scanner --remote`.

### Apify (one-time)

1. **Task:** open `harvestapi/linkedin-post-search` in Apify Console, use *Create task*, and paste the input JSON above. In the task's run options, set a max total charge of $5 as a safety cap (a full run is at most ~$3.60).
2. **Schedule:** go to Schedules → *Create new*. Set cron `0 9,21 * * *` and timezone `Asia/Kolkata`, add the task, and **Enable** it (new schedules start disabled). Check that the next runs show 09:00 and 21:00 IST.
3. **Webhook:** on the task, go to Integrations → HTTP webhook.
   - Event: *Run succeeded* (`ACTOR.RUN.SUCCEEDED`)
   - URL: `https://<worker>/webhooks/apify` (exact, with no trailing slash)
   - Headers template: `{"X-Apify-Webhook-Secret": "<the APIFY_WEBHOOK_SECRET value>"}`
   - Keep the default payload template.
4. **Test:** the webhook's *Test* button should get `200 {"status":"ignored","eventType":"TEST"}`.
5. **First run:** start the task manually once. Within a minute or two, `/runs` should show it as `succeeded`.
6. Set `APIFY_TASK_ID` in `wrangler.jsonc` to the task id and redeploy, so only that task's runs are accepted. It is already set to the production task `linkedin-job-signals`.

### Recovery

Re-send a run's webhook if any of these happen:

- The run shows `failed` on `/runs`.
- The run has been `processing` for more than 30 minutes.
- Apify gave up on a webhook after ~32 h of retries.

The Worker restarts failed or stale runs, keeps the pages it already stored, and ignores runs that already succeeded.

```bash
curl -X POST "https://<worker>/webhooks/apify" -H "Content-Type: application/json" -H "X-Apify-Webhook-Secret: <secret>" -d "{\"eventType\":\"ACTOR.RUN.SUCCEEDED\",\"eventData\":{\"actorRunId\":\"<APIFY_RUN_ID>\"}}"
```

Logs are available with `npx wrangler tail`, or in the Cloudflare dashboard (Workers Logs). Logs contain run ids and counts only, never secrets or post text.

## Free-tier budget (Cloudflare)

| Resource | Free limit | This project (approx.) |
| --- | --- | --- |
| Worker CPU | 10 ms per invocation | one 25-post page per queue invocation, measured at 8.5 ms average and 17 ms max (a run's cold first page); webhook ~9 ms; the retention cron is one D1 statement |
| Worker requests | 100k / day | per run: 1 webhook + ~25 queue invocations; plus 24 cron runs a day and dashboard views |
| Queue operations | 10k / day | ~3 per page → ~75 per run |
| D1 rows written | 100k / day | ~8 per new post (row, indexes, counter) + ~2 per post when its `raw_json` is cleared → ~12k / day at ~1,200 new posts a day |
| D1 rows read | 5M / day | Unfiltered and per-query views read counters and index ranges (≈ page size). Author/text searches scan up to 90 days of posts (≤ ~110k rows each at ~1,200 posts a day). Deep pages read the skipped rows (capped at 10k). Retention reads ~5 rows per post it clears. |
| D1 storage | 500 MB per database | ~7 KB per post while `raw_json` is kept, ~3.2 KB after → see note below |

**Storage note:** at two runs a day (~1,200 new posts a day), the last 7 days of `raw_json` take ~30 MB and normalized posts grow ~4 MB a day, so the database reaches 500 MB in about 4 months. More frequent runs make it grow proportionally faster. Before then, either delete old non-matching posts once classification exists, or move to Workers Paid (10 GB).

## Project layout

```
src/
  worker.ts        Hono app + queue and cron handlers (entry point)
  config/          bindings (env.ts), Actor input + schedule (search-config.ts), raw_json retention (retention.ts)
  domain/          RawPost (Zod schema) and IngestRun types
  apify/           Apify API client (fetch) and schemas
  normalization/   Actor item → RawPost
  ingestion/       start a run (webhook), ingest one page (queue)
  maintenance/     hourly raw_json retention (cron)
  storage/         D1 repositories
  webhook/         POST /webhooks/apify
  routes/, views/  dashboard, runs, API, health
  lib/             time-zone helpers, constant-time compare
migrations/        D1 schema
tests/             Vitest (workerd + local D1), fixture, helpers
wrangler.jsonc     Worker, D1, Queue, cron and vars
```
