import { describe, it, expect } from "vitest";
import { TelegramSurface, type TelegramSurfaceOptions } from "@squidclaw/surfaces";
import type { Update, UserFromGetMe } from "grammy/types";

function fakeUpdate(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10, date: 0, text,
      chat: { id: 77, type: "private", first_name: "T" },
      from: { id: 77, is_bot: false, first_name: "T" },
    },
  };
}

const botInfo = {
  id: 1, is_bot: true, first_name: "sq", username: "sq_bot",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

function capture(surface: TelegramSurface) {
  const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
  surface.bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true as const, result: true as never };
  });
  return sent;
}

const make = (
  handler: (chatId: string, text: string, progress?: (n: string) => void) => Promise<string>,
  opts: Partial<TelegramSurfaceOptions> = {},
) => new TelegramSurface("test-token", handler, { botInfo, ...opts });

describe("telegram surface", () => {
  it("routes text to handler and replies", async () => {
    const surface = make(async (chatId, text) => `echo:${chatId}:${text}`);
    const sent = capture(surface);

    await surface.bot.handleUpdate(fakeUpdate("hi"));

    const messages = sent.filter((s) => s.method === "sendMessage");
    expect(messages).toHaveLength(1);
    expect(messages[0].payload.text).toBe("echo:77:hi");
  });

  it("shows typing the moment work starts", async () => {
    const surface = make(async () => "done");
    const sent = capture(surface);

    await surface.bot.handleUpdate(fakeUpdate("hi"));

    expect(sent[0].method).toBe("sendChatAction");
    expect(sent[0].payload.action).toBe("typing");
  });

  it("narrates progress when work drags, but stays quiet for quick answers", async () => {
    // Thresholds at zero: every note passes the throttle.
    const chatty = make(async (_c, _t, progress) => {
      progress?.("running web.search…");
      progress?.("running web.read…");
      return "found it";
    }, { progressAfterMs: 0, progressGapMs: 0 });
    const sentChatty = capture(chatty);
    await chatty.bot.handleUpdate(fakeUpdate("look it up"));

    const notes = sentChatty.filter((s) => s.method === "sendMessage").map((s) => s.payload.text);
    expect(notes).toEqual(["⚙️ running web.search…", "⚙️ running web.read…", "found it"]);

    // Default thresholds: a fast task says nothing but its answer.
    const quiet = make(async (_c, _t, progress) => {
      progress?.("running web.search…");
      return "instant";
    });
    const sentQuiet = capture(quiet);
    await quiet.bot.handleUpdate(fakeUpdate("quick one"));

    const quietMessages = sentQuiet.filter((s) => s.method === "sendMessage").map((s) => s.payload.text);
    expect(quietMessages).toEqual(["instant"]);
  });

  it("throttles a flood of notes down to a trickle", async () => {
    const surface = make(async (_c, _t, progress) => {
      for (let i = 0; i < 10; i++) progress?.(`step ${i}`);
      return "done";
    }, { progressAfterMs: 0, progressGapMs: 60_000 });
    const sent = capture(surface);
    await surface.bot.handleUpdate(fakeUpdate("big job"));

    const notes = sent.filter((s) => s.method === "sendMessage" && String(s.payload.text).startsWith("⚙️"));
    expect(notes).toHaveLength(1); // first passes, the rest wait out the gap
  });

  it("replies with a warning when the handler throws", async () => {
    const surface = make(async () => {
      throw new Error("db down");
    });
    const sent = capture(surface);

    await surface.bot.handleUpdate(fakeUpdate("hi"));

    const messages = sent.filter((s) => s.method === "sendMessage");
    expect(String(messages[0].payload.text)).toContain("⚠️");
  });
});
