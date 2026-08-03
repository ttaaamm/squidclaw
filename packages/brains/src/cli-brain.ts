import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CompleteRequest, CompleteResult, Mind, ToolSpec } from "./router.js";

const run = promisify(execFile);

/**
 * A brain that thinks through the Claude CLI instead of the API.
 *
 * Why: it runs on the human's existing subscription — no API key, no metering.
 * The CLI has no tool-use protocol, so we ask for a structured decision and
 * translate it into the same shape the API brain returns. One mind, two doors.
 */
const DECISION_SCHEMA = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["use_tool", "reply"] },
    tool: { type: "string" },
    input: { type: "object", additionalProperties: true },
    reply: { type: "string" },
  },
} as const;

function renderTools(tools: ToolSpec[]): string {
  if (!tools.length) return "You have no tools.";
  return [
    "You have these tools:",
    ...tools.map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema)}`),
    "",
    'To use one, answer with action "use_tool", the tool name, and its input.',
    "Prefer using a tool over speculating. After a tool result arrives, either use the next tool or give the final reply.",
    'When the task is done, or no tool is needed, answer with action "reply" and your reply text.',
  ].join("\n");
}

/** The API brain speaks in content blocks; so must we. */
function renderTranscript(messages: unknown[]): string {
  const lines: string[] = [];
  for (const m of messages as Array<{ role: string; content: unknown }>) {
    if (typeof m.content === "string") {
      lines.push(`${m.role.toUpperCase()}: ${m.content}`);
      continue;
    }
    for (const block of (m.content ?? []) as Array<Record<string, unknown>>) {
      if (block.type === "text") lines.push(`${m.role.toUpperCase()}: ${block.text}`);
      else if (block.type === "tool_use") lines.push(`ASSISTANT used ${block.name} with ${JSON.stringify(block.input)}`);
      else if (block.type === "tool_result")
        lines.push(`TOOL RESULT${block.is_error ? " (error)" : ""}: ${String(block.content).slice(0, 4000)}`);
    }
  }
  return lines.join("\n");
}

export interface CliBrainOptions {
  /** Maps our tiers onto CLI model aliases. */
  models?: { cheap: string; strong: string };
  timeoutMs?: number;
  /** Injectable for tests — defaults to spawning the real `claude` binary. */
  exec?: (args: string[], timeoutMs: number) => Promise<string>;
}

export class CliBrain implements Mind {
  private models: { cheap: string; strong: string };
  private timeoutMs: number;
  private exec: (args: string[], timeoutMs: number) => Promise<string>;

  constructor(opts: CliBrainOptions = {}) {
    this.models = opts.models ?? { cheap: "haiku", strong: "sonnet" };
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.exec =
      opts.exec ??
      (async (args, timeoutMs) => {
        const { stdout } = await run("claude", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        return stdout;
      });
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const prompt = [
      renderTools(req.tools ?? []),
      "",
      "Conversation so far:",
      renderTranscript(req.messages),
      "",
      "Decide the single next step.",
    ].join("\n");

    const args = [
      "-p", prompt,
      "--model", this.models[req.tier],
      "--json-schema", JSON.stringify(DECISION_SCHEMA),
    ];
    if (req.system) args.push("--append-system-prompt", req.system);

    // One retry: a single garbled output or transient CLI hiccup must not
    // derail a whole conversation turn.
    let decision: Decision;
    try {
      decision = parseDecision(await this.exec(args, this.timeoutMs));
    } catch {
      decision = parseDecision(await this.exec(args, this.timeoutMs));
    }

    if (decision.action === "use_tool" && decision.tool) {
      const block = {
        type: "tool_use",
        id: `cli_${Date.now().toString(36)}`,
        name: decision.tool,
        input: decision.input ?? {},
      };
      return {
        text: "",
        toolCalls: [{ id: block.id, name: block.name, input: block.input }],
        assistantContent: [block],
      };
    }

    const text = decision.reply ?? "";
    return { text, toolCalls: [], assistantContent: [{ type: "text", text }] };
  }
}

interface Decision {
  action: "use_tool" | "reply";
  tool?: string;
  input?: Record<string, unknown>;
  reply?: string;
}

/** The CLI prints JSON, sometimes with hook noise around it. Find the object. */
export function parseDecision(raw: string): Decision {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Decision;
  } catch {
    // fall through
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Decision;
    } catch {
      // fall through
    }
  }
  return { action: "reply", reply: trimmed || "(the brain returned nothing)" };
}
