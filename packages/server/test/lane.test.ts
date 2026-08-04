import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Platform } from "./../src/platform.js";

/**
 * The session lane: one run per chat, ever. Mid-run messages steer into the
 * active turn; commands wait their turn; escape hatches jump the queue.
 */

const says = (text: string) => ({ content: [{ type: "text", text }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A mind whose calls can be held open until the test says go. */
function gatedMind() {
  const gates: Array<(v: unknown) => void> = [];
  const seen: Array<{ messages: unknown[] }> = [];
  let script: unknown[] = [];
  let i = 0;
  const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    seen.push({ messages: req.messages as unknown[] });
    const step = script[i++] ?? says("ok");
    if (step === "GATE") return new Promise((resolve) => gates.push(resolve));
    return step;
  });
  return {
    mind, seen,
    play: (s: unknown[]) => { script = s; i = 0; },
    release: (value: unknown) => gates.shift()?.(value),
  };
}

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "lane-"));
  writeFileSync(join(root, "INNERME.md"), "# INNER ME\nI am SquidClaw.\n");
  const g = gatedMind();
  const platform = new Platform({ root, mind: g.mind, via: "cli", adminChats: ["telegram:999"] });
  const invite = (await platform.handle("telegram", "999", "/tenant new Lane")).match(/\/join (\S+)/)![1];
  await platform.handle("telegram", "111", `/join ${invite}`);
  for (const a of ["Agent", "human", "testing", "warm"]) await platform.handle("telegram", "111", a);
  return { platform, g };
}

beforeEach(() => {
  clearNodes();
  registerBuiltinNodes();
});

describe("the session lane", () => {
  it("steers a mid-run message into the active turn — one thought answers both", async () => {
    const { platform, g } = await boot();
    g.play(["GATE", says("answered both things")]);

    const first = platform.handle("telegram", "111", "how far is the moon?");
    await sleep(50); // let the run reach the model and open for steering

    // The second message is absorbed — no second run, no separate reply.
    const second = await platform.handle("telegram", "111", "and in kilometers please");
    expect(second).toBe("");

    g.release(says("first answer"));
    const reply = await first;
    expect(reply).toContain("first answer");
    expect(reply).toContain("answered both things");
    // The steered text reached the same model turn (not a second run).
    const carried = g.seen.some((c) => JSON.stringify(c.messages).includes("and in kilometers please"));
    expect(carried).toBe(true);
    platform.stop();
  });

  it("queues commands behind the active run instead of racing it", async () => {
    const { platform, g } = await boot();
    g.play(["GATE"]);

    const first = platform.handle("telegram", "111", "think about something");
    await sleep(50);

    let habitsDone = false;
    const habits = platform.handle("telegram", "111", "/habits").then((r) => { habitsDone = true; return r; });
    await sleep(80);
    expect(habitsDone).toBe(false); // still waiting its turn

    g.release(says("thought complete"));
    await first;
    await habits;
    expect(habitsDone).toBe(true);
    platform.stop();
  });

  it("lets /flow jump the queue — stop never stands in line", async () => {
    const { platform, g } = await boot();
    g.play(["GATE"]);

    const first = platform.handle("telegram", "111", "long thought");
    await sleep(50);

    // Resolves immediately, while the long run is still gated.
    const flow = await platform.handle("telegram", "111", "/flow");
    expect(flow).toContain("flow");

    g.release(says("done"));
    await first;
    platform.stop();
  });
});
