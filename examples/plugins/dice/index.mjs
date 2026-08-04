/**
 * The reference plugin — small enough to read in one breath, complete
 * enough to copy. Drop this directory into <workspace>/plugins/ and the
 * agent can roll dice: as a chat request, inside a flow, in a habit.
 */
export default {
  name: "dice",
  version: "1.0.0",
  description: "Dice rolls as a tool — the hello-world of SquidClaw plugins.",
  nodes: () => [
    {
      name: "dice.roll",
      description: "Roll dice. Params: sides (default 6), count (default 1, max 20). Returns rolls and their total.",
      inputSchema: {
        type: "object",
        properties: { sides: { type: "number" }, count: { type: "number" } },
      },
      run: async (params) => {
        const sides = Math.max(2, Number(params.sides ?? 6));
        const count = Math.min(20, Math.max(1, Number(params.count ?? 1)));
        const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
        return [{ json: { rolls, total: rolls.reduce((a, b) => a + b, 0), sides } }];
      },
    },
  ],
};
