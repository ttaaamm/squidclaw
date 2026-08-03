import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatSurface, MessageHandler } from "./surface.js";

/**
 * The WhatsApp face — via Baileys, the same library legacy trusts.
 *
 * Honest caveat, by design: this is the unofficial WhatsApp Web route. Fine
 * for the human's own numbers; client numbers wait for the official Meta API.
 *
 * The socket is injectable so every behavior is testable offline; the real
 * connection needs a QR scan on first pairing (printed wherever logs go).
 */

export interface WaMessage {
  chatId: string;
  text: string;
}

/** The few Baileys capabilities we consume, as an interface we can fake. */
export interface WaSocket {
  onMessage(handler: (msg: WaMessage) => void): void;
  onQr(handler: (qr: string) => void): void;
  onReady(handler: () => void): void;
  sendText(chatId: string, text: string): Promise<void>;
  typing(chatId: string, on: boolean): Promise<void>;
  stop(): Promise<void>;
}

export interface WhatsAppSurfaceOptions {
  /** Where pairing credentials persist, so one QR scan lasts. */
  authDir?: string;
  /** Injectable for tests; defaults to a real Baileys connection. */
  connect?: (authDir: string) => Promise<WaSocket>;
  /** Silence before the first progress note. */
  progressAfterMs?: number;
  progressGapMs?: number;
  /** Where to announce the pairing QR and connection events. */
  onEvent?: (event: string) => void;
}

async function connectBaileys(authDir: string): Promise<WaSocket> {
  const baileys = await import("@whiskeysockets/baileys");
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys as unknown as {
    default: (opts: Record<string, unknown>) => Record<string, unknown>;
    useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
    DisconnectReason: { loggedOut: number };
  };

  mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let messageHandler: ((msg: WaMessage) => void) | undefined;
  let qrHandler: ((qr: string) => void) | undefined;
  let readyHandler: (() => void) | undefined;

  let sock = start();

  function start(): Record<string, unknown> {
    const s = makeWASocket({ auth: state, printQRInTerminal: false, syncFullHistory: false });
    const ev = (s as { ev: { on: (event: string, cb: (arg: never) => void) => void } }).ev;

    ev.on("creds.update", saveCreds as never);
    ev.on("connection.update", ((update: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => {
      if (update.qr) qrHandler?.(update.qr);
      if (update.connection === "open") readyHandler?.();
      if (update.connection === "close") {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) sock = start(); // transient — reconnect
      }
    }) as never);
    ev.on("messages.upsert", ((upsert: { type: string; messages: unknown[] }) => {
      if (upsert.type !== "notify") return;
      for (const raw of upsert.messages) {
        const msg = raw as unknown as {
          key: { remoteJid?: string; fromMe?: boolean };
          message?: { conversation?: string; extendedTextMessage?: { text?: string } };
        };
        if (msg.key.fromMe || !msg.key.remoteJid) continue;
        const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
        if (text) messageHandler?.({ chatId: msg.key.remoteJid, text });
      }
    }) as never);
    return s;
  }

  const current = () => sock as {
    sendMessage: (jid: string, content: Record<string, unknown>) => Promise<unknown>;
    sendPresenceUpdate: (presence: string, jid: string) => Promise<void>;
    end: (err: undefined) => void;
  };

  return {
    onMessage: (h) => (messageHandler = h),
    onQr: (h) => (qrHandler = h),
    onReady: (h) => (readyHandler = h),
    sendText: async (chatId, text) => void (await current().sendMessage(chatId, { text })),
    typing: async (chatId, on) => current().sendPresenceUpdate(on ? "composing" : "paused", chatId),
    stop: async () => current().end(undefined),
  };
}

const TYPING_REFRESH_MS = 8_000;

export class WhatsAppSurface implements ChatSurface {
  private socket?: WaSocket;
  private authDir: string;
  private connect: (authDir: string) => Promise<WaSocket>;
  private progressAfterMs: number;
  private progressGapMs: number;
  private onEvent: (event: string) => void;

  constructor(
    private onMessage: MessageHandler,
    opts: WhatsAppSurfaceOptions = {},
  ) {
    this.authDir = opts.authDir ?? join(process.cwd(), "workspace", "whatsapp");
    this.connect = opts.connect ?? connectBaileys;
    this.progressAfterMs = opts.progressAfterMs ?? 6_000;
    this.progressGapMs = opts.progressGapMs ?? 10_000;
    this.onEvent = opts.onEvent ?? ((e) => console.log(`[whatsapp] ${e}`));
  }

  async start(): Promise<void> {
    const socket = await this.connect(this.authDir);
    this.socket = socket;

    socket.onQr((qr) => this.onEvent(`scan to pair:\n${qr}`));
    socket.onReady(() => this.onEvent("connected"));

    socket.onMessage((msg) => {
      void this.handle(socket, msg);
    });
  }

  private async handle(socket: WaSocket, msg: WaMessage): Promise<void> {
    // The same rhythm as every face: show life, narrate slow work, answer.
    void socket.typing(msg.chatId, true).catch(() => {});
    const heartbeat = setInterval(() => void socket.typing(msg.chatId, true).catch(() => {}), TYPING_REFRESH_MS);

    const started = Date.now();
    let lastNote = 0;
    const progress = (note: string) => {
      const now = Date.now();
      if (now - started < this.progressAfterMs) return;
      if (now - lastNote < this.progressGapMs) return;
      lastNote = now;
      void socket.sendText(msg.chatId, `⚙️ ${note}`).catch(() => {});
    };

    try {
      const reply = await this.onMessage(msg.chatId, msg.text, progress);
      await socket.sendText(msg.chatId, reply);
    } catch (err) {
      await socket.sendText(msg.chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      void socket.typing(msg.chatId, false).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    await this.socket?.stop();
  }
}
