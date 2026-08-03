import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { NodeDef } from "@squidclaw/kernel";

const run = promisify(exec);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 200_000;

async function capture(command: string, timeoutMs: number) {
  try {
    const { stdout, stderr } = await run(command, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT });
    return { ok: true, exitCode: 0, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    return {
      ok: false,
      exitCode: e.code ?? 1,
      stdout: (e.stdout ?? "").slice(0, MAX_OUTPUT),
      stderr: (e.stderr ?? e.message).slice(0, MAX_OUTPUT),
    };
  }
}

export const shellExecNode: NodeDef = {
  name: "shell.exec",
  description:
    "Run a shell command on the machine this agent runs on. Params: command (required), timeoutMs (optional). Returns {ok, exitCode, stdout, stderr}. Prefer read-only commands; never run destructive commands without the human asking for them explicitly.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
  },
  run: async (params) => {
    const out = await capture(params.command as string, (params.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS);
    return [{ json: out }];
  },
};

export const sshExecNode: NodeDef = {
  name: "ssh.exec",
  description:
    "Run a command on a remote server over SSH, using the host's configured SSH keys and ~/.ssh/config aliases. Params: host (alias or user@ip, required), command (required), timeoutMs (optional). Returns {ok, exitCode, stdout, stderr}. Never run destructive or service-restarting commands on production hosts unless the human explicitly asked.",
  inputSchema: {
    type: "object",
    required: ["host", "command"],
    properties: { host: { type: "string" }, command: { type: "string" }, timeoutMs: { type: "number" } },
  },
  run: async (params) => {
    const host = String(params.host).replace(/"/g, "");
    const command = String(params.command).replace(/"/g, '\\"');
    const ssh = `ssh -o ConnectTimeout=20 -o BatchMode=yes "${host}" "${command}"`;
    const out = await capture(ssh, (params.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS);
    return [{ json: { host: params.host, ...out } }];
  },
};
