-- Migration number: 0002 	 raw_json retention index

-- raw_json (the full Actor item) is kept for 7 days, then set to NULL by the
-- hourly retention cron; rows and their normalized columns are kept forever
-- (raw_json is already nullable). This partial index holds only the posts that
-- still have raw_json, so each cron run reads just the rows it clears instead of
-- every post ever stored, and its D1 rows-read stays flat as raw_posts grows.
CREATE INDEX idx_raw_posts_raw_json_pending ON raw_posts (created_at) WHERE raw_json IS NOT NULL;
