/**
 * The whole dashboard UI as one static page. It contains no project data: everything is
 * fetched from /api and written into the page with textContent only, never innerHTML, so
 * recorded text (commit subjects, notes, test output) can never become markup.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PCS dashboard</title>
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#1b1b1f; --mut:#6b6b76; --card:#fff; --line:#e3e3e8;
    --ok:#1a7f37; --bad:#c62828; --warn:#9a6700; --ver:#1a7f37; --rep:#0b5fff; --inf:#8250df; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111114; --fg:#ececf1; --mut:#9a9aa6; --card:#1a1a1f; --line:#2c2c33;
    --ok:#3fb950; --bad:#ff6b6b; --warn:#d29922; --ver:#3fb950; --rep:#6ea0ff; --inf:#b794f6; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; } h2 { font-size:14px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); }
  main { padding:16px 20px; display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); max-width:1400px; margin:auto; }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; min-width:0; }
  section.wide { grid-column: 1 / -1; }
  .row { padding:6px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; } .row:first-of-type { border-top:0; }
  .mut { color:var(--mut); } code, pre { font:12px ui-monospace, Consolas, monospace; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; overflow:auto; max-height:220px; margin:6px 0 0; white-space:pre-wrap; }
  .tag { display:inline-block; font-size:11px; font-weight:600; padding:1px 7px; border-radius:10px; border:1px solid currentColor; margin-right:6px; }
  .verified { color:var(--ver); } .reported { color:var(--rep); } .inferred { color:var(--inf); }
  .passed, .ok { color:var(--ok); } .failed, .timeout, .error, .bad { color:var(--bad); } .warn { color:var(--warn); }
  .banner { padding:10px 14px; border-radius:6px; font-weight:600; width:100%; } .banner.bad { background:color-mix(in srgb, var(--bad) 15%, transparent); }
  details summary { cursor:pointer; } .kv { display:flex; gap:8px; flex-wrap:wrap; }
</style>
</head>
<body>
<header><h1 id="title">PCS</h1><span class="mut" id="sub"></span><span class="mut" id="stamp" style="margin-left:auto"></span></header>
<div style="padding:12px 20px"><div id="banner"></div></div>
<main>
  <section><h2>Now</h2><div id="now"></div></section>
  <section><h2>Sessions</h2><div id="sessions"></div></section>
  <section><h2>Tasks</h2><div id="tasks"></div></section>
  <section><h2>Notes</h2><div id="notes"></div></section>
  <section><h2>Test runs (PCS executed)</h2><div id="runs"></div></section>
  <section><h2>Snapshots</h2><div id="snaps"></div></section>
  <section class="wide"><h2>Timeline</h2><div class="mut" style="margin-bottom:6px"><span class="tag verified">verified</span>PCS observed it &nbsp; <span class="tag reported">reported</span>an agent or person said it &nbsp; <span class="tag inferred">inferred</span>PCS concluded it</div><div id="events"></div></section>
</main>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function row(parts) { const r = el("div", "row"); for (const p of parts) r.append(p); return r; }
function tag(prov) { return el("span", "tag " + prov, prov); }
function mut(t) { return el("span", "mut", t); }
function short(h) { return h ? String(h).slice(0, 7) : "-"; }
function ago(ts) { const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000); if (s < 90) return Math.round(s) + "s ago"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 172800) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; }
function fill(id, rows, empty) { const box = $(id); clear(box); if (!rows.length) box.append(el("div", "mut", empty)); for (const r of rows) box.append(r); }
function cmd(argv) { return argv.map((a) => (a === "" || /[^\\w@%+=:,.\\/\\\\-]/.test(a) ? JSON.stringify(a) : a)).join(" "); }

function render(d) {
  const s = d.status;
  $("title").textContent = "PCS · " + s.project.name;
  $("sub").textContent = s.git.branch + " @ " + short(s.git.head && s.git.head.hash);
  $("stamp").textContent = "updated " + new Date(d.generatedAt).toLocaleTimeString() + " · refreshes every 5s · read-only";
  const b = $("banner"); clear(b);
  if (!s.integrity.ok) b.append(el("div", "banner bad", "INTEGRITY FAILURE: " + (s.integrity.reason || "the evidence log does not verify") + ". Do not trust recorded evidence."));

  const now = $("now"); clear(now);
  now.append(row([tag("verified"), document.createTextNode("Log: " + (s.integrity.ok ? "OK (" + s.integrity.count + " events, chain, snapshots, test runs verified)" : "FAILED"))]));
  now.append(row([tag("verified"), document.createTextNode("Changed files: " + s.git.changed.length + (s.git.changed.length ? " — " + s.git.changed.slice(0, 8).map((f) => f.path).join(", ") + (s.git.changed.length > 8 ? " …" : "") : " (clean)"))]));
  now.append(row([tag("verified"), document.createTextNode(s.session ? "Active session #" + s.session.id + " (" + s.session.agent + ") since " + ago(s.session.started_at) : "No active session")]));
  now.append(row([tag("verified"), document.createTextNode(s.watcher.running ? "Watcher running (pid " + s.watcher.pid + ")" : s.watcher.stale ? "Watcher not running (the previous one died)" : "Watcher not running")]));
  const h = d.lastHandoff;
  now.append(row([h ? tag("verified") : mut(""), document.createTextNode(h ? "Last handoff " + ago(h.ts) + " (event #" + h.id + ")" : "No handoff yet")]));
  if (d.lastPickup) now.append(row([tag("reported"), document.createTextNode("Picked up by " + d.lastPickup.source + " " + ago(d.lastPickup.ts))]));

  fill("sessions", d.sessions.map((x) => {
    const state = x.ended_at === null ? "ACTIVE" : x.end_reason === "interrupted" ? "interrupted" : "ended: " + x.end_reason;
    return row([tag(x.end_reason === "interrupted" ? "inferred" : x.ended_at === null ? "verified" : "reported"), document.createTextNode("#" + x.id + " " + x.agent + " — " + state), mut("  started " + ago(x.started_at))]);
  }), "No sessions yet.");

  fill("tasks", d.tasks.map((t) => {
    const ev = d.evidence[t.id];
    const r = row([tag("reported"), document.createTextNode("#" + t.id + " [" + t.status + "] " + t.title)]);
    if (ev) { r.append(document.createTextNode("  ")); r.append(el("span", ev.outcome, "run #" + ev.run_id + " " + ev.outcome)); }
    else if (t.status === "done") r.append(el("span", "warn", "  no test run linked: not verified"));
    return r;
  }), "No tasks.");

  fill("notes", d.notes.map((n) => row([tag("reported"), el("b", "", n.kind), document.createTextNode(" #" + n.id + " " + n.text), mut(n.resolved_at ? "  (resolved)" : "")])), "No notes.");

  fill("runs", d.runs.map((r) => {
    const x = row([tag("verified"), el("span", r.outcome, "run #" + r.id + " " + r.outcome.toUpperCase()), document.createTextNode(" exit " + r.exit_code + " · " + (r.duration_ms / 1000).toFixed(1) + "s · " + ago(r.ts) + " @ " + short(r.head)), el("div", "", "")]);
    x.lastChild.append(el("code", "", cmd(r.argv)));
    if (r.outcome !== "passed" && r.output) { const det = el("details"); det.append(el("summary", "mut", "output tail")); det.append(el("pre", "", r.output)); x.append(det); }
    return x;
  }), "No test runs. Use pcs test -- <command>.");

  fill("snaps", d.snapshots.map((x) => row([tag("verified"), document.createTextNode("#" + x.id + " " + x.kind + " · " + x.fileCount + " changed file(s) · " + short(x.head) + " · " + ago(x.taken_at)), x.session_id ? mut("  session #" + x.session_id) : mut("")])), "No snapshots.");

  fill("events", d.events.map((e) => {
    const x = row([tag(e.provenance), el("b", "", e.type), mut("  #" + e.id + " · " + e.source + (e.session_id ? " · session #" + e.session_id : "") + " · " + ago(e.ts))]);
    if (e.summary) x.append(el("div", "mut", e.summary));
    return x;
  }), "No events.");
}

async function load() {
  try {
    const res = await fetch("/api/overview", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    render(await res.json());
  } catch (err) {
    const b = $("banner"); clear(b); b.append(el("div", "banner bad", "Cannot load data: " + err.message + ". Is pcs dashboard still running?"));
  }
}
load(); setInterval(load, 5000);
</script>
</body>
</html>
`;
