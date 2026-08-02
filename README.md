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

## Status

**Phase 1 — Heartbeat.** It thinks, acts, speaks, and remembers — both this
conversation and what it chose to keep. It does not yet
form habits (Phase 2), fire reflexes (Phase 3), or show you its mind (Phase 4).

## Anatomy

```
workspace/              # the agent's body
├── INNERME.md          # WHO IT IS
├── BRAINS.yaml         # HOW IT THINKS — tiers → models, never hardcoded
├── memory/*.md         # WHAT IT KNOWS — facts it chose to keep, in plain markdown
└── journal/            # WHAT IT HAS LIVED — every execution, every step

packages/
├── kernel/     # the spine: items, registry, journal, graph walker. No LLM, no chat.
├── brains/     # one interface, many minds — tier routing with fallback
├── memory/     # episodic (this conversation) + semantic (durable facts)
├── agent/      # the improviser: thinking, recorded as a graph
├── nodes/      # what it can do: echo, http.request, memory.remember, memory.recall
├── surfaces/   # its faces: telegram, terminal
└── server/     # runners + journal CLI
```

Memory is a **tool**, not a feature bolted on: the agent decides for itself what
is worth keeping and goes looking when something feels familiar. What it keeps
lands in `workspace/memory/` as plain markdown — greppable, git-diffable,
editable by you. An agent whose mind you can read is an agent you can trust.

## Run it

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY (+ TELEGRAM_BOT_TOKEN for Telegram)

npm run heartbeat         # talk to it in your terminal
npm run dev               # talk to it on Telegram
npm run journal -- list   # what it has lived
npm run journal -- show <id>
```

```bash
npm test        # 28 tests
npm run typecheck
```

## Lineage

None. Clean-room build — no code from OpenClaw, n8n, or squidclaw-legacy.
It learned from its elders; it carries none of their blood.
