/**
 * The window into the agent's mind.
 *
 * One self-contained page — no bundler, no framework, no build step. The spec
 * called for React Flow, which earns its weight when a canvas is editable;
 * this one is deliberately read-only, so hand-drawn SVG is smaller, faster,
 * and ships inside the same Node process the agent already runs in.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SquidClaw — the mind</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #12161b; --line: #222a33; --ink: #e6edf3;
    --dim: #8b98a5; --accent: #4fd1c5; --ok: #3fb950; --err: #f85149;
    --warn: #d29922; --habit: #a371f7;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --line:#d8dee4; --ink:#1f2328; --dim:#636c76; --accent:#0f766e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { display:flex; align-items:baseline; gap:16px; padding:14px 20px;
    border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:5; }
  h1 { font-size:15px; margin:0; letter-spacing:.02em; }
  h1 span { color:var(--dim); font-weight:400; }
  .pills { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; }
  .pill { font:11px/1 var(--mono); padding:6px 9px; border:1px solid var(--line);
    border-radius:99px; color:var(--dim); white-space:nowrap; }
  .pill b { color:var(--ink); font-weight:600; }
  main { display:grid; grid-template-columns:320px 1fr; height:calc(100vh - 53px); }
  @media (max-width:860px) { main { grid-template-columns:1fr; height:auto; } }
  aside { border-right:1px solid var(--line); overflow-y:auto; background:var(--panel); }
  section.detail { overflow-y:auto; padding:20px; }
  .group { border-bottom:1px solid var(--line); }
  .group > h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
    margin:0; padding:12px 16px 6px; }
  .row { display:block; width:100%; text-align:left; background:none; border:0; color:inherit;
    padding:9px 16px; cursor:pointer; border-left:2px solid transparent; font:inherit; }
  .row:hover { background:rgba(127,127,127,.08); }
  .row[aria-current="true"] { border-left-color:var(--accent); background:rgba(79,209,197,.09); }
  .row .top { display:flex; gap:8px; align-items:center; }
  .row .shape { font:11px/1.4 var(--mono); color:var(--dim); margin-top:3px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:7px; height:7px; border-radius:99px; flex:none; }
  .ok { background:var(--ok) } .error { background:var(--err) } .running { background:var(--warn) }
  .kind { font:10px/1 var(--mono); padding:3px 6px; border-radius:4px; border:1px solid var(--line); color:var(--dim); }
  .kind.flow { color:var(--habit); border-color:color-mix(in srgb, var(--habit) 40%, transparent); }
  .when { margin-left:auto; font:10px/1 var(--mono); color:var(--dim); }
  .empty { padding:14px 16px; color:var(--dim); font-size:13px; }
  .card { border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:14px 16px; margin-bottom:14px; }
  .card h3 { margin:0 0 4px; font-size:13px; }
  .card p { margin:0; color:var(--dim); font-size:12.5px; }
  .canvas-wrap { border:1px solid var(--line); border-radius:10px; background:var(--panel);
    overflow:auto; margin-bottom:16px; }
  svg { display:block; }
  .n rect { fill:color-mix(in srgb, var(--accent) 8%, var(--panel)); stroke:var(--line); }
  .n[data-status="ok"] rect { stroke:color-mix(in srgb, var(--ok) 55%, var(--line)); }
  .n[data-status="error"] rect { stroke:var(--err); fill:color-mix(in srgb, var(--err) 12%, var(--panel)); }
  .n { cursor:pointer; }
  .n:hover rect { stroke:var(--accent); }
  .n.sel rect { stroke:var(--accent); stroke-width:2; }
  .n text { fill:var(--ink); font:12px var(--mono); }
  .n text.sub { fill:var(--dim); font-size:10.5px; }
  path.edge { fill:none; stroke:var(--line); stroke-width:1.5; }
  pre { margin:0; font:11.5px/1.55 var(--mono); white-space:pre-wrap; word-break:break-word;
    color:var(--ink); max-height:320px; overflow:auto; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font:12px var(--mono); color:var(--dim); }
  .kv b { color:var(--ink); font-weight:500; }
  .err { color:var(--err); }
  .hint { color:var(--dim); font-size:12.5px; }
  .live { display:inline-flex; align-items:center; gap:6px; }
  .live .dot { background:var(--ok); animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.35 } }
</style>
</head>
<body>
<header>
  <h1>🐙 SquidClaw <span>— the mind</span></h1>
  <div class="pills" id="pills"></div>
</header>
<main>
  <aside id="side"></aside>
  <section class="detail" id="detail">
    <p class="hint">Pick something on the left to see how it went.</p>
  </section>
</main>
<script>
const $ = (s, r=document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
};
const dur = (ms) => ms == null ? '' : ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';

let state = null, runs = [], selected = null, selectedNode = null;
let showRoutine = false;

// The canvas is for workflows. Only habit runs — deterministic flows the
// agent crystallized and the human promoted — earn the front page.
// Everything improvised is the agent's private thinking, folded away.
const isSignificant = (e) => e.kind === "flow";

async function load() {
  [state, runs] = await Promise.all([
    fetch('/api/state').then(r => r.json()),
    fetch('/api/executions').then(r => r.json()),
  ]);
  renderPills(); renderSide();
}

function renderPills() {
  $('#pills').innerHTML = [
    '<span class="pill live"><span class="dot"></span>live</span>',
    '<span class="pill">thinking via <b>' + esc(state.mind.via) + '</b></span>',
    '<span class="pill"><b>' + state.mind.tools + '</b> tools</span>',
    '<span class="pill"><b>' + state.counts.habits + '</b> habits</span>',
    '<span class="pill"><b>' + state.counts.reflexes + '</b> reflexes armed</span>',
  ].join('');
}

function group(title, inner) {
  return '<div class="group"><h2>' + title + '</h2>' + inner + '</div>';
}

function renderSide() {
  const habitRows = state.habits.map(h =>
    '<button class="row" data-habit="' + esc(h.name) + '"><div class="top">' +
    '<span class="kind flow">habit</span><b>' + esc(h.name) + '</b>' +
    '<span class="when">' + h.runs + ' runs</span></div>' +
    '<div class="shape">' + esc(h.description) + '</div></button>').join('');

  const draftRows = state.drafts.map(h =>
    '<button class="row" data-habit="' + esc(h.name) + '"><div class="top">' +
    '<span class="kind">draft</span><b>' + esc(h.name) + '</b></div>' +
    '<div class="shape">awaiting /promote</div></button>').join('');

  const reflexRows = state.reflexes.map(r =>
    '<div class="row"><div class="top"><span class="dot ' + (r.lastStatus || 'running') + '"></span>' +
    '<b>' + esc(r.name) + '</b><span class="when">' + esc(r.cron || 'POST /hooks/' + r.webhook) + '</span></div>' +
    '<div class="shape">runs ' + esc(r.flow) + '</div></div>').join('');

  const visible = showRoutine ? runs : runs.filter(isSignificant);
  const hidden = runs.length - (showRoutine ? runs.length : visible.length);
  const runRows = visible.map(e =>
    '<button class="row" data-run="' + e.id + '" aria-current="' + (e.id === selected) + '"><div class="top">' +
    '<span class="dot ' + e.status + '"></span><span class="kind ' + e.kind + '">' + (e.kind === 'flow' ? 'squidflow' : e.kind) + '</span>' +
    '<span class="when">' + ago(e.startedAt) + (e.durationMs != null ? ' · ' + dur(e.durationMs) : '') + '</span></div>' +
    '<div class="shape">' + esc(e.shape) + '</div></button>').join('');

  const routineToggle =
    '<button class="row" id="routine-toggle" style="color:var(--dim);font-size:12px">' +
    (showRoutine ? 'hide improvised runs' : (hidden > 0 ? 'show ' + hidden + ' improvised run' + (hidden === 1 ? '' : 's') + ' (its thinking)' : '')) +
    '</button>';

  $('#side').innerHTML =
    (habitRows ? group('Habits — runs without thinking', habitRows) : '') +
    (draftRows ? group('Draft habits', draftRows) : '') +
    (reflexRows ? group('Reflexes', reflexRows) : '') +
    group('SquidFlow runs',
      (runRows || '<p class="empty">No SquidFlow runs yet — when you /promote a habit, its runs land here.</p>') +
      ((showRoutine || hidden > 0) ? routineToggle : ''));

  $('#side').querySelectorAll('[data-run]').forEach(b =>
    b.onclick = () => openRun(b.dataset.run));
  $('#side').querySelectorAll('[data-habit]').forEach(b =>
    b.onclick = () => openHabit(b.dataset.habit));
  const toggle = $('#routine-toggle');
  if (toggle) toggle.onclick = () => { showRoutine = !showRoutine; renderSide(); };
}

async function openHabit(name) {
  const h = await fetch('/api/habits/' + encodeURIComponent(name)).then(r => r.json());
  if (h.error) return;
  const L = h.layout;
  $('#detail').innerHTML =
    '<div class="card"><h3>' + esc(h.name) + '</h3><p>' + esc(h.description) + '</p></div>' +
    '<div class="canvas-wrap">' + svg(L, h.nodes) + '</div>' +
    '<div class="card"><div class="kv">' +
    '<span>learned from</span><b>' + h.runs + ' runs</b>' +
    '<span>asks for</span><b>' + (h.params.length ? esc(h.params.map(function (p) { return p && p.name ? p.name : p; }).join(', ')) : '—') + '</b>' +
    '<span>status</span><b>' + esc(h.status) + '</b></div></div>' +
    (h.triggers.length ? '<div class="card"><h3>What people said to ask for it</h3><pre>' +
      esc(h.triggers.join('\n')) + '</pre></div>' : '');
  wireNodes(h.nodes);
}

async function openRun(id) {
  selected = id; selectedNode = null;
  const e = await fetch('/api/executions/' + id).then(r => r.json());
  if (e.error) return;
  $('#detail').innerHTML =
    '<div class="card"><h3>' + (e.kind === 'flow' ? 'Habit run' : 'Improvised') + ' · ' +
      '<span class="' + (e.status === 'error' ? 'err' : '') + '">' + e.status + '</span></h3>' +
      '<p>' + esc(e.shape) + '</p></div>' +
    '<div class="canvas-wrap">' + svg(e.layout, e.nodes) + '</div>' +
    '<div class="card"><div class="kv">' +
      '<span>started</span><b>' + new Date(e.startedAt).toLocaleString() + '</b>' +
      '<span>took</span><b>' + (dur(e.durationMs) || '—') + '</b>' +
      '<span>steps</span><b>' + e.steps + '</b></div></div>' +
    '<div id="node-detail"><p class="hint">Click a step to see exactly what went in and what came out.</p></div>';
  wireNodes(e.nodes);
  renderSide();
}

function svg(L, nodes) {
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const edges = L.edges.map(e => '<path class="edge" d="' + e.path + '"/>').join('');
  const boxes = L.nodes.map(n => {
    const info = byId[n.id] || {};
    // Imported steps keep their original names — "Send to Telegram", not a
    // wall of unsupported.node. The box's subtitle tells the honest status.
    const imported = info.params && info.params.n8nName;
    const name = imported ? String(info.params.n8nName) : n.node;
    const label = name.length > 22 ? name.slice(0, 21) + '…' : name;
    const sub = imported
      ? 'n8n · ' + (info.status || 'not run') + (info.durationMs != null ? ' · ' + dur(info.durationMs) : '')
      : (info.status || 'not run') + (info.durationMs != null ? ' · ' + dur(info.durationMs) : '');
    return '<g class="n" data-node="' + n.id + '" data-status="' + (info.status || '') + '">' +
      '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" rx="9"/>' +
      '<text x="' + (n.x + 14) + '" y="' + (n.y + 26) + '">' + esc(label) + '</text>' +
      '<text class="sub" x="' + (n.x + 14) + '" y="' + (n.y + 45) + '">' + esc(sub) + '</text></g>';
  }).join('');
  return '<svg width="' + Math.max(L.width, 320) + '" height="' + L.height + '" ' +
    'viewBox="0 0 ' + L.width + ' ' + L.height + '">' + edges + boxes + '</svg>';
}

function wireNodes(nodes) {
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  document.querySelectorAll('.n').forEach(g => g.onclick = () => {
    document.querySelectorAll('.n').forEach(x => x.classList.remove('sel'));
    g.classList.add('sel');
    const n = byId[g.dataset.node];
    const box = $('#node-detail');
    if (!n || !box) return;
    box.innerHTML =
      '<div class="card"><h3>' + esc(n.node) + '</h3>' +
      (n.error ? '<p class="err">' + esc(n.error) + '</p>' : '') + '</div>' +
      '<div class="card"><h3>Params</h3><pre>' + esc(JSON.stringify(n.params, null, 2)) + '</pre></div>' +
      (n.input && n.input.length ? '<div class="card"><h3>In</h3><pre>' +
        esc(JSON.stringify(n.input, null, 2)) + '</pre></div>' : '') +
      '<div class="card"><h3>Out</h3><pre>' +
        esc(n.output ? JSON.stringify(n.output, null, 2) : '—') + '</pre></div>';
  });
}

// Live: the agent acts on its own, so the page must too.
const events = new EventSource('/api/events');
events.onmessage = async (m) => {
  const data = JSON.parse(m.data);
  if (data.type === 'executions') {
    runs = data.executions;
    state.counts.executions = runs.length;
    renderSide();
    if (selected) {
      const still = runs.find(r => r.id === selected);
      if (still && still.status === 'running') openRun(selected);
    }
  }
};

load();
</script>
</body>
</html>`;
