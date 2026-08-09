/**
 * What "it" refers to.
 *
 * A person who has just asked what window is in front says "close it", not
 * "close Chrome". Someone who has just heard a list of projects says "open the
 * second one". Neither utterance carries its own subject, and without somewhere
 * to look both are unanswerable — which is why an assistant with no short-term
 * memory feels like a command line with a microphone attached.
 *
 * This is that somewhere. Three properties matter more than the feature:
 *
 *   1. **Nothing spoken is stored.** A turn records the decision and the
 *      canonical subject — a registry key, a catalog key, a process name. It
 *      never records the transcript. Utterances are audio from the room (§52)
 *      and may contain a colleague's conversation or a passing television; a
 *      rolling buffer of them is a recording, and this project does not make
 *      recordings (§50).
 *   2. **Referents expire.** "Open it" thirty seconds after hearing about a
 *      project is a follow-up. Ten minutes later it is a different sentence
 *      about a different thing, and resolving it against a stale subject would
 *      act on something the user has stopped thinking about. Expiry is the
 *      feature, not a limitation of it.
 *   3. **A referent is a key, not a phrase.** What gets remembered is what the
 *      registry called the project, not what the user called it. The spoken form
 *      is kept only to say the name back, and is never used to look anything up
 *      or to build a path.
 *
 * Pure: no I/O, no timers, no clock of its own. The caller passes `now`, the
 * same way the rest of the runtime does, so the expiry rules above are testable
 * rather than merely asserted.
 */

/** Where a turn went. Mirrors `LocalDecision.route`. */
export type TurnRoute = "local" | "ask" | "agent";

/**
 * The subject of a turn, in a form that can be acted on later.
 *
 * `key` is canonical and comes from a registry or catalog — never from the
 * utterance. That is what makes a referent safe to act on when it resurfaces as
 * "it": resolving a pronoun cannot introduce a path or an argument that was not
 * already trusted when it was first recorded.
 */
export interface Referent {
  kind: "project" | "app" | "window";
  key: string;
  /** How to name it out loud. Display only; never used to look anything up. */
  label: string;
}

/** One completed turn, reduced to what a follow-up might need. */
export interface Turn {
  at: number;
  route: TurnRoute;
  /** The local intent id, when one claimed the turn. */
  intent?: string;
  /** What the turn was about, when it was about something nameable. */
  referent?: Referent;
}

export interface ContextOptions {
  /**
   * How long a referent stays resolvable.
   *
   * Defaults to the conversation window, because that is the span in which the
   * user is still in the same exchange. A referent that outlived the window
   * would let "open it" reach back past a silence the user experienced as the
   * end of the conversation.
   */
  ttlMs?: number;
  /**
   * How many turns to keep.
   *
   * Small on purpose. This is short-term memory for pronoun resolution, not a
   * history feature; anything that wants a transcript should be a deliberate,
   * user-visible decision elsewhere rather than a side effect of this buffer.
   */
  limit?: number;
}

/** Matches the state machine's conversation window (30 s). */
export const REFERENT_TTL_MS = 30_000;

const DEFAULT_LIMIT = 8;

/** Words that stand in for a subject instead of naming one. */
const PRONOUN =
  /\b(it|that|this|them|those|these|the same|there|the one)\b/;

/**
 * Utterances that are asking about the subject rather than acting on it.
 *
 * Kept separate because the two need different answers: "what is it" should
 * describe the referent, while "close it" should act on it. Conflating them
 * produces an assistant that answers questions by doing things.
 */
const REFERENTIAL_QUESTION = /^(?:what|which|where|who)\b/;

/**
 * Recent turns, and the subject they leave behind.
 *
 * Deliberately not merged into `LocalIntentEngine`. The engine's `pending` is a
 * question it is waiting on — a one-shot with a hard timeout — while this is a
 * subject that persists across several turns and outlives any single one of
 * them. They expire on similar timers for similar reasons, but conflating a
 * question with a topic would mean answering the wrong one.
 */
export class ConversationContext {
  private readonly turns: Turn[] = [];
  private readonly ttlMs: number;
  private readonly limit: number;

  constructor(options: ContextOptions = {}) {
    this.ttlMs = options.ttlMs ?? REFERENT_TTL_MS;
    this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  }

  /** Record a completed turn. */
  record(turn: Turn): void {
    this.turns.push(turn);
    if (this.turns.length > this.limit) this.turns.shift();
  }

  /** The turns still held, oldest first. For diagnostics and the HUD. */
  get history(): readonly Turn[] {
    return this.turns;
  }

  /**
   * The subject still in play, if there is one.
   *
   * Searches backwards, because the most recent nameable thing is what a pronoun
   * means. A turn with no referent — "what time is it" — does not clear the
   * subject: asking the time in the middle of talking about a project does not
   * change what "it" refers to.
   */
  referent(now: number): Referent | null {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i];
      if (!turn?.referent) continue;
      return now - turn.at < this.ttlMs ? turn.referent : null;
    }
    return null;
  }

  /** Drop everything, e.g. on barge-in, cancel, or a session ending. */
  reset(): void {
    this.turns.length = 0;
  }
}

/**
 * Does this utterance lean on a subject it does not name?
 *
 * Detection only — resolution is the caller's, because only the caller knows
 * whether the referent it holds can satisfy the verb. A bare pronoun with no
 * live subject must reach the agent rather than being guessed at, which is the
 * same rule the local matcher follows for an unresolvable app name.
 */
export function usesReferent(utterance: string): boolean {
  return PRONOUN.test(utterance.toLowerCase());
}

/** Is a referential utterance a question about the subject, or an action on it? */
export function isReferentialQuestion(utterance: string): boolean {
  return REFERENTIAL_QUESTION.test(utterance.toLowerCase().trim());
}

/** How to name a referent out loud. */
export function describeReferent(r: Referent): string {
  return `${r.label} (${r.kind})`;
}
