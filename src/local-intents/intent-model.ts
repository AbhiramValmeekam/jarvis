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
  | "app.launch"
  | "window.active"
  | "screen.read"
  | "project.list"
  | "project.open"
  | "memory.remember"
  | "memory.recall"
  | "memory.forget"
  | "memory.list"
  | "skills.list"
  | "tasks.list"
  | "mcp.list";

export interface IntentSlots {
  /** `volume.set` target, 0–100. */
  level?: number;
  /** `volume.up` / `volume.down` step, 0–100. */
  step?: number;
  /** `app.launch` target, as the catalog's canonical key. */
  app?: string;
  /**
   * `project.open` target — what the user *said*, not a canonical key.
   *
   * Unlike `app`, this is unresolved on purpose: two projects can answer to one
   * word, and `findProject` in the registry owns that decision. See
   * `resolveProject`.
   */
  project?: string;
  /**
   * Free text the user dictated, as they said it — `memory.remember`'s content
   * and `memory.recall`/`memory.forget`'s query.
   *
   * Carries the *original* casing and punctuation, not the normalised form.
   * `normalise` exists to make matching reliable and is lossy by design: it
   * lowercases, drops apostrophes and strips punctuation, so a memory taken
   * from it would be stored as "sarah s flight is on the 14th". A slot the user
   * will later read back has to keep what they said.
   */
  text?: string;
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
  /**
   * Project keys, when the ambiguity is *which project* rather than which
   * intent. Two projects answering to one word is as legitimate as bare "mute"
   * being either device, and gets the same treatment: ask, remember what was
   * offered, and resolve the next utterance against it.
   */
  projects?: readonly string[];
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
  /**
   * The user's projects, canonical key → spoken aliases. Same contract as
   * `apps`, and same failure mode: absent means `project.open` never gets
   * confident enough to fire, so the utterance reaches Hermes instead.
   */
  projects?: ReadonlyMap<string, readonly string[]>;
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
  /**
   * Return the text as it was actually spoken, for rules whose slot *is* free
   * text the user dictated. The alternative — `re.exec(normalise(text))` — is
   * lossy for anything the normaliser touches: `remember that Sarah's flight
   * is on the 14th` becomes `sarah s flight is on the 14th` before the rule
   * ever sees it, and a memory captured that way is mangled on the way in.
   */
  raw?(m: RegExpExecArray, original: string): string | null;
  /**
   * Checked before `slots`, for a rule whose slot can fit more than one thing.
   *
   * A question has to be raised here rather than downstream: by the time an
   * executor runs, `routeUtterance` has already answered "local or ask", and the
   * chance to ask is gone. Returning null means "not ambiguous", and matching
   * continues normally.
   */
  ambiguity?: (m: RegExpExecArray, ctx: IntentContext) => IntentAmbiguous | null;
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

  // --- context ------------------------------------------------------------
  // Deterministic and local: reading the foreground window needs no model, and
  // routing it through Hermes would mean the title of whatever you are looking
  // at leaves the machine to answer a question the machine can already answer.
  {
    id: "window.active",
    re: anchored(
      String.raw`(?:what(?:'s| is)?|which)(?: app| application| window| program)?(?: am i| is)?(?: looking at| in front| focused| active| open| on screen| on my screen)|what am i (?:looking at|working on|doing)|what(?:'s| is) (?:the )?(?:active|current|focused|foreground) (?:window|app|application)|(?:what|which) window(?: is)?(?: active| focused| in front)?`,
    ),
    confidence: 1,
  },

  /**
   * "Look at my screen and tell me what this error says."
   *
   * Distinct from `screenshot`, which is earlier in this list and stays that
   * way: "take a screenshot" means *save me a file*, and it keeps its meaning.
   * This one means *look*, and every phrasing below contains a verb of seeing
   * rather than of capturing, so the two do not compete for a sentence.
   *
   * Local only in the sense that the *asking* is local — the executor's whole
   * job is to obtain consent and hand the pixels to the agent. It is a local
   * intent so that the consent prompt is deterministic: routing "look at my
   * screen" through Hermes first would mean the agent decides whether to request
   * a screenshot, and the gate would sit downstream of a model's judgement
   * instead of upstream of it.
   */
  {
    id: "screen.read",
    // The last alternative is bare "look at this" — no trailing "for me" or
    // "please", because `normalise` has already removed both as politeness by
    // the time a rule sees the text. Spelling them here would make that branch
    // unreachable, which a test caught.
    //
    // It does take a trailing clause, though, because §66's literal sentence is
    // "look at this and tell me what's wrong" and the first version of this rule
    // sent that to the agent with no pixels attached. The clause is bounded and
    // must begin with "and", so "look at this file in the editor" — which names
    // a different object to look at — still falls through rather than quietly
    // photographing the desktop instead.
    re: anchored(
      String.raw`(?:can you |could you |please )?(?:look at|read|check|examine)(?: the| my| this)? screen(?: and .{0,80})?|(?:what|tell me what)(?: does| do)?(?: the| my| this)? screen (?:say|show)s?(?: .{0,40})?|(?:look at|read) (?:this|that)(?: and .{0,80})?`,
    ),
    confidence: 1,
  },

  // --- projects -----------------------------------------------------------
  // Before `app.launch`, because "open my jarvis project" would otherwise be
  // read as an app named "my jarvis project" — which fails to resolve and goes
  // to the agent, turning a question the machine can answer into a slow one.
  //
  // The word "project" (or "repo", or "folder") is *required*. Without it,
  // "open notepad" would race the app catalog, and a registry entry called
  // `notepad` — which is a directory somebody might well have — could take over
  // a word that means an application to everyone who says it.
  {
    id: "project.list",
    re: anchored(
      String.raw`(?:what|which) (?:projects?|repos?|repositories)(?: do i have| are there| have i got)?|list (?:my |the )?(?:projects?|repos?|repositories)|(?:what|which) (?:projects?|repos?) do you know(?: about)?`,
    ),
    confidence: 1,
  },
  {
    id: "project.open",
    re: anchored(
      String.raw`(?:open|launch|go to|switch to|show me|bring up) (?:the |my )?([a-z0-9][a-z0-9 .'_-]{0,60}?) (?:project|repo|repository|folder|directory)`,
    ),
    confidence: 1,
    ambiguity: (m, ctx) => projectAmbiguity(m[1], ctx),
    slots: (m, ctx) => resolveProject(m[1], ctx),
  },

  // --- memory ---------------------------------------------------------------
  // Before `app.launch`, which would otherwise read "remember X" as launching an
  // app called "remember X" and fail to resolve.
  //
  // Every phrasing here names *Jarvis* as the one doing the remembering, or
  // names nobody. "Tell Hermes to remember X" deliberately matches none of them,
  // so it falls through to the agent and Hermes' own memory tool does that
  // write — with its own threat scan and its own lock. See `memory/memory-store.ts`.
  {
    id: "memory.remember",
    re: anchored(
      String.raw`(?:remember|note|make a note|keep in mind)(?: that| this)?[\s,:-]+(.{2,400})|don't (?:let me )?forget(?: that| about)?[\s,:-]+(.{2,400})`,
    ),
    confidence: 1,
    // Group 1 or 2, whichever alternative fired.
    raw: (m, original) => rawTail(original, m[1] ?? m[2]),
    slots: (m) => {
      const said = m[1] ?? m[2];
      return said && said.trim() ? { text: said.trim() } : null;
    },
  },
  {
    id: "memory.list",
    re: anchored(
      String.raw`(?:what|which) do you remember(?: about me)?|what have you (?:remembered|saved|got saved)|(?:list|show me) (?:my |the |your )?(?:memories|notes|what you remember)|what do you know about me`,
    ),
    confidence: 1,
  },
  {
    id: "memory.recall",
    re: anchored(
      String.raw`(?:what do you remember|what did i (?:tell|say to) you) about (.{2,120})|(?:remind me|what was it) about (.{2,120})`,
    ),
    confidence: 1,
    raw: (m, original) => rawTail(original, m[1] ?? m[2]),
    slots: (m) => {
      const said = m[1] ?? m[2];
      return said && said.trim() ? { text: said.trim() } : null;
    },
  },
  {
    id: "memory.forget",
    re: anchored(String.raw`forget (?:that |the one )?about (.{2,120})|forget what i (?:told|said to) you about (.{2,120})`),
    confidence: 1,
    raw: (m, original) => rawTail(original, m[1] ?? m[2]),
    slots: (m) => {
      const said = m[1] ?? m[2];
      return said && said.trim() ? { text: said.trim() } : null;
    },
  },

  // --- skills ---------------------------------------------------------------
  // Answerable from the filesystem, so it stays answerable with Hermes down —
  // and Hermes could not answer "what can you do" about itself any faster.
  {
    id: "skills.list",
    re: anchored(
      String.raw`what can you do(?: for me)?|what are you (?:able to do|capable of)|(?:list|show me|what are) (?:your |the )?(?:skills|capabilities|abilities)|what skills do you have`,
    ),
    confidence: 1,
  },

  // --- scheduled tasks ------------------------------------------------------
  // Read-only, and local for a reason beyond speed: "is my 9am job going to
  // fire?" is a question people ask *precisely* when something looks wrong, and
  // routing it through the agent whose scheduler is the suspect answers it least
  // reliably exactly when it matters most.
  //
  // Note what is absent. There is no `tasks.create`, `tasks.pause` or
  // `tasks.remove` rule. Hermes owns `cron/jobs.json` and repairs it in place
  // during a tick, so a second writer could lose a user's jobs — and
  // `cron/lifecycle_guard.py` refuses jobs that would restart or kill the
  // gateway, a check a local shortcut would bypass. Scheduling goes to Hermes,
  // which is also where "every weekday at 9" is understood properly.
  {
    id: "tasks.list",
    re: anchored(
      String.raw`(?:what|which)(?:'s| is| are)?(?: my| the)? (?:scheduled )?(?:tasks|jobs|automations|reminders)(?: (?:do i have|are (?:there|scheduled|set up)))?|(?:list|show me|what are) (?:my |the |your )?(?:scheduled )?(?:tasks|jobs|automations|cron jobs|reminders)|do i have any (?:tasks|jobs|reminders|automations)(?: scheduled| set up)?|what(?:'s| is) (?:coming up|scheduled|next on my schedule)|(?:is|are|will) (?:my |the )?(?:tasks|jobs|automations|scheduler|cron) (?:going to )?(?:run|running|fire|firing|work|working)`,
    ),
    confidence: 1,
  },

  // --- MCP -----------------------------------------------------------------
  // Read-only, from `config.yaml`, and local for the same reason skills are:
  // `hermes mcp list` costs 1.655 s of Python startup and prints a table, while
  // the answer is one key in a file Jarvis can already read. It also stays
  // answerable with Hermes down — and "why can't the agent reach my notes?" is
  // asked exactly when something is already broken.
  //
  // Absent by design: no `mcp.add`, `mcp.remove` or `mcp.enable`. An MCP entry
  // is a command Hermes will spawn, `hermes_cli/mcp_security.py` exists because
  // that has been used to plant backdoors, and a local shortcut that wrote one
  // would bypass the save-time validation Hermes added in response. Adding a
  // server goes through `hermes mcp add`, which validates.
  {
    id: "mcp.list",
    re: anchored(
      String.raw`(?:list|show me|what are) (?:my |the |your )?(?:mcp|m c p) (?:servers|server|connections|integrations|tools)|what (?:mcp|m c p) (?:servers|connections|integrations) (?:do i have|are (?:there|set up|configured|connected))|do i have any (?:mcp|m c p)(?: servers)?(?: set up| configured)?|(?:is|are) (?:my |the )?(?:mcp|m c p)(?: servers?)? (?:set up|configured|connected|working)|what(?:'s| is) (?:connected|plugged in) to (?:you|hermes)`,
    ),
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

  // A project named without the word "project" — "open my portfolio".
  //
  // **After `app.launch`, and that ordering is the entire safety argument.** The
  // rule above documents why the word "project" is required at all: a directory
  // called `notepad` must not be able to take over a word that means an
  // application to everyone who says it. Here the app catalog has already been
  // consulted and declined, so this can only ever claim names no installed
  // application answers to — and `resolveApp` returning null is a fall-through,
  // not a failure, which is what makes a second attempt possible.
  //
  // §68 is why it exists: "remember that my portfolio means this project" and
  // then "open my portfolio". The user said what the name means, in a sentence
  // whose whole purpose was to make the short form work. Requiring them to then
  // say "open my portfolio *project*" would make the memory decorative.
  //
  // Ambiguity is asked, not guessed, exactly as the qualified form does.
  {
    id: "project.open",
    re: anchored(String.raw`(?:open|launch|go to|switch to|show me|bring up) (?:the |my )?([a-z0-9][a-z0-9 .'_-]{0,60})`),
    confidence: 1,
    ambiguity: (m, ctx) => projectAmbiguity(m[1], ctx),
    slots: (m, ctx) => resolveProject(m[1], ctx),
  },
];

// --- dictated text ---------------------------------------------------------

/**
 * Recover the tail of an utterance as the user actually said it.
 *
 * The rules match against `normalise`d text, which is right for matching and
 * wrong for storing: it lowercases, and it turns every character outside
 * `[a-z0-9%'\s-]` into a space, so `version 3.5 ships Friday` arrives at the rule
 * as `version 3 5 ships friday`. A memory captured from the match is a memory
 * that was quietly damaged on the way in.
 *
 * Rather than trying to map a normalised offset back onto the original — which
 * cannot be done reliably, since one raw character can become one space or none
 * — this searches for the suffix of the original whose normalisation *is* the
 * captured tail, and verifies by re-normalising. That makes the answer correct by
 * construction or absent: when nothing matches, the normalised tail is returned
 * unchanged, which is degraded but never wrong about what was said.
 *
 * Longest suffix first, so a trigger word that survives normalisation (`remember
 * that …`) is never mistaken for content.
 */
function rawTail(original: string, tail: string | undefined): string | null {
  const want = tail?.trim();
  if (!want) return null;

  const tokens = original.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const candidate = tokens.slice(i).join(" ");
    if (normalise(candidate) === want) return trimTail(candidate) || want;
  }
  return want;
}

/**
 * Terminal punctuation and trailing politeness belong to the sentence, not the
 * note. `normalise` already removed both from the matched text, so a suffix that
 * still carries them normalises to the same thing and wins the search above —
 * "remember to call mum please" would otherwise be stored with the "please".
 */
function trimTail(text: string): string {
  return text
    .replace(/[\s,.;:!?]+$/, "")
    .replace(/[\s,]*\b(?:please|thanks|thank you|for me)$/i, "")
    .replace(/[\s,.;:!?]+$/, "")
    .trim();
}

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

// --- project resolution ----------------------------------------------------

/**
 * Confirm a spoken project name is one the registry knows.
 *
 * Same contract as `resolveApp` in the part that matters: `null` means the
 * utterance was project-shaped but named something not in the registry, and
 * that must reach the agent rather than becoming a local failure. A person
 * saying "open the payments project" about a repo Jarvis has not scanned is
 * better served by an agent that can look than by "I don't know that one".
 *
 * Unlike `resolveApp`, this deliberately does **not** return a canonical key.
 * Two projects can legitimately answer to one word, and choosing between them
 * is `findProject`'s job — it already models the three-way outcome, and having
 * a second place decide would mean the matcher picking the first map entry and
 * calling it resolved. So the slot carries what was *said*, and the executor
 * resolves it against the registry it holds.
 */
function resolveProject(raw: string | undefined, ctx: IntentContext): IntentSlots | null {
  const spoken = spokenProject(raw);
  if (!spoken) return null;
  return projectKeysFor(spoken, ctx).length === 0 ? null : { project: spoken, spoken };
}

/** Strip the determiner a person puts in front of a project name. */
function spokenProject(raw: string | undefined): string | null {
  if (!raw) return null;
  const spoken = raw.replace(/^(?:the|my|a)\s+/, "").trim();
  return spoken || null;
}

/**
 * Every project key a spoken name fits.
 *
 * Returns all of them, not the first: the count is the whole point. One is a
 * match, several is a question, none reaches the agent.
 */
function projectKeysFor(spoken: string, ctx: IntentContext): readonly string[] {
  if (!ctx.projects) return [];
  const keys: string[] = [];
  for (const [key, aliases] of ctx.projects) {
    if (key === spoken || aliases.includes(spoken)) keys.push(key);
  }
  return keys;
}

/**
 * "Which jarvis?" — when one spoken name fits several projects.
 *
 * The registry's aliases are generous by design: `jarvis-ui` answers to
 * "jarvis", because a stricter generator leaves projects that cannot be opened
 * by name at all. That generosity is only safe if a collision is *asked* rather
 * than guessed, and this is where the asking is decided. Silently opening the
 * first of three matching directories is the failure being prevented — the user
 * would not notice until they had edited the wrong repository.
 *
 * The question names the candidates, because "which project?" is not answerable
 * without them.
 */
function projectAmbiguity(raw: string | undefined, ctx: IntentContext): IntentAmbiguous | null {
  const spoken = spokenProject(raw);
  if (!spoken) return null;

  const keys = projectKeysFor(spoken, ctx);
  if (keys.length < 2) return null;

  return {
    kind: "ambiguous",
    question: `Which one — ${humanList(keys)}?`,
    candidates: ["project.open"],
    projects: keys,
  };
}

/** "a, b or c" — the candidates as a person would say them aloud. */
function humanList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
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

    // Before the slot, because an ambiguous slot would otherwise resolve to one
    // arbitrary candidate and look like a confident match.
    const ambiguous = rule.ambiguity?.(m, ctx);
    if (ambiguous) return ambiguous;

    let slots: IntentSlots = {};
    if (rule.slots) {
      const resolved = rule.slots(m, ctx);
      // A rule whose slot will not resolve has not matched. Falling through
      // lets a later rule try, and failing that the agent gets the utterance.
      if (resolved === null) continue;
      slots = resolved;
    }

    // After `slots`, and overriding what it produced for `text`: the slot
    // function only ever sees the normalised match, and for dictated content
    // that form is lossy. Same "null means not a match" contract as `slots`.
    if (rule.raw) {
      const said = rule.raw(m, utterance);
      if (said === null) continue;
      slots = { ...slots, text: said };
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
