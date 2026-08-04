import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, executeGraph, registerNode, Journal, type Item } from "@squidclaw/kernel";
import { n8nStepNode, importN8nWorkflow, registerBuiltinNodes } from "@squidclaw/nodes";

/**
 * Fidelity to n8n's actual behavior — every case here is a bug the real
 * formal-post bot hit on its first live conversation. The dialect must match
 * what n8n DOES, not what a reasonable person would guess it does.
 */

const ctx = { tenantId: "t" };
const item = (json: Record<string, unknown>): Item => ({ json });

// One fake HTTP server plays Telegram, Anthropic and Gotenberg.
let api: Server;
interface Seen { method?: string; url?: string; headers?: Record<string, unknown>; raw?: Buffer; json?: any }
const seen: Seen[] = [];
let respond: (url: string) => { status: number; body: string | Buffer; type: string } = () => ({
  status: 200, body: JSON.stringify({ ok: true, result: {} }), type: "application/json",
});
await new Promise<void>((r) => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const entry: Seen = { method: req.method, url: req.url, headers: req.headers as never, raw };
      try { entry.json = JSON.parse(raw.toString("utf8")); } catch { /* multipart or binary */ }
      seen.push(entry);
      const out = respond(req.url ?? "");
      res.statusCode = out.status;
      res.setHeader("content-type", out.type);
      res.end(out.body);
    });
  }).listen(0, r);
});
const PORT = (api!.address() as { port: number }).port;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SQUIDCLAW_TELEGRAM_API = BASE;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
afterAll(() => api.close());

beforeEach(() => {
  process.env.SQUIDCLAW_STATIC_DIR = mkdtempSync(join(tmpdir(), "static-"));
  seen.length = 0;
  respond = () => ({ status: 200, body: JSON.stringify({ ok: true, result: {} }), type: "application/json" });
});

describe("the walker honors n8n's cardinal rule", () => {
  it("never runs a node the switch did not route to", async () => {
    clearNodes();
    registerBuiltinNodes();
    const rec = await executeGraph(
      {
        nodes: [
          {
            id: "route", node: "n8n.step",
            params: {
              type: "n8n-nodes-base.switch", n8nName: "Route",
              parameters: {
                rules: { values: [
                  { conditions: { conditions: [{ leftValue: "={{ $json.action }}", rightValue: "render", operator: { operation: "equals" } }] } },
                  { conditions: { conditions: [{ leftValue: "={{ $json.action }}", rightValue: "reply", operator: { operation: "equals" } }] } },
                ] },
              },
            },
          },
          // The untaken branch: reading a file that does not exist. In n8n this
          // node simply never runs; before the fix it crashed the whole run.
          {
            id: "read-keys", node: "n8n.step",
            params: { type: "n8n-nodes-base.readWriteFile", n8nName: "Read Keys", parameters: { fileSelector: "/definitely/not/here/keys.json" } },
          },
          {
            id: "send", node: "n8n.step",
            params: { type: "n8n-nodes-base.telegram", n8nName: "Send Reply", parameters: { chatId: "={{ $json.chatId }}", text: "={{ $json.text }}" } },
          },
        ],
        edges: [
          { from: "route", to: "read-keys" },          // branch 0: render
          { from: "route", to: "send", branch: 1 },    // branch 1: reply
        ],
      },
      { tenantId: "t", kind: "flow", journal: new Journal(":memory:"), seedItems: [item({ action: "reply", chatId: "9", text: "hello" })] },
    );

    expect(rec.status).toBe("ok"); // the run survived
    expect(rec.steps.find((s) => s.nodeId === "read-keys")!.status).toBe("skipped");
    expect(seen.filter((s) => s.url?.includes("sendMessage"))).toHaveLength(1);
  });
});

describe("Code nodes speak full n8n", () => {
  it("require() gives Node builtins — the Store Key pattern works end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keys-"));
    const path = join(dir, "keys.json").replace(/\\/g, "\\\\");
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.code", __flow: "kf",
        parameters: { jsCode: `
          const fs = require('fs');
          fs.writeFileSync('${path}', JSON.stringify({ anthropic: 'sk-test' }), { mode: 0o600 });
          return [{ json: { saved: true } }];
        ` },
      },
      [item({})], ctx,
    );
    expect(out[0].json.saved).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"))).toEqual({ anthropic: "sk-test" });
  });

  it("refuses require() of anything that is not a builtin", async () => {
    await expect(
      n8nStepNode.run(
        { type: "n8n-nodes-base.code", __flow: "kf", parameters: { jsCode: `require('express'); return [];` } },
        [item({})], ctx,
      ),
    ).rejects.toThrow(/only Node builtins/);
  });

  it("carries n8n binary envelopes with fileName through code mutations", async () => {
    // Name PNG does exactly this: mutate item.binary.data.fileName in place.
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.code", __flow: "kf",
        parameters: { jsCode: `
          const item = $input.first();
          item.binary.data.fileName = 'renamed.png';
          return [item];
        ` },
      },
      [{ json: {}, binary: { data: { data: Buffer.from("png-bytes"), fileName: "old.png" } } }], ctx,
    );
    const bin = out[0].binary!.data as { data: Buffer; fileName?: string };
    expect(bin.fileName).toBe("renamed.png");
    expect(Buffer.isBuffer(bin.data) ? bin.data.toString() : bin.data).toBe("png-bytes");
  });
});

describe("httpRequest speaks n8n", () => {
  it("sends custom headers and hands the response body straight through as $json", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ content: [{ type: "text", text: "written copy" }] }), type: "application/json" });
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.httpRequest",
        parameters: {
          method: "POST", url: `${BASE}/v1/messages`,
          headerParameters: { parameters: [{ name: "x-api-key", value: "sk-real" }] },
          jsonBody: '{"model":"claude"}',
        },
      },
      [item({})], ctx,
    );
    expect(seen[0].headers!["x-api-key"]).toBe("sk-real");
    // n8n does NOT wrap: downstream code reads res.content[0].text directly.
    expect((out[0].json as any).content[0].text).toBe("written copy");
  });

  it("throws on HTTP errors — but neverError lets the body flow for inspection", async () => {
    respond = () => ({ status: 401, body: JSON.stringify({ error: { type: "authentication_error" } }), type: "application/json" });

    await expect(
      n8nStepNode.run(
        { type: "n8n-nodes-base.httpRequest", parameters: { method: "POST", url: `${BASE}/x` } },
        [item({})], ctx,
      ),
    ).rejects.toThrow(/HTTP 401/);

    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.httpRequest",
        parameters: { method: "POST", url: `${BASE}/x`, options: { response: { response: { neverError: true } } } },
      },
      [item({})], ctx,
    );
    expect((out[0].json as any).error.type).toBe("authentication_error"); // Parse Text's food
  });

  it("multipart formBinaryData uploads the file under its envelope fileName — Gotenberg's index.html", async () => {
    respond = () => ({ status: 200, body: Buffer.from("PNG-BYTES"), type: "image/png" });
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.httpRequest",
        parameters: {
          method: "POST", url: `${BASE}/forms/chromium/screenshot/html`,
          sendBody: true, contentType: "multipart-form-data",
          bodyParameters: { parameters: [
            { parameterType: "formBinaryData", name: "files", inputDataFieldName: "data" },
            { name: "format", value: "png" },
          ] },
          options: { response: { response: { responseFormat: "file", outputPropertyName: "data" } } },
        },
      },
      [{ json: {}, binary: { data: { data: Buffer.from("<html>x</html>", "utf8").toString("base64"), fileName: "index.html", mimeType: "text/html" } } }],
      ctx,
    );
    const raw = seen[0].raw!.toString("latin1");
    expect(raw).toContain('filename="index.html"'); // the name Gotenberg insists on
    expect(raw).toContain("<html>x</html>");        // base64 envelope decoded to real bytes
    expect(raw).toContain('name="format"');
    const bin = out[0].binary!.data as { data: Buffer; fileSize?: number; mimeType?: string };
    expect(bin.data.toString()).toBe("PNG-BYTES");  // file response landed as binary
    expect(bin.fileSize).toBe(9);                   // n8n stamps size; imported sanity checks read it
    expect(bin.mimeType).toBe("image/png");
  });
});

describe("telegram speaks the rest of the resource", () => {
  it("deleteMessage — how /setkey scrubs the key from the chat", async () => {
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.telegram",
        parameters: { resource: "message", operation: "deleteMessage", chatId: "={{ $json.chatId }}", messageId: "={{ $json.messageId }}" },
      },
      [item({ chatId: 8, messageId: 42 })], ctx,
    );
    const call = seen.find((s) => s.url?.includes("deleteMessage"))!;
    expect(call.json).toEqual({ chat_id: "8", message_id: 42 });
    expect(out[0].json.deleted).toBe(true);
  });

  it("file resource fetches and downloads into a named binary envelope", async () => {
    respond = (url) =>
      url.includes("/getFile")
        ? { status: 200, body: JSON.stringify({ ok: true, result: { file_path: "photos/pic_1.jpg" } }), type: "application/json" }
        : { status: 200, body: Buffer.from("JPEG-BYTES"), type: "image/jpeg" };
    const out = await n8nStepNode.run(
      { type: "n8n-nodes-base.telegram", parameters: { resource: "file", fileId: "={{ $json.imageFileId }}" } },
      [item({ imageFileId: "abc" })], ctx,
    );
    const bin = out[0].binary!.data as { data: Buffer; fileName?: string };
    expect(bin.data.toString()).toBe("JPEG-BYTES");
    expect(bin.fileName).toBe("pic_1.jpg");
  });

  it("sendDocument names the upload from the binary envelope", async () => {
    await n8nStepNode.run(
      { type: "n8n-nodes-base.telegram", parameters: { operation: "sendDocument", chatId: "5", binaryData: true } },
      [{ json: {}, binary: { data: { data: Buffer.from("png"), fileName: "formal-post-2026.png" } } }], ctx,
    );
    expect(seen[0].raw!.toString("latin1")).toContain('filename="formal-post-2026.png"');
  });
});

describe("error outputs — n8n's second lane", () => {
  it("a failing step with __errorOutput routes the failure to branch 1 instead of dying", async () => {
    clearNodes();
    registerBuiltinNodes();
    const caught: Item[] = [];
    registerNode({
      name: "collect.errors", description: "", inputSchema: {},
      run: async (_p, items) => { caught.push(...items); return items; },
    });
    respond = () => ({ status: 500, body: "boom", type: "text/plain" });

    const rec = await executeGraph(
      {
        nodes: [
          {
            id: "render", node: "n8n.step",
            params: { type: "n8n-nodes-base.httpRequest", n8nName: "Render PNG", __errorOutput: true, parameters: { method: "POST", url: `${BASE}/render` } },
          },
          { id: "ok-path", node: "n8n.step", params: { type: "n8n-nodes-base.noOp", n8nName: "Send Image", parameters: {} } },
          { id: "err-path", node: "collect.errors", params: {} },
        ],
        edges: [
          { from: "render", to: "ok-path" },
          { from: "render", to: "err-path", branch: 1 },
        ],
      },
      { tenantId: "t", kind: "flow", journal: new Journal(":memory:"), seedItems: [item({ chatId: 7 })] },
    );

    expect(rec.status).toBe("ok"); // the run survived the failure
    expect(caught).toHaveLength(1);
    expect(String(caught[0].json.error)).toContain("HTTP 500");
    expect(caught[0].json.chatId).toBe(7); // original json rides along for Build Error Message
    expect(rec.steps.find((s) => s.nodeId === "ok-path")!.status).toBe("skipped");
  });

  it("the importer stamps __errorOutput from onError", () => {
    const { graph } = importN8nWorkflow({
      name: "err",
      nodes: [
        { name: "Careful", type: "n8n-nodes-base.httpRequest", onError: "continueErrorOutput" },
        { name: "Normal", type: "n8n-nodes-base.noOp" },
      ],
    });
    expect(graph.nodes[0].params.__errorOutput).toBe(true);
    expect(graph.nodes[1].params.__errorOutput).toBeUndefined();
  });
});
