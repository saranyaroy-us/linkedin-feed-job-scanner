# LinkedIn Feed Job Scanner

## Product goal
Build a local browser automation tool that scans the logged-in user's LinkedIn home feed, inspects feed posts one by one, identifies active job/hiring posts, and saves only jobs matching one of these personas:

1. Sales Operations
2. Vendor Manager
3. Revenue Operations

## MVP scope
INPUT:
- User's own authenticated LinkedIn home feed.

PROCESS:
- Open linkedin.com/feed
- Read visible feed posts.
- Extract each post individually.
- Deduplicate previously seen posts.
- Determine whether each post represents an active job/hiring opportunity.
- If yes, classify it into one of the 3 supported personas.
- Ignore every other post.

OUTPUT:
Save qualifying posts locally.

Required fields:
- post_id
- linkedin_post_url
- author_name
- author_profile_url
- post_text
- post_timestamp
- is_job_post
- job_post_confidence
- persona
- persona_confidence
- detected_job_title
- detected_company
- detected_location
- evidence_text
- scanned_at

## Persona enum
- sales_operations
- vendor_manager
- revenue_operations
- none

## Explicitly out of scope
- CV tailoring
- job applications
- LinkedIn messaging
- email drafting
- hiring-manager research
- ATS scoring
- external job search
- company enrichment
- salary enrichment
- proxies
- IP rotation
- CAPTCHA bypass
- stealth/evasion techniques
- automated likes/comments/connections/messages

## Architecture
Use:
- TypeScript
- Node.js
- Playwright
- SQLite
- Zod for schemas
- Vitest for tests

Browser:
- Use a dedicated persistent browser profile.
- User logs into LinkedIn manually.
- Never store LinkedIn username/password in source code.
- Never commit cookies, session state, or browser profiles to Git.

## Engineering rules
- Keep browser extraction separate from job classification.
- Keep selectors centralized.
- Store raw extracted post text before classification.
- Make scans idempotent.
- Do not save duplicate posts.
- Unknown values must remain null rather than being invented.
- Every positive classification must contain evidence_text.
- Optimize for precision over recall.
- Do not implement anti-detection functionality.

## Git rules
- Make small commits.
- Do not commit secrets, browser sessions, databases, logs, screenshots, or node_modules.
- Update README when behavior changes.
