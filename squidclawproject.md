# SquidClaw — Project Record

> A habit-forming agent that improvises with tools, then freezes what worked
> into deterministic workflows. Born 2026-08-03.

**Local repo:** `C:\Users\Tamer\OneDrive\Desktop\N8N`
**GitHub:** `git@github.com:ttaaamm/squidclaw.git` (branch `main`)
**Production:** `/opt/agenticflow` on the Preplix VPS (`ssh preplix-prod`, 187.77.162.34)

Last updated 2026-08-06 · 89 commits · ~16,600 lines of TypeScript · 57 test files, 359 tests

---

## 1. What it is

Most agents forget. They solve the same problem from scratch every time, paying
full thinking cost for work they've already done.

SquidClaw closes that loop:

```
improvise → crystallize → /promote → execute deterministically → heal
```

It solves a task by reasoning with tools (**improvise**). That run is journaled as
a graph. When the same shape of work recurs, the graph becomes a named, reusable
flow (**crystallize**). Once promoted, the flow runs as plain deterministic code —
no model, no cost, no variance (**execute**). When a step breaks, it repairs
itself (**heal**).

**The central design decision: everything is an execution.** An improvised agent
run and a crystallized workflow share one graph format in one journal. That's why
a habit can form out of a conversation at all — there's no boundary to cross.

### Naming
- **SquidClaw** — the species/codebase
- **SquidFlow** — a workflow in its own dialect
- **INNERME.md** — the agent's self-definition (identity, purpose, voice)
- **Superclaw** — the live Telegram bot instance

---

## 2. Architecture

Eleven packages, npm workspaces, TypeScript throughout. `kernel` is the root
dependency; nothing depends on `server`.

| Package | Lines | Responsibility |
|---|---:|---|
| `kernel` | 314 | Items model, node registry, journal (SQLite), graph walker |
| `brains` | 271 | `Mind` interface — CLI brain (subscription) or API brain, tier routing |
| `agent` | 2129 | Improviser, crystallizer, healer, deep mind, policy gate, compaction, dreaming |
| `nodes` | 2312 | The tool arsenal + the n8n dialect |
| `memory` | 856 | Episodic, semantic (TF-IDF + vectors), knowledge, profiles, tasks |
| `server` | 1638 | Multi-tenant platform, hooks, boot, CLI runners |
| `canvas` | 1220 | The 3D neural dashboard |
| `reflexes` | 482 | Cron/webhook triggers — acting unasked |
| `surfaces` | 421 | Telegram, WhatsApp, terminal faces |
| `tenants` | 436 | Isolation, registry, encrypted vault, quotas |
| `sdk` | 135 | Plugin SDK + marketplace registry |

### The thinking path

A message walks three lanes, cheapest first:

1. **Fast lane** — one cheap-model breath. Answers casual messages in ~5s, or
   replies `<ESCALATE>` and steps aside. No classifier bot: the model that would
   have answered decides.
2. **Deep mind** — the whole task handed to the Claude Code harness, with our
   tools exposed to it over an MCP bridge. Every tool call comes back through
   that bridge and is journaled as a graph step, so habits crystallize out of
   deep runs exactly as from the classic loop.
3. **Classic loop** — our own step-by-step tool loop. The fallback that always works.

### The tool policy gate

`executeTool()` in `packages/agent/src/policy.ts` is the **only** place any tool
ever runs — both the classic loop and the deep bridge route through it. It
enforces required schema fields, rejects placeholder values, and applies operator
scopes (`shell.exec`→`shell`, `ssh.exec`→`ssh`, `email.send`→`email`,
`instagram.publish`→`publish`). One door, so there's no second path to audit.

---

## 3. The arsenal

**25 native tools:** `audio.transcribe` `browser.snap` `canvas.snap` `csv.read`
`csv.write` `doc.read` `email.read` `email.send` `gotenberg.render` `http.request`
`image.generate` `instagram.publish` `n8n.step` `pdf.create` `pptx.create`
`shell.exec` `squidflow.import` `ssh.exec` `telegram.poll` `telegram.send`
`unsupported.node` `vision.look` `voice.say` `web.read` `web.search`

**19 n8n node types spoken natively** — real n8n workflow JSON imports and *runs*,
via one dispatcher node (`n8n.step`): manualTrigger, telegramTrigger,
executeWorkflowTrigger, scheduleTrigger, webhook, noOp, set, code, if, switch,
filter, merge, wait, aggregate, httpRequest, telegram, readWriteFile,
extractFromFile, spreadsheetFile.

### Senses — all local, no API keys

| Sense | Implementation | Where |
|---|---|---|
| **Ears** | whisper.cpp, `ggml-small-q5_1` held hot in a server | `/opt/whisper`, port 8321 |
| **Mouth** | Piper neural TTS, Arabic + English auto-detected by script | `/opt/piper` |
| **Vector memory** | llama.cpp + `nomic-embed-text-v1.5` | port 8322 |
| **Eyes** | `vision.look` | via the mind |

Voice notes are transcribed **at the Telegram surface, before the mind wakes** —
so the agent gets words, not homework, and spends one thinking turn instead of two.

Grown by `scripts/install-ears.sh`, `install-voice.sh`, `install-vectors.sh`.

---

## 4. Memory

Four layers, because "remembering" means different things:

- **Episodic** — verbatim recent turns, plus a rolling summary when a chat
  outgrows its window
- **Semantic** — TF-IDF lexical search blended with true cosine similarity from
  local embeddings. A purely semantic match must clear a floor to count, which
  stops embedding noise from flooding results. Embedder down → silent fallback to
  lexical. It never goes deaf.
- **Knowledge / profiles / tasks** — durable structured facts
- **Active injection** — `systemPrompt()` pins core memories (`my-human`,
  `my-purpose`) always, then fills the budget with *relevance-ranked* recall for
  the current message

**Action-aware extraction** was a real fix: the passive ear used to read only the
chat text. When an SSH connection succeeded but the reply just said "connected,
done", nothing was remembered. Extraction now also sees `summarizeActions(graph)` —
what tools *actually ran*, the ground truth of the turn.

---

## 5. The canvas

`http://127.0.0.1:4200` — the agent's mind, drawn as a mind.

One WebGL scene (self-hosted three.js, no CDN, no build step). The agent is a
burning core; each workflow is a neuron on a fibonacci sphere; dendrites curve
between them. Grab and rotate the whole brain. Glide toward a neuron and its inner
network fades in — steps as smaller neurons, synapses that fired carrying moving
signals. Nothing navigates away; details open as glass overlays.

Live over SSE: a running flow pulses at every zoom level, and inside a zoomed
neuron the frontier step — parents done, no record yet — burns amber as *firing
right now*.

Built iteratively with a fixture server (`scripts/canvas-preview.ts`) plus headless
Chrome screenshots, so every visual claim was verified by looking at it. Glow was
deliberately dialed back after "too much glowy effect"; the later bloom pass was
kept subtle for the same reason.

---

## 6. Platform

Multi-tenant: many tenants, one process.

- **Hatching** — a birth ritual gives each tenant its own INNERME
- **Tenant isolation** — separate workspace, journal, memory, flows; encrypted
  vault; quotas
- **Flow contracts + elicitation** — a flow declares `ParamSpec {name, ask,
  options, default, reject}` and refuses to run with missing or placeholder
  params. The *platform* runs a deterministic interview — not the model, so the
  wording is guaranteed.
- **Session lanes + steering** — one run per chat, ever. Messages arriving
  mid-run fold into the turn already in flight instead of racing it.
- **Channel docking** — conversation history, vibes, and pending interviews follow
  the **tenant**, not `(surface, chatId)`. Tell it something on Telegram, ask
  about it from WhatsApp — one mind, many doors. Unsolicited pushes go to
  whichever door you last spoke from.
- **Reflexes** — cron and webhook triggers, so it acts unasked
- **Dreaming** — nightly memory consolidation with a Dream Diary (`/dreams`)
- **Plugin SDK + marketplace** — `/plugins`, per-plugin failure boundaries
- **Multi-agent delegation** — up to 3 parallel specialists, fresh heads, journaled
- **`/doctor`** — live-probes (not env-checks) the mind, tunnel, embeddings,
  whisper, piper. Has already caught two real production faults.

---

## 7. Hard-won lessons

Each of these cost real debugging time. They're recorded because the reasoning
matters more than the fix.

**Exit code 0 is not proof the feature you need got compiled in.** llama.cpp's
cmake configured "successfully" with only a *warning* when OpenSSL was missing,
then crash-looped at runtime with "HTTPS is not supported". The install script now
greps the configure log and fails loudly rather than trusting the exit code.

**Never edit flow JSON with `sed`.** One stray quote corrupted
`formal-post.flow.json` and crash-looped the platform through 25 systemd restarts —
which presented to Tamer as "he didn't reply." `FlowStore.read()` now skips and
logs a single corrupt flow instead of taking the whole platform down.

**A genie satisfies the letter of a rule.** Told "the title must come from the
human," the model invented `"Test Post"`. Fixed at three layers — a behavior rule,
the tool description naming the trap, and the flow rejecting placeholder titles
itself. Only the third layer actually held. *Enforce contracts where they're
consumed.*

**An error string is a value that propagates.** `execFile`'s error embeds the
entire command line — prompt, tool list, system prompt, tens of KB. That became a
reply, was journaled as history, and fed the next turn, until an outgoing message
blew past Telegram's 4096-char cap and was rejected outright. The human saw
*nothing*. Now: errors are sanitized to stderr + exit code, and long replies chunk
across messages instead of vanishing.

**Silent failure paths are the expensive ones.** That incident produced *zero*
server-side error lines for three hours; it had to be diagnosed from the tenant's
`conversation.db`. Both fallback paths now log.

**Verify the hypothesis before building the fix.** A `no stdin data received in 3s`
warning looked like the root cause and would have justified a real refactor. One
test command on the server showed the truth: `Not logged in`. The warning was
noise on stderr.

**`sudo` keeps the invoking user's HOME.** Without `-H`, credentials land where the
service will never read them — and the login *appears* to succeed.

---

## 8. Production

**Host:** Preplix VPS, Ubuntu 24.04, `ssh preplix-prod`

| Service | State | Port |
|---|---|---|
| `squidclaw-serve` | active | hooks 4100, canvas 4200 |
| `squidclaw-whisper` | active | 8321 |
| `squidclaw-embeddings` | active | 8322 |

Runs as the non-root system user `squidclaw`, with a narrow `sudo -u claudeuser`
lane for the Claude CLI only.

**Deploy:**
```bash
git add -A && git commit && git push
ssh preplix-prod "cd /opt/agenticflow && git pull --quiet && \
  chown -R squidclaw:squidclaw /opt/agenticflow && \
  systemctl restart squidclaw-serve && sleep 6 && systemctl is-active squidclaw-serve"
```

> **The `chown` is mandatory.** Root's `git pull` leaves root-owned files the
> service user can't read. Root also needs
> `git config --global --add safe.directory /opt/agenticflow`.

### ⚠️ Live operational risk

**The Claude CLI OAuth refresh token expires 2026-09-03.** When it lapsed on
2026-08-05 the CLI blanked its own credentials and the agent went *completely*
silent — all three thinking lanes call the same CLI.

Renew before then:
```bash
ssh preplix-prod
sudo -u claudeuser -H /usr/bin/claude.real auth login --claudeai
```
Use the standalone command, not the TUI (the TUI captures mouse events, so
right-click paste fails). Each run mints a new `state` — a code from an earlier
attempt gives `400`. One attempt at a time. Verify with `auth status`
(`loggedIn: true`, `authMethod: claude.ai`).

---

## 9. Quality gates

- **CI** — `.github/workflows/ci.yml`, green since the project's first commit
- **Secret scanning** — `scripts/check-secrets.mjs`, pre-commit hook (`--staged`)
  and CI (`--all`); Anthropic/OpenAI/Stripe/GitHub/AWS/Slack/Google/Telegram/
  private-key shapes
- **Tests** — 359 across 57 files; full suite + `tsc --build` before every commit
- **Verification discipline** — every deploy confirmed live on the VPS with real
  commands, never "should work"

---

## 10. Open items

**Recommended next** (small, and this failure mode is silence):
- `/doctor` reports credential days-remaining
- Heartbeat warns ~5 days before OAuth expiry

**Deferred by decision:**
- Model failover — explicitly postponed
- Splitting `packages/server/src/platform.ts` (1016 lines — the one real
  god-file left; docking, elicitation, hatching, flow sessions, commands, hooks)

**Waiting on external input:**
- WhatsApp switch-on (`SQUIDCLAW_WHATSAPP=1`; code is built and tested)
- Instagram token for `instagram.publish`

---

## 11. Timeline

Built across two days, 2026-08-03 → 2026-08-06.

**Aug 3 — birth.** Spec, plan, birth certificate. Kernel scaffold → nodes, brains
router, improviser, Telegram surface → memory → the crystallizer (habits form) →
reflexes and healing → the canvas → tenant isolation → the platform → the deep
mind → WhatsApp + email → the discipline layer.

**Aug 4 — reach.** SquidFlows and the n8n dialect (imported workflows *run*) →
flow sessions → seven dialect fidelity bugs from the first live run → flow
contracts and platform elicitation → session lanes and steering → the tool policy
gate → the neural canvas in 3D, dendritic arborization, glow dialed down → the
OpenClaw harvest.

**Aug 5 — depth.** Dreaming and REM sleep → the reach wave (images, publishing,
tables) → in-run compaction, sandboxing and operator scopes → Plugin SDK,
multi-agent orchestration, marketplace → hygiene wave (secret gate, `/doctor`) →
built-in ears, then a mouth, then instant hearing → the fast lane → strong memory:
TF-IDF, action-aware extraction, active injection → **true vector memory, local,
no API** → channel docking + deep-mind context safety → canvas polish.

**Aug 6 — hardening.** Repo cleanup (untracked build artifact, 9 dead scripts
removed, canvas asset serving deduped) → the "message is too long" incident: root
cause found, three-layer fix, and the OAuth expiry that was actually behind it.
