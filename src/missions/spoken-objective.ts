/**
 * Hearing a mission in something that was said — and, far more often, not hearing one.
 *
 * A mission is the largest thing a sentence can start in this system: a loop that
 * outlives the utterance, picks its own tools, and asks for consent on the dangerous
 * ones. A microphone is the least trustworthy way to start one, because what reaches
 * `onUtterance` is whatever was audible near the machine (§52). So this file is written
 * to be hard to trigger rather than easy:
 *
 *  - **Fixed phrases, anchored.** A mission is started by saying so — "start a mission
 *    to…", "new objective…", "fix this". There is no scoring, no model, and no branch
 *    that reads intent out of an arbitrary sentence, because a heuristic that turned
 *    ordinary speech into objectives would eventually turn a television into one.
 *  - **A request is not a start.** Nothing here runs anything. `readMissionRequest`
 *    returns a *request*, and the runtime speaks it back and waits for a confirmation
 *    it can quote. §"DO NOT allow unrestricted autonomous actions" is the reason: the
 *    wake word plus a fixed phrase is two gates, and an autonomous loop deserves three.
 *  - **Matching happens on the normalised text, and the objective comes from there
 *    too.** That is a deliberate loss. `normalise` keeps only `[a-z0-9%'\s-]`, so an
 *    objective from this path cannot contain a colon, a newline, a brace or a backtick
 *    before it is embedded in a planner prompt as data. Hyphens do survive that filter,
 *    so `defuseMarkers` runs over what was captured as well — between them, none of the
 *    shapes prompt injection needs is left. Punctuation in dictated speech is worth less
 *    than that, and this path takes typed text too, which has been through neither.
 *
 * The two kinds are not symmetrical, which is why they are a union rather than a flag.
 * A spoken objective already contains its own outcome. A vision request does not: "fix
 * this" names no outcome at all until something has looked at the screen, so it carries
 * the question asked and nothing more, and `vision-objective.ts` is what turns it into
 * a proposal a user can read before agreeing to it.
 */
import { normalise } from "../local-intents/intent-model.js";
import { defuseMarkers } from "../permissions/risk-model.js";

/** A spoken objective: the outcome is in the words. */
export interface SpokenObjectiveRequest {
  readonly kind: "objective";
  /** The outcome, normalised and capped. Untrusted text, and treated as data. */
  readonly objective: string;
  /** Which trigger matched, for the log line. Never shown as a justification. */
  readonly trigger: string;
}

/** A request about whatever is on screen: no objective yet, only a question. */
export interface SpokenVisionRequest {
  readonly kind: "vision";
  /** What was asked, after normalising. Becomes data in a prompt, never an instruction. */
  readonly ask: string;
  readonly trigger: string;
}

export type SpokenMissionRequest = SpokenObjectiveRequest | SpokenVisionRequest;

/**
 * How long a spoken offer stands, in milliseconds.
 *
 * The same 30 seconds `CLARIFY_TIMEOUT_MS` gives a spoken clarification, and the same
 * reason: it is about as long as a person will hold a question in their head before the
 * answer stops being an answer. An offer that outlived that would let a "yes" meant for
 * something else start a mission the user had forgotten they were asked about.
 */
export const MISSION_OFFER_TIMEOUT_MS = 30_000;

/**
 * The longest objective this will accept, in characters.
 *
 * Not a safety limit — the planner and the store have their own — but a limit on how
 * much of a run-on sentence becomes a mission title that then appears in a report, a
 * notification and a history row. Anything longer is far more likely to be a
 * transcription that ran on than an objective somebody meant.
 */
export const MAX_SPOKEN_OBJECTIVE = 240;

/** The shortest one. A few words of outcome is the floor; "do it" is not an objective. */
export const MIN_SPOKEN_OBJECTIVE = 8;

/**
 * The phrases that ask for a mission with its own objective.
 *
 * Each captures the outcome and nothing else. The verbs are deliberately narrow: this
 * is not a list of ways to ask Jarvis for something, it is a list of ways to say the
 * word *mission* or *objective*, which is what makes the gesture explicit enough to be
 * a first gate.
 */
const OBJECTIVE_TRIGGERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["start a mission", /^(?:start|run|begin|kick off) (?:a |the )?mission (?:to |that |for )?(.+)$/],
  ["new mission", /^new mission (?:to |that |for )?(.+)$/],
  ["objective", /^(?:new |your |the )?objective(?: is)? (.+)$/],
  ["take on the objective", /^take on (?:the )?objective (.+)$/],
];

/**
 * The nouns a vision trigger may carry after "this".
 *
 * Enumerated rather than open. "Fix this error" is about the screen; "fix this file in
 * the editor" names something else entirely, and letting a trailing wildcard swallow it
 * would photograph the desktop to answer a question about a path.
 */
const VISION_NOUNS = "error|problem|issue|bug|failure|test|build|crash|warning|mess|thing";

/**
 * The phrases that ask about what is on screen.
 *
 * Every one is an imperative to *change* something, which is the line between this and
 * the `screen.read` local intent. "Look at this and tell me what is wrong" is a read and
 * belongs there: it wants a sentence back, it costs one capture, and it finishes in a
 * turn. "Fix this" wants the world different afterwards, which is a mission — and
 * routing it to a description would answer a question nobody asked.
 */
const VISION_TRIGGERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["fix this", new RegExp(`^fix (?:this|that)(?: (?:${VISION_NOUNS}))?$`)],
  ["sort this out", /^(?:sort out|sort|deal with|handle) (?:this|that)(?: out)?$/],
  ["debug this", /^(?:debug|diagnose|investigate) (?:this|that)$/],
  ["make this work", /^make (?:this|that) work$/],
  ["fix what is on screen", /^fix (?:what(?:'s| is) on|whatever(?:'s| is) on) (?:the |my )?screen$/],
];

/**
 * Read a mission request out of an utterance, or return null.
 *
 * Null is the overwhelmingly common answer and the important one: everything that is
 * not one of these phrases carries on to the local intents and the agent exactly as it
 * did before this file existed.
 */
export function readMissionRequest(text: string): SpokenMissionRequest | null {
  const said = normalise(text);
  if (said === "") return null;

  for (const [trigger, re] of VISION_TRIGGERS) {
    if (re.test(said)) return { kind: "vision", ask: said, trigger };
  }

  for (const [trigger, re] of OBJECTIVE_TRIGGERS) {
    const match = re.exec(said);
    const captured = match?.[1]?.trim();
    if (captured === undefined || captured === "") continue;
    // Length is checked after the trigger matched, so "start a mission to go" is
    // refused rather than falling through to the agent as an ordinary question. Null
    // there is the honest answer: it was a mission request, and it did not say what
    // the mission was — which is what `NOTHING_TO_DO` is for.
    if (captured.length < MIN_SPOKEN_OBJECTIVE) return null;
    return {
      kind: "objective",
      // Capped, then defused: `normalise` keeps hyphens, so `---` is the one fence
      // shape that reaches here — and an accepted objective is written into
      // `llm-replanner`'s fenced prompt as data.
      objective: defuseMarkers(captured.slice(0, MAX_SPOKEN_OBJECTIVE)).trim(),
      trigger,
    };
  }

  return null;
}

/**
 * True when an utterance asked for a mission but named none.
 *
 * Separate from `readMissionRequest` because the two answers are different: that
 * function returning null means "carry on as before", and a runtime that could not tell
 * the two apart would send "start a mission to go" to the agent as a question.
 */
export function isEmptyMissionRequest(text: string): boolean {
  const said = normalise(text);
  if (said === "") return false;
  if (readMissionRequest(text) !== null) return false;
  return OBJECTIVE_TRIGGERS.some(([, re]) => re.test(said));
}

/** Every way of saying yes that this will accept. Whole utterance, not a substring. */
const YES = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "do it", "go ahead",
  "go for it", "start it", "run it", "confirm", "confirmed", "yes do it",
]);

/** And no. `no thanks` and `please don't` arrive here already trimmed by `normalise`. */
const NO = new Set([
  "no", "nope", "nah", "cancel", "stop", "don't", "dont", "do not", "forget it",
  "never mind", "nevermind", "not now", "leave it", "no don't",
]);

/**
 * Read a yes or a no, and nothing else.
 *
 * Exact matches on the whole normalised utterance, because a substring test is how "no,
 * do the other one instead" becomes a refusal of the wrong thing. Null means the user
 * said something that is not an answer — and the caller drops the offer and routes the
 * utterance from scratch, which is the rule `resolvePending` already follows for a
 * spoken clarification: insisting on a reply to a question somebody has moved on from
 * is worse than letting their new request through.
 */
export function readConfirmation(text: string): "yes" | "no" | null {
  const said = normalise(text);
  if (YES.has(said)) return "yes";
  if (NO.has(said)) return "no";
  return null;
}

/**
 * What Jarvis says to offer a heard objective back.
 *
 * Built here rather than at the call site so the sentence is testable and so it always
 * contains the objective *as understood*. That is the whole point of speaking it back:
 * a transcription error is invisible to someone who asked by voice and is not looking
 * at the screen, and "start a mission to delete my drafts" misheard is a mission the
 * user is entitled to hear before it runs.
 */
export function offerSentence(objective: string): string {
  return `I heard an objective: ${objective}. Should I start it?`;
}

/** Said when the offer has gone stale, rather than starting a stale mission. */
export const OFFER_EXPIRED =
  "That offer has expired. Say the objective again if you still want it.";

/** Said when a heard mission request named no mission. */
export const NOTHING_TO_DO = "I heard a mission request but not what the mission was.";

/** Said when an offer is declined, so a refusal is audibly acknowledged. */
export const OFFER_DECLINED = "Fine. I have not started it.";
