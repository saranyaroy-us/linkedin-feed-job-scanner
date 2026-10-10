# LinkedIn Job Signal Scanner

## Product goal

A cloud-first job-signal discovery system. It collects broad candidate LinkedIn posts through the Apify Actor `harvestapi/linkedin-post-search`, stores them deduplicated in Cloudflare D1, and shows them on a dashboard. Later milestones will classify which posts are genuine active hiring opportunities, and for which persona:

1. Revenue Operations
2. Sales Operations
3. Vendor Manager / Vendor Management

Precision matters more than recall for the future classifiers. Retrieval targets posts that mention hiring: every query requires "hiring", and ingestion stores only posts whose text contains it AND whose job is confidently located in the US (see Ingestion rules).

---

## Architecture

```
Dashboard "Run Search" (manual; there is no job-search schedule)
  -> Cloudflare Worker  POST /search (dashboard auth + CSRF check)
       validate window -> record search_runs row (one search in flight at a time)
       -> start ONE run of the Apify Task: production input + window as a one-run override
Apify Task (harvestapi/linkedin-post-search)
  -> Apify ACTOR.RUN.SUCCEEDED webhook
  -> Cloudflare Worker  POST /webhooks/apify
       verify secret + run (owner, Actor, status) -> record ingest run -> queue page 0 (15 items)
  -> Cloudflare Queue consumer (same Worker, one page per invocation)
       fetch page from Apify -> hard filters: drop items whose text lacks "hiring",
          then items whose job is not confidently in the US (non-US / location unknown)
       -> normalize (+ job title, company, work mode, LinkedIn job URL, external apply URL)
       -> (date range: keep posts inside it)
       -> dedupe insert into D1 -> record page
       -> full page: queue the next page; short/empty page: it is the last -> finish run
  -> Cloudflare D1
  -> Hono dashboard on the same Worker (/, POST /search, /runs, /api/posts)

Cron Trigger (same Worker, hourly): raw_json -> NULL on posts stored more than 7 days ago

Later: -> job classifier -> persona classifier -> job_opportunities
```

Everything runs in the cloud. Nothing depends on a laptop, Claude Desktop/Code, a local scheduler, local SQLite, Docker or a VM. Cloudflare usage must stay within the Workers/D1/Queues **free** tier. Apify usage is not constrained.

The only supported LinkedIn acquisition source is the Apify Actor `harvestapi/linkedin-post-search`. Claude Desktop + the Apify MCP may be used for development (e.g. inspecting runs); the application must never depend on it.

---

## Apify configuration

Production Actor input (source of truth: `src/config/search-config.ts`):

- searchQueries (exactly these seven, `SEARCH_QUERIES`):
  - `"Revenue Operations" AND "hiring"`
  - `"Revenue Operation" AND "hiring"`
  - `"Sales Operations" AND "hiring"`
  - `"Sales Operation" AND "hiring"`
  - `"Sales Ops" AND "hiring"`
  - `"Vendor Manager" AND "hiring"`
  - `"Vendor Management" AND "hiring"`
- maxPosts: 600 (per query, newest first). LinkedIn returns only ~190–230 results per search, so this means "everything available": the earlier, broader OR queries reached back only 4.4 h (Sales Ops), 6 h (Vendor) and 13.5 h (RevOps). Raising maxPosts cannot extend coverage; only more frequent searches or narrower queries can.
- postedLimit: "24h" (Run Search overrides it per run; see Manual search)
- sortBy: "date"
- profileScraperMode: "short"
- scrapeReactions, scrapeComments, postNestedReactions, postNestedComments: false
- contentType: "all" (the input schema accepts nothing else)

Never set `contentType: "jobs"`; the future classifier decides which posts are actual vacancies. Every query keeps a quoted "hiring", but the Worker's hard filter is authoritative (LinkedIn matches quoted phrases loosely). Overlap between searches is intentional; dedupe makes it harmless.

There is no schedule: every job search is started manually from the dashboard. Never create, enable or expose an Apify Schedule, recurring controls or schedule settings. Run Search starts one run of an Actor **Task** and sends the input above as that run's input override. The Task's stored input must mirror the same production input, so a run started from the Apify Console searches the same way: `scripts/apify-task/task-input.json` is the mirror (a test keeps it equal to `PRODUCTION_SEARCH_CONFIG`), and `node scripts/apify-task/sync.mjs [--apply]` compares (dry run) or updates the stored input only — never its run options or webhook. Change the stored input only with approval, after changing the config. The webhook is attached to that Task (event `ACTOR.RUN.SUCCEEDED`), not to the Actor. Production Task: `linkedin-job-signals` (`liLBnhHQdXrDUkcyJ`, also `APIFY_TASK_ID`), with a $5 max total charge per run (seven queries × LinkedIn's ~200-result cap ≈ at most ~1,700 posts × $0.002 ≈ $3.40).

---

## Manual search (src/search/manual-search.ts, src/routes/run-search.ts)

- Windows: Past 24 hours, 7 days, 30 days → postedLimit `24h`, `week`, `month` (`WINDOW_POSTED_LIMIT`). Date Range (From/To, whole days in `DISPLAY_TIMEZONE`; both required, From ≤ To, To not in the future) → postedLimit `any` + `postedLimitDate` = start of From (the Actor's historical cutoff). Ingestion keeps only posts with posted_at in [start of From, end of To); the rest (incl. undated posts) are counted as `out_of_range`, never as duplicates. LinkedIn's ~200-results cap limits how far back a search can reach.
- Each search runs the Task (`POST /v2/actor-tasks/{APIFY_TASK_ID}/runs`) with the full `PRODUCTION_SEARCH_CONFIG` plus the window as a one-run input override. Run Search never modifies the Task; its stored input changes only through `scripts/apify-task/sync.mjs` (see Apify configuration). Never touch the Task's webhooks or run options, and never create or enable a schedule.
- One search at a time: `search_runs` gets a 'starting' row before Apify is called, in one `INSERT … WHERE NOT EXISTS` statement, so simultaneous submissions start a single run. A search is in flight while 'starting' (≤ 2 min) or 'started' until its ingest run succeeds or fails (≤ 30 min). While one is in flight, `GET /` checks its Apify run once per view and marks the search failed if the run FAILED, TIMED-OUT or ABORTED.
- `POST /search` is behind dashboard auth + `hono/csrf` (Basic credentials are resent cross-site) and answers 303 to `/?search=<code>`. The browser never receives `APIFY_TOKEN`.
- The only script is the inline Run Search script, allowed by its SHA-256 in the CSP (`RUN_SEARCH_SCRIPT_HASH`; a test recomputes it). Editing the script means updating the hash.

---

## Validated Actor output (sanitized fixture: tests/fixtures/apify-posts.sample.json)

- `id == entityId` in validated items; the outer LinkedIn activity id is the identity.
- `engagement.id` must never be used for identity (differs for ugcPost items).
- `linkedinUrl` is the canonical post URL (`shareLinkedinUrl` is a fallback).
- Reposts: outer `id`/`content`/`author` are the stored post; nested `repost.id` is saved as `repost_id`; a repost is never deduplicated against its original.
- `author.type` is `profile` or `company`; profile URLs carry `?miniProfileUrn=…`, which is stripped.
- `article` (title, subtitle = the link's domain, link, linkLabel, description — usually null, image), `repost`, `job`, `contentAttributes`, `engagement` and author fields are all optional. Job-board article titles are often the bare URL or "<title> | Apply on Job".
- `job` is LinkedIn's structured job card: title (often with trailing spaces), `linkedinUrl` (`https://www.linkedin.com/jobs/view/<id>/?refId=…&trackingId=…`), `location` ("Plano, Texas, United States", "Dallas, TX (On-site)", "United States (Remote)", "Sydney, New South Wales, Australia (Hybrid)"), subtitle ("Job by <company>"), logoUrl, buttonText, buttonTip (can contain a person's name — never stored). The fixture has none; tests add one in this shape.
- `contentAttributes[]` entries are `COMPANY_NAME` (`company: {id, name, linkedinUrl}`, a /company/ or /school/ page) or `PROFILE_MENTION` (`profile: {id, firstName, lastName, linkedinUrl, publicIdentifier}` — never used for the company); each also has start, length, hyperlink, textLink. Links in post text are almost always lnkd.in short links; the Actor gives no expanded URL.
- `postedAt.date` is used for `posted_at` (fallback `postedAt.timestamp`).
- Post text can contain personal emails: never log post content.

Keep the fixture; it is the source of truth for normalization tests. Never replace it with invented structures.

---

## Normalization (src/normalization/post-normalizer.ts)

Each Actor item becomes a `RawPost` (Zod-validated):

source (always `apify_linkedin_post_search`), source_id, linkedin_post_id, entity_id, text, author_name, author_type, author_profile_url, author_headline, url, posted_at, search_query, apify_run_id, repost_id, article_title, article_url, job_title, company_name, company_linkedin_url, work_mode, linkedin_job_url, external_apply_url, job_location_text, job_country, location_source, likes, comments, shares, tagged_companies_json, raw_json, fetched_at.

source_id priority:

1. `li:<id>`
2. `li:<entityId>`
3. `url:<sha256(normalized linkedinUrl)>` (query + fragment + trailing slash stripped)

Never use `engagement.id`. Never invent identifiers, URLs, companies, titles, locations, authors, dates or compensation; unknown values stay `null`. One malformed item must never fail a page or a run — it is counted as invalid. `raw_json` keeps the full original item so a post can be re-normalized, but only for 7 days (see Retention); anything that needs the original item later must use the normalized columns instead.

Job links (src/normalization/job-links.ts) — never fetched or expanded, no id ever guessed:

- `linkedin_job_url`: job card `linkedinUrl` → article link → the first LinkedIn Jobs URL in the post text → null. Only linkedin.com (or a subdomain) `/jobs/view/[title-slug-]<6–20-digit id>` or `/jobs/…?currentJobId=<id>` counts, canonicalized to `https://www.linkedin.com/jobs/view/<id>/` (query, refId/trackingId and fragment dropped).
- `external_apply_url`: an application link outside LinkedIn, kept as linked: the article link when it is a job page → the first job link in the post text → (only when the post has no other application link, LinkedIn's included) an lnkd.in link that the text introduces with "apply" on the same line. A job page is a known applicant-tracking system or job board (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Rippling, Indeed…), a jobs/careers/apply subdomain, or a whole path segment such as /jobs/, /careers/, /apply/ — never a home page, a blog post or any LinkedIn page. `isJobListingUrl` (LinkedIn Jobs or such a job page) also decides which attached articles count as job listings for the location, title, company and work mode.
- `article_url` keeps the article link unchanged.

Job details (src/normalization/job-details.ts) — unknown values stay null:

- `job_title`: job card `title` → the title of an attached job listing (page-title suffixes such as " | Apply on Job", " | Acme Careers", "… at Acme", "Job Application for …", "… Job in <place>" removed) → an explicit title in the post text: "Role:/Position:/Job title:" lines, or the words after "hiring" on the same line ("We're hiring a Sales Operations Manager", "Hiring: Head of RevOps"). Listing and text titles must read as one role — ending in a role word (Manager, Analyst, Lead, Specialist…) or starting with one ("Head of …", "Director, …") — and must not be a listing page ("Remote Jobs in …"); text titles need two words. Unrelated article headlines are never used.
- `company_name` / `company_linkedin_url`: job card "Job by <Company>" → the one company tagged in the post (`contentAttributes[].company`, company pages only, not schools; two different tags are ambiguous) → the company author → the employer in a job listing title ("… at Acme", "… | Acme Careers"). Names that look like job boards or recruiters ("Dallas Jobs", "Get9to5Jobs.com", "… Careers", "… Staffing", "… Talent") are skipped, except on the job card. The URL is canonical (`https://www.linkedin.com/company/<slug>/`), from the same source, or from a tagged company / the company author with the same name. Profile mentions and the author's headline are never read.
- `work_mode`: `remote` | `hybrid` | `onsite` from the job card (LinkedIn's "(Remote)/(Hybrid)/(On-site)" location suffix, or the title) → a job listing → the post text; `unknown` when no source states exactly one mode ("remote or hybrid", "remote teams", "on-site interview", "not remote" do not count; days in the office fit hybrid). NULL only for posts stored before 0006.

job_location_text, job_country and location_source are filled by the US-job filter at ingestion (see Ingestion rules).

---

## D1 schema (migrations/0001_initial.sql … 0007_screened_runs.sql)

- `raw_posts` — normalized posts; `UNIQUE(source, source_id)`; CHECK `source = 'apify_linkedin_post_search'`; indexes on posted_at, (search_query, posted_at), author_name, url, apify_run_id, created_at; partial index `idx_raw_posts_raw_json_pending` on created_at WHERE raw_json IS NOT NULL (0002). `raw_json` is NULL after 7 days. Nullable job_location_text, job_country (CHECK `'US'`), location_source (CHECK `job` | `article` | `post_text`) and linkedin_job_url (0005). Nullable job_title, company_name, company_linkedin_url, work_mode (CHECK `remote` | `hybrid` | `onsite` | `unknown`), external_apply_url, and partial index `idx_raw_posts_work_mode` on (work_mode, posted_at) WHERE work_mode IS NOT NULL (0006). likes/comments/shares stay stored (no longer shown on the dashboard).
- `ingest_runs` — one row per Apify run (`apify_run_id` UNIQUE); started_at, completed_at, dataset_id, query_config_json (the run's real INPUT), fetched, new, already_seen, invalid, out_of_range (0003), dropped_no_hiring (0004), dropped_non_us, dropped_location_unknown (0005), screened (0007: 1 when the run was ingested through the hard filters, set by `claim`; NULL for historical runs from before them), status (`processing` | `succeeded` | `failed`), error, pages_total (0 until the last page is read), page_size (fixed at first claim).
- `ingest_run_pages` — one row per processed dataset page (fetched, invalid, out_of_range, dropped_no_hiring, dropped_non_us, dropped_location_unknown), written in the same D1 batch as that page's posts.
- `search_runs` (0003) — one row per Run Search: search_window (`24h` | `week` | `month` | `range`), requested_from/requested_to (UTC instants, to exclusive), apify_run_id (UNIQUE, set once Apify accepted the run), status (`starting` | `started` | `failed`), error, started_at. Its results are the ingest_runs row with the same apify_run_id.
- `post_query_counts` — per-query totals maintained by triggers, so the dashboard never COUNT(*)-scans raw_posts.

Schema changes go in new numbered migration files; never edit an applied migration. Write trigger bodies with uppercase `BEGIN`/`END`; `.sql` files must use LF line endings (`.gitattributes` enforces it) — remote D1 migrations can fail on CRLF.

---

## Ingestion rules

- The webhook body is never trusted beyond the run id. The Worker re-fetches the run and requires: run `userId` == the token's user (`/users/me`; the run endpoint is readable without a token), `actId` == `buIWk2uOUzTmcLsuB`, status `SUCCEEDED`, and — if `APIFY_TASK_ID` is set — that task. `defaultDatasetId` comes from the API, not the payload.
- Webhook responses follow Apify's retry rule (any non-2xx is retried ~11 times over ~32 h): 200 for queued/duplicate/ignored (incl. `TEST` events), 401 bad secret, 409 run in progress, 422 unusable body/unknown run, 502/503 transient failures.
- Idempotency: `ingest_runs.apify_run_id` is UNIQUE and claimed atomically; posts insert with `ON CONFLICT (source, source_id) DO NOTHING`; pages are recorded once. Redelivered webhooks or queue messages never duplicate posts or run history.
- Hard "hiring" filter (src/ingestion/hiring-filter.ts), BEFORE normalization: an item is kept only if its post text (`content`) contains "hiring" after `normalize("NFKC")` and lowercasing (so #Hiring, HIRING, 𝗛𝗶𝗿𝗶𝗻𝗴 and WeAreHiring match). Dropped items are never normalized, deduped or written (no row, no raw_json) and are counted as `dropped_no_hiring` — never as invalid or duplicates.
- Hard US-job filter (src/ingestion/job-location.ts, reference data in location-data.ts), after the hiring filter and BEFORE normalization (`screenItems` in screen-items.ts runs both): an item is kept only if the JOB — never the author — is confidently in the US. Sources in order: `job.location`, an attached article that links to a job listing (its title/subtitle/description), the post text; the first source with an answer wins. US evidence: "United States"/"USA"/"U.S."/"U.S.A.", US-remote wording ("US Remote", "Remote, US", "(US)", "US-based", "in the US"), a known city followed by one of its states ("Austin, TX", "Austin, Texas"), a full state name (Georgia and Washington only after a city or as "Washington State"), a few metro names (NYC, SF Bay Area, Silicon Valley…), and in `job.location` any "City, ST". A two-letter code alone (IN, OR, ME) never counts; plain "Remote" is not enough. Non-US evidence: countries, job regions (EMEA, APAC…), provinces and major non-US cities. Matching is case-insensitive and Unicode-folded. A source with both kinds of evidence, or none, has no answer; with no answer at all the item is `dropped_location_unknown`, with a non-US answer `dropped_non_us` — never invalid, duplicates or out_of_range. Free text (post text and job-listing articles; never the structured job card) is read in context: URLs and email addresses are removed first; travel ("monthly travel to Calgary"), headquarters ("headquartered in…", "HQ:") and the author's own story ("as an Australian based in…", "I'm based in…", "I moved to…") are dropped; a place followed by what it qualifies ("U.S. healthcare clients", "US market", "NYC-based company") or preceded by a time-zone word ("Pacific Time (US)") or by "<clients/customers/operations…> in/across" does not count; geographic eligibility ("candidates in the United States", "US citizens") does; "SF" counts next to a workplace word ("Hybrid SF", "SF-based", "in SF"). Conflicting or missing evidence is rejected. Stored posts get job_country 'US', location_source, and job_location_text: the job card's location without LinkedIn's "(On-site)"-style suffix (that is work_mode), or up to three US places found, e.g. "Austin, TX" ("United States" only when nothing more specific). Precision over recall: unlisted cities in free text stay unknown.
- `new` = posts whose `apify_run_id` is this run (exact across retries); `already_seen` = fetched − dropped_no_hiring − dropped_non_us − dropped_location_unknown − invalid − out_of_range − new.
- A run started by a date-range search stores only posts that pass both hard filters AND were posted inside its range (looked up in `search_runs` by apify_run_id); other runs store every valid post that passes the filters. Each item is counted once, in order: no hiring, then non-US / location unknown, then invalid, then out_of_range.
- Never log secrets, tokens, request bodies or post text. Log only run ids, offsets and counts.

---

## Retention (src/maintenance/raw-json-retention.ts)

- An hourly Cron Trigger (`0 * * * *` in wrangler.jsonc) sets `raw_json = NULL` on posts whose `created_at` is more than `RAW_JSON_RETENTION_DAYS` (7, `src/config/retention.ts`) ago. Rows and normalized columns are kept indefinitely — never delete posts for retention.
- One bounded statement per run (≤ 2,000 posts, oldest first). It uses `INDEXED BY idx_raw_posts_raw_json_pending`, so it reads only the rows it clears and fails loudly rather than table-scanning if the index is missing.
- Idempotent: cleared posts no longer match; repeated or overlapping runs are harmless and a backlog drains over later runs. Never re-populate raw_json for old posts.

---

## Cloudflare free-tier constraints (design rules)

- Workers Free: **10 ms CPU per invocation** for HTTP, cron, queue consumers and workflow steps alike. Never process a whole dataset in one invocation — keep one page (`PAGE_SIZE` = 15 items) per queue invocation and keep the webhook handler light. 50-item pages measured 10–13 ms in production (23 ms on a cold start); with the hiring and US-job filters, 25-item pages of hiring posts measured ~4 ms median but 13 ms p95 on a fresh process's first pass (Node), so pages now hold 15 (~2.5 ms warm, ~3.5 ms first-pass median, 10–18 ms for a fresh process's very first page). Do not raise the page size without measuring CPU again. The free-text location check is most of a page's CPU (~0.17 ms per hiring post in Node): keep its regexes linear (no pattern that retries every word, such as an unanchored email match) and measure before adding another pass over the text.
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

- `/` Run Search card (window selector, Run Search button; "Starting search…" on submit, then "Search started" / "Search in progress" with the form disabled and a 15 s refresh until the results are stored), stat cards (stored posts, added today, last ingestion time — from the newest *screened* run; historical runs are never the "last run"), a "Last run" row of eight compact counters with tooltips (Fetched, New, Duplicates, No hiring, Non-US, Loc. unknown, Out of range, Invalid — `RUN_COUNTERS`, src/views/run-counters.ts), posts per query, a one-row filter toolbar on desktop (search query, company, work mode, author, posted from/to, post text; the field widths are set so none clips at 1280 px — re-measure when adding one), recent posts. Posts table (`table.posts`, fixed column widths so it always fits its card; stacked label/value rows at ≤ 760 px; only posts with job_country 'US' — `PostsRepository.search` adds that condition for the dashboard and `/api/posts`, so unclassified or legacy rows never appear; empty state "No US hiring posts stored yet. Run a search to discover opportunities."): Posted, Job (job_title), Company (linked to company_linkedin_url when known), Location (job_location_text without a trailing ", United States", plus a Remote / Hybrid / On-site badge when known), Posted by (author name linked to the profile, author info clamped to two lines), Post (the approved hiring-centered snippet, Show/Hide full text; an "Article:" line only when the article is not the job or apply link), Links (compact View job → linkedin_job_url, Apply → external_apply_url, View post → url; a missing link is not shown). "—" for unknown values. There is no engagement, query or author-type column. Company, author and post-text filters are substring searches limited to the last 90 days without a "from" date; work mode uses its index. The query card and the query filter list only the seven `SEARCH_QUERIES` (posts under other query values stay in D1, in the totals and in the posts table).
- `POST /search` starts a manual search (see Manual search).
- `/runs` search history: search window, status, started, completed, the eight run counters (plus Apify run id and input). Historical runs (screened NULL) carry a "Historical" badge and show "—" for the three hard-filter counters (which did not exist); their recorded fetched/new/duplicate counts are kept as audit records. No schedule information.
- `/api/posts` normalized JSON of US job posts only (incl. job_title, company_name, company_linkedin_url, work_mode, linkedin_job_url, external_apply_url and the job location fields; filters query, company, work_mode, author, author_type, from, to, q); `raw_json` only with `include_raw=1` (null for posts older than 7 days).
- `/health` public liveness check (no data).

Dashboard and API are behind HTTP Basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` secrets) and fail closed when not configured. No D1 management endpoints. Times and date filters use `DISPLAY_TIMEZONE` (default Asia/Kolkata).

---

## Secrets and configuration

Cloudflare secrets (`npx wrangler secret put <NAME>`): `APIFY_TOKEN`, `APIFY_WEBHOOK_SECRET`, `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`. Local `wrangler dev` reads them from `.env` (git-ignored; template `.env.example`).

Vars in `wrangler.jsonc`: `DISPLAY_TIMEZONE`, `APIFY_TASK_ID` (the Task Run Search starts; required for Run Search). Bindings: `DB` (D1 `linkedin-job-scanner`), `INGEST_QUEUE` (Queue `linkedin-ingest-pages`). Cron Trigger: `0 * * * *` (raw_json retention). Never hardcode Cloudflare IDs in application code; the D1 `database_id` lives only in `wrangler.jsonc`.

Never print, log, commit or expose `APIFY_TOKEN`, the webhook secret, dashboard credentials or any environment value — not in HTML, API responses, errors, logs, fixtures or Git.

---

## Technology

TypeScript, Hono, Cloudflare Workers, D1, Queues, Wrangler, Zod (`import * as z from 'zod'` so it tree-shakes), plain `fetch` to the Apify API, Vitest 4 with `@cloudflare/vitest-plugin` (tests run in workerd against a real local D1).

Do not use: better-sqlite3 or any local SQLite runtime, Express, a Node HTTP server (`@hono/node-server`), Docker, VMs, Supabase, local cron, Playwright or any browser automation.

---

## Project structure

```
src/
  config/          env.ts (bindings), search-config.ts (Actor input, Run Search windows, Actor id), retention.ts
  apify/           client.ts (fetch-based Apify API), types.ts (webhook/run/message schemas)
  domain/          raw-post.ts, ingest-run.ts, search-run.ts
  normalization/   post-normalizer.ts, job-details.ts (title, company, work mode), job-links.ts (LinkedIn job + apply URLs)
  storage/         posts.repository.ts, ingest-runs.repository.ts, search-runs.repository.ts (D1)
  search/          manual-search.ts (validate window, Actor input, start search, in-flight check)
  ingestion/       ingest-service.ts (start run, ingest page), queue-consumer.ts, screen-items.ts (hard filters),
                   hiring-filter.ts, job-location.ts + location-data.ts (US-job filter)
  maintenance/     raw-json-retention.ts (hourly cron)
  webhook/         apify-webhook.ts
  routes/          dashboard.ts, run-search.ts, runs.ts, api-posts.ts, health.ts, filters.ts
  views/           layout.ts, dashboard.ts, runs.ts, search-window.ts, post-snippet.ts, run-counters.ts
  lib/             time.ts, safe-equal.ts
  worker.ts        Hono app + queue and cron handlers (entry point)
migrations/        0001_initial.sql, 0002_raw_json_retention.sql, 0003_manual_search.sql, 0004_hiring_filter.sql, 0005_us_jobs.sql,
                   0006_job_details.sql, 0007_screened_runs.sql
scripts/           operator tools, dry run unless told otherwise: project.mjs (settings from wrangler.jsonc, APIFY_TOKEN from .env),
                   apify-task/ (task-input.json mirror + sync.mjs), legacy-reset/ (manifest.json, plan.mjs, cli.mjs)
tests/             fixtures/, normalization/, ingestion/, storage/, webhook/, dashboard/, search/, views/, maintenance/, config/, lib/, setup/,
                   helpers.ts, legacy-fixture.ts
wrangler.jsonc
```

---

## Testing

- `npm test` runs Vitest inside workerd with the real migrations applied to a local D1.
- Tests must never call the real Apify API: outbound network is blocked in `vitest.config.ts`; inject the fake Apify `fetch` from `tests/helpers.ts`.
- Use the sanitized fixture for normalization; synthesize extra items only by cloning it (`manyItems`, `itemsWithText`; both add a US job card shaped like production ones, `US_JOB`).
- Posts inserted directly in tests (bypassing ingestion) must go through `asUsPosts` to appear in the dashboard or API; legacy-reset tests use `tests/legacy-fixture.ts`.
- Run `npm test`, `npm run typecheck` and `npm run build` after meaningful changes.

---

## Legacy reset (scripts/legacy-reset/, one-time)

The 1,413 posts of the four pre-filter runs are deleted once, after migrations 0004–0007 and the new Worker are live, so the US job list starts empty. The scope is fixed by `manifest.json` (run ids, count, id range, SHA-256 of sorted source ids, job_country IS NULL); `cli.mjs` is a dry run unless given `--execute --confirm=<first 12 hex of the fingerprint>` and refuses to run when the database differs from the manifest or ingestion is active. Never run it against production, or delete posts any other way, without explicit approval and a fresh verified backup (README "Legacy reset"). Ingestion history, schema and newer posts are never touched. A full Time Travel restore discards everything written after the bookmark; once new posts exist, restore selectively from the export instead.

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

1. Run Search → Apify Task run → webhook → Worker → Queue → D1 works end to end in production.
2. Repeated webhook deliveries and overlapping runs create no duplicate posts or run rows.
3. The dashboard shows posts, stats and ingest history behind auth.
4. `npm test`, `npm run typecheck` and `npm run build` pass.

Do NOT implement job or persona classification yet. Once these criteria are met, stop and wait for the next milestone.
