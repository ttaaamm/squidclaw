import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NodeDef } from "@squidclaw/kernel";

const run = promisify(execFile);

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|yaml|yml|html?|xml|log|ts|js|py)$/i;
const MAX_DOC_CHARS = 200_000;

/**
 * Reads a document into text. Plain formats are read directly; PDFs go
 * through the Claude CLI's Read tool — the same eyes vision.look uses, so
 * reading a PDF costs no extra dependency and no API key.
 */
export function extractTextFromFile(
  exec: (args: string[]) => Promise<string> = async (args) =>
    (await run("claude", args, { timeout: 240_000, maxBuffer: 16 * 1024 * 1024 })).stdout,
): (path: string) => Promise<string> {
  return async (rawPath: string) => {
    const path = resolve(rawPath);
    if (!existsSync(path)) throw new Error(`no file at ${path}`);

    if (TEXT_EXTENSIONS.test(path)) {
      return readFileSync(path, "utf8").slice(0, MAX_DOC_CHARS);
    }

    if (/\.pdf$/i.test(path)) {
      const raw = await exec([
        "-p", `Read the PDF at ${path} and output its full text content, nothing else.`,
        "--allowedTools", "Read",
        "--model", "haiku",
      ]);
      return raw.slice(0, MAX_DOC_CHARS);
    }

    throw new Error(`I can't read ${path.split(/[\\/]/).at(-1)} yet — txt, md, csv, json, html and pdf work`);
  };
}

export function docReadNode(
  extract: (path: string) => Promise<string> = extractTextFromFile(),
): NodeDef {
  return {
    name: "doc.read",
    description:
      "Read a document file into text — txt, md, csv, json, html, or PDF. Params: path (file on disk, required), maxChars (optional). Use when the human sends a file and asks about its contents.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, maxChars: { type: "number" } },
    },
    run: async (params) => {
      const text = await extract(String(params.path));
      const max = (params.maxChars as number) ?? 20_000;
      return [{ json: { path: params.path, text: text.slice(0, max), truncated: text.length > max } }];
    },
  };
}
