/**
 * The window into the agent's mind — drawn as the mind it is.
 *
 * A neural canvas: the agent is a bright core, every workflow a neuron
 * wired to it by organic dendrites, and a neuron PULSES while its flow is
 * running (live over SSE — real activity, not decoration). Clicking a
 * neuron dives into its inner network: the steps, also neurons, with
 * signals traveling the synapses that actually fired.
 *
 * Still one self-contained page — no bundler, no framework, no build step.
 * Hand-drawn SVG + one ambient <canvas>, shipped from the same Node process
 * the agent already runs in.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SquidClaw — the mind</title>
<style>
  :root {
    --bg0:#03060e; --bg1:#081226; --bg2:#0b1a33;
    --glass:rgba(9,19,38,.62); --glass2:rgba(12,24,46,.5); --line:rgba(110,190,255,.14);
    --ink:#d9e9ff; --dim:#6e87a8; --accent:#4fc3ff; --amber:#ffb35c;
    --ok:#39e6b0; --err:#ff5c7a; --habit:#ffb35c;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; color:var(--ink);
    background:radial-gradient(1200px 700px at 30% 20%, var(--bg2), transparent 60%),
               radial-gradient(900px 600px at 75% 70%, #0a1730, transparent 55%),
               linear-gradient(160deg, var(--bg1), var(--bg0) 70%);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    overflow:hidden; }
  #bg { position:fixed; inset:0; z-index:0; pointer-events:none; }
  header { position:relative; z-index:3; display:flex; align-items:baseline; gap:16px;
    padding:14px 20px; border-bottom:1px solid var(--line);
    background:var(--glass); backdrop-filter:blur(10px); }
  h1 { font-size:15px; margin:0; letter-spacing:.02em;
    text-shadow:0 0 18px rgba(79,195,255,.55); }
  h1 span { color:var(--dim); font-weight:400; text-shadow:none; }
  .pills { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; }
  .pill { font:11px/1 var(--mono); padding:6px 9px; border:1px solid var(--line);
    border-radius:99px; color:var(--dim); white-space:nowrap; background:var(--glass2); }
  .pill b { color:var(--ink); font-weight:600; }
  main { position:relative; z-index:2; display:grid; grid-template-columns:300px 1fr;
    height:calc(100vh - 53px); }
  @media (max-width:860px) { main { grid-template-columns:1fr; } aside { display:none; } }
  aside { border-right:1px solid var(--line); overflow-y:auto;
    background:var(--glass); backdrop-filter:blur(10px); }
  section.detail { overflow-y:auto; padding:20px; }
  .group { border-bottom:1px solid var(--line); }
  .group > h2 { font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--dim);
    margin:0; padding:12px 16px 6px; }
  .row { display:block; width:100%; text-align:left; background:none; border:0; color:inherit;
    padding:9px 16px; cursor:pointer; border-left:2px solid transparent; font:inherit; }
  .row:hover { background:rgba(79,195,255,.07); }
  .row[aria-current="true"] { border-left-color:var(--accent); background:rgba(79,195,255,.1); }
  .row .top { display:flex; gap:8px; align-items:center; }
  .row .shape { font:11px/1.4 var(--mono); color:var(--dim); margin-top:3px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:7px; height:7px; border-radius:99px; flex:none; }
  .ok { background:var(--ok); box-shadow:0 0 8px rgba(57,230,176,.7); }
  .error { background:var(--err); box-shadow:0 0 8px rgba(255,92,122,.7); }
  .running { background:var(--amber); box-shadow:0 0 8px rgba(255,179,92,.8); animation:pulse 1.4s infinite; }
  .kind { font:10px/1 var(--mono); padding:3px 6px; border-radius:4px; border:1px solid var(--line); color:var(--dim); }
  .kind.flow { color:var(--accent); border-color:rgba(79,195,255,.4); }
  .when { margin-left:auto; font:10px/1 var(--mono); color:var(--dim); }
  .empty { padding:14px 16px; color:var(--dim); font-size:13px; }
  .card { border:1px solid var(--line); border-radius:12px; background:var(--glass);
    backdrop-filter:blur(8px); padding:14px 16px; margin-bottom:14px; }
  .card h3 { margin:0 0 4px; font-size:13px; }
  .card p { margin:0; color:var(--dim); font-size:12.5px; }
  .canvas-wrap { border:1px solid var(--line); border-radius:12px; background:rgba(5,10,22,.5);
    overflow:auto; margin-bottom:16px; }
  svg { display:block; }
  .back { display:inline-block; margin-bottom:12px; color:var(--accent); cursor:pointer;
    font:12px var(--mono); background:none; border:0; padding:0; }
  .back:hover { text-shadow:0 0 10px rgba(79,195,255,.7); }

  /* ——— neurons ——— */
  .n { cursor:pointer; }
  .n .halo { opacity:.5; }
  .n .core { fill:url(#gradIdle); }
  .n[data-status="ok"] .core { fill:url(#gradOk); }
  .n[data-status="error"] .core { fill:url(#gradErr); }
  .n[data-status="skipped"] .core { fill:url(#gradDim); opacity:.45; }
  .n[data-status="skipped"] .halo { opacity:.1; }
  .n[data-status="running"] .core, .n.pulsing .core { fill:url(#gradRun); animation:neuron 1.5s ease-in-out infinite; transform-box:fill-box; transform-origin:center; }
  .n[data-status="running"] .halo, .n.pulsing .halo { animation:haloPulse 1.5s ease-in-out infinite; }
  .n:hover .halo, .n.sel .halo { opacity:.95; }
  .n text { fill:var(--ink); font:11.5px var(--mono); text-anchor:middle; }
  .n text.sub { fill:var(--dim); font-size:9.5px; }
  .n.dim text { fill:var(--dim); }
  .n.dim .core { opacity:.5; }
  path.edge { fill:none; stroke:rgba(110,190,255,.18); stroke-width:1.5; }
  path.edge.fired { stroke:rgba(79,195,255,.55); stroke-dasharray:5 9; animation:signal 1.1s linear infinite; }
  path.edge.err { stroke:rgba(255,92,122,.5); }
  path.edge.live { stroke:rgba(255,179,92,.6); stroke-dasharray:4 10; animation:signal .8s linear infinite; }
  .satellite { fill:var(--amber); opacity:.85; }
  .corelabel { fill:var(--ink); font:12.5px var(--mono); text-anchor:middle;
    letter-spacing:.06em; }

  pre { margin:0; font:11.5px/1.55 var(--mono); white-space:pre-wrap; word-break:break-word;
    color:var(--ink); max-height:320px; overflow:auto; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font:12px var(--mono); color:var(--dim); }
  .kv b { color:var(--ink); font-weight:500; }
  .err { color:var(--err); }
  .hint { color:var(--dim); font-size:12.5px; }
  .live-pill { display:inline-flex; align-items:center; gap:6px; }
  .live-pill .dot { background:var(--ok); animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.35 } }
  @keyframes neuron { 50% { transform:scale(1.18); } }
  @keyframes haloPulse { 50% { opacity:.95; } }
  @keyframes signal { to { stroke-dashoffset:-28; } }
</style>
</head>
<body>
<canvas id="bg"></canvas>
<header>
  <h1>🐙 SquidClaw <span>— the mind</span></h1>
  <div class="pills" id="pills"></div>
</header>
<main>
  <aside id="side"></aside>
  <section class="detail" id="detail"></section>
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

let state = null, runs = [], selected = null;
let showRoutine = false;
let view = 'brain'; // 'brain' | 'run' | 'habit'

const isSignificant = (e) => e.kind === "flow";

/* ——— shared SVG defs: the glow language every view speaks ——— */
function defs() {
  return '<defs>' +
    '<radialGradient id="gradOk"><stop offset="0%" stop-color="#eaffff"/><stop offset="45%" stop-color="#7fd8ff"/><stop offset="100%" stop-color="#1668a8"/></radialGradient>' +
    '<radialGradient id="gradRun"><stop offset="0%" stop-color="#fff6e8"/><stop offset="45%" stop-color="#ffcf8e"/><stop offset="100%" stop-color="#b06a1e"/></radialGradient>' +
    '<radialGradient id="gradErr"><stop offset="0%" stop-color="#ffe8ee"/><stop offset="45%" stop-color="#ff8aa5"/><stop offset="100%" stop-color="#8f1f38"/></radialGradient>' +
    '<radialGradient id="gradDim"><stop offset="0%" stop-color="#9fb4cf"/><stop offset="100%" stop-color="#2a3a55"/></radialGradient>' +
    '<radialGradient id="gradIdle"><stop offset="0%" stop-color="#d8f2ff"/><stop offset="45%" stop-color="#5fb9e8"/><stop offset="100%" stop-color="#134e7f"/></radialGradient>' +
    '<radialGradient id="gradCore"><stop offset="0%" stop-color="#ffffff"/><stop offset="35%" stop-color="#9fe2ff"/><stop offset="100%" stop-color="#1a5a94"/></radialGradient>' +
    '<radialGradient id="gradHalo"><stop offset="0%" stop-color="rgba(79,195,255,.5)"/><stop offset="100%" stop-color="rgba(79,195,255,0)"/></radialGradient>' +
    '<radialGradient id="gradHaloAmber"><stop offset="0%" stop-color="rgba(255,179,92,.5)"/><stop offset="100%" stop-color="rgba(255,179,92,0)"/></radialGradient>' +
    '</defs>';
}

async function load() {
  [state, runs] = await Promise.all([
    fetch('/api/state').then(r => r.json()),
    fetch('/api/executions').then(r => r.json()),
  ]);
  renderPills(); renderSide(); if (view === 'brain') renderBrain();
}

function renderPills() {
  $('#pills').innerHTML = [
    '<span class="pill live-pill"><span class="dot"></span>live</span>',
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
    '<span class="kind flow">neuron</span><b>' + esc(h.name) + '</b>' +
    '<span class="when">' + h.runs + ' runs</span></div>' +
    '<div class="shape">' + esc(h.description) + '</div></button>').join('');

  const draftRows = state.drafts.map(h =>
    '<button class="row" data-habit="' + esc(h.name) + '"><div class="top">' +
    '<span class="kind">draft</span><b>' + esc(h.name) + '</b></div>' +
    '<div class="shape">awaiting /promote</div></button>').join('');

  const reflexRows = state.reflexes.map(r =>
    '<div class="row"><div class="top"><span class="dot ' + (r.lastStatus || 'running') + '"></span>' +
    '<b>' + esc(r.name) + '</b><span class="when">' + esc(r.cron || 'POST /hooks/' + r.webhook) + '</span></div>' +
    '<div class="shape">fires ' + esc(r.flow) + '</div></div>').join('');

  const visible = showRoutine ? runs : runs.filter(isSignificant);
  const hidden = runs.length - (showRoutine ? runs.length : visible.length);
  const runRows = visible.map(e =>
    '<button class="row" data-run="' + e.id + '" aria-current="' + (e.id === selected) + '"><div class="top">' +
    '<span class="dot ' + e.status + '"></span><span class="kind ' + e.kind + '">' + (e.kind === 'flow' ? (e.flow || 'squidflow') : e.kind) + '</span>' +
    '<span class="when">' + ago(e.startedAt) + (e.durationMs != null ? ' · ' + dur(e.durationMs) : '') + '</span></div>' +
    '<div class="shape">' + esc(e.shape) + '</div></button>').join('');

  const routineToggle =
    '<button class="row" id="routine-toggle" style="color:var(--dim);font-size:12px">' +
    (showRoutine ? 'hide improvised runs' : (hidden > 0 ? 'show ' + hidden + ' improvised run' + (hidden === 1 ? '' : 's') + ' (its thinking)' : '')) +
    '</button>';

  $('#side').innerHTML =
    '<button class="row" id="to-brain" style="color:var(--accent)">◉ the brain</button>' +
    (habitRows ? group('Neurons — flows it runs without thinking', habitRows) : '') +
    (draftRows ? group('Forming — drafts', draftRows) : '') +
    (reflexRows ? group('Reflexes', reflexRows) : '') +
    group('SquidFlow runs',
      (runRows || '<p class="empty">No SquidFlow runs yet — when you /promote a habit, its runs land here.</p>') +
      ((showRoutine || hidden > 0) ? routineToggle : ''));

  $('#side').querySelectorAll('[data-run]').forEach(b =>
    b.onclick = () => openRun(b.dataset.run));
  $('#side').querySelectorAll('[data-habit]').forEach(b =>
    b.onclick = () => openHabit(b.dataset.habit));
  $('#to-brain').onclick = () => { view = 'brain'; selected = null; renderBrain(); renderSide(); };
  const toggle = $('#routine-toggle');
  if (toggle) toggle.onclick = () => { showRoutine = !showRoutine; renderSide(); };
}

/* ——— the brain: every workflow a neuron around the agent's core ——— */
function hashOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

function renderBrain() {
  view = 'brain';
  const stage = $('#detail');
  const W = Math.max(640, stage.clientWidth - 40);
  const H = Math.max(480, window.innerHeight - 120);
  const cx = W / 2, cy = H / 2 - 10;

  const flows = state.habits.concat(state.drafts.map(d => Object.assign({}, d, { draft: true })));
  const running = new Set(runs.filter(r => r.status === 'running' && r.flow).map(r => r.flow));
  const anyRunning = runs.some(r => r.status === 'running');
  const lastByFlow = {};
  for (const r of runs) if (r.flow && !(r.flow in lastByFlow)) lastByFlow[r.flow] = r.status;

  const R = Math.min(W, H) / 2 - 110;
  const placed = flows.map((f, i) => {
    const jitter = (hashOf(f.name) % 40) - 20;
    const angle = -Math.PI / 2 + (i * 2 * Math.PI / Math.max(1, flows.length)) + jitter / 160;
    const radius = R + ((hashOf(f.name + 'r') % 50) - 25);
    return { f, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), angle };
  });

  const edges = placed.map(p => {
    const w = (hashOf(p.f.name + 'w') % 60) - 30;
    const mx = (cx + p.x) / 2 - Math.sin(p.angle) * w;
    const my = (cy + p.y) / 2 + Math.cos(p.angle) * w;
    const cls = running.has(p.f.name) ? 'edge live' : 'edge' + (lastByFlow[p.f.name] === 'error' ? ' err' : '');
    return '<path class="' + cls + '" d="M ' + cx + ' ' + cy + ' Q ' + mx.toFixed(1) + ' ' + my.toFixed(1) + ', ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + '"/>';
  }).join('');

  const neurons = placed.map(p => {
    const isRunning = running.has(p.f.name);
    const status = isRunning ? 'running' : (lastByFlow[p.f.name] === 'error' ? 'error' : (p.f.draft ? '' : 'ok'));
    const halo = isRunning ? 'url(#gradHaloAmber)' : 'url(#gradHalo)';
    return '<g class="n' + (p.f.draft ? ' dim' : '') + (isRunning ? ' pulsing' : '') + '" data-habit="' + esc(p.f.name) + '" data-status="' + status + '">' +
      '<circle class="halo" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="42" fill="' + halo + '"/>' +
      '<circle class="core" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="17"/>' +
      '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 38).toFixed(1) + '">' + esc(p.f.name) + '</text>' +
      '<text class="sub" x="' + p.x.toFixed(1) + '" y="' + (p.y + 52).toFixed(1) + '">' +
        (p.f.draft ? 'forming' : (isRunning ? 'firing…' : p.f.runs + ' runs')) + '</text></g>';
  }).join('');

  // Reflexes orbit the neuron they fire.
  const sats = state.reflexes.map((r, i) => {
    const host = placed.find(p => p.f.name === r.flow);
    if (!host) return '';
    const a = (i * 2.4) + hashOf(r.name) % 6;
    return '<circle class="satellite" r="3.5" cx="' + (host.x + 30 * Math.cos(a)).toFixed(1) + '" cy="' + (host.y + 30 * Math.sin(a)).toFixed(1) + '"><title>' + esc(r.name) + '</title></circle>';
  }).join('');

  const core =
    '<g class="n' + (anyRunning ? ' pulsing' : '') + '" id="core">' +
    '<circle class="halo" cx="' + cx + '" cy="' + cy + '" r="86" fill="url(#gradHalo)"/>' +
    '<circle class="halo" cx="' + cx + '" cy="' + cy + '" r="52" fill="url(#gradHalo)"/>' +
    '<circle class="core" cx="' + cx + '" cy="' + cy + '" r="26" fill="url(#gradCore)"/>' +
    '<text class="corelabel" x="' + cx + '" y="' + (cy + 54) + '">the mind</text></g>';

  stage.innerHTML =
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    defs() + edges + sats + neurons + core + '</svg>' +
    (flows.length ? '' : '<p class="hint">No flows yet — when habits crystallize and get promoted, they appear here as neurons.</p>');

  stage.querySelectorAll('[data-habit]').forEach(g =>
    g.onclick = () => openHabit(g.dataset.habit));
}

async function openHabit(name) {
  const h = await fetch('/api/habits/' + encodeURIComponent(name)).then(r => r.json());
  if (h.error) return;
  view = 'habit';
  $('#detail').innerHTML =
    '<button class="back" id="back">← the brain</button>' +
    '<div class="card"><h3>' + esc(h.name) + '</h3><p>' + esc(h.description) + '</p></div>' +
    '<div class="canvas-wrap">' + svg(h.layout, h.nodes) + '</div>' +
    '<div class="card"><div class="kv">' +
    '<span>learned from</span><b>' + h.runs + ' runs</b>' +
    '<span>asks for</span><b>' + (h.params.length ? esc(h.params.map(function (p) { return p && p.name ? p.name : p; }).join(', ')) : '—') + '</b>' +
    '<span>status</span><b>' + esc(h.status) + '</b></div></div>' +
    (h.triggers.length ? '<div class="card"><h3>What people said to ask for it</h3><pre>' +
      esc(h.triggers.join('\n')) + '</pre></div>' : '');
  $('#back').onclick = () => { renderBrain(); renderSide(); };
  wireNodes(h.nodes);
}

async function openRun(id) {
  selected = id;
  const e = await fetch('/api/executions/' + id).then(r => r.json());
  if (e.error) return;
  view = 'run';
  $('#detail').innerHTML =
    '<button class="back" id="back">← the brain</button>' +
    '<div class="card"><h3>' + (e.kind === 'flow' ? (e.flow ? esc(e.flow) + ' run' : 'SquidFlow run') : 'Improvised thought') + ' · ' +
      '<span class="' + (e.status === 'error' ? 'err' : '') + '">' + e.status + '</span></h3>' +
      '<p>' + esc(e.shape) + '</p></div>' +
    '<div class="canvas-wrap">' + svg(e.layout, e.nodes) + '</div>' +
    '<div class="card"><div class="kv">' +
      '<span>started</span><b>' + new Date(e.startedAt).toLocaleString() + '</b>' +
      '<span>took</span><b>' + (dur(e.durationMs) || '—') + '</b>' +
      '<span>steps</span><b>' + e.steps + '</b></div></div>' +
    '<div id="node-detail"><p class="hint">Click a neuron to see exactly what went in and what came out.</p></div>';
  $('#back').onclick = () => { selected = null; renderBrain(); renderSide(); };
  wireNodes(e.nodes);
  renderSide();
}

/* ——— a run's inner network: each step a neuron, fired synapses animated ——— */
function svg(L, nodes) {
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const fired = (id) => { const s = (byId[id] || {}).status; return s === 'ok' || s === 'error' || s === 'running'; };
  const edges = L.edges.map(e => {
    const cls = 'edge' +
      (fired(e.from) && fired(e.to) ? ((byId[e.to] || {}).status === 'error' ? ' fired err' : ' fired') : '');
    return '<path class="' + cls + '" d="' + e.path + '"/>';
  }).join('');
  const orbs = L.nodes.map(n => {
    const info = byId[n.id] || {};
    const imported = info.params && info.params.n8nName;
    const name = imported ? String(info.params.n8nName) : n.node;
    const label = name.length > 19 ? name.slice(0, 18) + '…' : name;
    const sub = (info.status || 'not run') + (info.durationMs != null ? ' · ' + dur(info.durationMs) : '');
    const ox = n.x + n.width / 2, oy = n.y + 30;
    return '<g class="n" data-node="' + n.id + '" data-status="' + (info.status || '') + '">' +
      '<circle class="halo" cx="' + ox + '" cy="' + oy + '" r="34" fill="url(#gradHalo)"/>' +
      '<circle class="core" cx="' + ox + '" cy="' + oy + '" r="15"/>' +
      '<text x="' + ox + '" y="' + (oy + 34) + '">' + esc(label) + '</text>' +
      '<text class="sub" x="' + ox + '" y="' + (oy + 48) + '">' + esc(sub) + '</text></g>';
  }).join('');
  return '<svg width="' + Math.max(L.width, 320) + '" height="' + L.height + '" ' +
    'viewBox="0 0 ' + L.width + ' ' + L.height + '">' + defs() + edges + orbs + '</svg>';
}

function wireNodes(nodes) {
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  document.querySelectorAll('.n[data-node]').forEach(g => g.onclick = () => {
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

/* ——— ambient: the space the mind floats in ——— */
(function ambient() {
  const cv = $('#bg'), ctx = cv.getContext('2d');
  const WORDS = ['function','output','true','then','flow','habit','if','else','signal','recall'];
  let parts = [], words = [];
  function size() {
    cv.width = innerWidth; cv.height = innerHeight;
    parts = Array.from({length: Math.min(110, Math.floor(innerWidth / 12))}, () => ({
      x: Math.random() * cv.width, y: Math.random() * cv.height,
      vx: (Math.random() - .5) * .18, vy: (Math.random() - .5) * .18,
      r: Math.random() * 1.8 + .6, amber: Math.random() < .28,
    }));
    words = WORDS.map(w => ({ w, x: Math.random() * cv.width, y: Math.random() * cv.height,
      vy: -.06 - Math.random() * .06, o: .05 + Math.random() * .06 }));
  }
  size(); addEventListener('resize', size);
  (function tick() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x = (p.x + p.vx + cv.width) % cv.width;
      p.y = (p.y + p.vy + cv.height) % cv.height;
    }
    ctx.lineWidth = .5;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j], dx = a.x - b.x, dy = a.y - b.y, d = dx*dx + dy*dy;
      if (d < 10000) {
        ctx.strokeStyle = 'rgba(90,170,240,' + (0.06 * (1 - d / 10000)).toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    for (const p of parts) {
      ctx.fillStyle = p.amber ? 'rgba(255,179,92,.5)' : 'rgba(79,195,255,.55)';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    ctx.font = '11px ui-monospace, Menlo, monospace';
    for (const w of words) {
      w.y = (w.y + w.vy + cv.height) % cv.height;
      ctx.fillStyle = 'rgba(140,190,240,' + w.o.toFixed(3) + ')';
      ctx.fillText(w.w, w.x, w.y);
    }
    requestAnimationFrame(tick);
  })();
})();

// Live: the agent acts on its own, so the page must too.
const events = new EventSource('/api/events');
events.onmessage = async (m) => {
  const data = JSON.parse(m.data);
  if (data.type === 'executions') {
    runs = data.executions;
    state.counts.executions = runs.length;
    renderSide();
    if (view === 'brain') renderBrain();
    if (view === 'run' && selected) {
      const still = runs.find(r => r.id === selected);
      if (still && still.status === 'running') openRun(selected);
    }
  }
};

load();
</script>
</body>
</html>`;
