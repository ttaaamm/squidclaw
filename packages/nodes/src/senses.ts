import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { NodeDef } from "@squidclaw/kernel";

const run = promisify(execFile);

/**
 * Eyes — look at an image through the Claude CLI's own vision.
 *
 * Runs on the subscription like everything else: the CLI's Read tool can open
 * images, so seeing costs no API key. Overridable exec for tests.
 */
export function visionLookNode(
  exec: (args: string[]) => Promise<string> = async (args) =>
    (await run("claude", args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
): NodeDef {
  return {
    name: "vision.look",
    description:
      "Look at an image file and describe what's in it. Params: path (image file on disk, required), question (what to look for — optional; default is a full description). Use this when the human sends a photo.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, question: { type: "string" } },
    },
    run: async (params) => {
      const path = resolve(String(params.path));
      if (!existsSync(path)) throw new Error(`vision.look: no file at ${path}`);
      const question = String(params.question ?? "Describe everything relevant in this image, concisely.");
      const raw = await exec([
        "-p", `Read the image file at ${path} and answer: ${question}`,
        "--allowedTools", "Read",
        "--model", "haiku",
        "--json-schema", JSON.stringify({ type: "object", required: ["answer"], properties: { answer: { type: "string" } } }),
      ]);
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("vision.look: the eyes returned nothing readable");
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { answer: string };
      return [{ json: { path, saw: parsed.answer } }];
    },
  };
}

/**
 * Voice — speak a reply aloud via Microsoft Edge's free TTS (the same engine
 * legacy uses). Produces an mp3 that telegram.send can deliver as a voice note.
 */
export function voiceSayNode(
  synthesize?: (text: string, outPath: string, voice: string) => Promise<void>,
): NodeDef {
  return {
    name: "voice.say",
    description:
      "Turn text into spoken audio (mp3). Params: text (required), path (where to save, required), voice (optional; e.g. en-US-GuyNeural, ar-SA-HamedNeural — Arabic works). Chain telegram.send with the filename to deliver it as a voice note.",
    inputSchema: {
      type: "object",
      required: ["text", "path"],
      properties: { text: { type: "string" }, path: { type: "string" }, voice: { type: "string" } },
    },
    run: async (params) => {
      const outPath = resolve(String(params.path));
      mkdirSync(dirname(outPath), { recursive: true });
      const voice = String(params.voice ?? "en-US-GuyNeural");

      if (synthesize) {
        await synthesize(String(params.text), outPath, voice);
      } else {
        const { EdgeTTS } = await import("node-edge-tts");
        const tts = new EdgeTTS({ voice, outputFormat: "audio-24khz-48kbitrate-mono-mp3" });
        await tts.ttsPromise(String(params.text), outPath);
      }

      const audio = readFileSync(outPath);
      return [{ json: { path: outPath, bytes: audio.length, voice, kind: "audio" }, binary: { data: audio } }];
    },
  };
}

/**
 * Ears — transcribe a voice note. Needs one key: GEMINI_API_KEY (free tier,
 * the same trick legacy uses) or OPENAI_API_KEY (whisper). Without either it
 * explains what's missing instead of pretending to hear.
 */
export function transcribeNode(
  transports: {
    gemini?: (audio: Buffer, mime: string, key: string) => Promise<string>;
    whisper?: (audio: Buffer, filename: string, key: string) => Promise<string>;
  } = {},
): NodeDef {
  const gemini =
    transports.gemini ??
    (async (audio: Buffer, mime: string, key: string) => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: "Transcribe this audio exactly. Reply with only the transcription." },
                  { inline_data: { mime_type: mime, data: audio.toString("base64") } },
                ],
              },
            ],
          }),
        },
      );
      if (!res.ok) throw new Error(`gemini: HTTP ${res.status}`);
      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text.trim()) throw new Error("gemini heard nothing");
      return text.trim();
    });

  const whisper =
    transports.whisper ??
    (async (audio: Buffer, filename: string, key: string) => {
      const form = new FormData();
      form.append("model", "whisper-1");
      form.append("file", new Blob([new Uint8Array(audio)]), filename);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) throw new Error(`whisper: HTTP ${res.status}`);
      return ((await res.json()) as { text: string }).text;
    });

  return {
    name: "audio.transcribe",
    description:
      "Transcribe an audio file (voice note) to text. Params: path (audio file on disk, required). Needs GEMINI_API_KEY or OPENAI_API_KEY in the environment.",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    run: async (params) => {
      const path = resolve(String(params.path));
      if (!existsSync(path)) throw new Error(`audio.transcribe: no file at ${path}`);
      const audio = readFileSync(path);
      const mime = path.endsWith(".mp3") ? "audio/mp3" : path.endsWith(".wav") ? "audio/wav" : "audio/ogg";

      if (process.env.GEMINI_API_KEY) {
        return [{ json: { path, text: await gemini(audio, mime, process.env.GEMINI_API_KEY) } }];
      }
      if (process.env.OPENAI_API_KEY) {
        return [{ json: { path, text: await whisper(audio, path.split(/[\\/]/).at(-1)!, process.env.OPENAI_API_KEY) } }];
      }
      throw new Error(
        "I have no ears yet — add GEMINI_API_KEY (free at aistudio.google.com) or OPENAI_API_KEY to the environment",
      );
    },
  };
}
