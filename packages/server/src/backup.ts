import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface AgentBackup {
  version: 1;
  createdAt: string;
  source: string;
  files: Record<string, string>; // relative path -> base64
}

/** Everything that IS the agent; journal WALs and temp state stay behind. */
const SKIP = /(^|[\\/])(node_modules|_archive|HATCHING\.json|.*\.db-wal|.*\.db-shm)$/;

function walk(dir: string, root: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP.test(full)) continue;
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out[relative(root, full).split(sep).join("/")] = readFileSync(full).toString("base64");
  }
}

/**
 * A whole agent in one file: identity, memories, habits, reflexes, journal,
 * tasks, knowledge — everything its directory holds. Restore it anywhere and
 * the same agent wakes up.
 */
export function exportAgent(agentDir: string): AgentBackup {
  const root = resolve(agentDir);
  if (!existsSync(root)) throw new Error(`no agent at ${root}`);
  const files: Record<string, string> = {};
  walk(root, root, files);
  return { version: 1, createdAt: new Date().toISOString(), source: root, files };
}

export function restoreAgent(backup: AgentBackup, targetDir: string): number {
  const root = resolve(targetDir);
  let restored = 0;
  for (const [rel, b64] of Object.entries(backup.files)) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(b64, "base64"));
    restored++;
  }
  return restored;
}

/** CLI: npm run backup -- export <agentDir> <out.json> | restore <backup.json> <targetDir> */
export async function backupCli(argv: string[]): Promise<string> {
  const [command, a, b] = argv;
  if (command === "export" && a) {
    const out = b ?? `squidclaw-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const backup = exportAgent(a);
    writeFileSync(out, JSON.stringify(backup), "utf8");
    return `exported ${Object.keys(backup.files).length} files from ${a} → ${out}`;
  }
  if (command === "restore" && a && b) {
    const backup = JSON.parse(readFileSync(a, "utf8")) as AgentBackup;
    return `restored ${restoreAgent(backup, b)} files into ${b}`;
  }
  return "usage: backup export <agentDir> [out.json] · backup restore <backup.json> <targetDir>";
}
