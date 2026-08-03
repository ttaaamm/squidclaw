/** Called mid-task so the surface can show life — "running web.search…". */
export type ProgressReporter = (note: string) => void;

export type MessageHandler = (
  chatId: string,
  text: string,
  progress?: ProgressReporter,
) => Promise<string>;

/** A face the agent can wear. Telegram today; WhatsApp and web later. */
export interface ChatSurface {
  start(): Promise<void>;
  stop(): Promise<void>;
}
