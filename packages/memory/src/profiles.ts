import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeDef } from "@squidclaw/kernel";

export interface Profile {
  person: string;
  fields: Record<string, string>;
  notes: string[];
  updatedAt: string;
}

const slug = (name: string) =>
  name.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9؀-ۿ]+/g, "-").replace(/^-+|-+$/g, "") || "someone";

/**
 * Who's who in the human's world — structured per-person memory, so "what's
 * Khalid's number" is a lookup, not a hope that a flat fact exists.
 */
export class Profiles {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(person: string): string {
    return join(this.dir, `${slug(person)}.json`);
  }

  get(person: string): Profile | undefined {
    const path = this.path(person);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as Profile;
  }

  set(person: string, field: string, value: string): Profile {
    const profile = this.get(person) ?? { person, fields: {}, notes: [], updatedAt: "" };
    profile.fields[field] = value;
    profile.updatedAt = new Date().toISOString();
    writeFileSync(this.path(person), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    return profile;
  }

  note(person: string, note: string): Profile {
    const profile = this.get(person) ?? { person, fields: {}, notes: [], updatedAt: "" };
    profile.notes.push(note);
    profile.updatedAt = new Date().toISOString();
    writeFileSync(this.path(person), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    return profile;
  }

  all(): Profile[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Profile);
  }
}

export function profileNodes(profiles: Profiles): NodeDef[] {
  return [
    {
      name: "profile.set",
      description:
        'Save a structured fact about a person the human knows. Params: person (their name), field (e.g. "phone", "role", "company", "birthday"), value. Prefer this over memory.remember for facts about people.',
      inputSchema: {
        type: "object",
        required: ["person", "field", "value"],
        properties: { person: { type: "string" }, field: { type: "string" }, value: { type: "string" } },
      },
      run: async (params) => [
        { json: { saved: true, ...profiles.set(String(params.person), String(params.field), String(params.value)) } },
      ],
    },
    {
      name: "profile.note",
      description: "Add a free-form note to a person's profile. Params: person, note.",
      inputSchema: {
        type: "object",
        required: ["person", "note"],
        properties: { person: { type: "string" }, note: { type: "string" } },
      },
      run: async (params) => [
        { json: { saved: true, ...profiles.note(String(params.person), String(params.note)) } },
      ],
    },
    {
      name: "profile.get",
      description: "Everything known about a person. Params: person (their name).",
      inputSchema: { type: "object", required: ["person"], properties: { person: { type: "string" } } },
      run: async (params) => {
        const profile = profiles.get(String(params.person));
        return [{ json: profile ? { ...profile } : { found: false, person: params.person } }];
      },
    },
    {
      name: "profile.list",
      description: "List every person with a profile. No params.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const all = profiles.all();
        return all.length
          ? all.map((p) => ({ json: { person: p.person, fields: Object.keys(p.fields), notes: p.notes.length } }))
          : [{ json: { empty: true } }];
      },
    },
  ];
}
