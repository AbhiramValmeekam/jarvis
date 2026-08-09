/**
 * Which utterances Jarvis answers itself, and which go to Hermes.
 *
 * The point of this file is latency. "What time is it" does not need a language
 * model, and routing it through one costs seconds and a running Hermes for an
 * answer the machine already knows. Everything matched here is deterministic,
 * offline, and instant.
 *
 * The risk is the mirror image, and it is the thing this design is built
 * against: **stealing an utterance that was meant for the agent**. A local
 * engine that fires on "open the report and summarise the third section"
 * because it saw "open" has made Jarvis worse, not faster. Two rules keep that
 * from happening:
 *
 *   1. **Every pattern is anchored.** A match must consume the entire
 *      utterance, not a fragment of it. Compound and conversational requests
 *      therefore cannot match at all, and fall through to Hermes untouched.
 *   2. **Confidence must clear `LOCAL_THRESHOLD`.** Free-text slots — an app
 *      name, mainly — only score highly when the slot resolves against a real
 *      catalog supplied by the caller. "Open Notepad" is confident; "open the
 *      pod bay doors" is not, and goes to the agent.
 *
 * No I/O here, and no Windows calls: this decides *what* was asked. The
 * executors decide how to do it, and are the only part that touches the system.
 * Utterances are untrusted input (§52) — they are whatever was audible near the
 * microphone. Nothing below interpolates one into a command string.
 */

export type LocalIntentId =
  | "time.now"
  | "date.today"
  | "volume.set"
  | "volume.up"
  | "volume.down"
  | "volume.mute"
  | "volume.unmute"
  | "mic.mute"
  | "mic.unmute"
  | "screenshot"
  | "lock"
  | "battery"
  | "resources"
  | "app.launch";

export interface IntentSlots {
  /** `volume.set` target, 0–100. */
  level?: number;
  /** `volume.up` / `volume.down` step, 0–100. */
  step?: number;
  /** `app.launch` target, as the catalog's canonical key. */
  app?: string;
  /** What the user actually said for a resolved slot, for the reply text. */
  spoken?: string;
}

export interface IntentMatch {
  kind: "match";
  id: LocalIntentId;
  /** 0–1. Compared against `LOCAL_THRESHOLD` by `routeUtterance`. */
  confidence: number;
  slots: IntentSlots;
}

/**
 * Recognised, but under-specified in a way that matters.
 *
 * Only used where guessing has a cost the user would object to. Bare "mute" is
 * the motivating case: it could mean the speakers or the microphone, and
 * silently picking the speakers would leave a hot microphone behind a user who
 * believes they just switched it off. Asking is cheap; being wrong is a privacy
 * failure, so this asks.
 */
export interface IntentAmbiguous {
  kind: "ambiguous";
  question: string;
  candidates: LocalIntentId[];
}

export interface IntentNone {
  kind: "none";
  /** Why nothing matched — for the audit log, not the user. */
  reason: string;
}

export type IntentResult = IntentMatch | IntentAmbiguous | IntentNone;

/**
 * Confidence a match needs before Jarvis acts on it alone.
 *
 * Set high on purpose. The cost of routing a local-looking utterance to Hermes
 * is a slower answer; the cost of handling an agent-shaped request locally is a
 * wrong one.
 */
export const LOCAL_THRESHOLD = 0.8;

/** What the caller knows about the machine, so matching stays pure. */
export interface IntentContext {
  /**
   * Launchable apps, canonical key → spoken aliases. Supplied by the caller
   * because it depends on what is installed, which this file must not go and
   * look up. An empty catalog simply means no `app.launch` ever gets confident
   * enough to fire, which is the correct failure.
   */
  apps?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Reduce an utterance to its instruction.
 *
 * STT output carries capitalisation, terminal punctuation, and the politeness a
 * person uses out loud — "Jarvis, could you take a screenshot please?" — none of
 * which changes the request. Stripping it here means the patterns below can stay
 * anchored, which is what stops them matching fragments of longer sentences.
 */
export function normalise(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9%'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // The wake word survives into the transcript often enough to matter.
  s = s.replace(/^(hey |ok |okay )?jarvis\b[\s,]*/, "");
  s = s.replace(/^(please|could you|can you|would you|will you|i want you to|i'd like you to)\s+/, "");
  s = s.replace(/^(please|just)\s+/, "");
  s = s.replace(/\s+(please|thanks|thank you|for me)$/, "");
  s = s.replace(/^(go ahead and|now)\s+/, "");
  return s.trim();
}

// --- number words ----------------------------------------------------------

/**
 * Spoken numbers, because STT writes "fifty" as often as "50".
 *
 * Only the values a person actually says to a volume control. This is not a
 * general number parser and does not need to be.
 */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, "twenty-five": 25,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, "seventy-five": 75,
  eighty: 80, ninety: 90, "a hundred": 100, hundred: 100,
  half: 50, "halfway": 50, "full": 100, "max": 100, "maximum": 100,
};

/** Parse a spoken or written percentage. Returns null when it is not one. */
function parseLevel(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s*%$/, "").replace(/\s+percent$/, "");
  const digits = /^\d{1,3}$/.exec(s);
  if (digits) {
    const n = Number(s);
    return n >= 0 && n <= 100 ? n : null;
  }
  const word = NUMBER_WORDS[s];
  return word === undefined ? null : word;
}

// --- rules -----------------------------------------------------------------

/**
 * One recognisable phrasing.
 *
 * `re` is anchored at both ends by construction (see `anchored`), so a rule can
 * only ever match a whole utterance. `confidence` is the ceiling for the rule;
 * a slot that fails to resolve lowers it, never raises it.
 */
interface Rule {
  id: LocalIntentId;
  re: RegExp;
  confidence: number;
  slots?: (m: RegExpExecArray, ctx: IntentContext) => IntentSlots | null;
}

/** Force whole-utterance matching. The single most important line here. */
const anchored = (body: string): RegExp => new RegExp(`^(?:${body})$`);

const LEVEL = String.raw`(\d{1,3}\s*%?|[a-z]+(?:-[a-z]+)?(?:\s+percent)?)`;

const RULES: Rule[] = [
  // --- clock ---------------------------------------------------------------
  {
    id: "time.now",
    re: anchored(String.raw`(?:what(?:'s| is)? the )?time(?: is it)?|what time is it(?: right now)?|tell me the time`),
    confidence: 1,
  },
  {
    id: "date.today",
    re: anchored(String.raw`(?:what(?:'s| is)? (?:the |today's )?date(?: today)?)|what day is it(?: today)?|tell me the date`),
    confidence: 1,
  },

  // --- speaker volume -----------------------------------------------------
  {
    id: "volume.set",
    re: anchored(String.raw`(?:set |change )?(?:the )?volume (?:to|at) ${LEVEL}`),
    confidence: 1,
    slots: (m) => {
      const level = parseLevel(m[1]);
      return level === null ? null : { level };
    },
  },
  {
    id: "volume.up",
    re: anchored(String.raw`(?:turn |crank )?(?:the )?volume up(?: by ${LEVEL})?|turn up the volume|louder|turn it up`),
    confidence: 1,
    slots: (m) => {
      const step = parseLevel(m[1]);
      return step === null ? {} : { step };
    },
  },
  {
    id: "volume.down",
    re: anchored(String.raw`(?:turn )?(?:the )?volume down(?: by ${LEVEL})?|turn down the volume|quieter|turn it down`),
    confidence: 1,
    slots: (m) => {
      const step = parseLevel(m[1]);
      return step === null ? {} : { step };
    },
  },
  {
    id: "volume.mute",
    re: anchored(String.raw`mute (?:the )?(?:volume|sound|audio|speakers?)|silence|be quiet`),
    confidence: 1,
  },
  {
    id: "volume.unmute",
    re: anchored(String.raw`unmute (?:the )?(?:volume|sound|audio|speakers?)|(?:turn (?:the )?)?sound (?:back )?on`),
    confidence: 1,
  },

  // --- microphone ---------------------------------------------------------
  // Distinct from speaker volume on purpose: conflating them is the failure
  // that leaves a live microphone behind a user who thinks they muted it.
  {
    id: "mic.mute",
    re: anchored(String.raw`(?:mute|disable|turn off|switch off|cut) (?:the |my )?(?:mic|mics|microphone|input)|stop listening`),
    confidence: 1,
  },
  {
    id: "mic.unmute",
    re: anchored(String.raw`(?:unmute|enable|turn on|switch on) (?:the |my )?(?:mic|mics|microphone|input)|(?:start|resume) listening`),
    confidence: 1,
  },

  // --- machine ------------------------------------------------------------
  {
    id: "screenshot",
    re: anchored(String.raw`(?:take |grab |capture )?(?:a )?screen ?shot(?: of (?:the )?(?:screen|display))?|capture (?:the |my )?screen`),
    confidence: 1,
  },
  {
    id: "lock",
    re: anchored(String.raw`lock (?:the |my )?(?:screen|computer|pc|laptop|machine|workstation)|lock it`),
    confidence: 1,
  },
  {
    id: "battery",
    re: anchored(String.raw`(?:what(?:'s| is)? (?:the |my )?)?battery(?: level| percentage| status)?|how much battery(?: (?:do i have|is left|have i got))?|am i (?:on|plugged in(?:to)?) (?:battery|power)`),
    confidence: 1,
  },
  {
    id: "resources",
    re: anchored(String.raw`(?:what(?:'s| is)? (?:the |my )?)?(?:cpu|memory|ram|resource)(?: and (?:memory|ram))?(?: usage| use| load)?|how(?:'s| is) (?:the |my )?(?:cpu|memory|ram)(?: doing)?|system (?:usage|load|resources)`),
    confidence: 1,
  },

  // --- apps ---------------------------------------------------------------
  // Confidence is decided entirely by the catalog. An unresolvable name is a
  // near-miss, not a match, so "open the pod bay doors" reaches Hermes.
  {
    id: "app.launch",
    re: anchored(String.raw`(?:open|launch|start|run|fire up|bring up) (?:up )?([a-z0-9][a-z0-9 .'-]{0,40})`),
    confidence: 1,
    slots: (m, ctx) => resolveApp(m[1], ctx),
  },
];

// --- app resolution --------------------------------------------------------

/** Filler a person puts around an app name without meaning it. */
const APP_NOISE = /^(?:the|my|an?|up)\s+|\s+(?:app|application|program|window|for me)$/g;

/**
 * Resolve a spoken app name against the caller's catalog.
 *
 * Returning `null` is the important path: it means "I heard a launch-shaped
 * sentence naming something I do not have", which must reach the agent rather
 * than becoming a failed local action. Matching is exact against the aliases the
 * caller supplied — no fuzzy distance, because "open steam" resolving to
 * "Settings" would be worse than not resolving at all.
 */
function resolveApp(raw: string | undefined, ctx: IntentContext): IntentSlots | null {
  if (!raw || !ctx.apps) return null;
  const spoken = raw.replace(APP_NOISE, "").trim();
  if (!spoken) return null;

  for (const [key, aliases] of ctx.apps) {
    if (key === spoken) return { app: key, spoken };
    for (const alias of aliases) {
      if (alias === spoken) return { app: key, spoken };
    }
  }
  return null;
}

// --- matching --------------------------------------------------------------

/** Utterances that name a mute target too vaguely to act on. */
const BARE_MUTE = /^(?:mute|mute everything|mute it)$/;
const BARE_UNMUTE = /^(?:unmute|unmute everything|unmute it)$/;

/**
 * Match a single utterance.
 *
 * Rules are tried in order and the first whole-utterance match wins. Order
 * matters only where two rules could both match, and the table is arranged so
 * the more specific one (microphone before speakers) comes first.
 */
export function matchIntent(utterance: string, ctx: IntentContext = {}): IntentResult {
  const text = normalise(utterance);
  if (!text) return { kind: "none", reason: "empty utterance" };

  // Asked before the rules, because both readings are legitimate and the wrong
  // guess is a privacy failure rather than an inconvenience.
  if (BARE_MUTE.test(text)) {
    return {
      kind: "ambiguous",
      question: "Mute the microphone, or the speakers?",
      candidates: ["mic.mute", "volume.mute"],
    };
  }
  if (BARE_UNMUTE.test(text)) {
    return {
      kind: "ambiguous",
      question: "Unmute the microphone, or the speakers?",
      candidates: ["mic.unmute", "volume.unmute"],
    };
  }

  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;

    let slots: IntentSlots = {};
    if (rule.slots) {
      const resolved = rule.slots(m, ctx);
      // A rule whose slot will not resolve has not matched. Falling through
      // lets a later rule try, and failing that the agent gets the utterance.
      if (resolved === null) continue;
      slots = resolved;
    }
    return { kind: "match", id: rule.id, confidence: rule.confidence, slots };
  }

  return { kind: "none", reason: `no local intent for "${text}"` };
}

/**
 * The routing decision: does Jarvis answer this, or does Hermes?
 *
 * Separate from `matchIntent` so the threshold is applied in exactly one place
 * and can be tested against it directly.
 */
export function routeUtterance(
  utterance: string,
  ctx: IntentContext = {},
): { route: "local"; match: IntentMatch } | { route: "ask"; question: string } | { route: "agent"; reason: string } {
  const result = matchIntent(utterance, ctx);
  if (result.kind === "ambiguous") return { route: "ask", question: result.question };
  if (result.kind === "none") return { route: "agent", reason: result.reason };
  if (result.confidence < LOCAL_THRESHOLD) {
    return { route: "agent", reason: `${result.id} scored ${result.confidence.toFixed(2)}` };
  }
  return { route: "local", match: result };
}
