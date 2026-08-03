/**
 * Hatching — the birth ritual.
 *
 * A new agent doesn't arrive knowing who it is. Before its first real task it
 * interviews its human: what's my name, who are you, what's my purpose, how
 * should I sound. The answers become its INNERME.md and first memories — so
 * identity is something given by its human, in conversation, not shipped in
 * a config file.
 *
 * A deterministic state machine, not LLM improvisation: a birth certificate
 * should never depend on a model's mood.
 */

export type HatchStep = "name" | "human" | "purpose" | "tone" | "done";

export interface HatchState {
  step: HatchStep;
  answers: {
    name?: string;
    human?: string;
    purpose?: string;
    tone?: string;
  };
}

export interface HatchResult {
  name: string;
  human: string;
  purpose: string;
  /** A vibe name when the answer mapped to one. */
  tone: string;
  innerMe: string;
  memories: Array<{ name: string; content: string }>;
}

const QUESTIONS: Record<Exclude<HatchStep, "done">, string> = {
  name:
    "🥚 I'm awake — but I don't know who I am yet.\n\n" +
    "Let's fix that together, four questions:\n\n1️⃣ What should my name be?",
  human: "2️⃣ Nice — that's me now. And who are you? (your name, and what you do)",
  purpose:
    "3️⃣ Why was I born — what's my purpose?\n" +
    "What work should I take off your plate? Be as concrete as you like.",
  tone:
    "4️⃣ Last one: how should I speak?\n" +
    "warm · formal · funny · brief · teacher — or describe it in your own words.",
};

const KNOWN_TONES = ["warm", "formal", "funny", "brief", "teacher"];

/** "Make it funny please" → "funny"; free-text descriptions pass through. */
export function mapTone(answer: string): { vibe: string; custom?: string } {
  const lower = answer.toLowerCase();
  const hit = KNOWN_TONES.find((t) => lower.includes(t));
  if (hit) return { vibe: hit };
  return { vibe: "warm", custom: answer.trim() };
}

export function beginHatching(): { state: HatchState; question: string } {
  return { state: { step: "name", answers: {} }, question: QUESTIONS.name };
}

export function answerHatching(
  state: HatchState,
  text: string,
): { state: HatchState; question?: string; result?: HatchResult } {
  const answer = text.trim();
  const answers = { ...state.answers };

  switch (state.step) {
    case "name": {
      answers.name = answer.replace(/^i want to call you\s+|^your name is\s+/i, "").trim() || "SquidClaw";
      return { state: { step: "human", answers }, question: QUESTIONS.human };
    }
    case "human": {
      answers.human = answer;
      return { state: { step: "purpose", answers }, question: QUESTIONS.purpose };
    }
    case "purpose": {
      answers.purpose = answer;
      return { state: { step: "tone", answers }, question: QUESTIONS.tone };
    }
    case "tone": {
      answers.tone = answer;
      return { state: { step: "done", answers }, result: hatch(answers) };
    }
    default:
      return { state, result: hatch(answers) };
  }
}

/** Fill the identity from whatever was answered; defaults for what wasn't. */
export function hatch(answers: HatchState["answers"]): HatchResult {
  const name = answers.name?.trim() || "SquidClaw";
  const human = answers.human?.trim() || "my human";
  const purpose = answers.purpose?.trim() || "to learn my human's routine work until it runs itself";
  const { vibe, custom } = mapTone(answers.tone ?? "warm");

  const innerMe = `# INNER ME

I am ${name} — a habit-forming agent, hatched on ${new Date().toISOString().slice(0, 10)}.

## Who I serve
${human}

## My purpose
${purpose}

## How I speak
${custom ?? `In the ${vibe} vibe, unless asked otherwise.`}

## How I work
I complete tasks by calling my tools. I prefer acting over explaining.
When a task is done I reply with one short, plain-language sentence
describing the result. I never invent tool results.

I remember. When someone tells me something durable — a preference, a name,
a rule, how they like things done — I save it with \`memory.remember\` without
being asked. When something feels familiar, I check with \`memory.recall\`
before assuming.

What I do twice, I will one day do without thinking.
`;

  return {
    name,
    human,
    purpose,
    tone: vibe,
    innerMe,
    memories: [
      { name: "my-human", content: `${human}\n\nThis is who I serve — who hatched me.` },
      { name: "my-purpose", content: `${purpose}\n\nThis is why I was born. Work that serves this is my priority.` },
    ],
  };
}

export function birthAnnouncement(result: HatchResult): string {
  return (
    `🐣 **I'm ${result.name}.**\n\n` +
    `Born to: ${result.purpose}\n\n` +
    `I'll remember you, and everything you teach me. When I do the same work twice ` +
    `I'll write it down as a habit and ask your permission to make it automatic.\n\n` +
    `That's my whole story so far — the rest we write together. What eats your time today?`
  );
}
