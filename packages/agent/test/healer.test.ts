import { describe, it, expect } from "vitest";
import type { ExecutionRecord, StepRecord } from "@squidclaw/kernel";
import { diagnose, heal } from "@squidclaw/agent";

const failing = (error: string): ExecutionRecord => ({
  id: "e1", tenantId: "dev", kind: "flow", status: "error",
  graph: { nodes: [], edges: [] }, startedAt: "now",
  steps: [
    { nodeId: "n1", node: "http.request", params: {}, input: [], output: [], status: "error", error,
      startedAt: "now", finishedAt: "now" } as StepRecord,
  ],
});

const ok = (): ExecutionRecord => ({ ...failing("x"), status: "ok", steps: [] });

describe("reading a failure the way an on-call engineer would", () => {
  it("calls network trouble transient", () => {
    for (const err of ["Error: ECONNRESET", "fetch failed", "socket hang up", "HTTP 503", "429 Too Many Requests"]) {
      expect(diagnose(failing(err)).ailment).toBe("transient");
    }
  });

  it("calls a wrong habit broken", () => {
    for (const err of ["Unknown node: telegram.send", "Unsupported imported node", "HTTP 404", "missing required param url"]) {
      expect(diagnose(failing(err)).ailment).toBe("broken");
    }
  });

  it("admits when it doesn't recognise something", () => {
    expect(diagnose(failing("the vibes were off")).ailment).toBe("unknown");
  });

  it("explains itself in plain language, naming the step", () => {
    expect(diagnose(failing("ETIMEDOUT")).reason).toContain("http.request");
    expect(diagnose(failing("ETIMEDOUT")).reason).toContain("the world was flaky");
    expect(diagnose(failing("HTTP 404")).reason).toContain("the habit itself is wrong");
  });
});

describe("healing", () => {
  const noSleep = async () => {};

  it("retries what the world merely fumbled, and stops as soon as it works", async () => {
    let attempts = 0;
    const result = await heal(
      failing("ECONNRESET"),
      async () => {
        attempts++;
        return attempts >= 2 ? ok() : failing("ECONNRESET");
      },
      { sleep: noSleep },
    );
    expect(result.healed).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("gives up after the retry budget and tells a human in plain words", async () => {
    const told: string[] = [];
    const result = await heal(failing("ETIMEDOUT"), async () => failing("ETIMEDOUT"), {
      sleep: noSleep, maxRetries: 3, notify: (m) => void told.push(m),
    });
    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(3);
    expect(told[0]).toContain("Tried 3 times");
    expect(told[0]).not.toMatch(/stack|at Object|node_modules/i);
  });

  it("never retries a broken habit — it wakes a human immediately", async () => {
    let reran = false;
    const told: string[] = [];
    const result = await heal(failing("Unknown node: telegram.send"), async () => {
      reran = true;
      return ok();
    }, { sleep: noSleep, notify: (m) => void told.push(m) });

    expect(reran).toBe(false);
    expect(result.attempts).toBe(0);
    expect(told[0]).toContain("couldn't fix this myself");
    expect(told[0]).toContain("needs changing");
  });

  it("stops retrying when the failure changes character mid-way", async () => {
    const told: string[] = [];
    const result = await heal(failing("ECONNRESET"), async () => failing("HTTP 404"), {
      sleep: noSleep, notify: (m) => void told.push(m),
    });
    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.diagnosis.ailment).toBe("broken");
    expect(told[0]).toContain("changed its mind about failing");
  });

  it("backs off exponentially", async () => {
    const waits: number[] = [];
    await heal(failing("ETIMEDOUT"), async () => failing("ETIMEDOUT"), {
      sleep: async (ms) => void waits.push(ms), maxRetries: 3, backoffMs: 100,
    });
    expect(waits).toEqual([100, 200, 400]);
  });
});
