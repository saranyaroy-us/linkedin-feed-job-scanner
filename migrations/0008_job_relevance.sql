-- Migration number: 0008 	 Job relevance classification

-- Where job_title came from: LinkedIn's job card, an attached job listing, or
-- the post text. NULL when there is no title, and for posts stored before this
-- migration (until they are re-normalized by the backfill).
ALTER TABLE raw_posts ADD COLUMN job_title_source TEXT CHECK (job_title_source IN ('job_card', 'listing', 'text'));

-- One deterministic classification per stored post (src/classification/job-relevance.ts):
-- is it an actual opening, and is the role one of the target functions? Kept
-- apart from raw_posts so a new classifier version can re-label posts without
-- touching ingestion data. Deleting a post deletes its classification.
CREATE TABLE post_classifications (
  post_id            INTEGER PRIMARY KEY REFERENCES raw_posts (id) ON DELETE CASCADE,
  classifier_version INTEGER NOT NULL,
  relevance          TEXT    NOT NULL CHECK (relevance IN ('relevant', 'needs_review', 'unrelated', 'not_a_job')),
  persona            TEXT    NOT NULL CHECK (persona IN ('revenue_operations', 'sales_operations', 'vendor_manager', 'none')),
  hiring_intent      TEXT    NOT NULL CHECK (hiring_intent IN ('strong', 'weak', 'none', 'commentary')),
  role_title         TEXT,
  title_source       TEXT    CHECK (title_source IN ('job_card', 'listing', 'labeled', 'header', 'team')),
  -- The exact phrase the label rests on (a role title or "join our … team"), never whole post text.
  evidence_text      TEXT,
  reason             TEXT    NOT NULL,
  classified_at      TEXT    NOT NULL
);

-- The dashboard's Relevant / Needs review views look posts up by label.
CREATE INDEX idx_post_classifications_relevance ON post_classifications (relevance, post_id);

-- Posts per label, maintained by triggers like post_query_counts, so the
-- dashboard's view tabs never COUNT(*)-scan the classifications.
CREATE TABLE relevance_counts (
  relevance TEXT    NOT NULL PRIMARY KEY,
  posts     INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER trg_post_classifications_count_insert AFTER INSERT ON post_classifications
BEGIN
  INSERT INTO relevance_counts (relevance, posts) VALUES (NEW.relevance, 1)
  ON CONFLICT (relevance) DO UPDATE SET posts = posts + 1;
END;

CREATE TRIGGER trg_post_classifications_count_delete AFTER DELETE ON post_classifications
BEGIN
  UPDATE relevance_counts SET posts = posts - 1 WHERE relevance = OLD.relevance;
END;

CREATE TRIGGER trg_post_classifications_count_update AFTER UPDATE OF relevance ON post_classifications
WHEN OLD.relevance <> NEW.relevance
BEGIN
  UPDATE relevance_counts SET posts = posts - 1 WHERE relevance = OLD.relevance;
  INSERT INTO relevance_counts (relevance, posts) VALUES (NEW.relevance, 1)
  ON CONFLICT (relevance) DO UPDATE SET posts = posts + 1;
END;
