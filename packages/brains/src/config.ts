import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Tier = "cheap" | "strong";

export interface BrainsConfig {
  tiers: Record<Tier, string[]>;
}

/** Models live in config, never in code — swapping a brain must never be a code change. */
export function loadBrainsConfig(yamlPath: string): BrainsConfig {
  const cfg = parse(readFileSync(yamlPath, "utf8")) as BrainsConfig;
  for (const tier of ["cheap", "strong"] as Tier[]) {
    if (!cfg?.tiers?.[tier]?.length) throw new Error(`BRAINS.yaml: tier "${tier}" missing or empty`);
  }
  return cfg;
}
