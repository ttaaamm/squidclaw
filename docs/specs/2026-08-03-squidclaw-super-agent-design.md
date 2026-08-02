# SquidClaw — The Habit-Forming Super Agent

**Design spec · 2026-08-03 · Status: approved by Tamer, pending final review**

---

## 0. What this is

SquidClaw (new entity — not the OpenClaw fork; that codebase is hereafter
**squidclaw-legacy**) is a new species of agent born from fusing two ideas
that have always lived apart:

- **Agents** (chat, reasoning, memory) — flexible but expensive, slow, and
  inconsistent at repeated work.
- **Workflow engines** (n8n-style graphs) — reliable and cheap but mindless;
  they only do what a human wires by hand.

SquidClaw is one organism with both modes of thought. Its defining power:
**it turns repetition into instinct.** Improvised work crystallizes into
deterministic workflows the agent authors for itself. It gets faster,
cheaper, and more reliable the longer it serves you — the opposite cost
curve of every agent on the market.

This is a clean-room build. Zero code from OpenClaw, n8n, or
squidclaw-legacy. The idea — the improvise→crystallize→execute→heal loop as
an agent's core identity — originated in this project.

## 1. Identity & core loop

1. **IMPROVISE** — A request arrives via chat with no matching habit. The
   agent plans and executes live: brains route the thinking, tools do the
   work. The entire run is recorded in the journal **as a graph of steps**
   — the same format as a workflow.
2. **CRYSTALLIZE** — When the journal shows the same task succeeded
   repeatedly (default: 2 clean runs), the agent freezes the recorded graph
   into a draft flow: strips LLM reasoning steps, parameterizes what varied
   (names, amounts, dates), keeps what didn't. Drafts live in
   `flows/_drafts/` until a human promotes them in chat ("yes, make this
   automatic").
3. **EXECUTE** — Matching requests now run the flow directly: no
   improvisation, no routing tokens, identical behavior every run. The
   agent supervises instead of thinks.
4. **HEAL** — A flow fails → the agent reads that execution's journal
   entry and classifies: transient → retry with backoff; broken → repair
   the flow and re-crystallize; ambiguous → message the human in plain
   language. Healing is itself an improvisation, so repeated healings can
   crystallize too.

**Design principle:** *everything is an execution.* An improvised run and a
crystallized flow are the same data structure in the same kernel, recorded
in the same journal. Crystallization is therefore nearly free — "save this
graph, parameterize it" — not a translation between two alien systems.

**v1 success criterion:** one real task (e.g. the invoice-generation job)
completes the full loop — improvised in chat, crystallized after two runs,
executing as a habit, surviving one induced failure via healing — every
step visible in the dashboard.

## 2. Anatomy — the agent's workspace

```
agent/
├── SOUL.md            # WHO IT IS — persona, voice, values, boundaries
├── memory/            # WHAT IT KNOWS — facts, people, preferences (*.md)
├── flows/             # WHAT IT KNOWS HOW TO DO — procedural memory
│   ├── *.flow.json    #   crystallized habits, authored by the agent
│   └── _drafts/       #   habits still forming (not yet promoted)
├── reflexes/          # ITS INSTINCTS — standing triggers (cron, webhook)
│   └── *.trigger.json
├── journal/           # WHAT IT HAS LIVED — every execution, every I/O
│   └── executions.db  #   read by the agent to heal, learn, crystallize
├── BRAINS.yaml        # HOW IT THINKS — model routing policy
├── SURFACES.yaml      # ITS FACES — telegram / whatsapp / web config
└── vault/             # WHAT IT'S TRUSTED WITH — encrypted credentials
```

Everything except `vault/` and `journal/` is human-readable text —
auditable, git-diffable minds. Adopted as philosophy from the soul-file
tradition; implementation is entirely ours.

## 3. Code structure

Monorepo, TypeScript, Node ≥22. The **kernel is the spine**; the agent is a
client of the kernel — not its owner (the inversion from legacy).

```
squidclaw/
├── packages/
│   ├── kernel/     # executions, items model, graph walker, journal,
│   │               # node/tool registry, credential vault. No LLM, no chat.
│   ├── brains/     # router: one interface, many models (BRAINS.yaml)
│   ├── agent/      # the improviser: plans live graphs, crystallizes,
│   │               # heals. A client of the kernel.
│   ├── nodes/      # node library: telegram-send, http, gotenberg, …
│   ├── surfaces/   # ChatSurface implementations: telegram, whatsapp, web
│   ├── server/     # API, auth, tenants, trigger runtime (webhook + cron)
│   └── canvas/     # React + React Flow — read-only viewer of flows/runs
```

Data model rules (day-0, cheap now, brutal to retrofit):
- Every table carries `tenant_id`.
- Nodes/steps declare a **brain tier** (`cheap|writer|vision|coder|auto`),
  never a hardcoded model name.
- Data between nodes is always an **array of items** `{json, binary}`
  (n8n's hardest-won lesson, adopted from day one).
- Flows expose a **tool-call manifest** (name, description, input schema)
  so every flow is callable by agents, MCP-style.
- Kernel never assumes "our server": Postgres or SQLite, BYOK brains,
  surfaces are config. This guarantees self-host later at packaging cost
  only.

## 4. Brains — the router

`BRAINS.yaml` maps tiers → models with fallbacks and budgets. Plumbing via
an existing gateway (LiteLLM-class); the IP is the routing policy, not the
plumbing. Multi-brain buys: cost routing (cheap models for extraction,
strong for writing/coding, vision where needed), provider-outage
resilience, and plan-tier pricing for the hosted service.

## 5. Surfaces & client UX

- `ChatSurface` interface from day one; **Telegram first**. WhatsApp via
  Meta Cloud API when a verified business exists (unofficial libraries are
  a ban risk — never used).
- **Agent-first UX:** clients only ever chat. Onboarding *is* a
  conversation; no signup ceremony (the messenger already authenticated
  them). Dashboard is a web link: **read-only canvas** — a window into the
  agent's mind, showing habits and live executions. No client editing, no
  client-authored code at launch (kills the sandboxing problem).
- The canvas-editing/co-editing mode is architecturally possible later
  (shared-artifact model, per-workflow edit lock) behind a per-tenant flag.

## 6. Deployment & distribution

**Hosted (launch):** one Node process + Postgres + nginx on the **Preplix
VPS (187.77.162.34)** — Tamer's pick: the species grows on the box that
already hosts squidclaw.dev. Dev at `/opt/agenticflow` (name avoids any
collision with legacy squidclaw installs), localhost-only until explicit
go → then `flow.preplix.ai` (DNS + TLS + systemd). Multi-tenant
single instance. No Kubernetes, no Redis until load demands.

**Self-host (v1.1, guaranteed by architecture):** docker compose / npx,
SQLite default, BYOK brains. Signup only ever required for what genuinely
lives on our side: metered brains, WhatsApp number, hosted dashboard, sync.

**Infrastructure map:**

| Box | Names | Hosts |
|---|---|---|
| Preplix VPS · 187.77.162.34 | preplix.ai, squidclaw.dev, flow.preplix.ai (planned) | TARS (legacy), product landing page, **new build** |
| aljoodbs · 76.13.49.186 | n8n.preplix.ai, aljoodbs.com | n8n, Saudi Times bots, Ash (legacy) — reference environment |

`squidclaw.dev` (owned, static page, Preplix VPS) becomes the product's
brand home. TARS and Ash continue on squidclaw-legacy, untouched; they may
be reborn on the new SquidClaw when it matures.

## 7. Phases

| Phase | Name | Alive when |
|---|---|---|
| 0 | Birth certificate | Repo (private, spec = commit #1), monorepo scaffold, CI, dev env on aljoodbs box |
| 1 | Heartbeat | Message it on Telegram → it improvises with tools → full run queryable in journal |
| 2 | **First habit** | Real task: improvised ×2 → crystallized → third run executes with zero improvisation. *The species exists.* |
| 3 | Reflexes & healing | Habits fire on cron/webhook; a habit survives an induced failure overnight unattended |
| 4 | Face & window | Read-only dashboard: watch a habit run live on the canvas from a phone |
| 5 | Doors open | Multi-tenant hardening; flow.preplix.ai live; one outside client onboards by chatting |
| 6 | Species spreads | Self-host package, WhatsApp surface, billing, node library growth (own specs later) |

Rules: every phase ends demonstrably alive; our own bots dogfood before any
client; nothing public-facing without Tamer's explicit go.

## 8. Boundaries (v1 non-goals)

No client-authored code · no client canvas editing · no self-host at launch
(v1.1) · no marketplace · no Kubernetes/queues until load · no unofficial
WhatsApp libraries · phases 5–6 details (billing, quotas) get separate
specs.

## 9. Decisions log

| Decision | Choice |
|---|---|
| Goal | Service for us + others (grew from learning build) |
| Foundation | New entity, clean core — zero legacy/n8n code |
| Spine | Kernel; *everything is an execution* |
| Stack | Node + TypeScript; React + React Flow canvas |
| Brains | Multi-model router, tier-based, BYOK-capable |
| Client UX | Agent-first; canvas read-only in dashboard |
| Distribution | Hosted at launch; self-host v1.1 (architecture guarantees) |
| Dev host | Preplix VPS (187.77.162.34), /opt/agenticflow, localhost until go |
| Name | **SquidClaw** (the species). Old fork = squidclaw-legacy. Home: squidclaw.dev |
