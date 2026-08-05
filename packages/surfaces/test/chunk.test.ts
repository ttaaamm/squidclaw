import { describe, it, expect } from "vitest";
import { chunkMessage, WhatsAppSurface, type WaMessage, type WaSocket } from "@squidclaw/surfaces";

/**
 * Chat platforms reject an over-long message outright — the whole reply is
 * lost, not truncated. A real incident: one CLI failure produced a huge
 * error string, and Telegram answered "400: message is too long", so the
 * human saw nothing at all.
 */
describe("chunkMessage", () => {
  it("leaves a normal message alone", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("splits an over-long message into pieces that each fit", () => {
    const chunks = chunkMessage("x".repeat(10_000), 4_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4_000);
    expect(chunks.join("")).toHaveLength(10_000);
  });

  it("prefers a paragraph boundary over slicing mid-sentence", () => {
    const para = "A".repeat(3_000);
    const chunks = chunkMessage(`${para}\n\nsecond paragraph here`, 3_010);
    expect(chunks[0]).toBe(para);
    expect(chunks[1]).toBe("second paragraph here");
  });

  it("falls back to a line boundary when there's no blank line", () => {
    const line = "B".repeat(3_000);
    const chunks = chunkMessage(`${line}\nnext line`, 3_005);
    expect(chunks[0]).toBe(line);
    expect(chunks[1]).toBe("next line");
  });
});

function fakeSocket() {
  let messageHandler: ((msg: WaMessage) => void) | undefined;
  const sent: Array<{ chatId: string; text: string }> = [];
  const socket: WaSocket = {
    onMessage: (h) => (messageHandler = h),
    onQr: () => {},
    onReady: () => {},
    sendText: async (chatId, text) => void sent.push({ chatId, text }),
    typing: async () => {},
    stop: async () => {},
  };
  return { socket, sent, incoming: (msg: WaMessage) => messageHandler?.(msg) };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("a face sending an over-long reply", () => {
  it("delivers it as several messages instead of losing it", async () => {
    const fake = fakeSocket();
    const surface = new WhatsAppSurface(async () => "y".repeat(9_000), { connect: async () => fake.socket });
    await surface.start();

    fake.incoming({ chatId: "x@s.whatsapp.net", text: "go" });
    await flush();

    expect(fake.sent.length).toBeGreaterThan(1);
    expect(fake.sent.map((s) => s.text).join("")).toHaveLength(9_000);
  });
});
