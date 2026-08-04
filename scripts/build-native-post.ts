/**
 * Builds flow.post — the agent-native formal post — out of the imported
 * wizard's own proven organs.
 *
 * The wizard (formal-post) is a Telegram state machine: rigid by design,
 * because n8n had no mind. SquidClaw does. This flow drops the wizard and
 * keeps the pipeline: title+topic+size in → copy drafted (CLI socket) →
 * image generated → branded card rendered, archived, delivered. The agent
 * gathers the inputs conversationally and calls it like any tool — the
 * human never leaves the agent.
 *
 * Usage: npx tsx scripts/build-native-post.ts <wizard.flow.json> <out-dir>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHAT_ID = 8123517797; // Tamer's chat — this tenant's flow, this tenant's owner

const [wizardPath, outDir] = process.argv.slice(2);
const wizard = JSON.parse(readFileSync(wizardPath, "utf8"));

function organ(name: string): Record<string, any> {
  const node = wizard.graph.nodes.find((n: any) => n.params.n8nName === name);
  if (!node) throw new Error(`wizard is missing "${name}"`);
  return JSON.parse(JSON.stringify(node.params));
}

/** Rename a reach-back inside copied code/expressions — loudly if absent. */
function rewire(params: Record<string, any>, from: string, to: string): Record<string, any> {
  const before = JSON.stringify(params);
  if (!before.includes(`$('${from}')`)) throw new Error(`expected $('${from}') in ${params.n8nName}`);
  const after = before.split(`$('${from}')`).join(`$('${to}')`);
  return JSON.parse(after);
}

const composeCode = `
const p = $input.first().json;
const title = String(p.title || '').trim();
// No separate topic given? The headline carries the story — write from it.
const topic = String(p.topic || '').trim() || title;
if (!title) throw new Error('I need a title (the headline) to make a post.');
// "create tst post" is a request to USE this flow, not a headline. Refuse
// placeholders outright — the refusal reaches the mind, which then has no
// choice but to ask the human what the post is actually about.
if (/^(a\s+)?(tst|test|demo|sample)(\s*-?\s*post)?$/i.test(title)) {
  throw new Error("'" + title + "' is a placeholder, not a headline. Do not retry with another invented title — ask the human what the post should be about, wait for their answer, then call me with their real headline.");
}
const size = String(p.size || 'post').toLowerCase() === 'story' ? 'story' : 'post';
const dims = size === 'post' ? { w: 1080, h: 1350 } : { w: 1080, h: 1920 };
const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
const date = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
return [{ json: {
  chatId: ${CHAT_ID},
  title: title, topic: topic,
  size: size, sizeClass: size, width: dims.w, height: dims.h,
  date: date, imageMode: 'generate', imageFileId: ''
} }];
`;

const parseCode = `
const src = $('Compose').first().json;
const res = $input.first().json;

if (res.error) {
  throw new Error('Text generation failed: ' + (res.error.message || JSON.stringify(res.error)));
}

let out;
try {
  const raw = res.content[0].text.trim().replace(/^\\\`\\\`\\\`(json)?/, '').replace(/\\\`\\\`\\\`$/, '');
  out = JSON.parse(raw);
} catch (e) {
  throw new Error('Could not parse the model response as JSON.');
}

// Backstop only — the template body shrinks-to-fit now, so this ceiling sits
// well above the writer's budget and trims only runaway copy.
const limit = src.size === 'story' ? 100 : 34;
const words = String(out.body || '').trim().split(/\\s+/).filter(Boolean);
if (!words.length) throw new Error('The writer returned an empty body.');
const body = words.length > limit ? words.slice(0, limit).join(' ') + '…' : String(out.body).trim();

return [{ json: Object.assign({}, src, { body: body, caption: String(out.caption || '') }) }];
`;

const FLOW = "post";
const step = (id: string, params: Record<string, any>) => ({ id, node: "n8n.step", params: { ...params, __flow: FLOW } });
const code = (id: string, name: string, jsCode: string, errorLane = true) =>
  step(id, {
    type: "n8n-nodes-base.code", n8nName: name, parameters: { jsCode },
    ...(errorLane ? { __errorOutput: true } : {}),
  });

const writeText = rewire(organ("Write Text"), "Conversation", "Compose");
if (!JSON.stringify(writeText).includes("127.0.0.1:4100")) throw new Error("Write Text is not on the CLI socket");

const nodes = [
  step("params-1", {
    type: "n8n-nodes-base.set", n8nName: "Params",
    parameters: { assignments: { assignments: [
      { name: "title", value: "{{title}}" },
      { name: "topic", value: "{{topic}}" },
      { name: "size", value: "{{size}}" },
    ] } },
  }),
  code("compose-2", "Compose", composeCode, false),
  step("read-keys-3", organ("Read Keys")),
  step("extract-keys-4", organ("Extract Keys")),
  step("write-text-5", writeText),
  code("parse-6", "Parse Text", parseCode),
  step("read-keys2-7", organ("Read Keys 2")),
  step("extract-keys2-8", organ("Extract Keys 2")),
  step("gen-image-9", rewire(organ("Generate Image"), "Conversation", "Compose")),
  step("prep-10", rewire(organ("Prepare Generated Image"), "Conversation", "Parse Text")),
  step("read-tpl-11", organ("Read Template File")),
  step("ext-tpl-12", organ("Extract Template")),
  step("build-html-13", rewire(organ("Build HTML"), "Conversation", "Parse Text")),
  step("render-14", organ("Render PNG")),
  step("name-15", organ("Name PNG")),
  step("archive-16", organ("Archive PNG")),
  step("send-img-17", organ("Send Image")),
  step("send-cap-18", organ("Send Caption")),
  step("bem-19", rewire(organ("Build Error Message"), "Conversation", "Compose")),
  step("send-err-20", organ("Send Error")),
];

const chain = [
  "params-1", "compose-2", "read-keys-3", "extract-keys-4", "write-text-5", "parse-6",
  "read-keys2-7", "extract-keys2-8", "gen-image-9", "prep-10", "read-tpl-11", "ext-tpl-12",
  "build-html-13", "render-14", "name-15", "archive-16", "send-img-17", "send-cap-18",
];
const edges: Array<{ from: string; to: string; branch?: number }> = [];
for (let i = 1; i < chain.length; i++) edges.push({ from: chain[i - 1], to: chain[i] });
// Error lanes — every step the wizard protected routes its failure to the
// same messenger, so the chat hears plain words instead of silence.
for (const id of ["parse-6", "gen-image-9", "prep-10", "read-tpl-11", "ext-tpl-12", "build-html-13", "render-14", "name-15", "archive-16"]) {
  edges.push({ from: id, to: "bem-19", branch: 1 });
}
edges.push({ from: "bem-19", to: "send-err-20" });

const flow = {
  name: FLOW,
  description:
    "Create and deliver a finished Saudi Times formal post card to the chat. Use whenever the human asks for a formal post, news card, or Saudi Times post. IMPORTANT: title and topic must be the actual SUBJECT of the post, in the human's own words. Phrases like 'test post', 'tst post', 'a post', 'try the flow' are requests to use this tool, NOT subjects — in those cases DO NOT call yet: ask the human what the post should be about (and optionally post or story size), wait for the answer, then call with their real headline. Never invent placeholder titles or topics. Params: title (the human's headline), topic (a sentence or two the copy is written from — if the human only gave a headline, use it as the topic too), size ('post' or 'story'; default 'post'). It drafts the copy, generates an editorial image, renders the branded card and sends it with its caption. After it runs, confirm briefly — the card itself arrives in the chat.",
  signature: "native:post",
  triggers: [],
  // The contract: the platform itself interviews the human for anything
  // missing or placeholder-shaped. The mind can't forget to ask, and can't
  // invent its way past the gate.
  params: [
    {
      name: "title",
      ask: "What should the post be about? Give me the headline.",
      reject: "^(a\\s+)?(tst|test|demo|sample)(\\s*-?\\s*post)?$",
    },
    { name: "topic", default: "" },
    { name: "size", options: ["post", "story"], default: "post" },
  ],
  runs: 2,
  createdAt: new Date().toISOString(),
  status: "promoted",
  graph: { nodes, edges },
};

writeFileSync(join(outDir, `${FLOW}.flow.json`), JSON.stringify(flow, null, 2));
console.log(`flow "${FLOW}" written: ${nodes.length} steps, ${edges.length} edges — promoted`);
