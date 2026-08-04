/**
 * Two wizard repairs, applied to the imported formal-post flow file:
 *
 * 1. After a successful delivery the wizard now forgets the conversation —
 *    before this, the session sat parked at 'rendering' forever and every
 *    later message got "Still working on your last image".
 * 2. The description now tells the mind this is a /flow-session wizard and
 *    points it at flow.post for direct requests — calling the wizard as a
 *    tool is exactly the "chat_id is empty" trap.
 *
 * Usage: npx tsx scripts/patch-wizard.ts <formal-post.flow.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const flow = JSON.parse(readFileSync(path, "utf8"));

flow.description =
  "The Saudi Times formal post wizard — an interactive Telegram state machine, driven step by step by the human inside a /flow formal-post session. Never call this as a tool: it needs a real chat message as its trigger. When the human simply asks for a post, use flow.post instead.";

if (!flow.graph.nodes.some((n: any) => n.params.n8nName === "Close Session")) {
  flow.graph.nodes.push({
    id: "close-session-30",
    node: "n8n.step",
    params: {
      type: "n8n-nodes-base.code",
      n8nName: "Close Session",
      __flow: "formal-post",
      parameters: {
        jsCode: `
// The delivery just above succeeded — the conversation is complete. Forget
// the session so the next message starts fresh instead of hearing
// "Still working on your last image" forever.
const sd = $getWorkflowStaticData('global');
const src = $('Conversation').first().json;
if (sd.sessions) delete sd.sessions[src.chatId];
return [{ json: { closed: true } }];
`,
      },
    },
  });
  const sendCaption = flow.graph.nodes.find((n: any) => n.params.n8nName === "Send Caption");
  flow.graph.edges.push({ from: sendCaption.id, to: "close-session-30" });
}

writeFileSync(path, JSON.stringify(flow, null, 2));
console.log("wizard patched: session auto-close + honest description");
