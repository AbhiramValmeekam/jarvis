/**
 * Presentation rules for a proposal read off the screen.
 *
 * Separate from React for the reason `world-model` is: what a page may claim about a
 * screenshot is a security property, and a security property is worth testing without
 * a DOM. Three rules carry the weight here.
 *
 * **A proposal is never drawn as a decision.** The card says what it would take on and
 * offers a button; nothing in this file returns anything a page could mistake for a
 * mission that exists. The button's own label is "Start it", present tense and in the
 * user's hands, because the model that proposed this read the objective off pixels
 * nobody in this process could sanitise (§52).
 *
 * **What it saw is shown beside what it proposes, always.** `observed` is not a caption
 * and not a tooltip: it is the only way a person can tell "make the portfolio-site build
 * pass" proposed from a terminal apart from the same words proposed from a chat window
 * about last week's build. A card that dropped it to fit would be asking to be trusted.
 *
 * **A refusal is an answer, and it is shown as one.** "There was nothing on the screen
 * worth doing", "you denied the capture" and "there is no vision model" are three
 * different facts, and a page that showed an empty space for all three would make a
 * button that works indistinguishable from one that does nothing (§4).
 *
 * Nothing here is invented. There is no confidence, no ranking, and no "probably" — the
 * runtime sends one proposal or one refusal, and this arranges it.
 */
import { sanitiseForDisplay } from "../permissions/risk-model";
import type { ServerEvent, VisionProposalView } from "../ipc/contract";

const MAX_TEXT = 300;

/** What the page holds about the last look at the screen. */
export interface VisionScreen {
  /** The proposal or refusal on screen, or null when nothing has been asked. */
  answer: VisionProposalView | null;
  /** True from the click until an answer arrives. A capture waits on a human. */
  looking: boolean;
  /** A bridge failure, which is not the same thing as a refusal. */
  error: string | null;
}

export const emptyVision: VisionScreen = { answer: null, looking: false, error: null };

/**
 * Fold one runtime event into the screen.
 *
 * The event is what makes a spoken "fix this" visible: the voice path's whole offer is
 * a sentence Piper reads once, and an objective derived from a screenshot is exactly
 * the kind of thing somebody should be able to read before agreeing to it. It replaces
 * whatever was on screen rather than queueing — one screen, one latest look, and an
 * older proposal about a window that has since changed is worse than nothing.
 *
 * `looking` is cleared by any answer, including one this page did not ask for. A window
 * that asked and a voice that asked cannot both be waiting: the runtime spends one
 * capture at a time and refuses a second while a mission runs.
 */
export function applyVisionEvent(screen: VisionScreen, e: ServerEvent): VisionScreen {
  if (e.type !== "vision_proposal") return screen;
  return { answer: e.proposal, looking: false, error: null };
}

/** The click has gone to the runtime: a capture, a consent prompt, then a model. */
export function visionLooking(): VisionScreen {
  return { answer: null, looking: true, error: null };
}

/**
 * An answer came back from the request.
 *
 * Usually identical to what `applyVisionEvent` already stored — the runtime pushes to
 * every client including the one that asked — and storing it twice is harmless because
 * this is a replacement rather than a list.
 */
export function visionAnswered(answer: VisionProposalView): VisionScreen {
  return { answer, looking: false, error: null };
}

/**
 * The ask itself failed: a broken pipe, or a mission already running.
 *
 * Kept apart from a refusal, and shown differently. "I looked and there is nothing to
 * do" is Jarvis answering; this is Jarvis not having been reached, and a page that
 * merged the two would report an unanswered question as an answer.
 */
export function visionFailed(error: string): VisionScreen {
  return { answer: null, looking: false, error: sanitiseForDisplay(error, MAX_TEXT) };
}

/** Clear the card. Declining a proposal is dropping it; nothing is recorded. */
export function dismissVision(): VisionScreen {
  return emptyVision;
}

/** How the card reads. `objective` is present only when there is one to start. */
export interface VisionCard {
  tone: "proposal" | "refusal" | "problem" | "looking";
  /** The heading. Always a claim about what Jarvis did, never about what is true. */
  title: string;
  /** The body: the question being asked, or the refusal Jarvis gave. */
  body: string;
  /** What it saw, when there is a proposal. Shown beside the objective, not instead. */
  observed?: string;
  /** The exact string a Start button sends as `start_mission`. Absent otherwise. */
  objective?: string;
  /** One line of provenance: which model, how long, how large the picture was. */
  cost?: string;
  /** Whether a Start button belongs on this card at all. */
  startable: boolean;
}

/**
 * Arrange the last look into a card, or return null when there is nothing to show.
 *
 * The `startable` flag is computed here rather than in the page for the reason
 * `canStart` already is: "may this button exist" is a rule, and a rule in a component
 * is a rule that is not tested. It is false for every refusal, false while looking, and
 * false when a mission is already running — the runtime refuses that too, and a button
 * that produced an error instead of not being offered is a worse way to say so.
 */
export function visionCard(
  screen: VisionScreen,
  facts: { readonly connected: boolean; readonly busy: boolean },
): VisionCard | null {
  if (screen.error !== null) {
    return { tone: "problem", title: "Jarvis could not look", body: screen.error, startable: false };
  }
  if (screen.looking) {
    return {
      tone: "looking",
      title: "Looking at your screen",
      // Said plainly because the wait has a cause the user can act on: the capture is
      // behind a consent prompt, and a spinner with no explanation is how a dialog
      // waiting off-screen turns into a page that looks stuck.
      body: "Waiting for the screenshot to be allowed, then asking the model what it sees.",
      startable: false,
    };
  }
  const answer = screen.answer;
  if (answer === null) return null;
  if (answer.kind === "refused") {
    return {
      tone: "refusal",
      title: "Nothing proposed",
      body: sanitiseForDisplay(answer.speech, MAX_TEXT),
      startable: false,
    };
  }
  return {
    tone: "proposal",
    title:
      answer.source === "voice"
        ? "You asked out loud, and Jarvis looked"
        : "Jarvis looked at your screen",
    // The tense the spoken sentence uses, for the same reason: nothing has started, and
    // the next thing that happens is the user's click.
    body: "This is a proposal. Nothing has started.",
    observed: sanitiseForDisplay(answer.observed, MAX_TEXT),
    objective: sanitiseForDisplay(answer.objective, MAX_TEXT),
    cost: costLine(answer),
    startable: facts.connected && !facts.busy,
  };
}

/**
 * One line of provenance under a proposal.
 *
 * Which model, how long it took, and how large the picture was — the three facts that
 * say this came from a real call to something that could see, rather than from a rule
 * in this repository that guessed. §43 is why it is on the card and not only in a log:
 * a proposal is the one place autonomy would be easiest to fake convincingly.
 */
function costLine(answer: Extract<VisionProposalView, { kind: "proposed" }>): string {
  const kb = Math.max(1, Math.round(answer.bytes / 1024));
  return `${sanitiseForDisplay(answer.model, 60)} · ${answer.ms} ms · ${kb} KB of screenshot sent`;
}
