-- Migration number: 0003 	 manual searches: search_runs, out-of-range counts

-- One row per "Run Search" request from the dashboard. Every job search is
-- started by hand: the Worker runs the Apify Task once with the chosen window
-- as an input override, and the Task's webhook ingests the results into
-- ingest_runs as before (joined on apify_run_id). The row is inserted
-- ('starting') before Apify is called, so two simultaneous submissions cannot
-- both start a run.
CREATE TABLE search_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 24h, week and month map to the Actor's postedLimit. A range uses the
  -- Actor's postedLimitDate cutoff, and ingestion keeps only the posts posted
  -- inside [requested_from, requested_to).
  search_window   TEXT NOT NULL CHECK (search_window IN ('24h', 'week', 'month', 'range')),
  -- UTC ISO instants. A range covers whole days in DISPLAY_TIMEZONE, so
  -- requested_to is the first moment after the "To" day (exclusive).
  requested_from  TEXT NOT NULL,
  requested_to    TEXT NOT NULL,
  -- Set once Apify has accepted the run.
  apify_run_id    TEXT UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('starting', 'started', 'failed')),
  error           TEXT,
  started_at      TEXT NOT NULL
);

-- The in-flight check and the history page only look at recent searches.
CREATE INDEX idx_search_runs_started_at ON search_runs (started_at);

-- Valid posts of a date-range search that were posted outside the range:
-- fetched but not stored, so they are neither new nor duplicates.
ALTER TABLE ingest_run_pages ADD COLUMN out_of_range INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN out_of_range INTEGER NOT NULL DEFAULT 0;
