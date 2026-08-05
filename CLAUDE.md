# SquidClaw

**Read [squidclawproject.md](squidclawproject.md) first.** It is the full project
record — architecture, the arsenal, memory layers, production topology, hard-won
lessons, open items, timeline. This file is only the rules that must not be
violated while working here.

A habit-forming agent: improvise → crystallize → `/promote` → execute
deterministically → heal. The design rests on one decision — **everything is an
execution**: improvised runs and crystallized flows share one graph format in one
journal, which is why a habit can form out of a conversation at all.

## Before committing

Both must pass. No exceptions.

```bash
npx tsc --build && npx vitest run
```

357+ tests across 57 files. A pre-commit hook scans for secret shapes.

## Deploying

```bash
git add -A && git commit && git push
ssh preplix-prod "cd /opt/agenticflow && git pull --quiet && \
  chown -R squidclaw:squidclaw /opt/agenticflow && \
  systemctl restart squidclaw-serve && sleep 6 && systemctl is-active squidclaw-serve"
```

The `chown` is **mandatory** — root's `git pull` leaves root-owned files the
`squidclaw` service user cannot read, and the service dies on restart. Root also
needs `git config --global --add safe.directory /opt/agenticflow`.

Confirm live afterward. Never report a deploy as done on the strength of a clean
push.

## Rules with scars behind them

- **Never edit flow JSON with `sed`.** One stray quote crash-looped production
  through 25 systemd restarts. Use a node script.
- **Exit code 0 is not proof the feature you need got compiled in.** Check build
  logs for warnings when a dependency is optional.
- **Enforce contracts where they are consumed.** A model told "the title must come
  from the human" invented `"Test Post"`. Prompt rules and tool descriptions both
  failed; the flow rejecting the value itself is what held.
- **Verify the hypothesis before building the fix.** A plausible stderr warning
  once nearly justified a real refactor; one test command showed the true cause
  was unrelated.
- **Every tool call goes through `executeTool()`** in `packages/agent/src/policy.ts`.
  One door — do not add a second path.
- **Prefer the Write tool over inline heredocs** for multi-line scripts run via
  SSH/PowerShell. Nested quoting across shells has corrupted escapes repeatedly.
- **Background long commands** (builds, installs, SSH round-trips) rather than
  blocking on them.

## Production

Preplix VPS, `ssh preplix-prod` (key-based, no prompts — use Bash directly, not
Posh-SSH). Repo at `/opt/agenticflow`, running as the non-root `squidclaw` user.
Services: `squidclaw-serve` (hooks 4100, canvas 4200), `squidclaw-whisper` (8321),
`squidclaw-embeddings` (8322).

Pause for explicit confirmation before anything touching production state:
stopping/restarting services beyond the deploy above, writing secrets to disk,
pushing to shared branches.

### ⚠️ Claude CLI OAuth expires 2026-09-03

Its failure mode is **total silence** — all three thinking lanes call the same
CLI, so the agent stops answering entirely and logs nothing obvious. Renew with:

```bash
ssh preplix-prod
sudo -u claudeuser -H /usr/bin/claude.real auth login --claudeai
```

Standalone command, not the TUI (the TUI captures mouse events, so paste fails).
`-H` is mandatory or credentials land where the service never reads them. Each run
mints a new `state` — a code from an earlier attempt returns `400`. One attempt at
a time. Verify with `auth status` → `loggedIn: true`, `authMethod: claude.ai`.
