import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/**
 * Light SaaS theme. Everything is inline: the CSP is default-src 'none' with
 * inline styles and one hash-pinned inline script (Run Search), so there are
 * no web fonts or image URLs — icons are inline SVG and the select arrow is
 * drawn with CSS gradients.
 * Text colours on tinted backgrounds use the darker "-ink" shades so every
 * pairing stays at or above WCAG AA (4.5:1).
 */
const STYLES = `
:root {
  --bg: #f7f9fc; --surface: #ffffff; --surface-2: #f9fafc;
  --border: #e6eaf0; --border-strong: #d5dbe5; --row-line: #eef1f5;
  --text: #172033; --text-2: #475467; --muted: #667085; --placeholder: #6b7588;
  --primary: #4f6ef7; --primary-strong: #4361ee; --primary-hover: #3651dd; --primary-ink: #3347c9; --primary-soft: #eef2ff;
  --purple: #8b5cf6; --purple-ink: #6d28d9; --purple-soft: #f3eeff;
  --teal: #14b8a6; --teal-ink: #0f766e; --teal-soft: #e7f8f5;
  --cyan: #0ea5e9; --cyan-ink: #0369a1; --cyan-soft: #e6f4fd;
  --green: #22c55e; --green-ink: #166534; --green-soft: #e9f9ef;
  --emerald: #10b981; --emerald-ink: #047857; --emerald-soft: #e6f7f0;
  --amber: #f59e0b; --amber-ink: #b45309; --amber-soft: #fef5e3;
  --red: #ef4444; --red-ink: #b91c1c; --red-soft: #fdeded;
  --highlight: #fde68a;
  --radius: 12px; --radius-sm: 9px;
  --shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 3px 10px rgba(16, 24, 40, .05);
  --ring: 0 0 0 3px rgba(79, 110, 247, .25);
  color-scheme: light;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased; }
a { color: var(--primary-ink); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.icon { display: block; flex: none; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 0 24px; }
.muted { color: var(--muted); }
.num { font-variant-numeric: tabular-nums; text-align: right; }
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace; font-size: 12.5px; }
.sub { color: var(--muted); font-size: 12.5px; margin-top: 4px; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%);
  white-space: nowrap; border: 0; }

/* Header */
.topbar { position: relative; background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px;
  background: linear-gradient(90deg, var(--primary), var(--purple)); }
.topbar .wrap { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 24px; min-height: 64px; padding-top: 11px; padding-bottom: 8px; }
.brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
.brand-mark { flex: none; width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; color: #fff;
  background: linear-gradient(135deg, var(--primary), var(--purple)); box-shadow: 0 4px 12px rgba(79, 110, 247, .26); }
.brand h1 { margin: 0; font-size: 17px; line-height: 1.25; font-weight: 700; letter-spacing: -.01em; }
.brand p { margin: 1px 0 0; font-size: 12.5px; color: var(--muted); }
.tabs { display: flex; gap: 3px; padding: 3px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 11px; }
.tabs a { padding: 6px 15px; border-radius: 8px; color: var(--text-2); font-weight: 600; text-align: center; }
.tabs a:hover { color: var(--text); background: #eef1f6; text-decoration: none; }
.tabs a.active { background: var(--surface); color: var(--primary-ink); box-shadow: 0 1px 3px rgba(16, 24, 40, .1); }
.tz { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); font-size: 12.5px; font-weight: 500; }

/* Page structure */
main { padding: 20px 0 40px; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 14px; }
.page-head h2 { margin: 0; font-size: 20px; line-height: 1.25; font-weight: 700; letter-spacing: -.015em; }
.page-head p { margin: 2px 0 0; color: var(--muted); }
.card { min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.card-pad { padding: 16px 20px; }
.card-title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 15px; line-height: 1.4; font-weight: 700; }
.card-title .icon { color: var(--primary); }

/* Run search: one row on wide screens. The date fields and the note show only
   for "Date Range" (browsers without :has() always show them). */
.run-card { margin-bottom: 14px; padding: 14px 18px; }
.run-search fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.run-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.run-row .card-title { margin: 0 4px 0 0; }
.run-row .btn { margin-left: auto; }
.segmented { display: inline-flex; gap: 2px; padding: 3px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 11px; }
.segmented input { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); border: 0; }
.segmented label { display: flex; align-items: center; justify-content: center; height: 32px; padding: 0 13px; border-radius: 8px;
  color: var(--text-2); font-size: 13.5px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.segmented label:hover { color: var(--text); background: #eef1f6; }
.segmented input:checked + label { background: var(--surface); color: var(--primary-ink); box-shadow: 0 1px 3px rgba(16, 24, 40, .12); }
.segmented input:focus-visible + label { box-shadow: var(--ring); }
.range-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.inline-field { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: var(--text-2); }
.inline-field input { width: 152px; }
.range-note { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; color: var(--muted); font-size: 12.5px; }
.run-search:has(#window-range:not(:checked)) .range-fields,
.run-search:has(#window-range:not(:checked)) .range-note { display: none; }
.run-search fieldset:disabled .segmented label { cursor: not-allowed; opacity: .6; }
.run-status { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin-top: 10px; padding: 8px 12px;
  border: 1px solid; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.45; }
/* Text beside the icon; on narrow screens a progress detail wraps below its title. */
.run-status .detail { flex: 1 1 220px; min-width: 0; }
.run-status.progress { background: var(--primary-soft); border-color: #dbe2ff; color: var(--primary-ink); }
.run-status.ok { background: var(--green-soft); border-color: #c9eed6; color: var(--green-ink); }
.run-status.warn { background: var(--amber-soft); border-color: #f6e0b4; color: var(--amber-ink); }
.run-status.error { background: var(--red-soft); border-color: #f6cdcd; color: var(--red-ink); }
.spinner { flex: none; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
  animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

/* Colour families (stat cards, query badges, dots) */
.tone-blue { --tone: var(--primary); --tone-ink: var(--primary-ink); --tone-soft: var(--primary-soft); }
.tone-purple { --tone: var(--purple); --tone-ink: var(--purple-ink); --tone-soft: var(--purple-soft); }
.tone-teal { --tone: var(--teal); --tone-ink: var(--teal-ink); --tone-soft: var(--teal-soft); }
.tone-cyan { --tone: var(--cyan); --tone-ink: var(--cyan-ink); --tone-soft: var(--cyan-soft); }
.tone-green { --tone: var(--green); --tone-ink: var(--green-ink); --tone-soft: var(--green-soft); }
.tone-emerald { --tone: var(--emerald); --tone-ink: var(--emerald-ink); --tone-soft: var(--emerald-soft); }
.tone-amber { --tone: var(--amber); --tone-ink: var(--amber-ink); --tone-soft: var(--amber-soft); }
.tone-red { --tone: var(--red); --tone-ink: var(--red-ink); --tone-soft: var(--red-soft); }
.tone-neutral { --tone: #98a2b3; --tone-ink: var(--text-2); --tone-soft: #f1f3f7; }

/* Stat cards: three overview cards, then the last run's eight counters in one compact
   row (~88px tall). Icon and label share the first line; the number (or time, status
   and run id) sits below. */
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
.run-stats { margin-bottom: 12px; }
.stats-caption { margin: 0 0 6px; font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.run-grid { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 10px; }
.run-grid .stat { gap: 5px 6px; padding: 11px 12px; }
.run-grid .stat-icon { width: 26px; height: 26px; }
.run-grid .stat .value { font-size: 24px; }
.stat { position: relative; overflow: hidden; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center;
  align-content: start; gap: 6px 8px; padding: 12px 14px; }
.stat::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--tone); }
.stat-icon { grid-column: 1; grid-row: 1; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
  background: var(--tone-soft); color: var(--tone-ink); }
.stat .label { grid-column: 2; grid-row: 1; color: var(--muted); font-size: 12.5px; font-weight: 600; line-height: 1.3; }
.stat .value { grid-column: 1 / -1; font-size: 26px; line-height: 1.15; font-weight: 700; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.stat .value.small { font-size: 17px; line-height: 1.3; letter-spacing: -.01em; }
.stat .value-row { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
.stat .value-row .sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0; }
.stat .sub .badge { padding: 1px 8px; }

/* Posts per search query: compact rows, up to four per line */
.query-card { margin-bottom: 12px; padding: 12px 16px 14px; }
.query-card .card-title { margin-bottom: 8px; font-size: 14px; }
.qlist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 22px; }
.qlist li { min-width: 0; }
.qrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; line-height: 1.35; }
.qname { display: flex; align-items: center; gap: 7px; min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.dot { flex: none; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--tone); }
.qcount { font-weight: 700; }
.qbar { margin-top: 3px; height: 3px; border-radius: 999px; background: #eef1f6; overflow: hidden; }
.qbar span { display: block; height: 100%; border-radius: inherit; background: var(--tone); }

/* Filters: one compact toolbar row on desktop; fields wrap onto more rows on narrower screens */
.filter-card { margin-bottom: 14px; padding: 12px 16px; }
form.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 10px; }
.field { display: flex; flex-direction: column; gap: 3px; flex: 1 1 120px; min-width: 0; font-size: 12px; font-weight: 600; color: var(--text-2); }
/* Bases sized so the seven fields and both buttons share one row of the 1280px layout without clipping. */
.field.f-query { flex: 2.2 1 276px; }
.field.f-company { flex: 1 1 116px; }
.field.f-mode { flex: 0.8 1 100px; }
.field.f-author { flex: 1 1 116px; }
.field.f-date { flex: 0.9 1 102px; }
.field.f-text { flex: 1.3 1 126px; }
form.filters input, form.filters select, form.filters .btn { height: 38px; }
form.filters .input-icon input { padding-right: 8px; }
input, select { width: 100%; min-width: 0; height: 40px; padding: 0 11px; border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; font-size: 14px; font-weight: 400;
  transition: border-color .15s ease, box-shadow .15s ease; }
input::placeholder { color: var(--placeholder); opacity: 1; }
input:hover, select:hover { border-color: #b9c2d0; }
input:focus, select:focus { outline: none; border-color: var(--primary); box-shadow: var(--ring); }
select { appearance: none; -webkit-appearance: none; padding-right: 34px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
input[type=date] { padding-right: 8px; }
.input-icon { position: relative; display: block; }
.input-icon .icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.input-icon input { padding-left: 34px; }
.filter-actions { flex: none; display: flex; gap: 8px; }

/* Buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 40px; padding: 0 16px;
  border: 1px solid transparent; border-radius: var(--radius-sm); font: inherit; font-size: 14px; font-weight: 600; line-height: 1;
  white-space: nowrap; cursor: pointer; text-decoration: none; transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease; }
.btn:hover { text-decoration: none; }
.btn:focus-visible { outline: none; box-shadow: var(--ring); }
.btn:disabled { cursor: not-allowed; opacity: .6; box-shadow: none; }
.btn-primary { background: var(--primary-strong); color: #fff; box-shadow: 0 1px 2px rgba(16, 24, 40, .08), 0 3px 10px rgba(67, 97, 238, .24); }
.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn-secondary { background: var(--surface); color: var(--text-2); border-color: var(--border-strong); }
.btn-secondary:hover { background: var(--surface-2); color: var(--text); border-color: #b9c2d0; }

/* Tables */
.table-card { overflow: hidden; }
.table-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 2px 16px; padding: 12px 18px 10px; }
.table-head h2 { margin: 0; font-size: 15px; font-weight: 700; }
.results { margin: 0; color: var(--muted); font-size: 13px; }
.note { display: flex; align-items: flex-start; gap: 8px; margin: 0 18px 10px; padding: 8px 12px; border-radius: var(--radius-sm);
  background: var(--primary-soft); border: 1px solid #dbe2ff; color: var(--primary-ink); font-size: 13px; }
.note .icon { margin-top: 2px; }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: separate; border-spacing: 0; }
th { padding: 9px 14px; background: var(--surface-2); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  text-align: left; font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
th.num { text-align: right; }
td { padding: 11px 14px; border-bottom: 1px solid var(--row-line); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: #f8faff; }
/* Posts: fixed column widths, so the table always fits its card (text wraps); stacked rows on phones */
table.posts { table-layout: fixed; }
table.posts col.c-when { width: 92px; }
table.posts col.c-job { width: 14%; }
table.posts col.c-company { width: 11%; }
table.posts col.c-location { width: 11%; }
table.posts col.c-author { width: 14%; }
table.posts col.c-links { width: 100px; }
table.posts th, table.posts td { padding-left: 10px; padding-right: 10px; }
table.posts td { overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.45; }
td.when { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
td.job { font-weight: 600; color: var(--text); }
a.company-name { font-weight: 500; }
td.location .badge { margin-top: 5px; }
.badge.mode.remote { background: var(--green-soft); color: var(--green-ink); }
.badge.mode.hybrid { background: var(--primary-soft); color: var(--primary-ink); }
.badge.mode.onsite { background: var(--amber-soft); color: var(--amber-ink); }
.author-name { font-weight: 600; color: var(--text); }
a.author-name:hover { color: var(--primary-ink); }
.author .headline { margin-top: 3px; color: var(--muted); font-size: 12.5px; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.post .text { white-space: pre-line; overflow-wrap: anywhere; line-height: 1.5; }
/* Snippet around "hiring"; expanding shows the full text in its place. */
.post mark { padding: 0 2px; border-radius: 3px; background: var(--highlight); color: var(--text); font-weight: 600; }
details:not([open]) summary .hide, details[open] summary .show { display: none; }
.post:has(details[open]) .snippet { display: none; }
.post .badge.repost { margin-bottom: 6px; }
details summary { width: fit-content; margin-top: 6px; color: var(--primary-ink); font-size: 12.5px; font-weight: 600; cursor: pointer; }
details[open] summary { margin-bottom: 4px; }
.article { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); color: var(--muted); font-size: 12.5px; }
.link-list { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
a.action { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; white-space: nowrap; color: var(--primary-ink); }
.pager { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 20px; text-align: center; color: var(--muted); }
.empty .icon { color: #98a2b3; }
.empty p { margin: 0; font-weight: 500; }

/* Pills */
.badge { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 9px; border-radius: 999px;
  background: #f1f3f7; color: var(--text-2); font-size: 12px; font-weight: 600; line-height: 1.45; white-space: nowrap; }
.badge.repost { background: var(--amber-soft); color: var(--amber-ink); }
.badge.status::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge.succeeded { background: var(--green-soft); color: var(--green-ink); }
.badge.processing, .badge.running, .badge.starting { background: var(--primary-soft); color: var(--primary-ink); }
.badge.failed { background: var(--red-soft); color: var(--red-ink); }
.badge.historical { margin-top: 4px; background: #eef0f4; color: var(--muted); font-weight: 600; }
td.job .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.badge.persona { background: var(--teal-soft); color: var(--teal-ink); font-weight: 600; }
.badge.persona.revenue_operations { background: var(--primary-soft); color: var(--primary-ink); }
.badge.persona.vendor_manager { background: var(--purple-soft); color: var(--purple-ink); }
.badge.relevance.needs_review { background: var(--amber-soft); color: var(--amber-ink); font-weight: 600; }
.badge.relevance.unrelated, .badge.relevance.not_a_job, .badge.relevance.unclassified { background: #eef0f4; color: var(--muted); }
.view-tabs { display: inline-flex; gap: 2px; padding: 3px; margin-right: auto; background: var(--surface-2); border: 1px solid var(--border); border-radius: 11px; }
.view-tabs a { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px; border-radius: 8px;
  color: var(--text-2); font-size: 13px; font-weight: 600; white-space: nowrap; }
.view-tabs a:hover { color: var(--text); background: #eef1f6; text-decoration: none; }
.view-tabs a[aria-current="page"] { background: var(--surface); color: var(--primary-ink); box-shadow: 0 1px 3px rgba(16, 24, 40, .12); }
.view-tabs .num { color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
table.runs tr.historical td { color: var(--muted); }

/* Runs */
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
table.runs td { white-space: nowrap; }
table.runs td.num { font-weight: 600; }
table.runs td.id { color: var(--muted); font-weight: 500; }
table.runs th .dot { margin-right: 6px; vertical-align: 0; }
table.runs td.status-cell { white-space: normal; min-width: 130px; }
table.runs td.window { font-weight: 600; }
table.runs td.window .sub { font-weight: 500; }
.run-error { margin-top: 4px; max-width: 300px; color: var(--red-ink); font-size: 12.5px; line-height: 1.4; overflow-wrap: anywhere; }
table.runs td.config { white-space: normal; min-width: 90px; }
td.config pre { margin: 6px 0 0; max-width: 420px; max-height: 260px; overflow: auto; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Responsive */
@media (max-width: 1200px) { .qlist { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 1180px) { .run-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 900px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stats > .stat:nth-child(3) { grid-column: 1 / -1; }
}
@media (max-width: 720px) {
  .wrap { padding: 0 16px; }
  main { padding: 16px 0 32px; }
  .topbar .wrap { min-height: 0; }
  .tz { order: 2; margin-left: 0; }
  .tabs { order: 3; width: 100%; }
  .tabs a { flex: 1; }
  .page-head h2 { font-size: 19px; }
  .stat { padding: 11px 12px; }
  .stat .value { font-size: 23px; }
  .card-pad, .run-card { padding: 14px 16px; }
  .query-card, .filter-card { padding: 12px 14px; }
  .filter-actions { flex: 1 1 160px; }
  .run-row .card-title { width: 100%; }
  .segmented { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .range-fields { width: 100%; }
  .inline-field { flex: 1 1 140px; }
  .inline-field input { width: 100%; }
  .run-row .btn { width: 100%; margin-left: 0; }
  .filter-actions .btn, .pager .btn { flex: 1; }
  .table-head { padding: 12px 14px 10px; }
  .note { margin: 0 14px 10px; }
}
@media (max-width: 760px) {
  table.posts, table.posts tbody, table.posts tr, table.posts td { display: block; width: auto; }
  table.posts colgroup, table.posts thead { display: none; }
  table.posts tr { padding: 10px 14px; border-bottom: 1px solid var(--row-line); }
  table.posts tbody tr:last-child { border-bottom: 0; }
  table.posts td { padding: 3px 0; border-bottom: 0; }
  table.posts td::before { content: attr(data-label); display: block; color: var(--muted); font-size: 11px; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase; }
  .link-list { flex-direction: row; flex-wrap: wrap; gap: 4px 16px; }
}
@media (max-width: 560px) {
  .qlist { grid-template-columns: 1fr; }
  .run-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
  form.filters { gap: 10px; }
  form.filters .field, .filter-actions { flex-basis: 100%; }
}
`;

/** Inline SVG icons (static, trusted markup; decorative, so hidden from assistive tech). */
const ICON_PATHS = {
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M12 12.5v5M9.5 15h5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"/>',
  sparkle: '<path d="M12 3l2.2 5.3 5.3 2.2-5.3 2.2L12 18l-2.2-5.3-5.3-2.2 5.3-2.2z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5H10"/>',
  filter: '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/>',
  inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5.5 5h13l2.5 8v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V13z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName, size = 18): Html {
  return raw(
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`,
  );
}

/** Auto-refresh interval of a page with `refreshUrl`. */
export const REFRESH_SECONDS = 15;

export type Tone = 'blue' | 'purple' | 'teal' | 'cyan' | 'green' | 'emerald' | 'amber' | 'red' | 'neutral';

export function layout(options: {
  title: string;
  active: 'posts' | 'runs';
  timeZone: string;
  body: Html;
  /** Reload this URL every REFRESH_SECONDS (while a search is in progress). */
  refreshUrl?: string;
  /** Trusted inline script; it must be allowed by hash in the CSP (src/worker.ts). */
  script?: string;
}): Html {
  const { title, active, timeZone, body, refreshUrl, script } = options;
  const tab = (key: 'posts' | 'runs', href: string, label: string) =>
    html`<a href="${href}" class="${active === key ? 'active' : ''}" aria-current="${active === key ? 'page' : 'false'}">${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f7f9fc">
${refreshUrl ? html`<meta http-equiv="refresh" content="${REFRESH_SECONDS};url=${refreshUrl}">` : ''}
<title>${title}</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<header class="topbar"><div class="wrap">
  <div class="brand">
    <span class="brand-mark">${icon('pulse', 20)}</span>
    <div><h1>LinkedIn Job Signals</h1><p>LinkedIn posts for Revenue Ops, Sales Ops and Vendor Management</p></div>
  </div>
  <nav class="tabs" aria-label="Sections">${tab('posts', '/', 'Posts')}${tab('runs', '/runs', 'Ingest runs')}</nav>
  <span class="tz">${icon('clock', 14)}Times in ${timeZone}</span>
</div></header>
<main><div class="wrap">${body}</div></main>
${script ? html`<script>${raw(script)}</script>` : ''}
</body>
</html>`;
}

export function statCard(options: {
  label: string;
  value: string | number;
  tone: Tone;
  icon: IconName;
  sub?: Html | string;
  small?: boolean;
  /** Tooltip explaining the number. */
  title?: string;
}): Html {
  const { label, value, tone, sub, small = false, title } = options;
  const valueHtml = html`<div class="value${small ? ' small' : ''}">${value}</div>`;
  // A status line (e.g. the last run's status and id) shares the value's row, wrapping only when narrow.
  return html`<div class="card stat tone-${tone}"${title ? html` title="${title}"` : ''}><span class="stat-icon">${icon(options.icon, 16)}</span><div class="label">${label}</div>${
    sub ? html`<div class="value-row">${valueHtml}<div class="sub">${sub}</div></div>` : valueHtml
  }</div>`;
}

export function externalLink(href: string, label: string | Html, className?: string): Html {
  return html`<a href="${href}"${className ? html` class="${className}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`;
}
