/**
 * Verifies the render leg alone: pre-seeds the conversation state past the
 * text step (as if Claude had written the copy and the operator approved),
 * then sends "ok" — image generation (OpenAI), template fill, Gotenberg
 * render, archive, and delivery, all against a FAKE Telegram API. The
 * archived PNG lands in /opt/social-out for eyes-on inspection.
 *
 * Usage: npx tsx scripts/dryrun-render-leg.ts <flow.json>
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeGraph, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";

const CHAT = 424242;

async function main() {
  const sent: Array<{ method: string }> = [];
  const api = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      sent.push({ method: (req.url ?? "").split("/").pop() ?? "?" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => api.listen(0, r));
  process.env.SQUIDCLAW_TELEGRAM_API = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "dry-run-token";
  process.env.SQUIDCLAW_STATIC_DIR = mkdtempSync(join(tmpdir(), "dryrun-render-"));

  // The state the conversation would hold right before the operator's "ok".
  writeFileSync(join(process.env.SQUIDCLAW_STATIC_DIR, "formal-post.json"), JSON.stringify({
    owner: CHAT,
    sessions: {
      [CHAT]: {
        step: "preview", size: "post", title: "The dialect speaks n8n now",
        topic: "SquidClaw learned to run n8n workflows natively",
        date: "04/08/2026", imageMode: "generate", imageFileId: "",
        body: "SquidClaw, the newborn agent platform, can now execute imported n8n workflows natively — branching, error lanes, file handling and all. The formal post pipeline that once lived on a separate automation server now runs inside the agent itself, conversation state included.",
        caption: "SquidClaw now speaks n8n natively. #automation #ai",
      },
    },
  }));

  registerBuiltinNodes();
  const flow = JSON.parse(readFileSync(process.argv[2], "utf8"));

  const rec = await executeGraph(flow.graph, {
    tenantId: "dry-run", kind: "flow", journal: new Journal(":memory:"),
    seedItems: [{
      json: {
        update_id: 2000,
        message: {
          message_id: 2001, chat: { id: CHAT, type: "private" },
          from: { id: CHAT, is_bot: false, first_name: "DryRun" },
          date: Math.floor(Date.now() / 1000), text: "ok",
        },
      },
    }],
  });

  console.log(`run=${rec.status}`);
  for (const s of rec.steps) {
    const name = (s.params as any).n8nName ?? s.nodeId;
    if (s.status === "skipped") continue;
    console.log(`  ${name}: ${s.status}${s.error ? `  !! ${String(s.error).slice(0, 200)}` : ""}`);
  }
  const archived = rec.steps.find((s) => (s.params as any).n8nName === "Archive PNG");
  if (archived?.output?.[0]) console.log("archived:", (archived.output[0] as any).json.fileName);
  const bem = rec.steps.find((s) => (s.params as any).n8nName === "Build Error Message");
  if (bem?.input?.length) console.log("error item:", JSON.stringify((bem.input[0] as any).json).slice(0, 500));
  console.log("telegram calls:", sent.map((s) => s.method).join(", "));
  api.close();
}

main();
