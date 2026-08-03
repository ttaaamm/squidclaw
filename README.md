# SquidClaw

**An agent that turns repetition into instinct.**

Every agent alive today improvises the same task the same way, forever — burning
the same tokens on the hundredth run as on the first. Every workflow engine is
the opposite: reliable, cheap, and completely mindless.

SquidClaw is one organism with both modes of thought.

```
1. IMPROVISE   You ask. It figures the task out live, using its tools.
2. CRYSTALLIZE Done it twice? It freezes what worked into a deterministic flow —
               a habit it authored for itself.
3. EXECUTE     Next time: no thinking. The habit runs. Fast, cheap, identical.
4. HEAL        It broke? It reads its own journal, repairs the habit, or asks you.
```

It gets **cheaper, faster and more reliable the longer you use it.**

See [BIRTH-CERTIFICATE.md](BIRTH-CERTIFICATE.md) · [design spec](docs/specs/2026-08-03-squidclaw-super-agent-design.md) · [plan](docs/plans/2026-08-03-squidclaw-phases-0-1.md)

## The load-bearing idea

**Everything is an execution.** When the agent improvises, its tool calls are
recorded *as a graph* — the same format a workflow uses. So crystallizing a
habit isn't a translation between two systems; the habit is already written
down. One kernel, one data format, one journal, two temperatures: improvisation
is molten, habit is crystallized.

## Run it

No API key required — it can think on your existing Claude subscription.

```bash
npm install
npm run heartbeat         # talk to it in your terminal
```

```bash
npm run dev               # talk to it on Telegram (needs TELEGRAM_BOT_TOKEN)
npm run journal -- list   # everything it has ever done
npm run journal -- show <id>
```

Set `ANTHROPIC_API_KEY` to use the API instead (tier routing + fallback);
`SQUIDCLAW_BRAIN=cli|api` forces a door. Type `/vibe funny` in any chat.

## What it can do

| | |
|---|---|
| **Two brains, one mind** | Claude CLI (your subscription, no key) or the API with tier routing and automatic fallback |
| **Memory** | Remembers this conversation, *and* durable facts it chooses to keep — as plain markdown you can read and edit |
| **Personality** | Switchable vibes — warm, formal, funny, brief, teacher — per chat, without touching who it is |
| **Web** | `web.search`, `web.read` — searches and reads pages as readable text |
| **Machines** | `shell.exec`, `ssh.exec` — runs commands locally or on your servers via your SSH config |
| **Documents** | `pdf.create`, `pptx.create` — writes real PDFs and PowerPoint decks natively |
| **MCP** | Drop an `mcp.json` in the workspace; every tool on those servers becomes a node it can call |
| **n8n import** | `n8n.import` converts an exported n8n workflow into a runnable graph |
| **Faces** | Telegram and terminal today; WhatsApp and web next |

Every one of these is a **node** — so anything it does is journaled as a graph
step, and anything it does twice can become a habit.

## Anatomy

```
workspace/              # the agent's body
├── INNERME.md          # WHO IT IS
├── VIBES.yaml          # HOW IT SOUNDS
├── BRAINS.yaml         # HOW IT THINKS — tiers → models, never hardcoded
├── mcp.json            # BORROWED TOOLS (optional)
├── memory/*.md         # WHAT IT KNOWS — facts it chose to keep
└── journal/            # WHAT IT HAS LIVED — every execution, every step

packages/
├── kernel/     # the spine: items, registry, journal, graph walker. No LLM, no chat.
├── brains/     # one interface, many minds — API router + CLI brain
├── memory/     # episodic (this conversation) + semantic (durable facts)
├── agent/      # the improviser + vibes: thinking, recorded as a graph
├── nodes/      # what it can do — web, shell, ssh, documents, mcp, n8n import
├── surfaces/   # its faces: telegram, terminal
└── server/     # runners + journal CLI
```

Everything except the journal is human-readable text — auditable, git-diffable
minds. An agent whose mind you can read is an agent you can trust.

## Habits — the part nobody else has

Do the same work twice and it writes itself a habit:

```
you › Fetch https://api.github.com/zen and tell me what it says.
    › It says: "Non-blocking is better than blocking."

you › Now fetch https://api.github.com/octocat and tell me what it says.
    › It's the Octocat ASCII art, saying "Avoid administrative distraction."

      💡 I've done this 2 times now, so I wrote it down as a habit:
         http-request (asks for: url). Say `/promote http-request`
         and I'll stop thinking it through every time.

you › /promote http-request
    › Promoted. I'll run it directly from now on.
```

What it wrote for itself — constants baked in, the part that varied opened up:

```json
{ "name": "http-request", "params": ["url"], "runs": 2,
  "graph": { "nodes": [{ "node": "http.request",
    "params": { "url": "{{url}}", "method": "GET" } }], "edges": [] } }
```

That habit then runs in **~500 ms with zero LLM calls** — where improvising it
cost a full round-trip and tokens every single time. It never promotes itself;
habits wait in `flows/_drafts/` until a human says yes.

`/habits` to see them · `/promote <name>` to bless one · they're plain JSON you
can read, edit, and version.

## Status

**Phase 2 — First habit, complete.** It thinks, acts, speaks, remembers, and
now forms habits from its own successful work. It does not yet fire reflexes
on a schedule (Phase 3) or show you its mind on a canvas (Phase 4).

```bash
npm test        # 70 tests
npm run typecheck
```

## Lineage

None. Clean-room build — no code from OpenClaw, n8n, or squidclaw-legacy.
It learned from its elders; it carries none of their blood.
