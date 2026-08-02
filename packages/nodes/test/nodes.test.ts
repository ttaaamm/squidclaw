import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { clearNodes, getNode } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, method: req.method }));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
afterAll(() => server.close());

describe("builtin nodes", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("echo returns params as one item", async () => {
    const out = await getNode("echo")!.run({ value: 42 }, [], { tenantId: "t" });
    expect(out).toEqual([{ json: { value: 42 } }]);
  });

  it("http.request GETs and parses JSON", async () => {
    const out = await getNode("http.request")!.run({ url: `http://127.0.0.1:${port}/` }, [], { tenantId: "t" });
    expect(out[0].json.status).toBe(200);
    expect((out[0].json.body as { ok: boolean }).ok).toBe(true);
  });
});
