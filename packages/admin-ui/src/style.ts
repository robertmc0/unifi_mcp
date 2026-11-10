/** The admin stylesheet, served from /static/admin.css (no inline styles: strict CSP). */
export const ADMIN_CSS = `
:root { color-scheme: light dark; --fg: #1d2330; --muted: #5b6475; --bg: #f6f7f9; --card: #fff;
  --line: #d9dde4; --accent: #1f5fbf; --bad: #b42318; --warn: #a15c07; --ok: #087443; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e8ec; --muted: #a2a9b6; --bg: #14171c;
  --card: #1c2027; --line: #333a45; --accent: #7aa7ff; --bad: #ff8a80; --warn: #f5b759; --ok: #6fd3a0; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; padding: 12px 16px;
  border-bottom: 1px solid var(--line); background: var(--card); }
header .brand { font-weight: 600; }
nav a { margin-right: 16px; color: var(--accent); text-decoration: none; }
header form { margin-left: auto; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 8px 0 16px; }
h2 { font-size: 1.1rem; margin: 24px 0 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 500; }
.scroll { overflow-x: auto; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); padding: 12px; border-radius: 6px; margin: 0; }
.status-ok { color: var(--ok); } .status-warn { color: var(--warn); } .status-bad { color: var(--bad); }
.notice { padding: 10px 12px; border-radius: 6px; border: 1px solid var(--line); margin-bottom: 16px; }
.notice.error { border-color: var(--bad); color: var(--bad); }
.notice.ok { border-color: var(--ok); color: var(--ok); }
label { display: block; margin: 8px 0 4px; color: var(--muted); }
input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); width: 100%; max-width: 360px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent);
  background: var(--accent); color: #fff; cursor: pointer; margin-top: 12px; }
button.secondary { background: transparent; color: var(--accent); }
button.danger { border-color: var(--bad); background: var(--bad); }
.filters { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: end; }
.filters label { margin: 0; }
.muted { color: var(--muted); }
`;
