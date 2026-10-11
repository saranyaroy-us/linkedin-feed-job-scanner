# LinkedIn Job Signal Scanner

A cloud-only pipeline that collects LinkedIn posts about US-based hiring for **Revenue Operations**, **Sales Operations** and **Vendor Manager / Vendor Management**, stores them deduplicated in Cloudflare D1, and shows them on a small dashboard. Every stored post is labeled by a deterministic classifier — **Relevant** (an opening in one of the three functions), **Needs review**, **Unrelated** or **Not a job** — and the dashboard shows the Relevant posts by default.

Nothing runs on your laptop. You start each search from the dashboard (**Run Search**); Apify runs it, and a Cloudflare Worker ingests the results and serves the dashboard. There is no schedule. Cloudflare usage fits the free tier.

## Architecture

```
Dashboard "Run Search"  →  Worker  POST /search   (dashboard login + same-origin check)
   │  validates the window, records the search (one at a time), starts ONE run
   │  of the Apify Task with the production input + the window as a one-run
   │  override (the Task itself is not changed), using the Worker's Apify token
   ▼
Apify Task: harvestapi/linkedin-post-search
   │  ACTOR.RUN.SUCCEEDED webhook  (header X-Apify-Webhook-Secret)
   ▼
Cloudflare Worker  POST /webhooks/apify
   │  checks the secret, re-fetches the run from the Apify API (must be your
   │  account, the right Actor, status SUCCEEDED), records an ingest run,
   │  queues the first 15-item dataset page
   ▼
Cloudflare Queue  linkedin-ingest-pages  →  same Worker, one page per invocation
   │  fetch page → hard filters: drop items whose text lacks "hiring",
   │  then items whose job is not confidently located in the US
   │  → normalize (+ job title, company, work mode, job and apply links)
   │  → (date range: keep posts inside it)
   │  → classify relevance (posts this run stores)
   │  → INSERT … ON CONFLICT DO NOTHING + their labels → record page (one transaction)
   │  → a full page queues the next one; a short (or empty) page is the last
   │  → when every page is in, the run is marked succeeded with its totals
   ▼
Cloudflare D1  linkedin-job-scanner   (raw_posts, post_classifications, ingest_runs, search_runs, …)
   ▼
Hono dashboard on the same Worker:  /   POST /search   /runs   /api/posts   (HTTP Basic auth)

Cron Trigger on the same Worker, hourly:  raw_json → NULL once a post is older than 7 days
```

Why a queue? The Workers Free plan allows **10 ms of CPU per invocation**. Parsing and storing a whole run (up to ~1,800 posts, ~7 MB of JSON) in the webhook request would exceed that. Splitting it into 15-item pages gives each page its own invocation and CPU budget, plus automatic retries. (50-item pages measured 10–13 ms of CPU in production, so the page size was halved to 25; the hiring and US-job filters made each hiring post more expensive to screen, so it is now 15.)

Why follow pages instead of counting them first? Apify's dataset item count can lag for a few seconds after a run finishes. Sizing the run from that count could silently drop the last posts, so the Worker keeps reading pages until one comes back short.

### Idempotency

Apify delivers webhooks at least once and retries failures for about 32 hours, and searches overlap (a 7-day search after a 24-hour one returns many of the same posts). Duplicates are harmless:

- Each post is stored once, keyed by `(source, source_id)`. `source_id` is `li:<id>`, then `li:<entityId>`, then `url:<sha256(normalized linkedinUrl)>`. `engagement.id` is never used.
- Each Apify run has exactly one `ingest_runs` row (`apify_run_id` is UNIQUE). A redelivered webhook is a no-op if the run succeeded, gets `409` (Apify retries later) while it is still processing, and restarts it if it failed.
- Each dataset page is recorded in the same transaction as its posts, so a redelivered queue message is skipped. The "queue next page" step is repeated on redelivery, so a lost message cannot break the chain.
- Failed pages retry with backoff (30 s, 1, 2, 4 min). After 5 attempts, or a non-retryable Apify error, the run is marked `failed` with partial totals. Nothing is lost: re-sending the webhook resumes it (see Recovery).
- A run's **new** count is the number of posts that run stored first. **Duplicates** (`already_seen`) is the rest of the run's valid posts: fetched minus new, invalid, the three drop reasons (**no hiring**, **non-US**, **location unknown**; see below) and out of range (date-range searches). Each item is counted under exactly one of these.

## Apify Actor and Run Search

- **Actor:** `harvestapi/linkedin-post-search` (id `buIWk2uOUzTmcLsuB`). It is the only LinkedIn source.
- **Search input:** source of truth is [`src/config/search-config.ts`](src/config/search-config.ts). Every search sends this input (with the chosen window) as a one-run override; Run Search never modifies the Task. The Task's stored input must mirror this input too, so a run started from the Apify Console searches the same way: [`scripts/apify-task/task-input.json`](scripts/apify-task/task-input.json) is that mirror (a test fails if it differs from `PRODUCTION_SEARCH_CONFIG`), and `node scripts/apify-task/sync.mjs` shows the differences (dry run) or, with `--apply`, updates the stored input and verifies it. Only the input is written: run options (the $5 charge cap) and the webhook are left as they are.

  ```json
  {
    "searchQueries": [
      "\"Revenue Operations\" AND \"hiring\"",
      "\"Revenue Operation\" AND \"hiring\"",
      "\"Sales Operations\" AND \"hiring\"",
      "\"Sales Operation\" AND \"hiring\"",
      "\"Sales Ops\" AND \"hiring\"",
      "\"Vendor Manager\" AND \"hiring\"",
      "\"Vendor Management\" AND \"hiring\""
    ],
    "maxPosts": 600,
    "postedLimit": "24h",
    "sortBy": "date",
    "contentType": "all",
    "profileScraperMode": "short",
    "scrapeReactions": false,
    "scrapeComments": false,
    "postNestedReactions": false,
    "postNestedComments": false
  }
  ```

  `contentType` is always `"all"`, never `"jobs"`: the future classifier decides which posts are actual vacancies.
- **Hard "hiring" filter:** LinkedIn matches quoted phrases loosely, so the Worker is authoritative. Before normalization, every dataset item's post text (`content`) is Unicode-normalized (NFKC, which turns styled letters such as 𝗛𝗶𝗿𝗶𝗻𝗴 into plain ones), lowercased and checked for "hiring" (also inside words such as #WeAreHiring). Items without it are dropped: no row, no `raw_json`, no dedupe or D1 work. They are counted per run as **no hiring** (`dropped_no_hiring`), never as invalid or duplicates.
- **Hard US-job filter:** next, the Worker works out where the *job* is (never where the author is) and keeps only jobs that are confidently in the US. It reads LinkedIn's structured job card (`job.location`), then an attached article that links to a job listing (its title, subtitle and description), then the post text; the first that gives an answer wins.
  - **US:** "United States", "USA", "U.S.", "U.S.A."; US-remote wording ("US Remote", "Remote, United States", "Remote (US)", "US-based", "in the US"); a known US city with its state ("New York, NY", "Austin, Texas"); a full state name; a few metro names ("NYC", "San Francisco Bay Area"). In the job card, "City, ST" counts for any city.
  - **Not enough on its own:** plain "Remote"; two-letter words that are also state codes ("IN", "OR", "ME"); a city without its state; "Georgia" or "Washington" without a city (also a country and a surname).
  - **Non-US:** countries, job regions (EMEA, APAC, LATAM…), provinces and major cities outside the US ("London, UK", "Toronto, Canada", "Bangalore, India").
  - Both kinds of evidence in one source ("New York, NY and London, UK") or none at all mean the location is unknown.
  - **Free text is read in context** (the post text and job-listing articles, not the structured job card): URLs and email addresses are ignored (an `@acme.co.uk` address, a `/job/us/` link or a company website say nothing about the job); so are travel destinations ("Hybrid SF, monthly travel to Calgary" is a US job, "London based, occasional travel to New York" is not), the employer's headquarters ("headquartered in Austin, TX", "a NYC-based company") and the author's own story ("as an Australian based in New York", "I live in Denver"). A place that describes something other than the workplace does not count either: "U.S. healthcare clients", "US market", "Pacific Time (US)", "customers across the U.S.", "supporting United States operations". Geographic eligibility does ("open to candidates in the United States", "US citizens only"). "SF" counts next to a workplace word ("Hybrid SF", "SF-based", "in SF").

  Dropped items are counted as **non-US** (`dropped_non_us`) or **location unknown** (`dropped_location_unknown`), never as invalid, duplicates or out of range, and nothing of them is stored. Stored posts get `job_country = 'US'`, `location_source` (`job`, `article` or `post_text`) and `job_location_text` (the job card's location without LinkedIn's "(On-site)"-style work mode, or the places found, such as "Austin, TX"). Matching is case-insensitive and folds styled Unicode letters and accents. The rules favour precision: a job in a city that is not on the list and is named only in the post text counts as unknown. A date-range search stores a post only if it passes both filters *and* was posted inside the range.
- **LinkedIn job URL:** `linkedin_job_url` is the post's LinkedIn Jobs listing: the job card's `linkedinUrl`, else the attached article's link, else the first LinkedIn Jobs URL in the post text. Only `linkedin.com/jobs/view/<numeric id>` (optionally with a title slug before the id) and `linkedin.com/jobs/…?currentJobId=<id>` count, always stored as `https://www.linkedin.com/jobs/view/<id>/` without tracking parameters (`trackingId`, `refId`…), other query parameters or fragments. External apply pages (Greenhouse, Lever, Ashby, Workday, career sites) go to `external_apply_url` instead; other LinkedIn pages and `lnkd.in` short links give `null`; no job id is ever guessed. `article_url` keeps the article link as before.
- **External apply URL:** `external_apply_url` is an application link outside LinkedIn, stored as linked: the attached article's link when it is a job page, else the first job link in the post text, else — only when the post has no other way to apply, LinkedIn's included — an `lnkd.in` link that the text introduces with "apply" ("Apply here: https://lnkd.in/…"). A job page is a known applicant-tracking system or job board (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Rippling, Indeed…), a `jobs.`/`careers.`/`apply.` site, or a page under `/jobs/`, `/careers/`, `/apply/`… — never a home page, a blog post or a LinkedIn page. Nothing is fetched or expanded.
- **Job title:** the job card's title, else the title of an attached job listing (site suffixes such as " | Apply on Job" or " | Acme Careers" removed), else an explicit title in the post text: a labeled line ("Role:", "Position:", "Position Title:", "Job title:", "Job:", also after an emoji such as "💼 Position:"), a job alert ("New … Job: <title> at <Company>"), or the words after "hiring" on the same line ("We're hiring a Sales Operations Manager", "#NOWHIRING: …"). Listing and text titles must read as one role (ending in a word such as Manager, Analyst, Lead or PM, or starting with "Head of …", "Director, …"); a labeled title may also end in the function ("Vertical Sales Strategy and Operations") and keep a spaced dash ("Airframe Vendor Maintenance - Program Manager"). "and" joins words of one title ("Sales and Operations Management Trainee") but not two complete roles ("Sales Manager and Recruiter"). A digest of several jobs (two or more hiring headers naming different titles) gets no title. "&amp;" artifacts of the source text are decoded. `job_title_source` records where the title came from (`job_card`, `listing` or `text`). An unrelated article headline is never used. Otherwise `null`.
- **Company:** the job card's "Job by <Company>", else an employer the post names outright ("Company: …", "Employer: …", or a job alert's "… at <Company>") — so a job-alert account or agency that posted it is not shown as the employer — else the one company tagged in the post, else the company that posted it, else the employer named in a job listing title ("… at Acme"). Placeholders and descriptions ("Confidential", "Well Reputed Organization", "IT Sector") are never stored. Job boards and recruiters ("Dallas Jobs", "… Careers", "… Staffing") are skipped, and people mentioned in the post or the author's headline are never used. `company_linkedin_url` is the company's LinkedIn page (`https://www.linkedin.com/company/<slug>/`) when the post links it.
- **Work mode:** `remote`, `hybrid` or `onsite` when the job card ("Dallas, TX (On-site)"), a job listing or the post text states exactly one; in the post text a labeled line ("Remote Option: Hybrid", "Work Mode: Onsite", "Work Arrangement: In-Office") is read first. `unknown` otherwise ("remote or hybrid", "remote teams", "on-site interview" do not count).
- **Coverage:** `maxPosts` is per query, newest first. LinkedIn returns only ~190–230 results per search (187, 228 and 203 in production), so 600 means "everything available". On 2026-10-03 the earlier, broader OR queries reached back only 4.4 h for Sales Ops, 6 h for Vendor Management and 13.5 h for RevOps; the narrower "hiring" queries should reach further. A higher `maxPosts` cannot extend that; only more frequent searches or narrower queries can. The same cap limits historical searches: a 30-day or date-range search still returns at most ~200 posts per query, newest first.
- **Run Search windows:** *Past 24 hours*, *7 days* and *30 days* set `postedLimit` to `24h`, `week` and `month`. *Date Range* (From/To, whole days in `DISPLAY_TIMEZONE`, To not in the future) sets `postedLimit: "any"` and the Actor's historical cutoff `postedLimitDate` (the start of From); ingestion then keeps only posts posted from the start of From to the end of To and counts the rest as out of range (undated posts included).
- **One search at a time:** a search is recorded before Apify is called, in one statement that fails if another search is still in flight, so double clicks and simultaneous submissions start a single run. A search stops blocking new ones when its ingestion finishes, when Apify reports its run failed, or after 30 minutes.
- **No schedule:** searches only run when started from the dashboard. Nothing creates or enables an Apify schedule.
- **Cost:** about $0.002 per post (and $0.001 per query with no results). With LinkedIn's ~200-result cap per query, a run of the seven queries returns at most ~1,700 posts (~$3.40). The Task's max total charge of $5 is a safety cap.

## Job relevance classification

Every post the hard filters store is labeled at ingestion, in the same transaction, by a deterministic classifier ([`src/classification/job-relevance.ts`](src/classification/job-relevance.ts); no LLM). It reads the normalized post only — never the author, the search query that found it or raw JSON — and a target function counts only in a **role title** (the job card, a job listing, a labeled or "hiring" line) or as "join our <function> team"; a function named only as a duty or skill ("vendor management experience") never makes a post relevant.

| Label | Meaning |
| --- | --- |
| **Relevant** | An actual opening whose role is Revenue Operations / RevOps, Sales Operations / Sales Ops (incl. "Sales Strategy and Operations", GTM Operations) or Vendor Management / Vendor Manager (incl. Supplier Manager, Third-party risk management), any seniority. |
| **Needs review** | An opening that may be one: a supporting technical role in the function (a Salesforce Administrator on a Sales Operations team, a "Revenue Operations Systems Analyst") unless the post lists at least three of the function's duties (forecasting, quotas, territories, deal desk…); an expert or advisor gig; an adjacent title (vendor, supplier, procurement, business operations); or the function named right at the hiring statement without a title. |
| **Unrelated** | An opening for another role, including combined "Sales & Operations" jobs, revenue-cycle and billing roles. |
| **Not a job** | No vacancy: commentary, advice, staffing promotion or talent-pool outreach. |

Each label keeps its persona (`revenue_operations`, `sales_operations`, `vendor_manager` or `none`), hiring intent, the exact evidence (the role title or team phrase, never post text) and a short reason. Posts stored before the classifier existed are labeled by the backfill (below).

## Data model (D1)

The schema is in [`migrations/`](migrations/): `0001_initial.sql`, `0002_raw_json_retention.sql`, `0003_manual_search.sql`, `0004_hiring_filter.sql`, `0005_us_jobs.sql`, `0006_job_details.sql`, `0007_screened_runs.sql` (`ingest_runs.screened`: 1 for runs ingested through the hard filters, NULL for historical runs) and `0008_job_relevance.sql` (`raw_posts.job_title_source`, `post_classifications`, `relevance_counts`).

| Table | Purpose |
| --- | --- |
| `raw_posts` | One normalized post per LinkedIn activity. `UNIQUE(source, source_id)`, `source` is always `apify_linkedin_post_search`. Keeps `raw_json` (the full Actor item) for 7 days so a post can be re-normalized; after that `raw_json` is `NULL`. Rows and normalized fields are kept indefinitely. |
| `search_runs` | One row per Run Search: the window (`24h`, `week`, `month` or `range`), requested from/to (UTC instants), Apify run id, status (`starting`, `started` or `failed`), error and start time. Its results are the `ingest_runs` row with the same Apify run id. |
| `ingest_runs` | One row per Apify run: started/completed time, Apify run id, dataset id, the run's actual input, fetched / new / already seen / no hiring / non-US / location unknown / invalid / out of range (filled when the run succeeds, or with partial totals when it fails), status (`processing`, `succeeded` or `failed`), error, `pages_total` (0 until the last short or empty page is read) and `page_size`. |
| `ingest_run_pages` | Pages of a run that have been processed, with their counts (makes queue redelivery safe). |
| `post_query_counts` | Per-query post totals kept up to date by triggers, so the dashboard never scans the whole table. |
| `post_classifications` | One relevance label per post: classifier version, relevance, persona, hiring intent, role title and where it came from, evidence and reason. Deleted with its post. |
| `relevance_counts` | Posts per label, kept up to date by triggers, for the dashboard's view tabs. |

Normalized post fields: `source`, `source_id`, `linkedin_post_id`, `entity_id`, `text`, `author_name`, `author_type` (`profile` or `company`), `author_profile_url` (query string stripped), `author_headline`, `url` (`linkedinUrl`), `posted_at` (`postedAt.date`), `search_query`, `apify_run_id`, `repost_id` (nested `repost.id`; the outer post stays the identity), `article_title`, `article_url`, `job_title`, `job_title_source` (`job_card`, `listing` or `text`), `company_name`, `company_linkedin_url`, `work_mode` (`remote`, `hybrid`, `onsite` or `unknown`), `linkedin_job_url` (canonical LinkedIn Jobs URL), `external_apply_url`, `job_location_text`, `job_country` (`US`), `location_source`, `likes`, `comments`, `shares` (stored, not shown on the dashboard), `tagged_companies_json`, `raw_json` (7 days, then `null`) and `fetched_at`. Unknown values are `null`. A malformed item is counted as invalid and never fails the run.

**raw_json retention.** An hourly Cron Trigger on the same Worker sets `raw_json = NULL` on posts stored (`created_at`) more than 7 days ago, at most 2,000 per run, oldest first. Nothing else changes and no row is deleted. A partial index (`0002_raw_json_retention.sql`) holds only the posts that still have `raw_json`, so each run reads just the rows it clears. Running it again, or twice at once, does nothing.

## Dashboard and API

All pages require HTTP Basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`), because the data contains LinkedIn posts.

- **`/`**: **Run Search** (Past 24 hours, 7 days, 30 days or a date range). The button shows "Starting search…" and is disabled on submit; after Apify accepts the run the page shows "Search started", then "Search in progress" (form disabled, page refreshes every 15 s) until the results are stored. Below it: stored posts, posts added today and last ingestion time (from the newest run ingested through the hard filters; historical runs are not the "last run"), then a **Last run** row of eight compact counters: Fetched, New, Duplicates, No hiring, Non-US, Loc. unknown, Out of range and Invalid (hover for a description). Also shows post counts for the seven search queries (`SEARCH_QUERIES` in [`src/config/search-config.ts`](src/config/search-config.ts); posts stored under any other query value, such as earlier searches, stay in D1 and in the table but are not listed), a one-row filter toolbar, and a newest-first table of US job posts (only posts the US-job filter stored, `job_country = 'US'`; older or unclassified rows never appear). Tabs above it switch between **Relevant** (the default), **Needs review** and **All**, each with its count; every view keeps the other filters. The Job column shows the persona (RevOps, Sales Ops, Vendor Mgmt) and, outside the Relevant view, the label (Needs review, Unrelated, Not a job, Unclassified); hover for the reason and evidence. Exact totals ("of N") come from the counter tables: per label in a relevance view, per query in All. The table has compact columns: **Posted**, **Job** (title), **Company** (linked to its LinkedIn page when known), **Location** (without the country, plus a Remote / Hybrid / On-site badge when known), **Posted by** (the author's name linked to their profile, and their headline), **Post** (the hiring-centered snippet with Show / Hide full text, a repost marker, and an article line when the article is not the job link) and **Links** (View job → LinkedIn job, Apply → external apply link, View post → the post; only the links that exist). Unknown values show "—". With no posts yet the table reads "No US hiring posts stored yet. Run a search to discover opportunities."; an empty Relevant view with other posts stored points to Needs review and All. Likes, comments, shares, the search query and the author type are no longer shown. The columns have fixed widths, so the table always fits its card; on phones each post becomes a stacked card. Filters: search query (one of the seven), company, work mode, author, posted from/to and post text. Company, author and post-text searches cover the last 90 days unless "Posted from" is set, since they cannot use an index and would otherwise scan the whole table; work mode has its own index.
- **`POST /search`**: the Run Search form. Requires the dashboard login and a same-origin form post (CSRF check). Starts the search with the Worker's Apify token (the browser never sees it) and redirects back to `/` with the outcome.
- **`/runs`**: the 60 most recent searches, newest first. Each shows its search window, status (`starting`, `running`, `processing`, `succeeded`, `failed` or `unknown`, with the reason), started and completed time, the same eight counters as the dashboard, the Apify run id (linked to Apify Console) and the run's actual input. Counts show "…" while a search is in flight. Runs ingested before Run Search existed show the window from their input. Runs ingested before the hard filters are marked **Historical** and kept as audit records (their fetched / new / duplicate counts as recorded; "—" for the filter counters, which did not exist then).
- **`/api/posts`**: normalized US job posts (`job_country = 'US'`) as JSON, including `job_title`, `company_name`, `company_linkedin_url`, `work_mode`, `linkedin_job_url`, `external_apply_url` and the job location fields (`null` when unknown). Each post carries its classification (`relevance`, `persona`, `hiring_intent`, `evidence_text`, `relevance_reason`; `null` when not classified yet). Same filters (`query`, `company`, `work_mode`, `author`, `author_type`, `from`, `to`, `q`) plus `relevance` (`relevant`, `needs_review`, `unrelated`, `not_a_job` or `all`, the default), `limit` (≤ 100) and `offset`. `raw_json` is only included with `include_raw=1` (≤ 20 per page), and is `null` once a post is older than 7 days. `search_window_from` is set when a company, author or text search was limited to the last 90 days.
- **`/health`**: public liveness check that returns no data.

Times and date filters use `DISPLAY_TIMEZONE` (default `Asia/Kolkata`).

## Configuration

**Secrets** are set with `npx wrangler secret put <NAME>`. For local `wrangler dev`, put them in `.env` (git-ignored; copy `.env.example`).

| Secret | Purpose |
| --- | --- |
| `APIFY_TOKEN` | Apify API token; the Worker starts searches and reads runs and datasets with it |
| `APIFY_WEBHOOK_SECRET` | Long random string; Apify sends it in the `X-Apify-Webhook-Secret` header |
| `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` | Dashboard / API login |

**Vars** are set in `wrangler.jsonc`:

| Var | Purpose |
| --- | --- |
| `DISPLAY_TIMEZONE` | Display time zone (default `Asia/Kolkata`) |
| `APIFY_TASK_ID` | The Apify Task that Run Search starts (required for Run Search); only runs of this Task are ingested |

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

1. **Task:** open `harvestapi/linkedin-post-search` in Apify Console, use *Create task*, and paste the input JSON above. In the task's run options, set a max total charge of $5 as a safety cap (a full run is at most ~$3.40). Do not add a schedule: searches are started from the dashboard.
2. **Webhook:** on the task, go to Integrations → HTTP webhook.
   - Event: *Run succeeded* (`ACTOR.RUN.SUCCEEDED`)
   - URL: `https://<worker>/webhooks/apify` (exact, with no trailing slash)
   - Headers template: `{"X-Apify-Webhook-Secret": "<the APIFY_WEBHOOK_SECRET value>"}`
   - Keep the default payload template.
3. **Test:** the webhook's *Test* button should get `200 {"status":"ignored","eventType":"TEST"}`.
4. Set `APIFY_TASK_ID` in `wrangler.jsonc` to the task id and redeploy: Run Search starts that Task, and only its runs are accepted. It is already set to the production task `linkedin-job-signals`.
5. **First search:** use Run Search on the dashboard. Within a few minutes, `/runs` should show it as `succeeded`.

### Recovery

Re-send a run's webhook if any of these happen:

- The run shows `failed` on `/runs`.
- The run has been `processing` for more than 30 minutes.
- Apify gave up on a webhook after ~32 h of retries.

The Worker restarts failed or stale runs, keeps the pages it already stored, and ignores runs that already succeeded. A search that shows `failed` or `unknown` without an ingested run can simply be started again with Run Search.

```bash
curl -X POST "https://<worker>/webhooks/apify" -H "Content-Type: application/json" -H "X-Apify-Webhook-Secret: <secret>" -d "{\"eventType\":\"ACTOR.RUN.SUCCEEDED\",\"eventData\":{\"actorRunId\":\"<APIFY_RUN_ID>\"}}"
```

Logs are available with `npx wrangler tail`, or in the Cloudflare dashboard (Workers Logs). Logs contain run ids and counts only, never secrets or post text.

### Legacy reset (one-time, after the hard filters are deployed)

The four runs ingested before the hiring and US-job filters (2026-10-03 to 2026-10-05) stored 1,413 posts that do not meet the current rules. The reset deletes exactly those posts so the US job list starts empty; the database, schema, migrations, indexes, triggers, ingestion history (`ingest_runs`, `ingest_run_pages`, `search_runs`), the Apify Task, the queue, secrets and the cron are kept. Their runs stay on `/runs` as historical audit records.

- [`scripts/legacy-reset/manifest.json`](scripts/legacy-reset/manifest.json) fixes the scope: the four run ids, 1,413 posts, post ids 1–1748 and a SHA-256 of the exact sorted source ids. Posts must also have no `job_country` (every post stored since the US-job filter has `US`).
- [`scripts/legacy-reset/cli.mjs`](scripts/legacy-reset/cli.mjs) is a dry run by default. It refuses to delete unless the database matches the manifest exactly, no ingestion or Apify run is in progress, and `--execute --confirm=<first 12 characters of sourceIdsSha256>` is given. Deletion is one `DELETE` (atomic, with the trigger that updates `post_query_counts`), then the emptied per-query rows are removed; both steps are idempotent, so after any failure running it again finishes the job. It then verifies that only the scope changed and that the counters match. It prints counts only.

Procedure (each production step needs explicit approval):

1. Confirm nothing is running: no `processing` rows in `ingest_runs` and no READY/RUNNING Apify run of the Task (the CLI checks both).
2. Record the Worker version (`npx wrangler deployments list`) and the D1 Time Travel bookmark (`npx wrangler d1 time-travel info linkedin-job-scanner`).
3. Export a fresh backup outside the repository: `npx wrangler d1 export linkedin-job-scanner --remote --output <secure folder outside the repo>/prod-<timestamp>.sql`. Check it restores: `npx wrangler d1 execute linkedin-job-scanner --local --persist-to <short temp dir> --file <backup>`, then count `raw_posts` (use a short path on Windows: long `--persist-to` paths fail).
4. Dry run: `node scripts/legacy-reset/cli.mjs --remote` must report `"state": "ready"` with 1,413 scope posts.
5. Execute (separate approval): `node scripts/legacy-reset/cli.mjs --remote --execute --confirm=7f5423824985`; the report must show `"problems": []`.
6. Validate: `/` shows 0 stored posts and the empty state, `/api/posts` returns no posts, `/runs` still lists the historical runs.

Recovery: Time Travel (`npx wrangler d1 time-travel restore linkedin-job-scanner --bookmark=<recorded bookmark>`) returns the whole database to that moment and discards everything written since, including posts from searches made after the reset. Use it only right after a failed reset. Once new searches have stored posts, restore selectively instead: load the export into a local or temporary database and copy back only the rows needed.

### Backfill (job details and relevance labels, after migration 0008)

Posts stored before the classifier have no label, and their job details came from the older rules. [`scripts/backfill/cli.mjs`](scripts/backfill/cli.mjs) re-derives `job_title`, `job_title_source`, `company_name`, `company_linkedin_url` and `work_mode` from `raw_json` (kept 7 days; nothing else changes) and labels every post without a current classification ([`src/maintenance/backfill.ts`](src/maintenance/backfill.ts)). It is a dry run by default and prints counts, titles, employers and labels (`--show` lists each post), never post text. Execution needs migration 0008, no ingestion in progress and `--confirm=<first 12 characters of the plan fingerprint>` from a dry run of the same data; the plan is plain idempotent SQL, and the CLI plans again afterwards and expects nothing left. Each production step needs explicit approval:

1. `node scripts/backfill/cli.mjs --remote --show` (read-only).
2. `node scripts/backfill/cli.mjs --remote --execute --confirm=<code from step 1>`; the report must show `"verified": true`.

## Free-tier budget (Cloudflare)

| Resource | Free limit | This project (approx.) |
| --- | --- | --- |
| Worker CPU | 10 ms per invocation | one 15-post page per queue invocation. The first production search (2026-10-10) measured 15 ms median, 28 ms p95 and 46 ms max per page (none cut off); the pre-filter version did the same D1, Apify and queue calls at 6 ms. The difference was the US-location check's regex scans, which run several times slower in Workers than in a warm local V8; they now scan only where a match is possible, with identical results (locally, with V8's regex interpreter: ~9–15 ms → ~2–3 ms per page). Classifying the posts a page stores adds ~0.1–0.4 ms each. Webhook ~9–15 ms; the retention cron is one D1 statement |
| Worker requests | 100k / day | per search: 1 form post, 1 webhook + up to ~115 queue invocations (one per 15 of up to ~1,700 items), and a dashboard reload every 15 s while it runs; plus 24 cron runs a day and dashboard views |
| Queue operations | 10k / day | ~3 per page → up to ~350 per run |
| D1 rows written | 100k / day | ~8 per new post (row, indexes, counter) + ~2 per post when its `raw_json` is cleared → ~12k / day at ~1,200 new posts a day |
| D1 rows read | 5M / day | Unfiltered and per-query views read counters and index ranges (≈ page size). Company, author and text searches scan up to 90 days of posts (≤ ~110k rows each at ~1,200 posts a day). Deep pages read the skipped rows (capped at 10k). Retention reads ~5 rows per post it clears. |
| D1 storage | 500 MB per database | ~7 KB per post while `raw_json` is kept, ~3.2 KB after → see note below |

**Storage note:** the hiring and US-job filters store only part of what a search fetches, so these figures are upper bounds. At ~1,200 new posts a day (e.g. two 24-hour searches a day), the last 7 days of `raw_json` take ~30 MB and normalized posts grow ~4 MB a day, so the database reaches 500 MB in about 4 months. More frequent searches make it grow proportionally faster. Before then, either delete old non-matching posts once classification exists, or move to Workers Paid (10 GB).

## Project layout

```
src/
  worker.ts        Hono app + queue and cron handlers (entry point)
  config/          bindings (env.ts), Actor input + Run Search windows (search-config.ts), raw_json retention (retention.ts)
  domain/          RawPost (Zod schema), IngestRun and SearchRun types
  apify/           Apify API client (fetch) and schemas
  normalization/   Actor item → RawPost: job title (+ source), company, work mode, LinkedIn job and apply links
  classification/  deterministic job-relevance classifier (relevant, needs review, unrelated, not a job)
  search/          Run Search: validation, Actor input per window, one search at a time
  ingestion/       start a run (webhook), ingest one page (queue), hard filters (hiring, US job location)
  maintenance/     hourly raw_json retention (cron), job-detail and relevance backfill plan
  storage/         D1 repositories
  webhook/         POST /webhooks/apify
  routes/, views/  dashboard + Run Search, runs, API, health
  lib/             time-zone helpers, constant-time compare
migrations/        D1 schema
scripts/           operator tools: apify-task/ (keep the saved Task input equal to the production input),
                   legacy-reset/ (one-time deletion of the pre-filter posts), backfill/ (job details and labels
                   for posts stored before migration 0008); dry run unless told otherwise
tests/             Vitest (workerd + local D1), fixture, helpers
wrangler.jsonc     Worker, D1, Queue, cron and vars
```
