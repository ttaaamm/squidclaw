import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { clearNodes, registerNode, executeGraph, Journal } from "@squidclaw/kernel";
import { telegramSendNode, gotenbergRenderNode } from "@squidclaw/nodes";

/** One fake world: pretends to be both Telegram's API and Gotenberg. */
let server: Server;
let base: string;
const received: Array<{ url: string; contentType: string; body: Buffer }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        contentType: req.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
      });
      if (req.url?.includes("/forms/chromium/convert/html")) {
        res.setHeader("content-type", "application/pdf");
        res.end(Buffer.from("%PDF-1.4 fake-but-valid-enough\n%%EOF"));
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

describe("telegram.send", () => {
  it("sends a text message", async () => {
    received.length = 0;
    const node = telegramSendNode({ apiRoot: base, token: "tkn" });
    const out = await node.run({ chatId: "77", text: "invoice ready" }, [], { tenantId: "t" });

    expect(out[0].json).toEqual({ sent: true, kind: "message" });
    expect(received[0].url).toBe("/bottkn/sendMessage");
    expect(JSON.parse(received[0].body.toString())).toEqual({ chat_id: "77", text: "invoice ready" });
  });

  it("sends binary flowing in from the previous node as a document", async () => {
    received.length = 0;
    const node = telegramSendNode({ apiRoot: base, token: "tkn" });
    const pdf = Buffer.from("%PDF-1.4 the-invoice");
    const out = await node.run(
      { chatId: "77", filename: "invoice.pdf", text: "your invoice" },
      [{ json: { bytes: pdf.length }, binary: { data: pdf } }],
      { tenantId: "t" },
    );

    expect(out[0].json.kind).toBe("document");
    expect(received[0].url).toBe("/bottkn/sendDocument");
    expect(received[0].contentType).toContain("multipart/form-data");
    const raw = received[0].body.toString("latin1");
    expect(raw).toContain('filename="invoice.pdf"');
    expect(raw).toContain("the-invoice");
    expect(raw).toContain("your invoice"); // caption came along
  });

  it("refuses to run without a token, and with nothing to send", async () => {
    const bare = telegramSendNode({ apiRoot: base });
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(bare.run({ chatId: "77", text: "x" }, [], { tenantId: "t" })).rejects.toThrow(/TOKEN missing/);

    const node = telegramSendNode({ apiRoot: base, token: "tkn" });
    await expect(node.run({ chatId: "77" }, [], { tenantId: "t" })).rejects.toThrow(/nothing to send/);
  });
});

describe("gotenberg.render", () => {
  it("posts the html as index.html — the name Gotenberg insists on — and returns binary", async () => {
    received.length = 0;
    const node = gotenbergRenderNode({ baseUrl: base });
    const out = await node.run({ html: "<h1>فاتورة</h1>", filename: "invoice.pdf" }, [], { tenantId: "t" });

    expect(received[0].url).toBe("/forms/chromium/convert/html");
    expect(received[0].body.toString("latin1")).toContain('filename="index.html"');
    expect(out[0].json).toMatchObject({ filename: "invoice.pdf", kind: "pdf" });
    expect(out[0].binary!.data.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("the invoice pipeline, end to end", () => {
  it("renders a PDF and delivers it to Telegram as one flow — binary crossing the edge", async () => {
    clearNodes();
    registerNode(gotenbergRenderNode({ baseUrl: base }));
    registerNode(telegramSendNode({ apiRoot: base, token: "tkn" }));
    received.length = 0;

    const rec = await executeGraph(
      {
        nodes: [
          { id: "render", node: "gotenberg.render", params: { html: "<h1>Invoice #42</h1>", filename: "invoice-42.pdf" } },
          { id: "deliver", node: "telegram.send", params: { chatId: "77", filename: "invoice-42.pdf", text: "Invoice #42" } },
        ],
        edges: [{ from: "render", to: "deliver" }],
      },
      { tenantId: "t", kind: "flow", journal: new Journal(":memory:") },
    );

    expect(rec.status).toBe("ok");
    expect(rec.steps).toHaveLength(2);
    // The PDF really crossed the edge: Telegram received the bytes Gotenberg made.
    const sent = received.find((r) => r.url === "/bottkn/sendDocument")!;
    expect(sent.body.toString("latin1")).toContain("fake-but-valid-enough");
  });
});
