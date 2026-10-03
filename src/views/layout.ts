import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const STYLES = `
:root {
  --bg: #f5f6f8; --panel: #ffffff; --border: #e2e5e9; --text: #1b1f24; --muted: #646d7a;
  --accent: #2f6fde; --accent-soft: #e8f0fd; --badge: #eef0f3;
  --warn: #8a5a00; --warn-soft: #fdf3e1; --ok: #1f7a43; --ok-soft: #e3f4ea; --bad: #b42318; --bad-soft: #fde8e7;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101216; --panel: #181b20; --border: #2a2f36; --text: #e6e8eb; --muted: #959daa;
    --accent: #6ea0f5; --accent-soft: #1c2a40; --badge: #242930;
    --warn: #f0b75a; --warn-soft: #3a2c14; --ok: #6fd39a; --ok-soft: #173325; --bad: #ff8a80; --bad-soft: #3d1b1a;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-size: 12px; background: var(--badge); padding: 1px 5px; border-radius: 4px; }
header { background: var(--panel); border-bottom: 1px solid var(--border); }
.wrap { max-width: 1320px; margin: 0 auto; padding: 0 20px; }
header .wrap { display: flex; align-items: center; gap: 24px; min-height: 56px; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; font-weight: 600; }
nav a { color: var(--muted); margin-right: 16px; font-weight: 500; }
nav a.active { color: var(--text); }
header .tz { margin-left: auto; color: var(--muted); font-size: 12px; }
main { padding: 24px 0 48px; }
h2 { font-size: 14px; margin: 0 0 10px; font-weight: 600; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; min-width: 0; }
.card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.card .value { font-size: 22px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.card .value.small { font-size: 15px; }
.card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
.section { margin-bottom: 20px; }
.qlist { list-style: none; margin: 0; padding: 0; }
.qlist li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--border); }
.qlist li:first-child { border-top: 0; }
.num { font-variant-numeric: tabular-nums; text-align: right; }
form.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-bottom: 14px; }
form.filters label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
input, select { background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 8px; font: inherit; min-width: 0; max-width: 100%; }
input[type=search] { width: 200px; }
button, .btn { display: inline-block; background: var(--accent); color: #fff; border: 0; border-radius: 6px;
  padding: 7px 14px; font: inherit; font-weight: 500; cursor: pointer; }
.btn.secondary { background: var(--badge); color: var(--text); }
.results { color: var(--muted); margin: 0 0 8px; font-size: 13px; }
.table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-top: 1px solid var(--border); }
th { font-size: 12px; color: var(--muted); font-weight: 600; border-top: 0; white-space: nowrap; }
td.when { white-space: nowrap; color: var(--muted); font-size: 13px; }
td.query { max-width: 170px; }
td.author { min-width: 170px; max-width: 240px; }
td.author .headline { color: var(--muted); font-size: 12px; }
td.post { min-width: 340px; }
td.post .text { white-space: pre-line; overflow-wrap: anywhere; }
td.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
details summary { cursor: pointer; color: var(--accent); font-size: 12px; margin-top: 4px; }
pre { margin: 6px 0 0; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.badge { display: inline-block; background: var(--badge); color: var(--muted); border-radius: 999px; padding: 1px 8px;
  font-size: 11px; font-weight: 500; margin-right: 4px; white-space: nowrap; }
.badge.query { background: var(--accent-soft); color: var(--accent); white-space: normal; border-radius: 8px; }
.badge.repost, .badge.processing { background: var(--warn-soft); color: var(--warn); }
.badge.succeeded { background: var(--ok-soft); color: var(--ok); }
.badge.failed { background: var(--bad-soft); color: var(--bad); }
.article { margin-top: 6px; font-size: 12px; color: var(--muted); }
.engage { white-space: nowrap; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.pager { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.empty { padding: 32px; text-align: center; color: var(--muted); background: var(--panel);
  border: 1px solid var(--border); border-radius: 8px; }
@media (max-width: 720px) {
  .wrap { padding: 0 16px; }
  header .tz { margin-left: 0; width: 100%; padding-bottom: 8px; }
  form.filters label { flex: 1 1 140px; }
  input[type=search] { width: 100%; }
}
`;

export function layout(options: { title: string; active: 'posts' | 'runs'; timeZone: string; body: Html }): Html {
  const { title, active, timeZone, body } = options;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<header><div class="wrap">
  <h1>LinkedIn Job Signals</h1>
  <nav>
    <a href="/" class="${active === 'posts' ? 'active' : ''}">Posts</a>
    <a href="/runs" class="${active === 'runs' ? 'active' : ''}">Ingest runs</a>
  </nav>
  <span class="tz">Times in ${timeZone}</span>
</div></header>
<main><div class="wrap">${body}</div></main>
</body>
</html>`;
}

export function statCard(label: string, value: string | number, sub?: string, small = false): Html {
  return html`<div class="card"><div class="label">${label}</div><div class="value${small ? ' small' : ''}">${value}</div>${
    sub ? html`<div class="sub">${sub}</div>` : ''
  }</div>`;
}

export function externalLink(href: string, label: string | Html): Html {
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}
