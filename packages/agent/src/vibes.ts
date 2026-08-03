import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Vibe {
  name: string;
  prompt: string;
}

export interface VibesConfig {
  default: string;
  vibes: Record<string, string>;
}

/** Who it is stays fixed; how it sounds is a dial. */
export const DEFAULT_VIBES: VibesConfig = {
  default: "warm",
  vibes: {
    warm: "Speak like a sharp, friendly colleague. Contractions, plain words, no corporate padding. Warm but never gushing.",
    formal:
      "Speak with professional precision. Full sentences, no slang, no emoji. Courteous and measured — appropriate for clients and official correspondence.",
    funny:
      "Be genuinely funny — dry, quick, a little mischievous. Land the joke, then land the answer. Never let a gag cost the human clarity.",
    brief: "Answer in as few words as the question honestly allows. No preamble, no summary, no restating the question.",
    teacher:
      "Explain so a smart beginner gets it. Lead with the idea, then the detail. Use a small concrete example when it helps.",
  },
};

export function loadVibes(yamlPath?: string): VibesConfig {
  if (!yamlPath || !existsSync(yamlPath)) return DEFAULT_VIBES;
  const loaded = parse(readFileSync(yamlPath, "utf8")) as Partial<VibesConfig>;
  const vibes = { ...DEFAULT_VIBES.vibes, ...(loaded.vibes ?? {}) };
  const chosen = loaded.default ?? DEFAULT_VIBES.default;
  return { default: vibes[chosen] ? chosen : DEFAULT_VIBES.default, vibes };
}

/** Remembers the tone each chat asked for. Vibes are per-conversation, not global. */
export class VibeState {
  private perChat = new Map<string, string>();

  constructor(private config: VibesConfig) {}

  list(): string[] {
    return Object.keys(this.config.vibes);
  }

  current(chatId: string): string {
    return this.perChat.get(chatId) ?? this.config.default;
  }

  set(chatId: string, name: string): boolean {
    if (!this.config.vibes[name]) return false;
    this.perChat.set(chatId, name);
    return true;
  }

  prompt(chatId: string): string {
    const name = this.current(chatId);
    return `## How I speak (${name})\n${this.config.vibes[name]}`;
  }
}
