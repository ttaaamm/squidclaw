export type MessageHandler = (chatId: string, text: string) => Promise<string>;

/** A face the agent can wear. Telegram today; WhatsApp and web later. */
export interface ChatSurface {
  start(): Promise<void>;
  stop(): Promise<void>;
}
