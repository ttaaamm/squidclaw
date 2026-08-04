import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Platform } from "./../src/platform.js";

/**
 * Inferred commitments: mention an interview tomorrow, and a hidden pass
 * quietly arms a check-in for after it — capped, so care never becomes
 * nagging. OpenClaw's idea, grown on our reminder machinery.
 */

const says = (text: string) => ({ content: [{ type: "text", text }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A mind keyed by what it's being asked to do — order-independent. */
function knowingMind(commitmentJson: string) {
  return new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    const sys = String((req as { system?: string }).system ?? "");
    if (sys.includes("check-in")) return says(commitmentJson);
    if (sys.includes("facts")) return says('{"facts":[]}');
    return says("Good luck tomorrow!");
  });
}

async function boot(commitmentJson: string) {
  const root = mkdtempSync(join(tmpdir(), "commit-"));
  writeFileSync(join(root, "INNERME.md"), "# INNER ME\nI am SquidClaw.\n");
  const platform = new Platform({ root, mind: knowingMind(commitmentJson), via: "cli", adminChats: ["telegram:999"] });
  const invite = (await platform.handle("telegram", "999", "/tenant new Care")).match(/\/join (\S+)/)![1];
  await platform.handle("telegram", "111", `/join ${invite}`);
  for (const a of ["Agent", "human", "testing", "warm"]) await platform.handle("telegram", "111", a);
  const org = await platform.organismFor(platform.tenants.tenantFor("telegram", "111")!.id);
  return { platform, org };
}

const commits = (org: { reflexes: { all(): Array<{ name: string }> } }) =>
  org.reflexes.all().filter((r) => r.name.startsWith("commit-"));

beforeEach(() => {
  clearNodes();
  registerBuiltinNodes();
});

describe("inferred commitments", () => {
  it("arms a check-in after a committing exchange", async () => {
    const { platform, org } = await boot('{"commitment":{"ask":"How did the interview go?","when":"+18h"}}');

    const reply = await platform.handle("telegram", "111", "i have a job interview tomorrow morning");
    expect(reply).toBe("Good luck tomorrow!");

    for (let i = 0; i < 30 && commits(org).length === 0; i++) await sleep(50); // the pass is fire-and-forget
    const armed = commits(org) as unknown as Array<{ message?: string; at?: string; enabled: boolean }>;
    expect(armed).toHaveLength(1);
    expect(armed[0].message).toBe("💭 How did the interview go?");
    expect(armed[0].enabled).toBe(true);
    const hours = (new Date(armed[0].at!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(17);
    expect(hours).toBeLessThan(19);
    platform.stop();
  });

  it("stays silent when there is nothing to follow up on", async () => {
    const { platform, org } = await boot('{"commitment":null}');
    await platform.handle("telegram", "111", "what is 2+2?");
    await sleep(200);
    expect(commits(org)).toHaveLength(0);
    platform.stop();
  });

  it("caps at three a day — care must never become nagging", async () => {
    const { platform, org } = await boot('{"commitment":{"ask":"Checking in!","when":"+4h"}}');
    for (let i = 0; i < 3; i++) {
      org.reflexes.save({
        name: `commit-pre${i}`, message: "💭 earlier", at: new Date(Date.now() + 3_600_000).toISOString(),
        enabled: true, createdAt: new Date().toISOString(),
      });
    }
    await platform.handle("telegram", "111", "flying to Jeddah tonight");
    await sleep(300);
    expect(commits(org)).toHaveLength(3); // the fourth was never armed
    platform.stop();
  });
});
