import type { Item, NodeContext } from "@squidclaw/kernel";
import { registerExecutor } from "./registry.js";
import { credentialStore } from "./credentials.js";

/**
 * Multi-provider AI nodes.
 *
 * An imported workflow picks its model per step on purpose — Gemini's long
 * context here, GPT-4's JSON there, Claude's reasoning elsewhere. So we honor
 * the node's choice: each provider is a real call on the TENANT'S own key, not
 * a substitution to one house brain. A plain chat completion is a single HTTP
 * POST per provider, so "multi-provider" is three thin wrappers, not an SDK
 * zoo.
 *
 * Credentials come from the per-tenant store. Missing → a clear error naming
 * the credential type, so the import checklist can tell the user what to add.
 */

const TIMEOUT_MS = 60_000;

/** Pull the user prompt out of the input item — the field name varies by how the flow was wired. */
function promptFromInput(items: Item[], parameters: Record<string, unknown>): string {
  const p = parameters as { text?: unknown; prompt?: unknown; messages?: unknown };
  if (typeof p.text === "string" && p.text.trim()) return p.text;
  if (typeof p.prompt === "string" && p.prompt.trim()) return p.prompt;
  const j = (items[0]?.json ?? {}) as Record<string, unknown>;
  for (const k of ["prompt", "text", "chatInput", "input", "message", "query"]) {
    if (typeof j[k] === "string" && (j[k] as string).trim()) return j[k] as string;
  }
  // last resort: the whole input as JSON, so the model at least sees the data
  return JSON.stringify(j);
}

function optionOf(parameters: Record<string, unknown>, key: string): unknown {
  const opts = (parameters.options ?? {}) as Record<string, unknown>;
  return opts[key] ?? (parameters as Record<string, unknown>)[key];
}

function requireKey(tenantId: string, credType: string): string {
  const cred = credentialStore.resolve(tenantId, credType);
  const key = cred?.values.apiKey ?? cred?.values.key;
  if (!key) throw new Error(`This step needs a "${credType}" credential — add your API key to run it.`);
  return key;
}

async function callOpenAI(tenantId: string, model: string, prompt: string, system: string | undefined, temperature: number | undefined): Promise<string> {
  const key = requireKey(tenantId, "openAiApi");
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: prompt },
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: model || "gpt-4o-mini", messages, ...(temperature != null ? { temperature } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(tenantId: string, model: string, prompt: string, system: string | undefined, temperature: number | undefined): Promise<string> {
  const key = requireKey(tenantId, "anthropicApi");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: model || "claude-3-5-sonnet-20241022",
      max_tokens: Number(optionOf({ }, "maxTokens")) || 1024,
      ...(system ? { system } : {}),
      ...(temperature != null ? { temperature } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content?: Array<{ text?: string }> };
  return body.content?.map((c) => c.text ?? "").join("") ?? "";
}

async function callGemini(tenantId: string, model: string, prompt: string, system: string | undefined): Promise<string> {
  const key = requireKey(tenantId, "googlePalmApi");
  const m = (model || "gemini-1.5-flash").replace(/^models\//, "");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

/** Wraps a provider call into a node executor that returns the completion on every input item. */
function makeAiExecutor(
  call: (tenantId: string, model: string, prompt: string, system: string | undefined, temperature: number | undefined) => Promise<string>,
  modelParam: string,
) {
  return async (parameters: Record<string, unknown>, items: Item[], ctx: NodeContext): Promise<Item[]> => {
    const base = items.length ? items : [{ json: {} } as Item];
    const model = String(parameters[modelParam] ?? (parameters as { model?: unknown }).model ?? "");
    const system = optionOf(parameters, "systemMessage") as string | undefined;
    const temperature = optionOf(parameters, "temperature") != null ? Number(optionOf(parameters, "temperature")) : undefined;
    const out: Item[] = [];
    for (const item of base) {
      const prompt = promptFromInput([item], parameters);
      const text = await call(ctx.tenantId, model, prompt, system, temperature);
      out.push({ ...item, json: { ...item.json, text, response: text } });
    }
    return out;
  };
}

// Register the langchain chat-model node types.
registerExecutor("@n8n/n8n-nodes-langchain.lmChatOpenAi", makeAiExecutor(
  (t, m, p, s, temp) => callOpenAI(t, m, p, s, temp), "model"));
registerExecutor("@n8n/n8n-nodes-langchain.lmChatAnthropic", makeAiExecutor(
  (t, m, p, s, temp) => callAnthropic(t, m, p, s, temp), "model"));
registerExecutor("@n8n/n8n-nodes-langchain.lmChatGoogleGemini", makeAiExecutor(
  (t, m, p, s) => callGemini(t, m, p, s), "modelName"));
