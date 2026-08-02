import type { NodeDef } from "@squidclaw/kernel";

export const echoNode: NodeDef = {
  name: "echo",
  description: "Returns its params back as a single item. Use to relay or shape data.",
  inputSchema: { type: "object", properties: { value: {} }, additionalProperties: true },
  run: async (params) => [{ json: { ...params } }],
};
