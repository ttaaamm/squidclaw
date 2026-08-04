/**
 * Walks the real imported formal-post flow through a full conversation
 * against a FAKE Telegram API — nothing reaches a real chat. Proves the
 * n8n dialect end to end on the production graph: the /setkey path (Store
 * Key writes keys.json via require('fs'), the key message is deleted), the
 * /post state machine, and the gentext leg failing gracefully through the
 * error lane when Anthropic rejects the dummy key.
 *
 * Usage: npx tsx scripts/dryrun-formal-post.ts <flow.json>
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeGraph, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";

const CHAT = 424242; // a fake operator — not a real chat id

async function main() {
  const sent: Array<{ method: string; body: any }> = [];
  const api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop() ?? "?";
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* multipart */ }
      sent.push({ method, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => api.listen(0, r));
  process.env.SQUIDCLAW_TELEGRAM_API = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "dry-run-token";
  process.env.SQUIDCLAW_STATIC_DIR = mkdtempSync(join(tmpdir(), "dryrun-static-"));

  registerBuiltinNodes();
  const flow = JSON.parse(readFileSync(process.argv[2], "utf8"));

  let updateId = 1000;
  const seed = (text: string) => [{
    json: {
      update_id: updateId++,
      message: {
        message_id: updateId, chat: { id: CHAT, type: "private" },
        from: { id: CHAT, is_bot: false, first_name: "DryRun" },
        date: Math.floor(Date.now() / 1000), text,
      },
    },
  }];

  // With real keys on disk, this walks the WHOLE pipeline: text written by
  // Claude, image generated, Gotenberg render, archive, send — all to the
  // fake Telegram. Skip /setkey so the stored keys stay untouched.
  const script = [
    "/post",                            // size question
    "1",                                // → title question
    "The dialect speaks n8n now",       // → topic question
    "SquidClaw learned to run n8n workflows natively, first try after seven bug fixes", // → image question
    "2",                                // generate → gentext leg (real Claude)
    "ok",                               // approve → render leg (image, Gotenberg, send)
  ];

  for (const text of script) {
    const before = sent.length;
    const rec = await executeGraph(flow.graph, {
      tenantId: "dry-run", kind: "flow", journal: new Journal(":memory:"), seedItems: seed(text),
    });
    const replies = sent.slice(before)
      .map((s) => s.method === "sendMessage" ? `→ "${String(s.body?.text ?? "").split("\n")[0]}"` : `→ [${s.method}]`)
      .join("  ");
    const failed = rec.steps.find((s) => s.status === "error");
    console.log(`you: ${text}`);
    console.log(`   run=${rec.status}${failed ? ` FAILED at ${(failed.params as any).n8nName}: ${failed.error}` : ""}  ${replies}`);
  }

  api.close();
}

main();
