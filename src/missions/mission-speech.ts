/**
 * A mission, said out loud.
 *
 * A voice-started mission has a problem a typed one does not: the person who
 * started it is not looking at the window. They said a sentence, walked off, and
 * the only account they will get is whatever Piper synthesises a minute later. So
 * this file is the narrowest possible bridge — it turns a `MissionReport`, which
 * is already composed entirely from recorded facts, into two or three sentences —
 * and it is built on three rules:
 *
 *  - **Nothing new is claimed.** Every sentence comes from a field of the report.
 *    There is no branch here that reads a step's result and characterises it, and
 *    no sentence that a report could not already print. The one thing this file
 *    decides is what is short enough to say.
 *  - **The headline is reused, not rewritten.** `buildReport` already composed the
 *    one-line verdict the window shows, so the voice says the same words. A second
 *    phrasing of one outcome would let a listener and a reader come away with
 *    different accounts of the same mission — the failure `ui-trace-model` guards
 *    against between two panes, here between two senses.
 *  - **The caveats are not optional.** Unverified steps and simulated capabilities
 *    are said even when the budget is tight, and the optional sentences are the
 *    ones that get dropped. A spoken report that fitted by omitting "nothing
 *    confirmed this" would be the §43 failure with the volume turned up: the
 *    listener has no screen to check it against.
 *
 * Every sentence leaves through `forSpeech`, which redacts and then rewrites for a
 * synthesiser. A report's details come from tool output — a step's recorded error
 * can carry a path, a backtick and, once in a while, a credential — and the order
 * those two passes run in is load-bearing rather than stylistic.
 */
import { redactSecrets } from "../context/window-facts.js";
import { speakable } from "../voice/speakable.js";
import type { MissionReport } from "./mission-report.js";

/**
 * How long a spoken report may be, in characters.
 *
 * Well under `speakable`'s own 1,000-character ceiling, because that limit exists
 * to stop a monologue and this one exists to keep a report *listenable*: about
 * fifteen seconds of Piper. Past that a listener stops tracking sentences, and the
 * screen is where the full report lives anyway.
 */
export const MAX_SPOKEN_REPORT = 420;

/**
 * The longest objective that gets repeated back in the report.
 *
 * Beyond this the objective is referred to rather than recited. Reciting sixty
 * words of dictated run-on sentence before saying whether it worked buries the
 * one fact the listener is waiting for, and truncating an objective mid-clause
 * aloud sounds like the process died.
 */
export const MAX_SPOKEN_ECHO = 90;

/** Said the moment an offer is accepted, so a mission never starts in silence. */
export const MISSION_STARTED = "Starting on it. I will tell you when it is done.";

/** Said when the mission layer would not take the objective at all. */
export const MISSION_NOT_STARTED = "I could not start that mission.";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One sentence naming the objective, or a reference to it.
 *
 * Exported for the tests rather than for callers: which of the two branches a
 * given objective takes is the sort of thing that changes silently when a limit
 * moves.
 */
export function echoObjective(objective: string): string {
  const said = objective.trim();
  if (said === "") return "The objective you gave me";
  return said.length <= MAX_SPOKEN_ECHO ? `Objective: ${said}` : "The objective you gave me";
}

/**
 * The last thing done to every sentence: redact, then rewrite for a synthesiser.
 *
 * In that order, and this is where the repository's order stops being a convention
 * and becomes load-bearing. A report's details come from tool output —
 * `nextActionFor` quotes a failed step's own recorded error, so a build that printed
 * a deploy key put it in `nextAction` — and `speakable` strips underscores and
 * asterisks on the way to espeak. It leaves `AWS_SECRET_ACCESS_KEY=` as
 * `AWSSECRETACCESSKEY=` and `ghp_1234…` as `ghp1234…`, so a redaction pass placed
 * *after* it would be looking for labels and prefixes that no longer exist.
 *
 * That this is needed at all is the part worth recording. `mission-view.ts` redacts
 * the same material on its way to the renderer, and the voice is a second surface
 * for it that is easy to miss because nothing is drawn: the text goes to the Piper
 * daemon over a pipe and is synthesised to a file on disk.
 */
function forSpeech(text: string): string {
  return speakable(redactSecrets(text).text);
}

/**
 * A spoken account of a mission, from its report.
 *
 * The sentences are assembled in the order a listener needs them — what happened,
 * then what to distrust about it, then whose turn it is — and the ones marked
 * required survive the length budget. `forSpeech` runs over the finished text
 * rather than over each fragment, so the punctuation this function creates is
 * tidied once, by the module that knows what espeak does with it.
 *
 * The say() helper in the runtime applies the same function before synthesis, which is
 * harmless — a second pass over text that has already been rewritten has nothing
 * left to rewrite — and doing it here as well is what makes the returned string
 * the exact text a test can assert on.
 */
export function spokenReport(report: MissionReport): string {
  const parts: Array<{ readonly text: string; readonly required: boolean }> = [];

  // What happened: the report's own headline, so the voice cannot describe the
  // outcome differently from the window that is showing it.
  parts.push({ text: `${echoObjective(report.objective)}. ${report.headline}.`, required: true });

  // What to distrust. Both of these are counted facts, and both are the kind of
  // fact a listener cannot discover for themselves.
  if (report.counts.unverified > 0) {
    parts.push({
      text: `${plural(report.counts.unverified, "step", "steps")} ran without anything confirming ${report.counts.unverified === 1 ? "it" : "them"}.`,
      required: true,
    });
  }
  if (report.counts.simulated > 0) {
    parts.push({
      text: `${plural(report.counts.simulated, "step", "steps")} used a mocked capability, so that part is a demonstration rather than a result.`,
      required: true,
    });
  }

  // What went well the hard way. Optional: a recovery is good news, and good news
  // is what a short report can afford to lose.
  if (report.recovered.length > 0) {
    parts.push({
      text: `${plural(report.recovered.length, "step", "steps")} only worked after a retry.`,
      required: false,
    });
  }

  // Whose turn it is. Optional in the same sense — it is on screen — but placed
  // last so that when it does fit, it is the sentence the listener is left with.
  if (report.nextAction !== undefined && report.nextAction.trim() !== "") {
    parts.push({ text: `Next, ${report.nextAction}.`, required: false });
  }

  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    // Required parts are added whatever the budget says; the budget's job is to
    // decide which *optional* sentence is the one too many.
    if (!part.required && used + part.text.length + 1 > MAX_SPOKEN_REPORT) continue;
    kept.push(part.text);
    used += part.text.length + 1;
  }

  return forSpeech(kept.join(" "));
}

/**
 * A sentence for a mission that has not finished, when someone asks about it.
 *
 * Deliberately not the report: a mission mid-flight has counts but no verdict, and
 * `buildReport`'s headline for a running mission ("Running — 1 of 4 steps verified
 * so far") is written for a pane that refreshes, not for a sentence someone hears
 * once. This says the state and the tally and stops.
 */
export function spokenProgress(report: MissionReport): string {
  const tally =
    report.counts.total === 0
      ? "it has no steps yet"
      : `${report.counts.done} of ${report.counts.total} steps are verified`;
  const waiting =
    report.counts.awaitingApproval > 0
      ? ` ${plural(report.counts.awaitingApproval, "step is", "steps are")} waiting for you to allow ${report.counts.awaitingApproval === 1 ? "it" : "them"}.`
      : "";
  return forSpeech(`${echoObjective(report.objective)}. Still running: ${tally}.${waiting}`);
}
