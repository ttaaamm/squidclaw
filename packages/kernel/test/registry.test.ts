import { describe, it, expect, beforeEach } from "vitest";
import { registerNode, getNode, listNodes, clearNodes, type NodeDef } from "@squidclaw/kernel";

const echo: NodeDef = {
  name: "echo",
  description: "returns its params as one item",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  run: async (params) => [{ json: { ...params } }],
};

describe("node registry", () => {
  beforeEach(clearNodes);

  it("registers and retrieves a node", () => {
    registerNode(echo);
    expect(getNode("echo")?.description).toContain("params");
    expect(listNodes().map((n) => n.name)).toEqual(["echo"]);
  });

  it("rejects duplicate names", () => {
    registerNode(echo);
    expect(() => registerNode(echo)).toThrow(/already registered/);
  });
});
