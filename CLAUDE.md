# LinkedIn Job Signal Scanner

## Product goal

A cloud-first job-signal discovery system. It collects broad candidate LinkedIn posts through the Apify Actor `harvestapi/linkedin-post-search`, stores them deduplicated in Cloudflare D1, and shows them on a dashboard. Later milestones will classify which posts are genuine active hiring opportunities, and for which persona:

1. Revenue Operations
2. Sales Operations
3. Vendor Manager / Vendor Management

Precision matters more than recall for the future classifiers. Retrieval is deliberately broad.

---

## Architecture

```
Apify Task (harvestapi/linkedin-post-search), scheduled 09:00 + 21:00 Asia/Kolkata
  -> Apify ACTOR.RUN.SUCCEEDED webhook
  -> Cloudflare Worker  POST /webhooks/apify
       verify secret + run (owner, Actor, status) -> record ingest run -> queue page 0 (25 items)
  -> Cloudflare Queue consumer (same Worker, one page per invocation)
       fetch page from Apify -> normalize -> dedupe insert into D1 -> record page
       -> full page: queue the next page; short/empty page: it is the last -> finish run
  -> Cloudflare D1
  -> Hono dashboard on the same Worker (/, /runs, /api/posts)

Cron Trigger (same Worker, hourly): raw_json -> NULL on posts stored more than 7 days ago

Later: -> job classifier -> persona classifier -> job_opportunities
```

Everything runs in the cloud. Nothing depends on a laptop, Claude Desktop/Code, a local scheduler, local SQLite, Docker or a VM. Cloudflare usage must stay within the Workers/D1/Queues **free** tier. Apify usage is not constrained.

The only supported LinkedIn acquisition source is the Apify Actor `harvestapi/linkedin-post-search`. Claude Desktop + the Apify MCP may be used for development (e.g. inspecting runs); the application must never depend on it.

---

## Apify configuration

Production Actor input (source of truth: `src/config/search-config.ts`):

- searchQueries:
  - `"Revenue Operations" OR RevOps`
  - `"Sales Operations" OR "Sales Ops"`
  - `"Vendor Manager" OR "Vendor Management"`
- maxPosts: 600 (per query, newest first). LinkedIn returns only ~190–230 results per search, so this means "everything available": in production a run reached back 4.4 h (Sales Ops), 6 h (Vendor) and 13.5 h (RevOps). Raising maxPosts cannot extend coverage; only more frequent runs or narrower queries can.
- postedLimit: "24h"
- sortBy: "date"
- profileScraperMode: "short"
- scrapeReactions, scrapeComments, postNestedReactions, postNestedComments: false

Do NOT set `contentType: "jobs"` and do NOT add "hiring" to the queries. Broad retrieval is intentional; the future classifier decides what is a hiring post. Overlap between the 09:00 and 21:00 runs is intentional; dedupe makes it harmless.

Schedule: Apify Schedule, cron `0 9,21 * * *`, timezone `Asia/Kolkata`, running an Actor **Task** that holds the input above. The webhook is attached to that Task (event `ACTOR.RUN.SUCCEEDED`), not to the Actor. Production Task: `linkedin-job-signals` (`liLBnhHQdXrDUkcyJ`, also `APIFY_TASK_ID`), with a $5 max total charge per run (a run is ~615 posts ≈ $1.23 today; at most 1,800 × $0.002 ≈ $3.60).

---

## Validated Actor output (sanitized fixture: tests/fixtures/apify-posts.sample.json)

- `id == entityId` in validated items; the outer LinkedIn activity id is the identity.
- `engagement.id` must never be used for identity (differs for ugcPost items).
- `linkedinUrl` is the canonical post URL (`shareLinkedinUrl` is a fallback).
- Reposts: outer `id`/`content`/`author` are the stored post; nested `repost.id` is saved as `repost_id`; a repost is never deduplicated against its original.
- `author.type` is `profile` or `company`; profile URLs carry `?miniProfileUrn=…`, which is stripped.
- `article` (title/subtitle/link), `repost`, `job`, `contentAttributes`, `engagement` and author fields are all optional.
- `contentAttributes[].company` holds tagged companies (future grounded company detection).
- `postedAt.date` is used for `posted_at` (fallback `postedAt.timestamp`).
- Post text can contain personal emails: never log post content.

Keep the fixture; it is the source of truth for normalization tests. Never replace it with invented structures.

---

## Normalization (src/normalization/post-normalizer.ts)

Each Actor item becomes a `RawPost` (Zod-validated):

source (always `apify_linkedin_post_search`), source_id, linkedin_post_id, entity_id, text, author_name, author_type, author_profile_url, author_headline, url, posted_at, search_query, apify_run_id, repost_id, article_title, article_url, likes, comments, shares, tagged_companies_json, raw_json, fetched_at.

source_id priority:

1. `li:<id>`
2. `li:<entityId>`
3. `url:<sha256(normalized linkedinUrl)>` (query + fragment + trailing slash stripped)

Never use `engagement.id`. Never invent identifiers, URLs, companies, titles, locations, authors, dates or compensation; unknown values stay `null`. One malformed item must never fail a page or a run — it is counted as invalid. `raw_json` keeps the full original item so a post can be re-normalized, but only for 7 days (see Retention); anything that needs the original item later must use the normalized columns instead.

---

## D1 schema (migrations/0001_initial.sql, 0002_raw_json_retention.sql)

- `raw_posts` — normalized posts; `UNIQUE(source, source_id)`; CHECK `source = 'apify_linkedin_post_search'`; indexes on posted_at, (search_query, posted_at), author_name, url, apify_run_id, created_at; partial index `idx_raw_posts_raw_json_pending` on created_at WHERE raw_json IS NOT NULL (0002). `raw_json` is NULL after 7 days.
- `ingest_runs` — one row per Apify run (`apify_run_id` UNIQUE); started_at, completed_at, dataset_id, query_config_json (the run's real INPUT), fetched, new, already_seen, invalid, status (`processing` | `succeeded` | `failed`), error, pages_total (0 until the last page is read), page_size (fixed at first claim).
- `ingest_run_pages` — one row per processed dataset page, written in the same D1 batch as that page's posts.
- `post_query_counts` — per-query totals maintained by triggers, so the dashboard never COUNT(*)-scans raw_posts.

Schema changes go in new numbered migration files; never edit an applied migration. Write trigger bodies with uppercase `BEGIN`/`END`; `.sql` files must use LF line endings (`.gitattributes` enforces it) — remote D1 migrations can fail on CRLF.

---

## Ingestion rules

- The webhook body is never trusted beyond the run id. The Worker re-fetches the run and requires: run `userId` == the token's user (`/users/me`; the run endpoint is readable without a token), `actId` == `buIWk2uOUzTmcLsuB`, status `SUCCEEDED`, and — if `APIFY_TASK_ID` is set — that task. `defaultDatasetId` comes from the API, not the payload.
- Webhook responses follow Apify's retry rule (any non-2xx is retried ~11 times over ~32 h): 200 for queued/duplicate/ignored (incl. `TEST` events), 401 bad secret, 409 run in progress, 422 unusable body/unknown run, 502/503 transient failures.
- Idempotency: `ingest_runs.apify_run_id` is UNIQUE and claimed atomically; posts insert with `ON CONFLICT (source, source_id) DO NOTHING`; pages are recorded once. Redelivered webhooks or queue messages never duplicate posts or run history.
- `new` = posts whose `apify_run_id` is this run (exact across retries); `already_seen` = valid − new.
- Never log secrets, tokens, request bodies or post text. Log only run ids, offsets and counts.

---

## Retention (src/maintenance/raw-json-retention.ts)

- An hourly Cron Trigger (`0 * * * *` in wrangler.jsonc) sets `raw_json = NULL` on posts whose `created_at` is more than `RAW_JSON_RETENTION_DAYS` (7, `src/config/retention.ts`) ago. Rows and normalized columns are kept indefinitely — never delete posts for retention.
- One bounded statement per run (≤ 2,000 posts, oldest first). It uses `INDEXED BY idx_raw_posts_raw_json_pending`, so it reads only the rows it clears and fails loudly rather than table-scanning if the index is missing.
- Idempotent: cleared posts no longer match; repeated or overlapping runs are harmless and a backlog drains over later runs. Never re-populate raw_json for old posts.

---

## Cloudflare free-tier constraints (design rules)

- Workers Free: **10 ms CPU per invocation** for HTTP, cron, queue consumers and workflow steps alike. Never process a whole dataset in one invocation — keep one page (`PAGE_SIZE` = 25 items) per queue invocation and keep the webhook handler light. 50-item pages measured 10–13 ms in production (23 ms on a cold start); do not raise the page size without measuring CPU again.
- 50 external subrequests per invocation; D1 may cap queries per invocation at 50. Insert posts with the chunked `json_each` statement (one statement per ≤ 900 KB chunk), not one statement per row.
- D1 Free: 500 MB per database, 5M rows read/day, 100k rows written/day. Every scanned row is billed: no `COUNT(*)` over raw_posts on page loads (use `post_query_counts`), filter/sort through indexes, keep page sizes small.
- D1 caps LIKE patterns at 50 bytes: use `instr(lower(col), lower(?))` for substring search.
- `meta.changes` includes trigger writes: use `RETURNING` to count inserts.
- Queues Free: 10k operations/day; one message per page.
- Never size a run from the dataset's `itemCount` (it lags after a run finishes): follow pages until a short one.
- Queue consumers must never throw: every failure becomes an explicit `retry({ delaySeconds })` or ack. A page past `MAX_PAGE_ATTEMPTS` marks its run failed (with partial totals) before doing any work, so an invocation that keeps dying still ends visibly.
- Author/free-text filters cannot use an index: they default to the last 90 days unless a `from` date is given. Cache `Intl.DateTimeFormat` instances (construction is expensive).

---

## Dashboard

Hono + server-rendered HTML (`hono/html`, auto-escaped) on the same Worker. No React, Vite or front-end build.

- `/` stat cards (stored posts, added today, last ingestion time, last run fetched/new/duplicates/invalid), posts per query, filters (search query, author, author type, date from/to, free text), recent posts.
- `/runs` ingestion history.
- `/api/posts` normalized JSON; `raw_json` only with `include_raw=1` (null for posts older than 7 days).
- `/health` public liveness check (no data).

Dashboard and API are behind HTTP Basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` secrets) and fail closed when not configured. No D1 management endpoints. Times and date filters use `DISPLAY_TIMEZONE` (default Asia/Kolkata).

---

## Secrets and configuration

Cloudflare secrets (`npx wrangler secret put <NAME>`): `APIFY_TOKEN`, `APIFY_WEBHOOK_SECRET`, `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`. Local `wrangler dev` reads them from `.env` (git-ignored; template `.env.example`).

Vars in `wrangler.jsonc`: `DISPLAY_TIMEZONE`, `APIFY_TASK_ID`. Bindings: `DB` (D1 `linkedin-job-scanner`), `INGEST_QUEUE` (Queue `linkedin-ingest-pages`). Cron Trigger: `0 * * * *` (raw_json retention). Never hardcode Cloudflare IDs in application code; the D1 `database_id` lives only in `wrangler.jsonc`.

Never print, log, commit or expose `APIFY_TOKEN`, the webhook secret, dashboard credentials or any environment value — not in HTML, API responses, errors, logs, fixtures or Git.

---

## Technology

TypeScript, Hono, Cloudflare Workers, D1, Queues, Wrangler, Zod (`import * as z from 'zod'` so it tree-shakes), plain `fetch` to the Apify API, Vitest 4 with `@cloudflare/vitest-plugin` (tests run in workerd against a real local D1).

Do not use: better-sqlite3 or any local SQLite runtime, Express, a Node HTTP server (`@hono/node-server`), Docker, VMs, Supabase, local cron, Playwright or any browser automation.

---

## Project structure

```
src/
  config/          env.ts (bindings), search-config.ts (Actor input, schedule, Actor id), retention.ts
  apify/           client.ts (fetch-based Apify API), types.ts (webhook/run/message schemas)
  domain/          raw-post.ts, ingest-run.ts
  normalization/   post-normalizer.ts
  storage/         posts.repository.ts, ingest-runs.repository.ts (D1)
  ingestion/       ingest-service.ts (start run, ingest page), queue-consumer.ts
  maintenance/     raw-json-retention.ts (hourly cron)
  webhook/         apify-webhook.ts
  routes/          dashboard.ts, runs.ts, api-posts.ts, health.ts, filters.ts
  views/           layout.ts, dashboard.ts, runs.ts
  lib/             time.ts, safe-equal.ts
  worker.ts        Hono app + queue and cron handlers (entry point)
migrations/        0001_initial.sql, 0002_raw_json_retention.sql
tests/             fixtures/, normalization/, storage/, webhook/, dashboard/, maintenance/, config/, lib/, setup/
wrangler.jsonc
```

---

## Testing

- `npm test` runs Vitest inside workerd with the real migrations applied to a local D1.
- Tests must never call the real Apify API: outbound network is blocked in `vitest.config.ts`; inject the fake Apify `fetch` from `tests/helpers.ts`.
- Use the sanitized fixture for normalization; synthesize extra items only by cloning it (`manyItems`).
- Run `npm test`, `npm run typecheck` and `npm run build` after meaningful changes.

---

## Explicitly out of scope

Do NOT implement unless the product scope changes:

- browser automation (Playwright, Puppeteer, etc.)
- LinkedIn login / session management / cookies
- any LinkedIn acquisition path other than harvestapi/linkedin-post-search
- proxies / IP rotation
- CAPTCHA bypass
- stealth / anti-detection / fingerprint spoofing
- automated LinkedIn actions (likes, comments, connections, messages)
- user-specific LinkedIn feeds
- CV tailoring, job applications, email generation
- hiring-manager research, company or salary enrichment, ATS scoring
- external job-board search
- LLM integration / AI scoring (until the classification milestone)

---

## Future pipeline (not implemented yet)

```
raw_posts -> job classifier (is_job_post, job_confidence, evidence_text)
          -> persona classifier (sales_operations | revenue_operations | vendor_manager | none)
          -> job_opportunities
```

Allowed persona values: `sales_operations`, `vendor_manager`, `revenue_operations`, `none`. No other personas.

Examples: Sales Operations Manager / Sales Ops Analyst → sales_operations; Revenue Operations Manager / RevOps Analyst → revenue_operations; Vendor Manager → vendor_manager; Sales Manager, Account Executive, Business Operations Manager, Marketing Operations Manager → none. When uncertain, prefer `none`.

Positive job signals: "We're hiring a Revenue Operations Manager", "I'm hiring a Sales Operations Analyst for my team", "My team at Acme is looking for a Vendor Manager", "Join our team as a Sales Operations Manager".

Not job posts: industry discussion, career advice, open-to-work posts, people announcing a new role, layoffs, growth announcements without a specific role, thought leadership, educational content, recruiter commentary without a vacancy, jobs where a target term is only a listed skill (e.g. "vendor management abilities").

Every positive classification must include `evidence_text` (the exact text proving an active vacancy); without it the post is not a job post. Unknown values remain `null`; never invent company, title, location, dates or compensation. Classification reads normalized post text, never raw HTML/JSON, and stays separate from ingestion and persistence. Classification tables are added in that milestone, not before.

---

## Engineering rules

- Keep acquisition, normalization, persistence and (later) classification separate.
- Keep configuration centralized (`src/config/`).
- Store raw posts before classification; preserve original LinkedIn URLs. raw_json is kept for 7 days only.
- Ingestion must stay idempotent; never store duplicate posts.
- Prefer precision over recall; unknown values stay null.
- Avoid unnecessary abstractions and dependencies; make the smallest reasonable change.
- No dead compatibility layers or commented-out legacy code.

---

## Git rules

Do not reinitialize Git, create a replacement repository, or rewrite history unless explicitly instructed. Make small logical commits (e.g. `feat: add apify webhook ingestion`, `fix: handle posts without entityId`). Never commit `.env`, `.dev.vars`, `.wrangler/`, `worker-configuration.d.ts`, `dist/`, logs, secrets or `node_modules`. Update README when behavior changes. Do not deploy, commit or push unless asked.

---

## Current milestone

CLOUD INGESTION + RAW-DATA DASHBOARD

Success criteria:

1. Apify scheduled Task → webhook → Worker → Queue → D1 works end to end in production.
2. Repeated webhook deliveries and overlapping runs create no duplicate posts or run rows.
3. The dashboard shows posts, stats and ingest history behind auth.
4. `npm test`, `npm run typecheck` and `npm run build` pass.

Do NOT implement job or persona classification yet. Once these criteria are met, stop and wait for the next milestone.
