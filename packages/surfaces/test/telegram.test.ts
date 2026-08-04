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
  let nextId = 100;
  surface.bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    // sendMessage answers with a real-looking message so drafts can be
    // edited and deleted by id, the way Telegram actually behaves.
    const result = method === "sendMessage" ? { message_id: nextId++, chat: { id: 77 } } : true;
    return { ok: true as const, result: result as never };
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

  it("progress is ONE draft that edits in place, then makes way for the answer", async () => {
    // Thresholds at zero: every note passes the throttle.
    const chatty = make(async (_c, _t, progress) => {
      progress?.("running web.search…");
      progress?.("running web.read…");
      return "found it";
    }, { progressAfterMs: 0, progressGapMs: 0 });
    const sentChatty = capture(chatty);
    await chatty.bot.handleUpdate(fakeUpdate("look it up"));

    // One visible working message…
    const notes = sentChatty.filter((s) => s.method === "sendMessage" && String(s.payload.text).startsWith("⚙️"));
    expect(notes).toHaveLength(1);
    expect(notes[0].payload.text).toBe("⚙️ running web.search…");
    // …that edits as the work moves…
    const edits = sentChatty.filter((s) => s.method === "editMessageText");
    expect(edits).toHaveLength(1);
    expect(edits[0].payload.text).toBe("⚙️ running web.read…");
    // …and disappears before the real answer lands as a fresh message.
    const deletes = sentChatty.filter((s) => s.method === "deleteMessage");
    expect(deletes).toHaveLength(1);
    const finals = sentChatty.filter((s) => s.method === "sendMessage").map((s) => s.payload.text);
    expect(finals.at(-1)).toBe("found it");

    // Default thresholds: a fast task says nothing but its answer.
    const quiet = make(async (_c, _t, progress) => {
      progress?.("running web.search…");
      return "instant";
    });
    const sentQuiet = capture(quiet);
    await quiet.bot.handleUpdate(fakeUpdate("quick one"));

    const quietMessages = sentQuiet.filter((s) => s.method === "sendMessage").map((s) => s.payload.text);
    expect(quietMessages).toEqual(["instant"]);
    expect(sentQuiet.filter((s) => s.method === "deleteMessage")).toHaveLength(0);
  });

  it("throttles a flood of notes down to a trickle", async () => {
    const surface = make(async (_c, _t, progress) => {
      for (let i = 0; i < 10; i++) progress?.(`step ${i}`);
      return "done";
    }, { progressAfterMs: 0, progressGapMs: 60_000 });
    const sent = capture(surface);
    await surface.bot.handleUpdate(fakeUpdate("big job"));

    const notes = sent.filter(
      (s) => (s.method === "sendMessage" || s.method === "editMessageText") && String(s.payload.text).startsWith("⚙️"),
    );
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

describe("voice notes heard at the surface", () => {
  it("transcribes before the mind wakes — the handler receives words", async () => {
    const asked: string[] = [];
    const surface = make(async (_c, text) => { asked.push(text); return "answered"; }, {
      download: async (_id, dest) => dest,
      transcribe: async () => "وينك؟ اتصل فيني",
    });
    capture(surface);

    await surface.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11, date: 0,
        chat: { id: 77, type: "private", first_name: "T" },
        from: { id: 77, is_bot: false, first_name: "T" },
        voice: { file_id: "v1", file_unique_id: "u1", duration: 2 },
      },
    } as never);

    expect(asked[0]).toContain("🎙️");
    expect(asked[0]).toContain("وينك؟ اتصل فيني");
  });

  it("a deaf moment falls back to the agent's own ears", async () => {
    const asked: string[] = [];
    const surface = make(async (_c, text) => { asked.push(text); return "ok"; }, {
      download: async (_id, dest) => dest,
      transcribe: async () => { throw new Error("server down"); },
    });
    capture(surface);

    await surface.bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 12, date: 0,
        chat: { id: 77, type: "private", first_name: "T" },
        from: { id: 77, is_bot: false, first_name: "T" },
        voice: { file_id: "v2", file_unique_id: "u2", duration: 2 },
      },
    } as never);

    expect(asked[0]).toContain("audio.transcribe");
  });
});
