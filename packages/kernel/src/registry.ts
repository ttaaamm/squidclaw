import type { NodeDef } from "./types.js";

const nodes = new Map<string, NodeDef>();

export function registerNode(def: NodeDef): void {
  if (nodes.has(def.name)) throw new Error(`Node "${def.name}" already registered`);
  nodes.set(def.name, def);
}

export const getNode = (name: string): NodeDef | undefined => nodes.get(name);
export const listNodes = (): NodeDef[] => [...nodes.values()];
export const clearNodes = (): void => nodes.clear();
