import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const requireFrom = createRequire(import.meta.url);
/** The vendored 3D engine, resolved from node_modules at load time. */
const threeBuild = dirname(requireFrom.resolve("three"));
const jsmRoot = join(threeBuild, "..", "examples", "jsm");

const FIXED_ASSETS: Record<string, string> = {
  "/assets/three.js": join(threeBuild, "three.module.min.js"),
  "/assets/three.core.min.js": join(threeBuild, "three.core.min.js"),
  "/assets/orbit.js": join(jsmRoot, "controls", "OrbitControls.js"),
};

/**
 * Resolves a request path under /assets/ to an absolute file on disk — the
 * self-hosted three.js engine plus whatever jsm module it cross-imports
 * (the bloom pass's postprocessing chain, future controls, etc). The jsm
 * tree isn't enumerated file-by-file; anything under it is servable by path.
 *
 * Shared by the real dashboard server and the local canvas-preview fixture
 * server so the two can't drift out of sync with each other.
 */
export function resolveAssetPath(urlPath: string): string | undefined {
  const fixed = FIXED_ASSETS[urlPath];
  if (fixed) return fixed;
  if (urlPath.startsWith("/assets/jsm/")) {
    const full = join(jsmRoot, urlPath.slice("/assets/jsm/".length));
    if (full.startsWith(jsmRoot)) return full;
  }
  return undefined;
}
