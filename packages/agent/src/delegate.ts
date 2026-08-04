import type { NodeDef } from "@squidclaw/kernel";
import { Agent, type AgentOptions } from "./improviser.js";

/**
 * Multi-agent orchestration, v1 — the "8 brains" idea, grown honestly.
 *
 * The main mind can spawn up to three SPECIALISTS: fresh sub-agents with a
 * role, one self-contained assignment each, and the shared toolset. They
 * work in parallel, journal their runs like any other thinking (everything
 * is an execution), and report their final answers back to the mind that
 * spawned them — which then owns the synthesis.
 *
 * Deliberate limits: specialists get no chat history (fresh head), no
 * memory-writing (the main agent owns the human's memory), no habit
 * formation, and no delegate tool of their own (no infinite recursion).
 */
export function delegateNode(
  base: Pick<AgentOptions, "brains" | "journal" | "tenantId" | "memory" | "policies">,
): NodeDef {
  return {
    name: "agent.delegate",
    description:
      "Spawn specialist sub-agents that work IN PARALLEL and report back. Params: tasks (required — up to 3 of " +
      '{role, task}: role is who the specialist is ("a meticulous fact-checker"), task is their COMPLETE ' +
      "self-contained assignment with every detail they need — they cannot see this conversation. " +
      "Use for genuinely parallel or specialist work; for anything simple, just do it yourself.",
    inputSchema: {
      type: "object",
      required: ["tasks"],
      properties: { tasks: { type: "array" } },
    },
    run: async (params) => {
      const tasks = (Array.isArray(params.tasks) ? params.tasks : [])
        .slice(0, 3) as Array<{ role?: string; task?: string }>;
      if (!tasks.length || tasks.some((t) => !t?.task)) {
        throw new Error(
          "agent.delegate needs tasks: [{role, task}] — every task must be a complete, self-contained assignment.",
        );
      }

      const results = await Promise.all(
        tasks.map(async (t, i) => {
          const role = String(t.role ?? "a capable specialist");
          const specialist = new Agent({
            brains: base.brains,
            journal: base.journal,
            tenantId: base.tenantId,
            memory: base.memory,
            policies: base.policies,
            extractFacts: false,
            innerMe:
              `# SPECIALIST\nYou are ${role} — a focused sub-agent spawned for exactly one assignment. ` +
              "Complete it and give your final answer. No small talk, no questions back: make sensible " +
              "assumptions and state them.",
          });
          try {
            const answer = await specialist.handleMessage(String(t.task), `delegate-${Date.now()}-${i}`);
            return { role, answer };
          } catch (err) {
            return { role, error: String(err instanceof Error ? err.message : err) };
          }
        }),
      );

      return results.map((r) => ({ json: r }));
    },
  };
}
