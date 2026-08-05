import { registerNode, type NodeDef } from "@squidclaw/kernel";
import type { SemanticMemory } from "./semantic.js";

/**
 * Memory as tools: the agent chooses what is worth keeping, and goes looking
 * when it needs something. Nobody has to tell it to remember.
 */
export function memoryNodes(memory: SemanticMemory): NodeDef[] {
  return [
    {
      name: "memory.remember",
      description:
        "Save a durable fact worth recalling in future conversations (a preference, a name, a decision, how someone likes things done). Params: name (short slug-like title), content (the fact, in your own words).",
      inputSchema: {
        type: "object",
        required: ["name", "content"],
        properties: { name: { type: "string" }, content: { type: "string" } },
      },
      run: async (params) => {
        const slug = memory.remember(params.name as string, params.content as string);
        return [{ json: { remembered: slug } }];
      },
    },
    {
      name: "memory.recall",
      description:
        "Search everything you have remembered. Params: query (a word or phrase). Returns matching memories.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
      },
      run: async (params) => {
        const hits = await memory.recall(params.query as string);
        return hits.length
          ? hits.map((m) => ({ json: { name: m.name, content: m.content } }))
          : [{ json: { found: false } }];
      },
    },
  ];
}

export function registerMemoryNodes(memory: SemanticMemory): void {
  for (const node of memoryNodes(memory)) registerNode(node);
}
