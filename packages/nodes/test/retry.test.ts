import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchWithRetry } from "@squidclaw/nodes";

/**
 * Retry policy: transient failures get quiet second chances, the provider's
 * retry_after is honored, and absurd rate limits surface instead of stalling.
 */

let server: Server;
let script: Array<{ status: number; body: string }> = [];
const hits: number[] = [];
await new Promise<void>((r) => {
  server = createServer((_req, res) => {
    hits.push(Date.now());
    const step = script.shift() ?? { status: 200, body: '{"ok":true}' };
    res.writeHead(step.status, { "content-type": "application/json" });
    res.end(step.body);
  }).listen(0, r);
});
const BASE = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
afterAll(() => server.close());

describe("fetchWithRetry", () => {
  it("retries a 429 and succeeds, honoring retry_after", async () => {
    hits.length = 0;
    script = [
      { status: 429, body: '{"ok":false,"parameters":{"retry_after":0}}' },
      { status: 200, body: '{"ok":true,"second":true}' },
    ];
    const res = await fetchWithRetry(BASE, undefined, { minDelayMs: 40, attempts: 3 });
    expect(res.status).toBe(200);
    expect(hits).toHaveLength(2);
    expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(35); // backoff actually waited
  });

  it("gives up after its attempts and hands back the last response", async () => {
    hits.length = 0;
    script = [
      { status: 500, body: "boom" },
      { status: 500, body: "boom" },
      { status: 500, body: "boom" },
    ];
    const res = await fetchWithRetry(BASE, undefined, { minDelayMs: 5, attempts: 3 });
    expect(res.status).toBe(500);
    expect(hits).toHaveLength(3);
  });

  it("refuses to sleep through an absurd rate limit — the 429 surfaces", async () => {
    hits.length = 0;
    script = [{ status: 429, body: '{"ok":false,"parameters":{"retry_after":120}}' }];
    const res = await fetchWithRetry(BASE, undefined, { minDelayMs: 5, attempts: 3 });
    expect(res.status).toBe(429); // no two-minute nap mid-conversation
    expect(hits).toHaveLength(1);
  });
});
