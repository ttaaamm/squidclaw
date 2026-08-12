import Anthropic from "@anthropic-ai/sdk";
import type { BrainsConfig, Tier } from "./config.js";

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CompleteResult {
  text: string;
  toolCalls: ToolCall[];
  assistantContent: unknown[];
}

export interface CompleteRequest {
  tier: Tier;
  system?: string;
  messages: unknown[];
  tools?: ToolSpec[];
  maxTokens?: number;
  /**
   * Called with each fragment of the reply as it arrives, for surfaces that
   * can show text appearing.
   *
   * Only honoured when there are no tools: with tools the answer is a JSON
   * decision, and half a decision is not something a human can read. A brain
   * that cannot stream ignores this and still returns the whole reply, so
   * passing it is never a reason for a surface to break.
   */
  onDelta?: (chunk: string) => void;
}

/** Anything that can think. The agent never cares which door it came through. */
export interface Mind {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

type MessagesCreate = (req: Record<string, unknown>) => Promise<unknown>;

/** One interface, many minds. Tries each model in the tier until one answers. */
export class Brains implements Mind {
  private call: MessagesCreate;

  constructor(
    private config: BrainsConfig,
    messagesCreate?: MessagesCreate,
  ) {
    this.call = messagesCreate ?? ((req) => new Anthropic().messages.create(req as never));
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    let lastErr: unknown = new Error("no models configured");
    for (const model of this.config.tiers[req.tier]) {
      try {
        const res = (await this.call({
          model,
          max_tokens: req.maxTokens ?? 1024,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
        })) as { content: Array<Record<string, unknown>> };
        const text = res.content
          .filter((b) => b.type === "text")
          .map((b) => b.text as string)
          .join("");
        const toolCalls = res.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            id: b.id as string,
            name: b.name as string,
            input: b.input as Record<string, unknown>,
          }));
        return { text, toolCalls, assistantContent: res.content };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
