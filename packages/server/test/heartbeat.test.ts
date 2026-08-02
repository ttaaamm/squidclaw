import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createServer } from "node:http";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";
import { TelegramSurface } from "@squidclaw/surfaces";
import type { Update, UserFromGetMe } from "grammy/types";

/** Stand-in for the outside world the agent will reach for. */
const world = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ zen: "Non-blocking is better than blocking." }));
});
await new Promise<void>((r) => world.listen(0, r));
const port = (world.address() as { port: number }).port;
afterAll(() => world.close());

const botInfo = {
  id: 1, is_bot: true, first_name: "sq", username: "sq_bot",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

const update = (text: string): Update => ({
  update_id: 1,
  message: {
    message_id: 1, date: 0, text,
    chat: { id: 5, type: "private", first_name: "T" },
    from: { id: 5, is_bot: false, first_name: "T" },
  },
});

describe("heartbeat: telegram -> agent -> brains -> node -> journal -> reply", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("completes one full lap of the organism", async () => {
    const journal = new Journal(":memory:");
    // A scripted mind: first it reaches for the world, then it speaks.
    const responses = [
      { content: [{ type: "tool_use", id: "t1", name: "http__request", input: { url: `http://127.0.0.1:${port}/` } }] },
      { content: [{ type: "text", text: "It says: Non-blocking is better than blocking." }] },
    ];
    let i = 0;
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => responses[i++]);
    const agent = new Agent({ brains, journal, tenantId: "dev", innerMe: "I am SquidClaw." });

    const surface = new TelegramSurface("tkn", (_c, text) => agent.handleMessage(text), botInfo);
    const sent: Record<string, unknown>[] = [];
    surface.bot.api.config.use(async (_prev, _method, payload) => {
      sent.push(payload as Record<string, unknown>);
      return { ok: true as const, result: true as never };
    });

    await surface.bot.handleUpdate(update("fetch the zen and tell me what it says"));

    // It spoke.
    expect(String(sent[0].text)).toContain("Non-blocking is better than blocking");

    // And it remembered — as a graph, in workflow shape, ready to crystallize.
    const [rec] = journal.list({ tenantId: "dev" });
    expect(rec.kind).toBe("improvised");
    expect(rec.status).toBe("ok");
    expect(rec.graph.nodes).toEqual([
      { id: "n1", node: "http.request", params: { url: `http://127.0.0.1:${port}/` } },
    ]);
    expect(rec.steps[0].status).toBe("ok");
    expect((rec.steps[0].output[0].json.body as { zen: string }).zen).toContain("Non-blocking");
  });
});
