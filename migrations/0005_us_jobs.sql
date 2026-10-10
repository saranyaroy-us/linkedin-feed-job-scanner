-- Migration number: 0005 	 US-job filter and LinkedIn job links

-- Stored posts now also pass a hard US-job filter (src/ingestion/job-location.ts).
-- Where the job is, and how that was found; null for posts stored before it.
ALTER TABLE raw_posts ADD COLUMN job_location_text TEXT;
ALTER TABLE raw_posts ADD COLUMN job_country TEXT CHECK (job_country IN ('US'));
ALTER TABLE raw_posts ADD COLUMN location_source TEXT CHECK (location_source IN ('job', 'article', 'post_text'));
-- Canonical LinkedIn Jobs listing (https://www.linkedin.com/jobs/view/<id>/), or null.
ALTER TABLE raw_posts ADD COLUMN linkedin_job_url TEXT;

-- Items dropped by the US-job filter, counted per page and per run, separately
-- from invalid items, duplicates, "no hiring" and out-of-range posts.
ALTER TABLE ingest_run_pages ADD COLUMN dropped_non_us INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_run_pages ADD COLUMN dropped_location_unknown INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN dropped_non_us INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN dropped_location_unknown INTEGER NOT NULL DEFAULT 0;
