import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Platform } from "./../src/platform.js";

/** A Telegram that exists only in this test. */
let api: Server;
const sent: Array<{ chat_id: unknown; text: string }> = [];
await new Promise<void>((r) => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      try { sent.push(JSON.parse(raw)); } catch { /* multipart etc */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  }).listen(0, r);
});
process.env.SQUIDCLAW_TELEGRAM_API = `http://127.0.0.1:${(api!.address() as { port: number }).port}`;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
afterAll(() => api.close());

const says = (text: string) => ({ content: [{ type: "text", text }] });

function makePlatform() {
  const root = mkdtempSync(join(tmpdir(), "fsess-"));
  writeFileSync(join(root, "INNERME.md"), "# INNER ME\nI am SquidClaw.\n");
  const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => says("mind answered"));
  return new Platform({ root, mind, via: "cli", adminChats: ["telegram:999"] });
}

async function tenantWithFlow(platform: Platform) {
  const invite = (await platform.handle("telegram", "999", "/tenant new Flowy")).match(/\/join (\S+)/)![1];
  await platform.handle("telegram", "111", `/join ${invite}`);
  for (const a of ["Agent", "human", "testing", "warm"]) await platform.handle("telegram", "111", a);
  const id = platform.tenants.tenantFor("telegram", "111")!.id;
  const org = await platform.organismFor(id);

  // A tiny conversational n8n flow: trigger → code(build reply from the
  // message + a persistent counter) → telegram send back to the chat.
  process.env.SQUIDCLAW_STATIC_DIR = mkdtempSync(join(tmpdir(), "static-"));
  org.flows.saveDraft({
    name: "echo-bot", description: "echoes via n8n dialect", signature: "n8n:echo-bot",
    triggers: [], params: [], runs: 2, createdAt: "now", status: "draft",
    graph: {
      nodes: [
        { id: "trigger-1", node: "n8n.step", params: { type: "n8n-nodes-base.telegramTrigger", n8nName: "Telegram Trigger", parameters: {}, __flow: "echo-bot" } },
        {
          id: "think-2", node: "n8n.step",
          params: {
            type: "n8n-nodes-base.code", n8nName: "Build Reply", __flow: "echo-bot",
            parameters: {
              jsCode: `
                const data = $getWorkflowStaticData('global');
                data.turn = (data.turn ?? 0) + 1;
                return [{ json: {
                  chatId: $json.message.chat.id,
                  reply: 'turn ' + data.turn + ': you said "' + $json.message.text + '"',
                } }];
              `,
            },
          },
        },
        {
          id: "send-3", node: "n8n.step",
          params: {
            type: "n8n-nodes-base.telegram", n8nName: "Send Reply", __flow: "echo-bot",
            parameters: { chatId: "={{ $json.chatId }}", text: "={{ $json.reply }}" },
          },
        },
      ],
      edges: [
        { from: "trigger-1", to: "think-2" },
        { from: "think-2", to: "send-3" },
      ],
    },
  });
  org.flows.promote("echo-bot");
  return { id, org };
}

describe("flow sessions — the n8n trigger, reborn", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
    sent.length = 0;
  });

  it("hands a chat to a flow: messages become trigger items, the flow replies itself", async () => {
    const platform = makePlatform();
    await tenantWithFlow(platform);

    // Entering the session fires the flow once with the /flow message itself.
    await platform.handle("telegram", "111", "/flow echo-bot");
    expect(sent).toHaveLength(1);

    // Every following message routes into the flow — not the mind.
    const out = await platform.handle("telegram", "111", "hello flow");
    expect(out).toBe(""); // the flow spoke for itself
    expect(sent).toHaveLength(2);
    expect(String(sent[1].chat_id)).toBe("111"); // back to the real chat
    expect(sent[1].text).toContain('you said "hello flow"');
    expect(sent[1].text).toContain("turn 2"); // staticData counted across runs

    // Leaving restores the mind.
    expect(await platform.handle("telegram", "111", "/flow off")).toContain("talking to me again");
    expect(await platform.handle("telegram", "111", "hello mind")).toBe("mind answered");
    expect(sent).toHaveLength(2); // the flow stayed quiet
    platform.stop();
  });

  it("refuses to start a session on an unpromoted flow", async () => {
    const platform = makePlatform();
    const { org } = await tenantWithFlow(platform);
    org.flows.saveDraft({
      name: "draft-only", description: "", signature: "x", triggers: [], params: [],
      runs: 0, createdAt: "now", status: "draft",
      graph: { nodes: [], edges: [] },
    });
    expect(await platform.handle("telegram", "111", "/flow draft-only")).toContain("isn't a promoted flow");
    platform.stop();
  });

  it("reports a flow crash in plain words, with the exit door named", async () => {
    const platform = makePlatform();
    const { org } = await tenantWithFlow(platform);
    org.flows.saveDraft({
      name: "broken", description: "", signature: "n8n:broken", triggers: [], params: [],
      runs: 2, createdAt: "now", status: "draft",
      graph: {
        nodes: [{ id: "bad-1", node: "n8n.step", params: { type: "n8n-nodes-base.spreadsheetFile", n8nName: "Make Sheet", parameters: {}, __flow: "broken" } }],
        edges: [],
      },
    });
    org.flows.promote("broken");

    const out = await platform.handle("telegram", "111", "/flow broken");
    expect(out).toContain("Make Sheet");
    expect(out).toContain("/flow off");
    platform.stop();
  });
});
