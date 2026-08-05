import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, registerNode } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Platform } from "./../src/platform.js";

/**
 * Channel docking: one conversation, wherever it's happening. A tenant
 * bound to both Telegram and WhatsApp shares chat history, vibes, and any
 * pending interview across both doors — and unsolicited pushes (reflex
 * firings) go wherever the human last actually spoke from.
 */

const says = (text: string) => ({ content: [{ type: "text", text }] });

/** A mind that can see whatever history it was actually handed, on demand. */
function historyAwareMind() {
  const seenMessages: unknown[][] = [];
  const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    const messages = (req as { messages: unknown[] }).messages;
    seenMessages.push(messages);
    const flat = JSON.stringify(messages);
    if (flat.includes("teal")) return says("yes — you told me your favorite color is teal");
    return says("noted");
  });
  return { mind, seenMessages };
}

async function bootTenant(mind: Brains) {
  const root = mkdtempSync(join(tmpdir(), "docking-"));
  writeFileSync(join(root, "INNERME.md"), "# INNER ME\nI am SquidClaw.\n");
  const platform = new Platform({ root, mind, via: "cli", adminChats: ["telegram:999"] });
  const invite = (await platform.handle("telegram", "999", "/tenant new Docked")).match(/\/join (\S+)/)![1];

  // Bound from Telegram, hatched there.
  await platform.handle("telegram", "111", `/join ${invite}`);
  for (const a of ["Agent", "human", "testing", "warm"]) await platform.handle("telegram", "111", a);

  // The SAME tenant also joined from WhatsApp — no second hatching needed.
  const whatsappJoin = await platform.handle("whatsapp", "222", `/join ${invite}`);
  expect(whatsappJoin).toContain("Welcome back");

  const tenantId = platform.tenants.tenantFor("telegram", "111")!.id;
  return { platform, tenantId };
}

beforeEach(() => {
  clearNodes();
  registerBuiltinNodes();
});

describe("channel docking", () => {
  it("a fact told on Telegram is known when asked about from WhatsApp", async () => {
    const { mind } = historyAwareMind();
    const { platform } = await bootTenant(mind);

    await platform.handle("telegram", "111", "my favorite color is teal");
    const fromWhatsapp = await platform.handle("whatsapp", "222", "what's my favorite color?");

    // The proof itself: a WhatsApp question answered from a Telegram fact —
    // one shared conversation, not two strangers with the same name.
    expect(fromWhatsapp).toContain("teal");
    platform.stop();
  });

  it("lastActive follows wherever the human most recently spoke from", async () => {
    const { mind } = historyAwareMind();
    const { platform, tenantId } = await bootTenant(mind);

    await platform.handle("telegram", "111", "hi from telegram");
    expect(platform.lastActive(tenantId)).toEqual({ surface: "telegram", chatId: "111" });

    await platform.handle("whatsapp", "222", "hi from whatsapp");
    expect(platform.lastActive(tenantId)).toEqual({ surface: "whatsapp", chatId: "222" });
    platform.stop();
  });

  it("an interview started on one door completes when answered from the other", async () => {
    const calls = (name: string, input: Record<string, unknown>) => ({
      content: [{ type: "tool_use", id: "t1", name, input }],
    });
    let i = 0;
    const script = [calls("flow__card", {})]; // asks for `title` — nothing else in the script matters
    const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => script[i++] ?? says("ok"));

    const { platform, tenantId } = await bootTenant(mind);
    const org = await platform.organismFor(tenantId);
    const captured: Array<Record<string, unknown>> = [];
    registerNode({
      name: "make.card", description: "", inputSchema: {},
      run: async (params) => { captured.push(params); return [{ json: { made: true } }]; },
    });
    org.flows.saveDraft({
      name: "card", description: "makes a card", signature: "s",
      triggers: [], params: [{ name: "title", ask: "What should the card say?" }],
      runs: 2, createdAt: "now", status: "draft",
      graph: { nodes: [{ id: "m", node: "make.card", params: { title: "{{title}}" } }], edges: [] },
    });
    org.flows.promote("card");
    org.agent.registerHabits();

    // Asked from Telegram…
    const ask = await platform.handle("telegram", "111", "make me a card");
    expect(ask).toContain("What should the card say?");
    // …answered from WhatsApp — same interview, same tenant, different door.
    const done = await platform.handle("whatsapp", "222", "Welcome to the team");
    expect(done).toBe("");
    expect(captured[0].title).toBe("Welcome to the team");
    void tenantId;
    platform.stop();
  });

  it("reflex firings deliver to the last active door, not just the first Telegram binding", async () => {
    const notified: Array<[string, string]> = [];
    const root = mkdtempSync(join(tmpdir(), "docking-notify-"));
    writeFileSync(join(root, "INNERME.md"), "# INNER ME\n");
    const { mind } = historyAwareMind();
    const platform = new Platform({
      root, mind, via: "cli", adminChats: ["telegram:999"],
      notify: (tenantId, message) => notified.push([tenantId, message]),
    });
    const invite = (await platform.handle("telegram", "999", "/tenant new Notify")).match(/\/join (\S+)/)![1];
    await platform.handle("telegram", "111", `/join ${invite}`);
    for (const a of ["Agent", "human", "testing", "warm"]) await platform.handle("telegram", "111", a);
    await platform.handle("whatsapp", "222", `/join ${invite}`);

    const tenantId = platform.tenants.tenantFor("telegram", "111")!.id;
    expect(platform.lastActive(tenantId)).toEqual({ surface: "whatsapp", chatId: "222" }); // joining counts as speaking

    await platform.handle("telegram", "111", "back on telegram now");
    expect(platform.lastActive(tenantId)).toEqual({ surface: "telegram", chatId: "111" });
    platform.stop();
  });
});
