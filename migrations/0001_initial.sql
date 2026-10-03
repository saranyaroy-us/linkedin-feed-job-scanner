-- Migration number: 0001 	 initial schema: raw_posts, ingest_runs, ingest_run_pages, post_query_counts

-- One row per LinkedIn activity returned by harvestapi/linkedin-post-search.
CREATE TABLE raw_posts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  source                TEXT NOT NULL CHECK (source = 'apify_linkedin_post_search'),
  source_id             TEXT NOT NULL,
  linkedin_post_id      TEXT,
  entity_id             TEXT,
  text                  TEXT,
  author_name           TEXT,
  author_type           TEXT CHECK (author_type IN ('profile', 'company')),
  author_profile_url    TEXT,
  author_headline       TEXT,
  url                   TEXT,
  posted_at             TEXT,
  search_query          TEXT,
  apify_run_id          TEXT,
  repost_id             TEXT,
  article_title         TEXT,
  article_url           TEXT,
  likes                 INTEGER,
  comments              INTEGER,
  shares                INTEGER,
  tagged_companies_json TEXT,
  raw_json              TEXT,
  fetched_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, source_id)
);

-- (posted_at) also serves ORDER BY posted_at DESC, id DESC: the index carries the rowid.
CREATE INDEX idx_raw_posts_posted_at ON raw_posts (posted_at);
-- Composite so "filter by query, newest first" is a single index range scan.
CREATE INDEX idx_raw_posts_search_query ON raw_posts (search_query, posted_at);
CREATE INDEX idx_raw_posts_author_name ON raw_posts (author_name);
CREATE INDEX idx_raw_posts_url ON raw_posts (url);
-- Lets an ingest run count exactly the posts it inserted (idempotent across retries).
CREATE INDEX idx_raw_posts_apify_run_id ON raw_posts (apify_run_id);
-- "Posts added today" without scanning the table.
CREATE INDEX idx_raw_posts_created_at ON raw_posts (created_at);

-- One row per Apify run delivered by webhook. apify_run_id is UNIQUE so a
-- redelivered webhook reuses the same row instead of adding history.
-- fetched/new/already_seen/invalid are filled in when the run succeeds or fails.
CREATE TABLE ingest_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at         TEXT NOT NULL,
  completed_at       TEXT,
  apify_run_id       TEXT UNIQUE,
  dataset_id         TEXT,
  query_config_json  TEXT,
  fetched            INTEGER NOT NULL DEFAULT 0,
  new                INTEGER NOT NULL DEFAULT 0,
  already_seen       INTEGER NOT NULL DEFAULT 0,
  invalid            INTEGER NOT NULL DEFAULT 0,
  status             TEXT CHECK (status IN ('processing', 'succeeded', 'failed')),
  error              TEXT,
  -- Number of dataset pages in the run; 0 until the last (short or empty) page
  -- has been read. The run completes when that many pages are recorded.
  pages_total        INTEGER NOT NULL DEFAULT 0,
  -- Items per page for this run, fixed at first claim so a restart reuses the
  -- same page boundaries as the pages already recorded.
  page_size          INTEGER NOT NULL DEFAULT 50,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_ingest_runs_started_at ON ingest_runs (started_at);

-- One row per processed dataset page. Written in the same D1 batch (transaction)
-- as the page's posts, so a redelivered queue message is detected and skipped,
-- and run totals are exact sums over distinct pages.
CREATE TABLE ingest_run_pages (
  ingest_run_id  INTEGER NOT NULL REFERENCES ingest_runs (id) ON DELETE CASCADE,
  page_offset    INTEGER NOT NULL,
  fetched        INTEGER NOT NULL,
  invalid        INTEGER NOT NULL,
  processed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ingest_run_id, page_offset)
) WITHOUT ROWID;

-- Running totals per search query, maintained by triggers. The dashboard reads
-- these few rows instead of COUNT(*)-scanning raw_posts on every page load,
-- which keeps D1 rows-read far inside the free tier as the table grows.
-- Posts without a search_query are counted under ''.
CREATE TABLE post_query_counts (
  search_query TEXT NOT NULL PRIMARY KEY,
  posts        INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER trg_raw_posts_count_insert AFTER INSERT ON raw_posts
BEGIN
  INSERT INTO post_query_counts (search_query, posts)
  VALUES (COALESCE(NEW.search_query, ''), 1)
  ON CONFLICT (search_query) DO UPDATE SET posts = posts + 1;
END;

CREATE TRIGGER trg_raw_posts_count_delete AFTER DELETE ON raw_posts
BEGIN
  UPDATE post_query_counts SET posts = posts - 1
  WHERE search_query = COALESCE(OLD.search_query, '');
END;
