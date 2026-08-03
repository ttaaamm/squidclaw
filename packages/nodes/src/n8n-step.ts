import { createContext, runInContext } from "node:vm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { withBranches, type Item, type NodeContext, type NodeDef } from "@squidclaw/kernel";

/**
 * The n8n dialect, spoken natively.
 *
 * One dispatcher node executes every imported step type: Code (with $input,
 * $json, $('Node'), staticData), IF/Switch (real branching), Telegram sends,
 * file read/write/extract, HTTP — including n8n's `={{ … }}` expressions.
 * An imported SquidFlow stops being a museum piece and runs.
 */

const SUPPORTED = new Set([
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.telegramTrigger",
  "n8n-nodes-base.executeWorkflowTrigger",
  "n8n-nodes-base.noOp",
  "n8n-nodes-base.set",
  "n8n-nodes-base.code",
  "n8n-nodes-base.if",
  "n8n-nodes-base.switch",
  "n8n-nodes-base.merge",
  "n8n-nodes-base.httpRequest",
  "n8n-nodes-base.telegram",
  "n8n-nodes-base.readWriteFile",
  "n8n-nodes-base.extractFromFile",
]);

export const isSupportedN8nType = (type: string): boolean => SUPPORTED.has(type);

/** Where a flow's staticData lives — n8n's cross-run memory, file-backed. */
function staticPath(flowSlug: string): string {
  const dir = process.env.SQUIDCLAW_STATIC_DIR ?? join(tmpdir(), "squidclaw-static");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${flowSlug}.json`);
}

function loadStatic(flowSlug: string): Record<string, unknown> {
  const path = staticPath(flowSlug);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
}

function saveStatic(flowSlug: string, data: Record<string, unknown>): void {
  writeFileSync(staticPath(flowSlug), JSON.stringify(data), "utf8");
}

/** The scope n8n expressions and Code nodes see. */
function scopeFor(item: Item | undefined, items: Item[], ctx: NodeContext) {
  const dollarNode = (name: string) => {
    const id = ctx.nodeIds?.get(name);
    const branches = id ? ctx.outputs?.get(id) : undefined;
    const all = branches?.flat() ?? [];
    return {
      all: () => all,
      first: () => all[0],
      last: () => all.at(-1),
      item: all[0],
      json: all[0]?.json ?? {},
    };
  };
  return {
    $json: item?.json ?? {},
    $binary: item?.binary ?? {},
    $items: items,
    $now: new Date(),
    $today: new Date().toISOString().slice(0, 10),
    $: dollarNode,
    $node: new Proxy({}, { get: (_t, name) => dollarNode(String(name)) }),
  };
}

/** n8n expressions: a param string starting with "=" interpolates {{ … }}. */
export function resolveExpr(value: unknown, item: Item | undefined, items: Item[], ctx: NodeContext): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("=")) return value;
    const template = value.slice(1);
    const scope = scopeFor(item, items, ctx);
    const vmCtx = createContext({ ...scope });
    // A template that is exactly one expression keeps its real type.
    const single = template.match(/^\{\{([\s\S]+)\}\}$/);
    if (single) {
      try {
        return runInContext(`(${single[1]})`, vmCtx, { timeout: 1000 });
      } catch {
        return "";
      }
    }
    return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => {
      try {
        const out = runInContext(`(${expr})`, vmCtx, { timeout: 1000 });
        return out === undefined || out === null ? "" : String(out);
      } catch {
        return "";
      }
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveExpr(v, item, items, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveExpr(v, item, items, ctx)]));
  }
  return value;
}

/** n8n's filter conditions (v2 shape), evaluated per item. */
export function evalConditions(
  conditions: { conditions?: Array<{ leftValue?: unknown; rightValue?: unknown; operator?: { operation?: string; type?: string } }>; combinator?: string } | undefined,
  item: Item,
  items: Item[],
  ctx: NodeContext,
): boolean {
  const list = conditions?.conditions ?? [];
  if (!list.length) return true;
  const results = list.map((c) => {
    const left = resolveExpr(c.leftValue, item, items, ctx);
    const right = resolveExpr(c.rightValue, item, items, ctx);
    const op = c.operator?.operation ?? "equals";
    switch (op) {
      case "equals": return String(left) === String(right);
      case "notEquals": return String(left) !== String(right);
      case "contains": return String(left).includes(String(right));
      case "notContains": return !String(left).includes(String(right));
      case "startsWith": return String(left).startsWith(String(right));
      case "endsWith": return String(left).endsWith(String(right));
      case "gt": return Number(left) > Number(right);
      case "gte": return Number(left) >= Number(right);
      case "lt": return Number(left) < Number(right);
      case "lte": return Number(left) <= Number(right);
      case "exists": return left !== undefined && left !== null && left !== "";
      case "notExists": return left === undefined || left === null || left === "";
      case "true": return Boolean(left) === true;
      case "false": return Boolean(left) === false;
      default: return String(left) === String(right);
    }
  });
  return (conditions?.combinator ?? "and") === "or" ? results.some(Boolean) : results.every(Boolean);
}

async function runCode(
  parameters: Record<string, unknown>,
  items: Item[],
  ctx: NodeContext,
  flowSlug: string,
): Promise<Item[]> {
  const code = String(parameters.jsCode ?? "return items;");
  const staticData = loadStatic(flowSlug);
  const first = items[0];

  const sandbox = {
    ...scopeFor(first, items, ctx),
    items,
    $input: {
      all: () => items,
      first: () => items[0],
      last: () => items.at(-1),
      item: items[0],
    },
    $getWorkflowStaticData: (_scope?: string) => staticData,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, Buffer,
  };

  const vmCtx = createContext(sandbox);
  const result = runInContext(
    `(async () => { ${code}\n })()`,
    vmCtx,
    { timeout: 10_000 },
  );
  const out = (await result) as unknown;
  saveStatic(flowSlug, staticData);

  // n8n Code nodes return an array of items (or a single item); normalize.
  const arr = Array.isArray(out) ? out : out === undefined || out === null ? [] : [out];
  return arr.map((entry) => {
    const record = entry as { json?: Record<string, unknown>; binary?: Record<string, Buffer> };
    if (record && typeof record === "object" && "json" in record) {
      return { json: record.json ?? {}, ...(record.binary ? { binary: record.binary } : {}) } as Item;
    }
    return { json: (entry ?? {}) as Record<string, unknown> };
  });
}

async function telegramSend(
  parameters: Record<string, unknown>,
  item: Item,
  items: Item[],
  ctx: NodeContext,
): Promise<Item> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("telegram step: TELEGRAM_BOT_TOKEN missing");
  const api = `${process.env.SQUIDCLAW_TELEGRAM_API ?? "https://api.telegram.org"}/bot${token}`;

  const p = resolveExpr(parameters, item, items, ctx) as Record<string, unknown>;
  const chatId = String(p.chatId ?? "");
  const extra = (p.additionalFields ?? {}) as Record<string, unknown>;
  const operation = String(p.operation ?? "sendMessage");

  const binaryProp = String(p.binaryPropertyName ?? "data");
  const binary = item.binary?.[binaryProp];

  if ((operation === "sendPhoto" || operation === "sendDocument" || p.binaryData === true) && binary) {
    const field = operation === "sendPhoto" ? "photo" : "document";
    const form = new FormData();
    form.append("chat_id", chatId);
    const caption = (extra.caption ?? p.caption) as string | undefined;
    if (caption) form.append("caption", caption);
    form.append(field, new Blob([new Uint8Array(binary)]), String(p.fileName ?? `${field}.bin`));
    const res = await fetch(`${api}/${operation === "sendPhoto" ? "sendPhoto" : "sendDocument"}`, {
      method: "POST", body: form,
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) throw new Error(`telegram step: ${body.description ?? res.status}`);
    return { json: { sent: true, kind: field, chatId } };
  }

  const res = await fetch(`${api}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(p.text ?? ""),
      ...(extra.parse_mode ? { parse_mode: extra.parse_mode } : {}),
    }),
  });
  const body = (await res.json()) as { ok: boolean; description?: string };
  if (!body.ok) throw new Error(`telegram step: ${body.description ?? res.status}`);
  return { json: { sent: true, kind: "message", chatId } };
}

/** One node, the whole dialect. */
export const n8nStepNode: NodeDef = {
  name: "n8n.step",
  description:
    "Executes one imported n8n workflow step natively (code, if, switch, telegram, files, http). Used inside imported SquidFlows — not meant for direct calls.",
  inputSchema: { type: "object", additionalProperties: true },
  run: async (params, items, ctx) => {
    const type = String(params.type ?? "");
    const parameters = (params.parameters ?? {}) as Record<string, unknown>;
    const flowSlug = String(params.__flow ?? "imported");
    const first = items[0];

    switch (type) {
      case "n8n-nodes-base.manualTrigger":
      case "n8n-nodes-base.telegramTrigger":
      case "n8n-nodes-base.executeWorkflowTrigger":
      case "n8n-nodes-base.noOp":
      case "n8n-nodes-base.merge":
        // Triggers are entry markers here — the chat/webhook already fired.
        return items.length ? items : [{ json: {} }];

      case "n8n-nodes-base.set": {
        const assignments =
          ((parameters.assignments as { assignments?: Array<{ name: string; value: unknown }> })?.assignments) ?? [];
        const base = items.length ? items : [{ json: {} } as Item];
        return base.map((item) => ({
          ...item,
          json: {
            ...(parameters.includeOtherFields === false ? {} : item.json),
            ...Object.fromEntries(
              assignments.map((a) => [a.name, resolveExpr(a.value, item, items, ctx)]),
            ),
          },
        }));
      }

      case "n8n-nodes-base.code":
        return runCode(parameters, items.length ? items : [{ json: {} }], ctx, flowSlug);

      case "n8n-nodes-base.if": {
        const pass: Item[] = [];
        const fail: Item[] = [];
        for (const item of items) {
          (evalConditions(parameters.conditions as never, item, items, ctx) ? pass : fail).push(item);
        }
        return withBranches([pass, fail]);
      }

      case "n8n-nodes-base.switch": {
        const rules =
          ((parameters.rules as { values?: Array<{ conditions?: unknown }> })?.values) ?? [];
        const outputs: Item[][] = rules.map(() => []);
        outputs.push([]); // fallback branch
        for (const item of items) {
          const idx = rules.findIndex((r) => evalConditions(r.conditions as never, item, items, ctx));
          outputs[idx === -1 ? rules.length : idx].push(item);
        }
        return withBranches(outputs);
      }

      case "n8n-nodes-base.httpRequest": {
        const out: Item[] = [];
        for (const item of items.length ? items : [{ json: {} } as Item]) {
          const p = resolveExpr(parameters, item, items, ctx) as Record<string, unknown>;
          const method = String(p.method ?? "GET");
          const body =
            p.jsonBody !== undefined
              ? typeof p.jsonBody === "string" ? p.jsonBody : JSON.stringify(p.jsonBody)
              : p.sendBody && p.bodyParameters
                ? JSON.stringify(
                    Object.fromEntries(
                      (((p.bodyParameters as { parameters?: Array<{ name: string; value: unknown }> })?.parameters) ?? [])
                        .map((bp) => [bp.name, bp.value]),
                    ),
                  )
                : undefined;
          const res = await fetch(String(p.url), {
            method,
            headers: body ? { "content-type": "application/json" } : undefined,
            body: method === "GET" ? undefined : body,
          });
          const contentType = res.headers.get("content-type") ?? "";
          if (contentType.includes("json") || contentType.startsWith("text/")) {
            const text = await res.text();
            let parsed: unknown = text;
            try { parsed = JSON.parse(text); } catch { /* keep text */ }
            out.push({ json: { statusCode: res.status, body: parsed } as Record<string, unknown> });
          } else {
            const buf = Buffer.from(await res.arrayBuffer());
            out.push({ json: { statusCode: res.status, mimeType: contentType }, binary: { data: buf } });
          }
        }
        return out;
      }

      case "n8n-nodes-base.telegram": {
        const out: Item[] = [];
        for (const item of items.length ? items : [{ json: {} } as Item]) {
          out.push(await telegramSend(parameters, item, items, ctx));
        }
        return out;
      }

      case "n8n-nodes-base.readWriteFile": {
        const out: Item[] = [];
        for (const item of items.length ? items : [{ json: {} } as Item]) {
          const p = resolveExpr(parameters, item, items, ctx) as Record<string, unknown>;
          if (String(p.operation ?? "read") === "write") {
            const fileName = resolve(String(p.fileName ?? "out.bin"));
            const prop = String(p.dataPropertyName ?? "data");
            const data = item.binary?.[prop];
            if (!data) throw new Error(`readWriteFile: no binary "${prop}" to write`);
            mkdirSync(dirname(fileName), { recursive: true });
            writeFileSync(fileName, data);
            out.push({ ...item, json: { ...item.json, fileName } });
          } else {
            const fileName = resolve(String(p.fileSelector ?? p.fileName ?? ""));
            const data = readFileSync(fileName);
            out.push({ json: { fileName }, binary: { data } });
          }
        }
        return out;
      }

      case "n8n-nodes-base.extractFromFile": {
        const out: Item[] = [];
        for (const item of items) {
          const p = resolveExpr(parameters, item, items, ctx) as Record<string, unknown>;
          const prop = String(p.binaryPropertyName ?? "data");
          const dest = String(p.destinationKey ?? "data");
          const data = item.binary?.[prop];
          if (!data) throw new Error(`extractFromFile: no binary "${prop}"`);
          const operation = String(p.operation ?? "text");
          const value =
            operation === "binaryToPropery" || operation === "binaryToProperty"
              ? data.toString("base64")
              : operation === "fromJson"
                ? JSON.parse(data.toString("utf8"))
                : data.toString("utf8");
          out.push({ ...item, json: { ...item.json, [dest]: value } });
        }
        return out;
      }

      default:
        throw new Error(`n8n step type "${type}" has no native support yet`);
    }
  },
};
