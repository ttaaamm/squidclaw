import { binaryBuffer, type Item, type NodeDef } from "@squidclaw/kernel";

/**
 * Tables — the wishlist's "excel node", grown honestly: CSV in and out,
 * zero dependencies, opens in Excel and Google Sheets. Real .xlsx can come
 * later behind the same two names if a workflow ever demands it.
 */

/** A small, correct CSV parser: quotes, embedded commas, embedded newlines. */
export function csvParse(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== "")) rows.push(row);

  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h || `col${i + 1}`, r[i] ?? ""])));
}

const cellOf = (v: unknown): string => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function csvMake(items: Array<Record<string, unknown>>): string {
  const headers = [...new Set(items.flatMap((r) => Object.keys(r)))];
  const lines = [headers.map(cellOf).join(",")];
  for (const r of items) lines.push(headers.map((h) => cellOf(r[h])).join(","));
  return lines.join("\n") + "\n";
}

export const csvReadNode: NodeDef = {
  name: "csv.read",
  description:
    "Read a CSV table into rows. Give it text via the `csv` param, or let a file's binary flow in from the " +
    "previous node (files.read, http.fetch, a Telegram upload). Each row becomes one item keyed by the header.",
  inputSchema: { type: "object", properties: { csv: { type: "string" } } },
  run: async (params, items) => {
    const source = params.csv
      ? String(params.csv)
      : (() => {
          const bin = items.find((i) => i.binary?.data)?.binary?.data;
          if (!bin) throw new Error("csv.read: give me `csv` text, or binary data flowing in from the previous node");
          return binaryBuffer(bin).toString("utf8");
        })();
    const rows = csvParse(source);
    return rows.length ? rows.map((r) => ({ json: r }) as Item) : [{ json: { empty: true, rows: 0 } }];
  },
};

export const csvWriteNode: NodeDef = {
  name: "csv.write",
  description:
    "Turn the items flowing in into a CSV table (opens in Excel / Google Sheets). Params: filename " +
    "(default table.csv). The file flows onward as binary — chain telegram.send or files.write to deliver it.",
  inputSchema: { type: "object", properties: { filename: { type: "string" } } },
  run: async (params, items) => {
    if (!items.length) throw new Error("csv.write: nothing flowed in to tabulate");
    const csv = csvMake(items.map((i) => i.json));
    const buf = Buffer.from(csv, "utf8");
    const fileName = String(params.filename ?? "table.csv");
    return [{
      json: { fileName, rows: items.length, bytes: buf.length },
      binary: { data: { data: buf, fileName, mimeType: "text/csv", fileSize: buf.length } },
    }];
  },
};
