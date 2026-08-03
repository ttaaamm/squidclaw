import { describe, it, expect } from "vitest";
import { WhatsAppSurface, type WaMessage, type WaSocket } from "@squidclaw/surfaces";

/** A WhatsApp that exists only in memory. */
function fakeSocket() {
  let messageHandler: ((msg: WaMessage) => void) | undefined;
  let qrHandler: ((qr: string) => void) | undefined;
  const sent: Array<{ chatId: string; text: string }> = [];
  const presence: string[] = [];

  const socket: WaSocket = {
    onMessage: (h) => (messageHandler = h),
    onQr: (h) => (qrHandler = h),
    onReady: () => {},
    sendText: async (chatId, text) => void sent.push({ chatId, text }),
    typing: async (_chatId, on) => void presence.push(on ? "composing" : "paused"),
    stop: async () => {},
  };

  return {
    socket,
    sent,
    presence,
    incoming: (msg: WaMessage) => messageHandler?.(msg),
    showQr: (qr: string) => qrHandler?.(qr),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("the whatsapp face", () => {
  it("routes a message to the handler and replies in the same chat", async () => {
    const fake = fakeSocket();
    const surface = new WhatsAppSurface(
      async (chatId, text) => `heard ${text} from ${chatId}`,
      { connect: async () => fake.socket },
    );
    await surface.start();

    fake.incoming({ chatId: "9665xxxx@s.whatsapp.net", text: "hello" });
    await flush();

    expect(fake.sent).toEqual([
      { chatId: "9665xxxx@s.whatsapp.net", text: "heard hello from 9665xxxx@s.whatsapp.net" },
    ]);
  });

  it("shows typing while working and stops after", async () => {
    const fake = fakeSocket();
    const surface = new WhatsAppSurface(async () => "done", { connect: async () => fake.socket });
    await surface.start();

    fake.incoming({ chatId: "x@s.whatsapp.net", text: "hi" });
    await flush();

    expect(fake.presence[0]).toBe("composing");
    expect(fake.presence.at(-1)).toBe("paused");
  });

  it("narrates slow work, throttled like every other face", async () => {
    const fake = fakeSocket();
    const surface = new WhatsAppSurface(
      async (_c, _t, progress) => {
        progress?.("running web.search…");
        return "found";
      },
      { connect: async () => fake.socket, progressAfterMs: 0, progressGapMs: 0 },
    );
    await surface.start();

    fake.incoming({ chatId: "x@s.whatsapp.net", text: "look it up" });
    await flush();

    expect(fake.sent.map((s) => s.text)).toEqual(["⚙️ running web.search…", "found"]);
  });

  it("apologises plainly when the handler explodes", async () => {
    const fake = fakeSocket();
    const surface = new WhatsAppSurface(
      async () => {
        throw new Error("brain offline");
      },
      { connect: async () => fake.socket },
    );
    await surface.start();

    fake.incoming({ chatId: "x@s.whatsapp.net", text: "hi" });
    await flush();

    expect(fake.sent[0].text).toContain("⚠️");
    expect(fake.sent[0].text).toContain("brain offline");
  });

  it("surfaces the pairing QR to whoever watches events", async () => {
    const fake = fakeSocket();
    const events: string[] = [];
    const surface = new WhatsAppSurface(async () => "", {
      connect: async () => fake.socket,
      onEvent: (e) => void events.push(e),
    });
    await surface.start();

    fake.showQr("QR-DATA-HERE");
    expect(events[0]).toContain("QR-DATA-HERE");
  });
});
