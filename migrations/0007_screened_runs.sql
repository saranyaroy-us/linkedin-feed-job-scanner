-- Migration number: 0007 	 Mark ingest runs whose items went through the hard filters

-- 1 when the run was ingested through the hiring and US-job hard filters (set
-- when a run is claimed); NULL for historical runs ingested before them. The
-- dashboard's "Last run" and "Last ingestion" use screened runs only, and /runs
-- labels the others as historical. No data is changed: existing runs stay NULL.
ALTER TABLE ingest_runs ADD COLUMN screened INTEGER CHECK (screened IN (1));
