import { describe, it, expect } from "vitest";
import { TelegramSurface } from "@squidclaw/surfaces";
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

describe("telegram surface", () => {
  it("routes text to handler and replies", async () => {
    const surface = new TelegramSurface("test-token", async (chatId, text) => `echo:${chatId}:${text}`, botInfo);
    const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
    surface.bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true as const, result: true as never };
    });

    await surface.bot.handleUpdate(fakeUpdate("hi"));

    expect(sent[0].method).toBe("sendMessage");
    expect(sent[0].payload.text).toBe("echo:77:hi");
  });

  it("replies with a warning when the handler throws", async () => {
    const surface = new TelegramSurface("test-token", async () => {
      throw new Error("db down");
    }, botInfo);
    const sent: Array<{ payload: Record<string, unknown> }> = [];
    surface.bot.api.config.use(async (_prev, _method, payload) => {
      sent.push({ payload: payload as Record<string, unknown> });
      return { ok: true as const, result: true as never };
    });

    await surface.bot.handleUpdate(fakeUpdate("hi"));

    expect(String(sent[0].payload.text)).toContain("⚠️");
  });
});
