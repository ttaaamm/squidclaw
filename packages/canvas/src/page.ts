/**
 * The window into the agent's mind — now a 3D brain you can hold.
 *
 * One WebGL scene (three.js, self-hosted): the agent a burning core, every
 * workflow a neuron floating around it in space, dendrites curving between
 * them. Grab and ROTATE the whole brain, zoom from any side; glide close to
 * a neuron and its inner network fades in around it — steps as smaller
 * neurons, synapses that fired carrying moving signals. Nothing navigates
 * away: details open as a glass overlay on the same page.
 *
 * Live over SSE: a running flow pulses at every zoom level, and inside a
 * zoomed neuron the frontier step — parents done, no record yet — burns
 * amber as "firing right now".
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SquidClaw — the mind</title>
<script type="importmap">{"imports":{"three":"/assets/three.js"}}</script>
<style>
  :root {
    --glass:rgba(9,19,38,.66); --glass2:rgba(12,24,46,.55); --line:rgba(110,190,255,.16);
    --ink:#d9e9ff; --dim:#6e87a8; --accent:#4fc3ff; --amber:#ffb35c; --err:#ff5c7a; --ok:#39e6b0;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; overflow:hidden; background:#03060e; color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  #scene { position:fixed; inset:0; }
  #labels { position:fixed; inset:0; pointer-events:none; z-index:2; }
  .lbl { position:absolute; transform:translate(-50%,0); text-align:center; white-space:nowrap;
    font:11.5px var(--mono); color:var(--ink); text-shadow:0 0 8px rgba(3,6,14,.9); }
  .lbl small { display:block; color:var(--dim); font-size:9.5px; }
  .lbl.core { font-size:13px; letter-spacing:.08em; }

  header { position:fixed; top:0; left:0; right:0; z-index:5; display:flex; align-items:center; gap:12px;
    padding:12px 16px; background:linear-gradient(rgba(3,6,14,.75), transparent); }
  h1 { font-size:15px; margin:0; text-shadow:0 0 18px rgba(79,195,255,.6); }
  h1 span { color:var(--dim); font-weight:400; text-shadow:none; }
  .pills { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; }
  .pill { font:11px/1 var(--mono); padding:6px 9px; border:1px solid var(--line);
    border-radius:99px; color:var(--dim); background:var(--glass2); backdrop-filter:blur(8px); }
  .pill b { color:var(--ink); }
  .live-pill { display:inline-flex; align-items:center; gap:6px; }
  .live-pill .dot { width:7px; height:7px; border-radius:99px; background:var(--ok); animation:pulse 2s infinite; }

  #menu-btn { z-index:6; font:12px var(--mono); color:var(--accent); background:var(--glass);
    border:1px solid var(--line); border-radius:8px; padding:7px 11px; cursor:pointer; backdrop-filter:blur(8px); }
  #home-btn { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); z-index:5;
    font:12px var(--mono); color:var(--accent); background:var(--glass); border:1px solid var(--line);
    border-radius:99px; padding:8px 16px; cursor:pointer; backdrop-filter:blur(8px); display:none; }
  #hint { position:fixed; bottom:16px; right:18px; z-index:4; font:10.5px var(--mono); color:var(--dim); text-align:right; }

  #side { position:fixed; top:53px; left:0; bottom:0; width:300px; z-index:5; overflow-y:auto;
    background:var(--glass); backdrop-filter:blur(12px); border-right:1px solid var(--line);
    transform:translateX(-100%); transition:transform .25s ease; }
  #side.open { transform:none; }
  .group { border-bottom:1px solid var(--line); }
  .group > h2 { font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--dim); margin:0; padding:12px 16px 6px; }
  .row { display:block; width:100%; text-align:left; background:none; border:0; color:inherit;
    padding:9px 16px; cursor:pointer; border-left:2px solid transparent; font:inherit; }
  .row:hover { background:rgba(79,195,255,.07); }
  .row .top { display:flex; gap:8px; align-items:center; }
  .row .shape { font:11px/1.4 var(--mono); color:var(--dim); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:7px; height:7px; border-radius:99px; flex:none; }
  .ok { background:var(--ok); box-shadow:0 0 8px rgba(57,230,176,.7); }
  .error { background:var(--err); box-shadow:0 0 8px rgba(255,92,122,.7); }
  .running { background:var(--amber); box-shadow:0 0 8px rgba(255,179,92,.8); animation:pulse 1.4s infinite; }
  .kind { font:10px/1 var(--mono); padding:3px 6px; border-radius:4px; border:1px solid var(--line); color:var(--dim); }
  .kind.flow { color:var(--accent); border-color:rgba(79,195,255,.4); }
  .when { margin-left:auto; font:10px/1 var(--mono); color:var(--dim); }
  .empty { padding:14px 16px; color:var(--dim); font-size:13px; }

  #inspector { position:fixed; top:53px; right:0; bottom:0; width:min(430px, 92vw); z-index:5; overflow-y:auto;
    background:var(--glass); backdrop-filter:blur(12px); border-left:1px solid var(--line);
    padding:16px; transform:translateX(100%); transition:transform .25s ease; }
  #inspector.open { transform:none; }
  .card { border:1px solid var(--line); border-radius:12px; background:var(--glass2); padding:13px 15px; margin-bottom:12px; }
  .card h3 { margin:0 0 4px; font-size:13px; }
  .card p { margin:0; color:var(--dim); font-size:12.5px; }
  pre { margin:0; font:11.5px/1.55 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:280px; overflow:auto; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font:12px var(--mono); color:var(--dim); }
  .kv b { color:var(--ink); font-weight:500; }
  .err-text { color:var(--err); }
  .x { float:right; color:var(--dim); cursor:pointer; font:14px var(--mono); background:none; border:0; }
  @keyframes pulse { 50% { opacity:.35 } }
</style>
</head>
<body>
<canvas id="scene"></canvas>
<div id="labels"></div>
<header>
  <button id="menu-btn">☰</button>
  <h1>🐙 SquidClaw <span>— the mind</span></h1>
  <div class="pills" id="pills"></div>
</header>
<aside id="side"></aside>
<section id="inspector"></section>
<button id="home-btn">⟵ whole brain</button>
<div id="hint">drag to rotate · scroll to zoom · right-drag to pan<br>click a neuron to enter it</div>

<script type="module">
import * as THREE from 'three';
import { OrbitControls } from '/assets/orbit.js';

const STATIC = location.search.includes('static');
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
const hashOf = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

/* ————— the stage ————— */
const renderer = new THREE.WebGLRenderer({ canvas: $('#scene'), antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03060e);
scene.fog = new THREE.FogExp2(0x03060e, 0.0016);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
camera.position.set(0, 34, 165);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 8;
controls.maxDistance = 480;
controls.autoRotate = !STATIC;
controls.autoRotateSpeed = 0.5;
let idleTimer;
controls.addEventListener('start', () => {
  controls.autoRotate = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { controls.autoRotate = !STATIC; }, 20000);
});

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
resize(); addEventListener('resize', resize);

/* ————— glow language: procedural sprite textures ————— */
function glowTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner); grad.addColorStop(0.35, outer); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const TEX = {
  cyan: glowTexture('rgba(255,255,255,1)', 'rgba(79,195,255,.85)'),
  amber: glowTexture('rgba(255,250,240,1)', 'rgba(255,179,92,.9)'),
  red: glowTexture('rgba(255,240,244,1)', 'rgba(255,92,122,.9)'),
  dim: glowTexture('rgba(180,200,225,.9)', 'rgba(70,95,130,.6)'),
  halo: glowTexture('rgba(79,195,255,.35)', 'rgba(79,195,255,.12)'),
  haloAmber: glowTexture('rgba(255,179,92,.4)', 'rgba(255,179,92,.14)'),
};
function sprite(tex, size, opacity) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: opacity == null ? 1 : opacity,
  }));
  s.scale.setScalar(size);
  return s;
}

/* ————— ambient space ————— */
const ambient = new THREE.Group(); scene.add(ambient);
function starField(count, color, size, spread) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) pos[i] = (Math.random() - 0.5) * spread;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color, size, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
}
ambient.add(starField(500, 0x4fc3ff, 1.1, 620));
ambient.add(starField(180, 0xffb35c, 1.3, 620));

/* ————— the brain ————— */
const brain = new THREE.Group(); scene.add(brain);
const core = new THREE.Group();
core.add(sprite(TEX.cyan, 30), sprite(TEX.halo, 95, .9), sprite(TEX.halo, 55, .9));
brain.add(core);

let state = null, runs = [];
const neurons = new Map(); // name -> {group, coreSprite, halo, pos, flow, cluster?, statuses?}
let focused = null;        // name of the neuron the camera lives inside
const labels = [];         // {el, obj, minDist, maxDist}

function label(text, sub, obj, cls, minDist, maxDist) {
  const el = document.createElement('div');
  el.className = 'lbl' + (cls ? ' ' + cls : '');
  el.innerHTML = esc(text) + (sub ? '<small>' + esc(sub) + '</small>' : '');
  $('#labels').appendChild(el);
  const entry = { el, obj, minDist: minDist || 0, maxDist: maxDist || 1e9 };
  labels.push(entry);
  return entry;
}

/** Neurons breathe on a fibonacci sphere — every side of the brain is a side. */
function neuronPosition(i, n, name) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * i + (hashOf(name) % 100) / 160;
  const R = 62 + (hashOf(name + 'r') % 22);
  return new THREE.Vector3(Math.cos(theta) * r * R, y * R * 0.8, Math.sin(theta) * r * R);
}

function dendrite(from, to, name) {
  const mid = from.clone().lerp(to, 0.5);
  const perp = new THREE.Vector3().crossVectors(to.clone().sub(from), new THREE.Vector3(0, 1, 0.3)).normalize();
  mid.add(perp.multiplyScalar(((hashOf(name) % 30) - 15)));
  const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
  const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(42));
  const mat = new THREE.LineBasicMaterial({ color: 0x4fa8e8, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending });
  return { line: new THREE.Line(geo, mat), curve, mat };
}

function buildBrain() {
  const flows = state.habits.concat(state.drafts.map(d => Object.assign({}, d, { draft: true })));
  flows.forEach((f, i) => {
    if (neurons.has(f.name)) return;
    const pos = neuronPosition(i, flows.length, f.name);
    const group = new THREE.Group();
    group.position.copy(pos);
    const coreSprite = sprite(f.draft ? TEX.dim : TEX.cyan, 10);
    const halo = sprite(TEX.halo, 30, .8);
    coreSprite.userData = { kind: 'neuron', name: f.name };
    group.add(coreSprite, halo);
    brain.add(group);
    const d = dendrite(new THREE.Vector3(0, 0, 0), pos, f.name);
    brain.add(d.line);
    const signal = sprite(TEX.amber, 3.2, 0); brain.add(signal);
    neurons.set(f.name, { flow: f, group, coreSprite, halo, pos, dendrite: d, signal, cluster: null });
    label(f.name, f.draft ? 'forming' : f.runs + ' runs', group, '', 0, 1e9);
  });
}

/* ————— inner networks: zoom into a neuron, see its synapses ————— */
async function loadCluster(name) {
  const n = neurons.get(name);
  if (!n || n.cluster) return;
  const h = await fetch('/api/habits/' + encodeURIComponent(name)).then(r => r.json());
  if (h.error) return;
  const cluster = new THREE.Group();
  cluster.position.copy(n.pos);
  // The radial 2D layout maps onto a disc facing the core — plus depth jitter,
  // so the inner network is a small galaxy, not a flat sticker.
  const L = h.layout;
  const cx = L.width / 2, cy = L.height / 2;
  const scale = 22 / Math.max(L.width, L.height);
  const normal = n.pos.clone().normalize();
  const right = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
  if (!right.lengthSq()) right.set(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(right, normal).normalize();
  const stepObjs = new Map();
  for (const node of L.nodes) {
    const info = h.nodes.find(x => x.id === node.id) || {};
    const lx = (node.x + node.width / 2 - cx) * scale;
    const ly = (node.y + 30 - cy) * scale;
    const lz = ((hashOf(node.id) % 14) - 7) * 0.45;
    const p = right.clone().multiplyScalar(lx).add(up.clone().multiplyScalar(-ly)).add(normal.clone().multiplyScalar(lz));
    const s = sprite(TEX.cyan, 2.6);
    s.position.copy(p);
    s.userData = { kind: 'step', flow: name, id: node.id };
    const hl = sprite(TEX.halo, 7, .7); hl.position.copy(p);
    cluster.add(s, hl);
    const stepName = (info.params && info.params.n8nName) ? info.params.n8nName : node.node;
    const lbl = label(stepName, '', { getWorldPosition: (v) => v.copy(p).add(n.pos), isStep: true }, '', 0, 46);
    lbl.el.style.fontSize = '9.5px';
    stepObjs.set(node.id, { sprite: s, halo: hl, label: lbl, pos: p, node: info });
  }
  const edgeObjs = [];
  for (const e of L.edges) {
    const a = stepObjs.get(e.from), b = stepObjs.get(e.to);
    if (!a || !b) continue;
    const mid = a.pos.clone().lerp(b.pos, 0.5).add(normal.clone().multiplyScalar(((hashOf(e.from + e.to) % 10) - 5) * 0.2));
    const curve = new THREE.QuadraticBezierCurve3(a.pos, mid, b.pos);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(20));
    const mat = new THREE.LineBasicMaterial({ color: 0x4fa8e8, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    cluster.add(line);
    edgeObjs.push({ from: e.from, to: e.to, mat, curve });
  }
  cluster.visible = false;
  brain.add(cluster);
  n.cluster = { group: cluster, steps: stepObjs, edges: edgeObjs, meta: h };
  applyStatuses(name);
}

/** Latest run of this flow paints the inner network — live if it's running. */
async function applyStatuses(name) {
  const n = neurons.get(name);
  if (!n || !n.cluster) return;
  const run = runs.find(r => r.flow === name);
  if (!run) return;
  const e = await fetch('/api/executions/' + run.id).then(r => r.json());
  if (e.error) return;
  const byId = {};
  for (const node of e.nodes) byId[node.id] = node;
  if (e.status === 'running') {
    for (const node of e.nodes) {
      if (node.status) continue;
      const parents = e.layout.edges.filter(x => x.to === node.id).map(x => byId[x.from]);
      if (!parents.length || parents.some(p => p && p.status === 'ok')) byId[node.id] = Object.assign({}, node, { status: 'running' });
    }
  }
  for (const [id, obj] of n.cluster.steps) {
    const info = byId[id] || {};
    obj.node = info;
    const st = info.status;
    obj.sprite.material.map = st === 'error' ? TEX.red : st === 'running' ? TEX.amber : st === 'skipped' ? TEX.dim : TEX.cyan;
    obj.sprite.material.opacity = st === 'skipped' ? .45 : 1;
    obj.pulsing = st === 'running';
    obj.label.el.querySelector('small')?.remove();
    if (st) obj.label.el.innerHTML = esc(obj.label.el.textContent) + '<small>' + esc(st + (info.durationMs != null ? ' · ' + dur(info.durationMs) : '')) + '</small>';
  }
  for (const eo of n.cluster.edges) {
    const a = byId[eo.from] || {}, b = byId[eo.to] || {};
    const firedEdge = (a.status === 'ok') && (b.status === 'ok' || b.status === 'error' || b.status === 'running');
    eo.mat.color.set(b.status === 'error' ? 0xff5c7a : firedEdge ? 0x7fd8ff : 0x4fa8e8);
    eo.mat.opacity = firedEdge ? 0.7 : 0.22;
  }
}

/* ————— flight: click a neuron, glide inside it ————— */
let flight = null;
function flyTo(targetPos, dist, name) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  flight = {
    t: 0,
    fromT: controls.target.clone(), toT: targetPos.clone(),
    fromC: camera.position.clone(), toC: targetPos.clone().add(dir.multiplyScalar(dist)),
  };
  focused = name;
  $('#home-btn').style.display = name ? 'block' : 'none';
  if (name) loadCluster(name).then(() => applyStatuses(name));
}
$('#home-btn').onclick = () => { closeInspector(); flyTo(new THREE.Vector3(0, 0, 0), 165, null); };

/* ————— picking ————— */
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6) return; // it was a drag
  mouse.x = (ev.clientX / innerWidth) * 2 - 1;
  mouse.y = -(ev.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObjects(brain.children, true).filter(h => h.object.userData && h.object.userData.kind);
  const hit = hits[0];
  if (!hit) { closeInspector(); return; }
  const ud = hit.object.userData;
  if (ud.kind === 'neuron') {
    const n = neurons.get(ud.name);
    flyTo(n.pos, 30, ud.name);
    showFlow(n.flow);
  } else if (ud.kind === 'step') {
    showStep(ud.flow, ud.id);
  }
});

/* ————— inspector: glass, same page, no navigation ————— */
function openInspector(html) { $('#inspector').innerHTML = '<button class="x" id="insp-x">✕</button>' + html; $('#inspector').classList.add('open'); $('#insp-x').onclick = closeInspector; }
function closeInspector() { $('#inspector').classList.remove('open'); }
function showFlow(f) {
  openInspector(
    '<div class="card"><h3>' + esc(f.name) + '</h3><p>' + esc(f.description || '') + '</p></div>' +
    '<div class="card"><div class="kv">' +
    '<span>runs</span><b>' + (f.runs || 0) + '</b>' +
    '<span>asks for</span><b>' + ((f.params || []).map(p => p && p.name ? p.name : p).join(', ') || '—') + '</b>' +
    '<span>status</span><b>' + (f.draft ? 'draft' : 'promoted') + '</b></div></div>' +
    '<p style="color:var(--dim);font-size:12px">Zoom closer — the neuron opens. Click a step inside for its data.</p>');
}
function showStep(flow, id) {
  const n = neurons.get(flow);
  const obj = n && n.cluster && n.cluster.steps.get(id);
  if (!obj) return;
  const info = obj.node || {};
  const name = (info.params && info.params.n8nName) ? info.params.n8nName : (info.node || id);
  openInspector(
    '<div class="card"><h3>' + esc(name) + '</h3>' +
    (info.error ? '<p class="err-text">' + esc(info.error) + '</p>' : '<p>' + esc(info.status || 'not run yet') + '</p>') + '</div>' +
    '<div class="card"><h3>Params</h3><pre>' + esc(JSON.stringify(info.params || {}, null, 2)) + '</pre></div>' +
    (info.input && info.input.length ? '<div class="card"><h3>In</h3><pre>' + esc(JSON.stringify(info.input, null, 2)) + '</pre></div>' : '') +
    '<div class="card"><h3>Out</h3><pre>' + esc(info.output ? JSON.stringify(info.output, null, 2) : '—') + '</pre></div>');
}

/* ————— sidebar (overlay, toggleable) ————— */
$('#menu-btn').onclick = () => $('#side').classList.toggle('open');
const isSignificant = (e) => e.kind === 'flow';
let showRoutine = false;
function renderSide() {
  const visible = showRoutine ? runs : runs.filter(isSignificant);
  const hidden = runs.length - (showRoutine ? runs.length : visible.length);
  const runRows = visible.map(e =>
    '<button class="row" data-run="' + e.id + '" data-flow="' + esc(e.flow || '') + '"><div class="top">' +
    '<span class="dot ' + e.status + '"></span><span class="kind ' + e.kind + '">' + (e.kind === 'flow' ? (e.flow || 'squidflow') : e.kind) + '</span>' +
    '<span class="when">' + ago(e.startedAt) + (e.durationMs != null ? ' · ' + dur(e.durationMs) : '') + '</span></div>' +
    '<div class="shape">' + esc(e.shape) + '</div></button>').join('');
  const toggle = '<button class="row" id="routine-toggle" style="color:var(--dim);font-size:12px">' +
    (showRoutine ? 'hide improvised runs' : (hidden > 0 ? 'show ' + hidden + ' improvised run' + (hidden === 1 ? '' : 's') + ' (its thinking)' : '')) + '</button>';
  $('#side').innerHTML =
    '<div class="group"><h2>SquidFlow runs</h2>' +
    (runRows || '<p class="empty">No runs yet.</p>') + ((showRoutine || hidden > 0) ? toggle : '') + '</div>';
  $('#side').querySelectorAll('[data-run]').forEach(b => b.onclick = () => {
    const flow = b.dataset.flow;
    if (flow && neurons.has(flow)) { const n = neurons.get(flow); flyTo(n.pos, 30, flow); showFlow(n.flow); }
    $('#side').classList.remove('open');
  });
  const t = $('#routine-toggle');
  if (t) t.onclick = () => { showRoutine = !showRoutine; renderSide(); };
}

function renderPills() {
  $('#pills').innerHTML = [
    '<span class="pill live-pill"><span class="dot"></span>live</span>',
    '<span class="pill">thinking via <b>' + esc(state.mind.via) + '</b></span>',
    '<span class="pill"><b>' + state.mind.tools + '</b> tools</span>',
    '<span class="pill"><b>' + state.counts.habits + '</b> neurons</span>',
  ].join('');
}

/* ————— live states ————— */
function refreshNeuronStates() {
  const running = new Set(runs.filter(r => r.status === 'running' && r.flow).map(r => r.flow));
  const lastByFlow = {};
  for (const r of runs) if (r.flow && !(r.flow in lastByFlow)) lastByFlow[r.flow] = r.status;
  for (const [name, n] of neurons) {
    n.running = running.has(name);
    n.coreSprite.material.map = n.running ? TEX.amber : lastByFlow[name] === 'error' ? TEX.red : (n.flow.draft ? TEX.dim : TEX.cyan);
    n.halo.material.map = n.running ? TEX.haloAmber : TEX.halo;
    n.dendrite.mat.color.set(n.running ? 0xffb35c : lastByFlow[name] === 'error' ? 0xff5c7a : 0x4fa8e8);
    n.dendrite.mat.opacity = n.running ? 0.55 : 0.22;
    if (n.running && n.cluster) applyStatuses(name);
  }
}

/* ————— the heartbeat ————— */
const clock = new THREE.Clock();
let frames = 0;
function animate() {
  const t = clock.getElapsedTime();
  if (flight) {
    flight.t = Math.min(1, flight.t + 0.022);
    const k = flight.t < 0.5 ? 2 * flight.t * flight.t : 1 - Math.pow(-2 * flight.t + 2, 2) / 2;
    controls.target.lerpVectors(flight.fromT, flight.toT, k);
    camera.position.lerpVectors(flight.fromC, flight.toC, k);
    if (flight.t >= 1) flight = null;
  }
  controls.update();
  ambient.rotation.y = t * 0.004;

  const camDist = (p) => camera.position.distanceTo(p);
  for (const [name, n] of neurons) {
    const pulse = n.running ? 1 + Math.sin(t * 5) * 0.22 : 1;
    n.coreSprite.scale.setScalar(10 * pulse);
    n.halo.scale.setScalar(30 * (n.running ? 1 + Math.sin(t * 5) * 0.12 : 1));
    if (n.running) {
      n.signal.material.opacity = 0.95;
      n.signal.position.copy(n.dendrite.curve.getPoint((t * 0.45 + hashOf(name) % 10 / 10) % 1));
    } else n.signal.material.opacity = 0;
    // Semantic zoom: the inner network breathes in as you approach.
    const d = camDist(n.group.position);
    if (n.cluster) {
      const near = Math.max(0, Math.min(1, (52 - d) / 22));
      n.cluster.group.visible = near > 0.02;
      n.cluster.group.children.forEach(ch => { if (ch.material) ch.material.opacity = Math.min(1, near) * (ch.userData.kind ? 1 : 0.6); });
      const shrink = 1 - near * 0.75;
      n.coreSprite.scale.setScalar(10 * pulse * shrink);
      n.halo.scale.setScalar(30 * shrink);
      for (const [, obj] of n.cluster.steps) {
        if (obj.pulsing) { obj.sprite.scale.setScalar(2.6 * (1 + Math.sin(t * 6) * 0.3)); obj.halo.scale.setScalar(7 * (1 + Math.sin(t * 6) * 0.2)); }
      }
    } else if (d < 60) loadCluster(name);
  }

  // Labels follow their objects through space.
  const v = new THREE.Vector3();
  for (const l of labels) {
    l.obj.getWorldPosition(v);
    const d = camera.position.distanceTo(v);
    v.project(camera);
    const visible = v.z < 1 && d >= l.minDist && d <= l.maxDist;
    l.el.style.display = visible ? 'block' : 'none';
    if (visible) {
      l.el.style.left = ((v.x + 1) / 2 * innerWidth) + 'px';
      l.el.style.top = ((-v.y + 1) / 2 * innerHeight + 14) + 'px';
      l.el.style.opacity = Math.max(0.25, Math.min(1, 90 / d));
    }
  }

  renderer.render(scene, camera);
  frames++;
  if (!STATIC || frames < 45) requestAnimationFrame(animate);
}

/* ————— data in ————— */
async function load() {
  [state, runs] = await Promise.all([
    fetch('/api/state').then(r => r.json()),
    fetch('/api/executions').then(r => r.json()),
  ]);
  renderPills(); renderSide(); buildBrain(); refreshNeuronStates();
  const fly = new URLSearchParams(location.search).get('flyto');
  if (fly && neurons.has(fly)) {
    const n = neurons.get(fly);
    await loadCluster(fly); await applyStatuses(fly);
    controls.target.copy(n.pos);
    camera.position.copy(n.pos.clone().add(new THREE.Vector3(6, 8, 26)));
    focused = fly;
  }
  animate();
}
load();

if (!STATIC) {
  const events = new EventSource('/api/events');
  events.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.type === 'executions') { runs = data.executions; renderSide(); refreshNeuronStates(); }
  };
}
</script>
</body>
</html>`;
