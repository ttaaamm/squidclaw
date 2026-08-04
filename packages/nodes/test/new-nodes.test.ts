import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { binaryBuffer } from "@squidclaw/kernel";
import {
  csvMake, csvParse, csvReadNode, csvWriteNode,
  imageGenerateNode, instagramPublishNode, n8nStepNode,
} from "@squidclaw/nodes";

/**
 * The node wave: images made, posts published, tables spoken — and the
 * dialect's six new types.
 */

const ctx = { tenantId: "t" };

let api: Server;
const calls: Array<{ url: string; body: any }> = [];
let respond: (url: string) => unknown = () => ({ ok: true });
await new Promise<void>((r) => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(respond(req.url ?? "")));
    });
  }).listen(0, r);
});
const BASE = `http://127.0.0.1:${(api!.address() as { port: number }).port}`;
afterAll(() => api.close());

beforeEach(() => {
  calls.length = 0;
});

describe("image.generate", () => {
  it("turns a prompt into named PNG binary", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.SQUIDCLAW_OPENAI_API = BASE;
    respond = () => ({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] });

    const out = await imageGenerateNode().run({ prompt: "a squid reading a newspaper" }, [], ctx);
    expect(calls[0].url).toBe("/v1/images/generations");
    expect(calls[0].body.prompt).toContain("squid");
    const bin = out[0].binary!.data;
    expect(binaryBuffer(bin).toString()).toBe("png-bytes");
    expect((bin as { fileName?: string }).fileName).toBe("generated.png");
  });

  it("speaks plainly when the API refuses", async () => {
    process.env.SQUIDCLAW_OPENAI_API = BASE;
    respond = () => ({ error: { message: "billing hard limit reached" } });
    await expect(imageGenerateNode().run({ prompt: "x" }, [], ctx)).rejects.toThrow(/billing hard limit/);
  });
});

describe("instagram.publish", () => {
  it("creates the container then publishes it — two calls, one media id", async () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = "ig-token";
    process.env.INSTAGRAM_ACCOUNT_ID = "17890";
    process.env.SQUIDCLAW_GRAPH_API = BASE;
    respond = (url) => (url.includes("media_publish") ? { id: "post-99" } : { id: "container-1" });

    const out = await instagramPublishNode().run(
      { imageUrl: "https://flow.preplix.ai/cards/x.png", caption: "The Saudi Times #news" }, [], ctx,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("/17890/media");
    expect(calls[0].body.image_url).toContain("cards/x.png");
    expect(calls[1].url).toBe("/17890/media_publish");
    expect(calls[1].body.creation_id).toBe("container-1");
    expect(out[0].json).toMatchObject({ published: true, mediaId: "post-99" });
  });

  it("says exactly what is missing when not connected", async () => {
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
    await expect(instagramPublishNode().run({ imageUrl: "https://x/y.png" }, [], ctx))
      .rejects.toThrow(/INSTAGRAM_ACCESS_TOKEN/);
  });
});

describe("csv tables", () => {
  it("survives quotes, commas and embedded newlines both ways", () => {
    const rows = [
      { client: "Al Jood, LLC", note: 'said "pay tuesday"', amount: "900" },
      { client: "Saudi Times", note: "line one\nline two", amount: "1200" },
    ];
    expect(csvParse(csvMake(rows))).toEqual(rows);
  });

  it("csv.read turns flowing binary into row items; csv.write turns items into a file", async () => {
    const csv = "name,runs\npost,12\ninvoice-bot,3\n";
    const rows = await csvReadNode.run({}, [{ json: {}, binary: { data: Buffer.from(csv) } }], ctx);
    expect(rows.map((r) => r.json)).toEqual([{ name: "post", runs: "12" }, { name: "invoice-bot", runs: "3" }]);

    const file = await csvWriteNode.run({ filename: "flows.csv" }, rows, ctx);
    expect(binaryBuffer(file[0].binary!.data).toString()).toBe(csv);
    expect(file[0].json.fileName).toBe("flows.csv");
  });
});

describe("the dialect's new types", () => {
  const item = (json: Record<string, unknown>) => ({ json });

  it("filter keeps only what passes", async () => {
    const out = await n8nStepNode.run(
      {
        type: "n8n-nodes-base.filter",
        parameters: { conditions: { conditions: [{ leftValue: "={{ $json.paid }}", operator: { operation: "true" } }] } },
      },
      [item({ paid: true, id: 1 }), item({ paid: false, id: 2 }), item({ paid: true, id: 3 })],
      ctx,
    );
    expect(out.map((i) => i.json.id)).toEqual([1, 3]);
  });

  it("wait pauses for real, and caps absurd sleeps honestly", async () => {
    const t0 = Date.now();
    const out = await n8nStepNode.run(
      { type: "n8n-nodes-base.wait", parameters: { amount: 0.05, unit: "seconds" } },
      [item({ x: 1 })], ctx,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(out[0].json.waitedMs).toBe(50);

    process.env.SQUIDCLAW_WAIT_CAP_MS = "30";
    const capped = await n8nStepNode.run(
      { type: "n8n-nodes-base.wait", parameters: { amount: 3, unit: "days" } },
      [item({})], ctx,
    );
    expect(capped[0].json).toMatchObject({ waitedMs: 30, waitCapped: true });
    delete process.env.SQUIDCLAW_WAIT_CAP_MS;
  });

  it("aggregate folds many items into one", async () => {
    const out = await n8nStepNode.run(
      { type: "n8n-nodes-base.aggregate", parameters: {} },
      [item({ a: 1 }), item({ a: 2 })], ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].json.data).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("spreadsheetFile round-trips csv, and names its xlsx limit out loud", async () => {
    const toFile = await n8nStepNode.run(
      { type: "n8n-nodes-base.spreadsheetFile", parameters: { operation: "toFile" } },
      [item({ name: "post", runs: 12 })], ctx,
    );
    const back = await n8nStepNode.run(
      { type: "n8n-nodes-base.spreadsheetFile", parameters: { operation: "fromFile" } },
      toFile, ctx,
    );
    expect(back[0].json).toEqual({ name: "post", runs: "12" });

    await expect(
      n8nStepNode.run({ type: "n8n-nodes-base.spreadsheetFile", parameters: { fileFormat: "xlsx" } }, [item({})], ctx),
    ).rejects.toThrow(/only csv/);
  });

  it("scheduleTrigger and webhook are honest entry markers now", async () => {
    for (const type of ["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.webhook"]) {
      const out = await n8nStepNode.run({ type, parameters: {} }, [item({ seeded: true })], ctx);
      expect(out[0].json.seeded).toBe(true);
    }
  });
});
