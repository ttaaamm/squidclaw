import { describe, it, expect } from "vitest";
import { CliBrain, parseDecision, sanitizeExecError, textDelta } from "@squidclaw/brains";

// Verbatim lines from `claude -p --output-format stream-json
// --include-partial-messages`, so the parser is tested against what the CLI
// really emits rather than what we imagine it emits.
describe("reading the CLI's stream-json events", () => {
  it("takes the reply's text and nothing else", () => {
    expect(
      textDelta('{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"one\\ntwo"}},"session_id":"x"}'),
    ).toBe("one\ntwo");
  });

  it("never leaks the model's private reasoning", () => {
    // thinking_delta arrives on the same stream, before the answer. Forwarding
    // it would put the model's scratchpad in front of the human.
    expect(
      textDelta('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user is asking me"}},"session_id":"x"}'),
    ).toBeUndefined();
  });

  it("ignores the rest of the noise on the stream", () => {
    for (const line of [
      '{"type":"system","subtype":"init","cwd":"/root","tools":["Bash"]}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":6}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[]}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"message_stop"}}',
      '{"type":"result","subtype":"success","duration_ms":1689}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"EqsD"}}}',
    ]) {
      expect(textDelta(line), line.slice(0, 60)).toBeUndefined();
    }
  });

  it("shrugs off a truncated or empty line instead of losing the reply", () => {
    expect(textDelta('{"type":"stream_event","event":{"delta":{"type":"text_d')).toBeUndefined();
    expect(textDelta("")).toBeUndefined();
    expect(textDelta("not json at all")).toBeUndefined();
  });
});

describe("cli brain (thinks on the human's subscription)", () => {
  // The decision envelope only exists when there is a decision to make — that
  // is, when tools are on offer. These two pass tools for that reason.
  const SEARCH = { name: "web__search", description: "search the web", input_schema: { type: "object" } };

  it("turns a structured decision into a tool call", async () => {
    const brain = new CliBrain({
      exec: async () => JSON.stringify({ action: "use_tool", tool: "web__search", input: { query: "n8n" } }),
    });
    const res = await brain.complete({
      tier: "strong",
      messages: [{ role: "user", content: "search" }],
      tools: [SEARCH],
    });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("web__search");
    expect(res.toolCalls[0].input).toEqual({ query: "n8n" });
    expect((res.assistantContent[0] as { type: string }).type).toBe("tool_use");
  });

  it("turns a reply decision into text", async () => {
    const brain = new CliBrain({ exec: async () => JSON.stringify({ action: "reply", reply: "All done." }) });
    const res = await brain.complete({ tier: "cheap", messages: [], tools: [SEARCH] });
    expect(res.text).toBe("All done.");
    expect(res.toolCalls).toEqual([]);
  });

  // With nothing to choose between, asking for a decision backfires: the CLI
  // injects its own StructuredOutput tool, and smaller models mistake it for a
  // request to format content — answering "hi" with "give me the data you want
  // structured". So a toolless call asks for prose and returns it verbatim,
  // even when that prose happens to look like an envelope.
  it("asks for plain prose when there are no tools, and passes it through untouched", async () => {
    let args: string[] = [];
    const brain = new CliBrain({
      exec: async (a) => {
        args = a;
        return JSON.stringify({ action: "reply", reply: "All done." });
      },
    });
    const res = await brain.complete({ tier: "cheap", messages: [{ role: "user", content: "hi" }] });

    expect(args).not.toContain("--json-schema");
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toBe('{"action":"reply","reply":"All done."}');
  });

  it("streams the reply in fragments, and still returns the whole thing", async () => {
    const seen: string[] = [];
    const brain = new CliBrain({
      execStream: async (_args, _t, onDelta) => {
        for (const part of ["Hey", " there", "!"]) onDelta(part);
        return "Hey there!";
      },
      exec: async () => {
        throw new Error("must not fall back to the buffering path when streaming");
      },
    });
    const res = await brain.complete({
      tier: "cheap",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (c) => seen.push(c),
    });
    expect(seen).toEqual(["Hey", " there", "!"]);
    expect(res.text).toBe("Hey there!");
  });

  it("ignores onDelta when tools are on offer — half a decision is unreadable", async () => {
    const seen: string[] = [];
    const brain = new CliBrain({
      exec: async () => JSON.stringify({ action: "use_tool", tool: "web__search", input: {} }),
      execStream: async () => {
        throw new Error("the tool path must not stream");
      },
    });
    const res = await brain.complete({
      tier: "strong",
      messages: [],
      tools: [SEARCH],
      onDelta: (c) => seen.push(c),
    });
    expect(seen).toEqual([]);
    expect(res.toolCalls).toHaveLength(1);
  });

  it("does not replay a stream after a failure — it gives up instead", async () => {
    let attempts = 0;
    const brain = new CliBrain({
      execStream: async (_a, _t, onDelta) => {
        attempts++;
        onDelta("half a sen");
        throw new Error("CLI died");
      },
    });
    await expect(
      brain.complete({ tier: "cheap", messages: [], onDelta: () => {} }),
    ).rejects.toThrow("CLI died");
    // Retrying would make the human watch the same words twice.
    expect(attempts).toBe(1);
  });

  it("survives a consumer that throws mid-stream", async () => {
    const brain = new CliBrain({
      execStream: async (_a, _t, onDelta) => {
        onDelta("a");
        onDelta("b");
        return "ab";
      },
    });
    const res = await brain.complete({
      tier: "cheap",
      messages: [],
      onDelta: () => {
        throw new Error("the browser hung up");
      },
    });
    expect(res.text).toBe("ab");
  });

  it("passes the chosen model and system prompt to the CLI", async () => {
    let captured: string[] = [];
    const brain = new CliBrain({
      models: { cheap: "haiku", strong: "opus" },
      exec: async (args) => {
        captured = args;
        return JSON.stringify({ action: "reply", reply: "ok" });
      },
    });
    await brain.complete({ tier: "strong", system: "I am SquidClaw.", messages: [] });
    expect(captured[captured.indexOf("--model") + 1]).toBe("opus");
    expect(captured[captured.indexOf("--append-system-prompt") + 1]).toBe("I am SquidClaw.");
  });

  it("renders tool results from the transcript so the brain sees what happened", async () => {
    let prompt = "";
    const brain = new CliBrain({
      exec: async (args) => {
        prompt = args[args.indexOf("-p") + 1];
        return JSON.stringify({ action: "reply", reply: "ok" });
      },
    });
    await brain.complete({
      tier: "cheap",
      messages: [
        { role: "user", content: "fetch it" },
        { role: "assistant", content: [{ type: "tool_use", name: "web__read", input: { url: "u" } }] },
        { role: "user", content: [{ type: "tool_result", content: "the page said hello" }] },
      ],
      tools: [{ name: "web__read", description: "read a page", input_schema: { type: "object" } }],
    });
    expect(prompt).toContain("used web__read");
    expect(prompt).toContain("the page said hello");
    expect(prompt).toContain("read a page");
  });
});

describe("decision parsing survives noisy CLI output", () => {
  it("reads clean json", () => {
    expect(parseDecision('{"action":"reply","reply":"hi"}').reply).toBe("hi");
  });

  it("digs the object out of surrounding hook noise", () => {
    const noisy = 'SessionStart hook ran\n{"action":"reply","reply":"hi"}\nSessionEnd hook failed';
    expect(parseDecision(noisy).reply).toBe("hi");
  });

  it("falls back to treating plain prose as a reply", () => {
    const d = parseDecision("just some text");
    expect(d.action).toBe("reply");
    expect(d.reply).toBe("just some text");
  });
});

/**
 * A real incident: the CLI failed, and execFile's own error carried the
 * ENTIRE command line — prompt, tool list, system prompt — in `.message`.
 * That text became the reply, was journaled as conversation history, and
 * fed the next turn, until an outgoing message was too long for Telegram
 * to send at all ("400: message is too long") and the human saw nothing.
 */
describe("a failed CLI invocation", () => {
  it("never leaks the prompt or command line into the error the human can see", () => {
    const secretPrompt = "You have these tools: " + "x".repeat(50_000);
    const err = Object.assign(new Error(`Command failed: claude -p ${secretPrompt}`), {
      code: 1,
      stderr: "claude: command not found",
    });

    const clean = sanitizeExecError(err);
    expect(clean.message).not.toContain("x".repeat(100));
    expect(clean.message).toContain("claude: command not found");
    expect(clean.message).toContain("exit 1");
    expect(clean.message.length).toBeLessThan(700);
  });

  it("caps a huge stderr too, rather than trusting it to be small", () => {
    const clean = sanitizeExecError({ code: 2, stderr: "boom ".repeat(5_000) });
    expect(clean.message.length).toBeLessThan(700);
    expect(clean.message).toContain("[trimmed]");
  });

  it("still says something useful when there is no stderr at all", () => {
    const clean = sanitizeExecError(Object.assign(new Error("timed out"), { signal: "SIGTERM" }));
    expect(clean.message).toContain("SIGTERM");
    expect(clean.message).toContain("timed out");
  });
});
