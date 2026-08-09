/**
 * The LocalIntentEngine: the decision to answer without waking the agent.
 *
 * Two things justify this layer existing at all, and both are about the user
 * rather than the architecture:
 *
 *   1. **Latency.** "What time is it" should be answered before an agent has
 *      finished tokenising it. Nothing here is a language model.
 *   2. **Availability.** Phase 4's gate is that these commands work with
 *      networking off and Hermes not running. So local routing happens *before*
 *      the runtime checks whether the agent is up: an unreachable Hermes must
 *      not stop the volume from changing.
 *
 * The risk this layer carries is the opposite one — stealing an utterance meant
 * for the agent. That is handled in `intent-model.ts` by anchoring every pattern
 * to the whole utterance, and the regression suite there is the real guard. This
 * module only adds the two stateful pieces the pure model cannot hold: the app
 * catalog, and a pending clarification when a command is genuinely ambiguous.
 */
import {
  matchIntent,
  routeUtterance,
  type IntentMatch,
  type LocalIntentId,
} from "./intent-model.js";
import { execute, type ExecOutcome, type ExecutorDeps } from "./executors.js";
import {
  buildCatalog,
  catalogMaps,
  type CatalogEntry,
  type CatalogOptions,
} from "../system/app-catalog.js";

/** What the engine decided, and what came of it. Shape of one audit record. */
export interface LocalDecision {
  utterance: string;
  route: "local" | "ask" | "agent";
  intent?: LocalIntentId;
  /** Present for `local`: what actually happened on the machine. */
  outcome?: ExecOutcome;
  /** Present for `ask`: the question put to the user. */
  question?: string;
  /** Present for `agent`: why nothing local claimed it. */
  reason?: string;
}

/** The machine-facing dependencies, minus the catalog the engine owns. */
export type EngineDeps = Omit<ExecutorDeps, "apps">;

export interface EngineOptions {
  catalog?: CatalogOptions;
  /** Pre-built catalog, for tests and for a cached one loaded from disk. */
  entries?: readonly CatalogEntry[];
  /**
   * Called for every decision, including the ones that go to the agent.
   *
   * Deliberately every decision and not just the actions: "why did it send that
   * to Hermes" is the question worth being able to answer later, and a log that
   * only records successes cannot answer it.
   */
  onAudit?: (d: LocalDecision) => void;
}

/**
 * How long a clarifying question stays open.
 *
 * Matched to the conversation window, because the question is asked out loud
 * and the follow-up arrives through the same window. An answer to a question
 * the user has forgotten they were asked would be worse than asking again.
 */
export const CLARIFY_TIMEOUT_MS = 30_000;

/** Words that settle a mic-versus-speakers question. Nothing else does. */
const MIC_WORDS = /\b(mic|microphone|mike|input|listening|me|ears)\b/;
const SPEAKER_WORDS = /\b(speakers?|volume|sound|audio|output|music|you)\b/;

export class LocalIntentEngine {
  private readonly entries: readonly CatalogEntry[];
  private readonly aliases: ReadonlyMap<string, readonly string[]>;
  private readonly apps: ExecutorDeps["apps"];
  private pending: { candidates: readonly LocalIntentId[]; at: number } | null = null;

  constructor(
    private readonly deps: EngineDeps,
    private readonly options: EngineOptions = {},
  ) {
    this.entries = options.entries ?? buildCatalog(options.catalog);
    const maps = catalogMaps(this.entries);
    this.aliases = maps.aliases;
    this.apps = maps.apps;
  }

  /** The apps this machine can be told to open, for the UI and for diagnostics. */
  get catalog(): readonly CatalogEntry[] {
    return this.entries;
  }

  /** True while a clarifying question is outstanding. */
  get awaitingAnswer(): boolean {
    return this.pending !== null && !this.expired();
  }

  private expired(): boolean {
    if (!this.pending) return true;
    return this.deps.now().getTime() - this.pending.at >= CLARIFY_TIMEOUT_MS;
  }

  /**
   * Decide, and act if the decision is local.
   *
   * Returns the decision so the caller can speak the outcome, ask the question,
   * or hand the utterance to Hermes. The engine never speaks; the runtime owns
   * the microphone and the speaker and should keep owning them.
   */
  async handle(utterance: string): Promise<LocalDecision> {
    const answered = await this.resolvePending(utterance);
    if (answered) return this.audit(answered);

    const routed = routeUtterance(utterance, { apps: this.aliases });

    if (routed.route === "agent") {
      return this.audit({ utterance, route: "agent", reason: routed.reason });
    }

    if (routed.route === "ask") {
      const result = matchCandidates(utterance, this.aliases);
      this.pending = { candidates: result, at: this.deps.now().getTime() };
      return this.audit({ utterance, route: "ask", question: routed.question });
    }

    return this.audit(await this.run(utterance, routed.match));
  }

  /**
   * Treat this utterance as the answer to an outstanding question, if it is one.
   *
   * An answer that names neither side is not an answer: the question is dropped
   * and the utterance is routed from scratch. The user has moved on, and
   * insisting on a reply to a question they abandoned would be worse than
   * letting the new request through.
   */
  private async resolvePending(utterance: string): Promise<LocalDecision | null> {
    if (!this.pending) return null;
    if (this.expired()) {
      this.pending = null;
      return null;
    }
    const { candidates } = this.pending;
    const text = utterance.toLowerCase();

    const mic = MIC_WORDS.test(text);
    const speaker = SPEAKER_WORDS.test(text);
    // Both, or neither, is not a decision. Fall through rather than pick one.
    if (mic === speaker) {
      this.pending = null;
      return null;
    }

    const id = candidates.find((c) => (mic ? c.startsWith("mic.") : c.startsWith("volume.")));
    this.pending = null;
    if (!id) return null;

    return this.run(utterance, { kind: "match", id, confidence: 1, slots: {} });
  }

  private async run(utterance: string, match: IntentMatch): Promise<LocalDecision> {
    const outcome = await execute(match, { ...this.deps, apps: this.apps });
    return { utterance, route: "local", intent: match.id, outcome };
  }

  /**
   * Record the decision, then return it unchanged.
   *
   * The utterance is recorded as spoken. It is untrusted text (§52) and is
   * never interpreted here — but redacting it would make the log useless for
   * the one thing it exists for, which is explaining what Jarvis did and why.
   */
  private audit(d: LocalDecision): LocalDecision {
    this.options.onAudit?.(d);
    return d;
  }

  /** Drop any outstanding question, e.g. on barge-in or cancel. */
  reset(): void {
    this.pending = null;
  }
}

/**
 * The candidate ids behind an ambiguous match.
 *
 * `routeUtterance` collapses ambiguity to a question, which is the right shape
 * for the runtime but loses what the options were. Rather than widening that
 * return type for one caller, the engine re-asks the matcher — the utterance is
 * short and the matcher is pure, so this costs nothing measurable.
 */
function matchCandidates(
  utterance: string,
  apps: ReadonlyMap<string, readonly string[]>,
): readonly LocalIntentId[] {
  const r = matchIntent(utterance, { apps });
  return r.kind === "ambiguous" ? r.candidates : [];
}
