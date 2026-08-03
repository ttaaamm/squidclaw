import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visionLookNode, voiceSayNode, transcribeNode, canvasSnapNode, telegramSendNode } from "@squidclaw/nodes";

const dir = () => mkdtempSync(join(tmpdir(), "senses-"));

describe("eyes — vision.look", () => {
  it("asks the CLI to read the image and returns what it saw", async () => {
    const imagePath = join(dir(), "photo.jpg");
    writeFileSync(imagePath, "fake-jpeg-bytes");

    let seenArgs: string[] = [];
    const node = visionLookNode(async (args) => {
      seenArgs = args;
      return '{"answer":"A signed invoice from Al Jood, total 500 SAR."}';
    });

    const out = await node.run({ path: imagePath, question: "what is this document?" }, [], { tenantId: "t" });
    expect(out[0].json.saw).toContain("500 SAR");
    expect(seenArgs).toContain("--allowedTools");
    expect(seenArgs).toContain("Read");
    expect(seenArgs.join(" ")).toContain(imagePath);
  });

  it("refuses a path that doesn't exist", async () => {
    await expect(visionLookNode(async () => "").run({ path: "/no/such.jpg" }, [], { tenantId: "t" }))
      .rejects.toThrow(/no file/);
  });
});

describe("voice — voice.say", () => {
  it("synthesizes speech to a file and passes the audio onward as binary", async () => {
    const outPath = join(dir(), "reply.mp3");
    const node = voiceSayNode(async (text, path) => {
      writeFileSync(path, `AUDIO(${text})`);
    });

    const out = await node.run({ text: "أهلاً يا طامر", path: outPath, voice: "ar-SA-HamedNeural" }, [], { tenantId: "t" });
    expect(out[0].json.kind).toBe("audio");
    expect(out[0].binary!.data.toString()).toContain("أهلاً");
    expect(readFileSync(outPath, "utf8")).toContain("أهلاً");
  });
});

describe("ears — audio.transcribe", () => {
  it("hears through gemini when the key exists", async () => {
    const audioPath = join(dir(), "note.ogg");
    writeFileSync(audioPath, "fake-ogg");
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const node = transcribeNode({
        gemini: async (_audio, mime, key) => {
          expect(mime).toBe("audio/ogg");
          expect(key).toBe("test-key");
          return "send the invoice tonight";
        },
      });
      const out = await node.run({ path: audioPath }, [], { tenantId: "t" });
      expect(out[0].json.text).toBe("send the invoice tonight");
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("explains what's missing when it has no ears, instead of pretending", async () => {
    const audioPath = join(dir(), "note.ogg");
    writeFileSync(audioPath, "fake-ogg");
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(transcribeNode().run({ path: audioPath }, [], { tenantId: "t" }))
      .rejects.toThrow(/GEMINI_API_KEY/);
  });
});

describe("canvas.snap + photo delivery", () => {
  let server: Server;
  let base: string;
  const received: Array<{ url: string; body: Buffer }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ url: req.url ?? "", body: Buffer.concat(chunks) });
        if (req.url?.includes("screenshot")) {
          res.setHeader("content-type", "image/png");
          res.end(Buffer.from("\x89PNG fake-pixels"));
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, result: {} }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => server.close());

  it("renders HTML to a PNG through gotenberg's screenshot route", async () => {
    const node = canvasSnapNode({ baseUrl: base });
    const out = await node.run({ html: "<h1>Sales chart</h1>", filename: "chart.png" }, [], { tenantId: "t" });
    expect(received.at(-1)!.url).toContain("/screenshot/html");
    expect(out[0].json.kind).toBe("image");
    expect(out[0].binary!.data.toString("latin1")).toContain("PNG");
  });

  it("telegram.send delivers a .png as a photo and an .mp3 as a voice note", async () => {
    const node = telegramSendNode({ apiRoot: base, token: "tkn" });

    const photo = await node.run(
      { chatId: "7", filename: "chart.png" },
      [{ json: {}, binary: { data: Buffer.from("png-bytes") } }],
      { tenantId: "t" },
    );
    expect(photo[0].json.kind).toBe("photo");
    expect(received.at(-1)!.url).toBe("/bottkn/sendPhoto");

    const voice = await node.run(
      { chatId: "7", filename: "reply.mp3" },
      [{ json: {}, binary: { data: Buffer.from("mp3-bytes") } }],
      { tenantId: "t" },
    );
    expect(voice[0].json.kind).toBe("voice");
    expect(received.at(-1)!.url).toBe("/bottkn/sendVoice");
  });
});
