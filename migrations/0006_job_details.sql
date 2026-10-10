-- Migration number: 0006 	 Job details: title, company, work mode and external apply link

-- Normalized from each Actor item (src/normalization/job-details.ts, job-links.ts);
-- null when unknown, and for posts stored before this migration.
ALTER TABLE raw_posts ADD COLUMN job_title TEXT;
ALTER TABLE raw_posts ADD COLUMN company_name TEXT;
-- The company's LinkedIn page (https://www.linkedin.com/company/<slug>/).
ALTER TABLE raw_posts ADD COLUMN company_linkedin_url TEXT;
ALTER TABLE raw_posts ADD COLUMN work_mode TEXT CHECK (work_mode IN ('remote', 'hybrid', 'onsite', 'unknown'));
-- Application link outside LinkedIn (applicant-tracking system, career page, job board).
ALTER TABLE raw_posts ADD COLUMN external_apply_url TEXT;

-- Work-mode filter on the dashboard: newest posts of one mode without scanning the others.
CREATE INDEX idx_raw_posts_work_mode ON raw_posts (work_mode, posted_at) WHERE work_mode IS NOT NULL;
