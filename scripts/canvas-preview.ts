/**
 * A stage for the canvas: serves the real PAGE with rich fixtures so the
 * neural look can be seen and tuned without touching production. Every few
 * seconds one flow flips to "running" over SSE — the pulse, demonstrated.
 *
 * Usage: npx tsx scripts/canvas-preview.ts   (then open http://localhost:4321)
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PAGE } from "../packages/canvas/src/page.js";
import { layoutRadial } from "../packages/canvas/src/layout.js";
import type { Graph } from "@squidclaw/kernel";

const requireFrom = createRequire(import.meta.url);
const threeBuild = dirname(requireFrom.resolve("three"));
const jsmRoot = join(threeBuild, "..", "examples", "jsm");
const ASSETS: Record<string, string> = {
  "/assets/three.js": join(threeBuild, "three.module.min.js"),
  "/assets/three.core.min.js": join(threeBuild, "three.core.min.js"),
  "/assets/orbit.js": join(jsmRoot, "controls", "OrbitControls.js"),
};

const step = (id: string, n8nName: string) => ({ id, node: "n8n.step", params: { n8nName, __flow: "post" } });
const GRAPH: Graph = {
  nodes: [
    step("params-1", "Params"), step("compose-2", "Compose"),
    step("write-5", "Write Text"), step("parse-6", "Parse Text"),
    step("gen-9", "Generate Image"), step("tpl-11", "Read Template"),
    step("html-13", "Build HTML"), step("render-14", "Render PNG"),
    step("send-17", "Send Image"), step("bem-19", "Build Error Message"),
  ],
  edges: [
    { from: "params-1", to: "compose-2" }, { from: "compose-2", to: "write-5" },
    { from: "write-5", to: "parse-6" }, { from: "parse-6", to: "gen-9" },
    { from: "gen-9", to: "tpl-11" }, { from: "tpl-11", to: "html-13" },
    { from: "html-13", to: "render-14" }, { from: "render-14", to: "send-17" },
    { from: "gen-9", to: "bem-19", branch: 1 }, { from: "render-14", to: "bem-19", branch: 1 },
  ],
};

const statuses: Record<string, { status: string; durationMs?: number; error?: string }> = {
  "params-1": { status: "ok", durationMs: 2 }, "compose-2": { status: "ok", durationMs: 5 },
  "write-5": { status: "ok", durationMs: 8200 }, "parse-6": { status: "ok", durationMs: 12 },
  "gen-9": { status: "ok", durationMs: 14200 }, "tpl-11": { status: "ok", durationMs: 30 },
  "html-13": { status: "ok", durationMs: 22 }, "render-14": { status: "error", durationMs: 900, error: "Gotenberg HTTP 500" },
  "send-17": { status: "skipped" }, "bem-19": { status: "ok", durationMs: 6 },
};

const flows = [
  { name: "post", description: "The Saudi Times formal post — agent-native.", params: [{ name: "title" }, { name: "topic" }, { name: "size" }], runs: 12, status: "promoted" },
  { name: "formal-post", description: "The interactive wizard, /flow sessions only.", params: [], runs: 6, status: "promoted" },
  { name: "invoice-bot", description: "Invoices as PDFs via Gotenberg.", params: [], runs: 3, status: "promoted" },
  { name: "http-request", description: "Fetch a URL and hand back the body.", params: [{ name: "url" }], runs: 9, status: "promoted" },
  { name: "morning-brief", description: "Summarize the news at 8am.", params: [], runs: 2, status: "promoted" },
];
const drafts = [{ name: "ssh-exec", description: "Run a command over SSH.", params: [], runs: 2, status: "draft" }];

const mkRun = (id: string, flow: string | undefined, status: string, minsAgo: number, kind = "flow") => ({
  id, kind, status, steps: 10,
  startedAt: new Date(Date.now() - minsAgo * 60000).toISOString(),
  finishedAt: status === "running" ? undefined : new Date(Date.now() - minsAgo * 60000 + 45000).toISOString(),
  shape: "n8n.step → n8n.step → n8n.step", durationMs: status === "running" ? undefined : 45000,
  ...(flow ? { flow } : {}),
});

let pulseOn = false;
const runsList = () => [
  ...(pulseOn ? [mkRun("run-live", "post", "running", 0)] : []),
  mkRun("run-1", "post", "ok", 12),
  mkRun("run-2", "formal-post", "error", 55),
  mkRun("run-3", "invoice-bot", "ok", 130),
  mkRun("run-4", undefined, "ok", 200, "improvised"),
];

const detail = () => ({
  ...mkRun("run-1", "post", "error", 12),
  layout: layoutRadial(GRAPH),
  nodes: GRAPH.nodes.map((n) => ({
    id: n.id, node: n.node, params: n.params,
    ...(statuses[n.id] ?? {}), input: [{ demo: true }], output: [{ made: true }],
  })),
});

const state = {
  mind: { via: "cli", tools: 41 },
  habits: flows, drafts,
  reflexes: [
    { name: "morning-brief", cron: "0 8 * * *", flow: "morning-brief", lastStatus: "ok" },
    { name: "invoice-hook", webhook: "invoice", flow: "invoice-bot", lastStatus: "ok" },
  ],
  memories: [], counts: { executions: 4, habits: flows.length, reflexes: 2 },
};

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (url.startsWith("/assets/")) {
    const clean = url.split("?")[0];
    const asset = ASSETS[clean];
    if (asset) {
      res.setHeader("content-type", "text/javascript");
      return res.end(readFileSync(asset));
    }
    if (clean.startsWith("/assets/jsm/")) {
      const full = join(jsmRoot, clean.slice("/assets/jsm/".length));
      if (full.startsWith(jsmRoot)) {
        try {
          res.setHeader("content-type", "text/javascript");
          return res.end(readFileSync(full));
        } catch { /* fall through to 404 */ }
      }
    }
    res.statusCode = 404; return res.end("no asset");
  }
  if (url === "/" || url.startsWith("/?")) {
    // The page handles ?static itself: no SSE, render 45 frames, stop.
    res.setHeader("content-type", "text/html");
    return res.end(PAGE);
  }
  if (url === "/api/state") return json(state);
  if (url === "/api/executions") return json(runsList());
  if (url.startsWith("/api/executions/")) return json(detail());
  if (url.startsWith("/api/habits/")) {
    const name = decodeURIComponent(url.split("/").pop()!);
    const f = [...flows, ...drafts].find((x) => x.name === name) ?? flows[0];
    return json({ ...f, triggers: ["make a formal post about X"], layout: layoutRadial(GRAPH), nodes: GRAPH.nodes.map((n) => ({ id: n.id, node: n.node, params: n.params })) });
  }
  if (url === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const push = () => res.write(`data: ${JSON.stringify({ type: "executions", executions: runsList() })}\n\n`);
    const timer = setInterval(() => { pulseOn = !pulseOn; push(); }, 4000);
    req.on("close", () => clearInterval(timer));
    return push();
  }
  res.statusCode = 404; res.end("not found");
});

server.listen(4321, () => console.log("canvas preview: http://localhost:4321"));
