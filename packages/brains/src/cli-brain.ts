import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { CompleteRequest, CompleteResult, Mind, ToolSpec } from "./router.js";

const run = promisify(execFile);

const EXEC_ERROR_CHARS = 500;

/**
 * A failed `execFile` call's own error embeds the ENTIRE command line — the
 * whole prompt, tool list, and system prompt, sometimes tens of KB — in its
 * `.message`. Left raw, that text ends up as a reply, gets fed back into the
 * next turn's history, or gets handed to fact-extraction as if it were a
 * real exchange — each of which is how one CLI hiccup snowballs into every
 * later turn's context (and, eventually, an outgoing message too long for
 * the chat platform to even send). The full detail still reaches the logs,
 * just not the conversation.
 */
export function sanitizeExecError(err: unknown): Error {
  const e = err as { code?: number | string; signal?: string; stderr?: string; message?: string };
  console.error("[cli-brain] claude CLI invocation failed:", e.stderr || e.message || err);
  const detail = (e.stderr ?? "").trim() || String(e.message ?? err);
  const short = detail.length > EXEC_ERROR_CHARS ? `${detail.slice(0, EXEC_ERROR_CHARS)}… [trimmed]` : detail;
  const where = [e.code != null ? `exit ${e.code}` : null, e.signal ? `signal ${e.signal}` : null].filter(Boolean).join(", ");
  return new Error(`claude CLI failed${where ? ` (${where})` : ""}: ${short || "no output"}`);
}

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

/**
 * The reply's own text out of one `--output-format stream-json` line, or
 * undefined for every other event.
 *
 * The stream carries far more than the answer: init banners, rate-limit
 * notices, token counts, and `thinking_delta` — the model's private reasoning.
 * Only `text_delta` is the reply, and forwarding anything else would put the
 * model's scratchpad in front of the human.
 */
export function textDelta(line: string): string | undefined {
  try {
    const ev = JSON.parse(line) as {
      type?: string;
      event?: { delta?: { type?: string; text?: string } };
    };
    const delta = ev.event?.delta;
    if (ev.type === "stream_event" && delta?.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
  } catch {
    /* one malformed line is not worth losing the reply over */
  }
  return undefined;
}

function renderTools(tools: ToolSpec[]): string {
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
  /**
   * Same call, but reporting stdout as it arrives. Separate from `exec`
   * because `execFile` buffers to completion by design — you cannot stream
   * from it however you hold it.
   */
  execStream?: (
    args: string[],
    timeoutMs: number,
    onDelta: (chunk: string) => void,
  ) => Promise<string>;
}

export class CliBrain implements Mind {
  private models: { cheap: string; strong: string };
  private timeoutMs: number;
  private exec: (args: string[], timeoutMs: number) => Promise<string>;
  private execStream: (
    args: string[],
    timeoutMs: number,
    onDelta: (chunk: string) => void,
  ) => Promise<string>;

  constructor(opts: CliBrainOptions = {}) {
    this.models = opts.models ?? { cheap: "haiku", strong: "sonnet" };
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.exec =
      opts.exec ??
      (async (args, timeoutMs) => {
        try {
          const { stdout } = await run("claude", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          return stdout;
        } catch (err) {
          throw sanitizeExecError(err);
        }
      });

    this.execStream =
      opts.execStream ??
      ((args, timeoutMs, onDelta) =>
        new Promise<string>((resolve, reject) => {
          // Plain `-p` buffers the whole reply and prints it at the end, so
          // nothing above can stream however it is plumbed. stream-json is the
          // only mode that emits as it goes; --include-partial-messages is what
          // makes the deltas partial rather than one block per message.
          const child = spawn("claude", [
            ...args,
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--verbose",
          ]);
          let out = "";
          let line = "";
          let err = "";
          let settled = false;
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
          };
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(() => reject(new Error(`claude CLI timed out after ${timeoutMs}ms`)));
          }, timeoutMs);

          // Newline-delimited JSON events. Only the reply's own text is
          // forwarded: the stream also carries thinking_delta, which is the
          // model's private reasoning and must never reach the human.
          child.stdout.on("data", (b: Buffer) => {
            line += b.toString();
            const lines = line.split("\n");
            line = lines.pop() ?? "";
            for (const raw of lines) {
              const text = textDelta(raw);
              if (text === undefined) continue;
              out += text;
              onDelta(text);
            }
          });
          child.stderr.on("data", (b: Buffer) => (err += b.toString()));
          child.on("error", (e) => finish(() => reject(sanitizeExecError(e))));
          child.on("close", (code) =>
            finish(() =>
              code === 0
                ? resolve(out)
                : reject(sanitizeExecError({ code, stderr: err, message: `claude exited ${code}` })),
            ),
          );
        }));
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const tools = req.tools ?? [];

    // No tools means there is nothing to actually decide between -- the
    // answer is always "reply". Forcing a decision through --json-schema
    // anyway makes the CLI auto-inject its own StructuredOutput tool for
    // the model to call, and smaller models (haiku) reliably confuse that
    // internal submission mechanism with a user-facing request to "format
    // some content" -- producing replies like "give me the data you want
    // structured" to a plain "hi". Skipping the schema entirely for this
    // case sidesteps the confusion at the source instead of prompting
    // around it (verified: the same model, same input, plain-text call,
    // answers "hi" with a plain greeting).
    if (tools.length === 0) {
      const prompt = [
        "Conversation so far:",
        renderTranscript(req.messages),
        "",
        "Reply to the human directly and naturally.",
      ].join("\n");
      const args = ["-p", prompt, "--model", this.models[req.tier]];
      if (req.system) args.push("--append-system-prompt", req.system);

      let text: string;
      if (req.onDelta) {
        // A consumer that throws — a browser that hung up mid-reply — must not
        // take the turn down with it. Guarded here rather than inside any one
        // execStream, so the promise holds for every implementation.
        const onDelta = req.onDelta;
        const safe = (chunk: string) => {
          try {
            onDelta(chunk);
          } catch {
            /* the reply still completes; only the live view misses a frame */
          }
        };
        // Streaming deliberately does not retry. The retry below exists to
        // paper over a flaky first call, but a second attempt would replay
        // text the human has already watched appear. Callers that stream
        // (the fast lane) treat any stumble as a reason to escalate anyway.
        text = (await this.execStream(args, this.timeoutMs, safe)).trim();
      } else {
        try {
          text = (await this.exec(args, this.timeoutMs)).trim();
        } catch {
          text = (await this.exec(args, this.timeoutMs)).trim();
        }
      }
      return { text, toolCalls: [], assistantContent: [{ type: "text", text }] };
    }

    const prompt = [
      renderTools(tools),
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
