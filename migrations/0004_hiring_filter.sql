-- Migration number: 0004 	 hard ingestion filter: count items dropped for not mentioning "hiring"

-- Dataset items whose post text does not contain "hiring" (after Unicode NFKC
-- normalization and lowercasing) are dropped before normalization and never
-- stored. They are counted here, separately from invalid items, duplicates and
-- out-of-range posts.
ALTER TABLE ingest_run_pages ADD COLUMN dropped_no_hiring INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN dropped_no_hiring INTEGER NOT NULL DEFAULT 0;
