import { createContext, runInContext } from "node:vm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire, isBuiltin } from "node:module";
import {
  binaryBuffer, binaryMeta, branchesOf, withBranches,
  type BinaryValue, type Item, type NodeContext, type NodeDef,
} from "@squidclaw/kernel";

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

const hostRequire = createRequire(import.meta.url);

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
    // n8n's NODE_FUNCTION_ALLOW_BUILTIN, honored: imported Code nodes may
    // require node builtins (fs, path, crypto…) — never node_modules.
    require: (name: string) => {
      if (!isBuiltin(name)) throw new Error(`require("${name}"): only Node builtins are available in Code steps`);
      return hostRequire(name);
    },
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
  // Binary passes through untouched — it may be a Buffer or n8n's envelope
  // ({data: base64, fileName, mimeType}); binaryBuffer() reads both.
  const arr = Array.isArray(out) ? out : out === undefined || out === null ? [] : [out];
  return arr.map((entry) => {
    const record = entry as { json?: Record<string, unknown>; binary?: Record<string, BinaryValue> };
    if (record && typeof record === "object" && "json" in record) {
      return { json: record.json ?? {}, ...(record.binary ? { binary: record.binary } : {}) } as Item;
    }
    return { json: (entry ?? {}) as Record<string, unknown> };
  });
}

async function telegramStep(
  parameters: Record<string, unknown>,
  item: Item,
  items: Item[],
  ctx: NodeContext,
): Promise<Item> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("telegram step: TELEGRAM_BOT_TOKEN missing");
  const base = process.env.SQUIDCLAW_TELEGRAM_API ?? "https://api.telegram.org";
  const api = `${base}/bot${token}`;

  const p = resolveExpr(parameters, item, items, ctx) as Record<string, unknown>;
  const chatId = String(p.chatId ?? "");
  const extra = (p.additionalFields ?? {}) as Record<string, unknown>;
  const resource = String(p.resource ?? "message");
  const operation = String(p.operation ?? "sendMessage");

  const call = async (method: string, payload: Record<string, unknown>) => {
    const res = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) throw new Error(`telegram step ${method}: ${body.description ?? res.status}`);
    return body.result;
  };

  // n8n's file resource: getFile, then download the bytes as binary.
  if (resource === "file") {
    const file = (await call("getFile", { file_id: String(p.fileId ?? "") })) as { file_path?: string };
    if (!file?.file_path) throw new Error("telegram step: getFile returned no file_path");
    const res = await fetch(`${base}/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram step: file download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const fileName = basename(file.file_path);
    return {
      json: { ...item.json, ...file },
      binary: { data: { data: buf, fileName, mimeType: res.headers.get("content-type") ?? undefined } },
    };
  }

  if (operation === "deleteMessage") {
    await call("deleteMessage", { chat_id: chatId, message_id: Number(p.messageId) });
    return { json: { deleted: true, chatId } };
  }

  const binaryProp = String(p.binaryPropertyName ?? "data");
  const binary = item.binary?.[binaryProp];

  if ((operation === "sendPhoto" || operation === "sendDocument" || p.binaryData === true) && binary) {
    const field = operation === "sendPhoto" ? "photo" : "document";
    const meta = binaryMeta(binary);
    const fileName = String(p.fileName ?? meta.fileName ?? item.json.fileName ?? `${field}.bin`);
    const form = new FormData();
    form.append("chat_id", chatId);
    const caption = (extra.caption ?? p.caption) as string | undefined;
    if (caption) form.append("caption", caption);
    form.append(field, new Blob([new Uint8Array(binaryBuffer(binary))]), fileName);
    const res = await fetch(`${api}/${operation === "sendPhoto" ? "sendPhoto" : "sendDocument"}`, {
      method: "POST", body: form,
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) throw new Error(`telegram step: ${body.description ?? res.status}`);
    return { json: { sent: true, kind: field, chatId } };
  }

  await call("sendMessage", {
    chat_id: chatId,
    text: String(p.text ?? ""),
    ...(extra.parse_mode ? { parse_mode: extra.parse_mode } : {}),
  });
  return { json: { sent: true, kind: "message", chatId } };
}

/** One node, the whole dialect. */
export const n8nStepNode: NodeDef = {
  name: "n8n.step",
  description:
    "Executes one imported n8n workflow step natively (code, if, switch, telegram, files, http). Used inside imported SquidFlows — not meant for direct calls.",
  inputSchema: { type: "object", additionalProperties: true },
  run: async (params, items, ctx) => {
    // n8n's "error output": a step configured onError=continueErrorOutput gets
    // a second lane — success on branch 0, the failure (as an item carrying
    // `error`) on branch 1 — instead of killing the whole run. The importer
    // stamps __errorOutput from the source workflow.
    if (params.__errorOutput === true) {
      try {
        const result = await executeStep(params, items, ctx);
        return branchesOf(result) ? result : withBranches([result, []]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return withBranches([[], [{ json: { ...(items[0]?.json ?? {}), error: message } }]]);
      }
    }
    return executeStep(params, items, ctx);
  },
};

async function executeStep(
  params: Record<string, unknown>,
  items: Item[],
  ctx: NodeContext,
): Promise<Item[]> {
    const type = String(params.type ?? "");
    const parameters = (params.parameters ?? {}) as Record<string, unknown>;
    const flowSlug = String(params.__flow ?? "imported");

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
          const respOpts =
            (((p.options as { response?: { response?: Record<string, unknown> } })?.response)?.response) ?? {};

          // Custom headers — the AI calls die as anonymous without these.
          const headers: Record<string, string> = {};
          for (const h of (((p.headerParameters as { parameters?: Array<{ name: string; value: unknown }> })
            ?.parameters) ?? [])) {
            if (h.name) headers[String(h.name).toLowerCase()] = String(h.value ?? "");
          }

          let body: BodyInit | undefined;
          const bodyParams =
            ((p.bodyParameters as { parameters?: Array<Record<string, unknown>> })?.parameters) ?? [];

          if (p.contentType === "multipart-form-data") {
            // Gotenberg's lane: fields plus binary file parts, each keeping
            // its fileName (index.html is not optional there).
            const form = new FormData();
            for (const bp of bodyParams) {
              if (bp.parameterType === "formBinaryData") {
                const field = String(bp.inputDataFieldName ?? "data");
                const bin = item.binary?.[field];
                if (!bin) throw new Error(`httpRequest: no binary "${field}" for multipart part "${bp.name}"`);
                const meta = binaryMeta(bin);
                form.append(
                  String(bp.name ?? "file"),
                  new Blob([new Uint8Array(binaryBuffer(bin))], { type: meta.mimeType ?? "application/octet-stream" }),
                  meta.fileName ?? String(item.json.fileName ?? "file.bin"),
                );
              } else {
                form.append(String(bp.name ?? ""), String(bp.value ?? ""));
              }
            }
            delete headers["content-type"]; // fetch sets the multipart boundary
            body = form;
          } else if (p.jsonBody !== undefined) {
            body = typeof p.jsonBody === "string" ? p.jsonBody : JSON.stringify(p.jsonBody);
            headers["content-type"] = headers["content-type"] ?? "application/json";
          } else if (p.sendBody && bodyParams.length) {
            body = JSON.stringify(Object.fromEntries(bodyParams.map((bp) => [String(bp.name), bp.value])));
            headers["content-type"] = headers["content-type"] ?? "application/json";
          }

          const res = await fetch(String(p.url), {
            method,
            headers: Object.keys(headers).length ? headers : undefined,
            body: method === "GET" ? undefined : body,
          });

          // n8n throws on 4xx/5xx unless the node opted into neverError —
          // the AI steps here do exactly that and inspect the body instead.
          if (!res.ok && respOpts.neverError !== true) {
            const snippet = (await res.text()).slice(0, 300);
            throw new Error(`httpRequest: HTTP ${res.status} from ${new URL(String(p.url)).host}${snippet ? `: ${snippet}` : ""}`);
          }

          const contentType = res.headers.get("content-type") ?? "";
          const wantsFile = respOpts.responseFormat === "file";
          if (wantsFile || (!contentType.includes("json") && !contentType.startsWith("text/"))) {
            const buf = Buffer.from(await res.arrayBuffer());
            const prop = String(respOpts.outputPropertyName ?? "data");
            out.push({ json: { ...item.json }, binary: { [prop]: { data: buf, mimeType: contentType || undefined } } });
          } else {
            // n8n hands the response body straight through as $json —
            // downstream code does res.content[0].text, not res.body.content.
            const text = await res.text();
            let parsed: unknown = text;
            try { parsed = JSON.parse(text); } catch { /* keep text */ }
            if (Array.isArray(parsed)) {
              for (const entry of parsed) out.push({ json: entry as Record<string, unknown> });
            } else if (parsed && typeof parsed === "object") {
              out.push({ json: parsed as Record<string, unknown> });
            } else {
              out.push({ json: { data: parsed } });
            }
          }
        }
        return out;
      }

      case "n8n-nodes-base.telegram": {
        const out: Item[] = [];
        for (const item of items.length ? items : [{ json: {} } as Item]) {
          out.push(await telegramStep(parameters, item, items, ctx));
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
            writeFileSync(fileName, binaryBuffer(data));
            out.push({ ...item, json: { ...item.json, fileName } });
          } else {
            const fileName = resolve(String(p.fileSelector ?? p.fileName ?? ""));
            const data = readFileSync(fileName);
            out.push({ json: { fileName }, binary: { data: { data, fileName: basename(fileName) } } });
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
          const raw = item.binary?.[prop];
          if (!raw) throw new Error(`extractFromFile: no binary "${prop}"`);
          const data = binaryBuffer(raw);
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
}
