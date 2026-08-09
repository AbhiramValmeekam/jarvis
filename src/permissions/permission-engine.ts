/**
 * Deciding whether an action happens, and remembering that it did.
 *
 * `risk-model.ts` says how dangerous something is; this file says what to do
 * about it. The split matters because the policy is the part a user might
 * reasonably want to change, and the classification is the part they should not
 * have to.
 *
 * The rules:
 *
 * - **Forbidden is not askable.** A classification with `forbidden: true` is
 *   denied here and no consent, stored grant, or configuration can reach it
 *   (§61). Everything else is a question.
 * - **Consent is scoped, and scope is checked against the *new* action.** A
 *   grant remembers the tool and the risk level it was given for. "Always allow
 *   writing files" does not become "always allow deleting them", and it does
 *   not carry into a higher level than the one the user actually saw.
 * - **No answer is not a yes.** A prompt that times out denies. The user may be
 *   away from the machine — this is an always-on assistant — and silence must
 *   never be the thing that authorises a level 3 action.
 * - **Everything is logged.** Allowed, denied, expired, forbidden. The audit
 *   log is the only place a user can reconstruct what Jarvis did while they were
 *   not watching, so an unlogged action is worse than a denied one.
 */
import {
  classify,
  describe as describeAction,
  sanitiseForDisplay,
  type ActionDescriptor,
  type Classification,
  type RiskLevel,
} from "./risk-model.js";
import type { ActionOutcome } from "./verified-action.js";

export type Verdict = "allow" | "deny";

/** What the user chose, in the UI's vocabulary. */
export type ConsentChoice = "allow_once" | "allow_always" | "deny" | "deny_always";

export interface PolicyDecision {
  verdict: Verdict;
  classification: Classification;
  /** Why, in a sentence suitable for both the log and the user. */
  reason: string;
  /** True when the decision came from a stored grant rather than a fresh ask. */
  fromGrant: boolean;
}

export interface AuditEntry {
  at: number;
  tool: string;
  level: RiskLevel;
  category: string;
  verdict: Verdict;
  reason: string;
  /**
   * What became of the action, once it has run and been *checked*.
   *
   * `ActionOutcome`, not a local three-way of its own: this used to be
   * `"ok" | "failed" | "not-run"`, which has no way to say "the tool reported no
   * error and nothing changed" — the exact case `runVerified` exists to name.
   * Anything that collapses `unconfirmed` into `ok` re-tells the lie described
   * at the top of `verified-action.ts`.
   *
   * Absent on most entries, and absent is not success. Jarvis decides whether
   * Hermes may run a tool; Hermes runs it. Only actions Jarvis performs itself,
   * through `runVerified`, can be reported on here.
   */
  outcome?: ActionOutcome;
}

/**
 * Highest level that runs without asking.
 *
 * Level 1 by default: reads and reversible file edits proceed, anything that
 * moves, deletes, executes, or leaves the machine asks. Deliberately not
 * user-facing yet — Phase 5 ships the mechanism, and a settings surface for it
 * is a Phase 11 concern.
 */
export const DEFAULT_AUTO_ALLOW: RiskLevel = 1;

/**
 * Levels that no stored grant can cover.
 *
 * "Allow always" is a real convenience for level 2, and a trap at level 4:
 * nobody remembers granting it, and the actions it covers are the ones that
 * change the machine permanently. Level 4 therefore asks every single time.
 */
export const NO_ALWAYS_ABOVE: RiskLevel = 3;

export interface Grant {
  tool: string;
  level: RiskLevel;
  /** Absolute ms. Grants expire so a one-off session cannot authorise forever. */
  expiresAt: number;
  deny: boolean;
}

export interface AskContext {
  requestId: string;
  title: string;
  detail: string;
  options: readonly ConsentChoice[];
  classification: Classification;
}

export interface EngineOptions {
  autoAllowUpTo?: RiskLevel;
  /** How long "always" lasts. A day by default, not forever. */
  grantTtlMs?: number;
  /** How long to wait for an answer before denying. */
  askTimeoutMs?: number;
  now?: () => number;
  /**
   * Put the question to the user. Resolves with their choice, or `null` if the
   * UI cannot ask right now — which is treated as a denial, never as consent.
   */
  ask?: (ctx: AskContext) => Promise<ConsentChoice | null>;
  onAudit?: (entry: AuditEntry) => void;
}

export const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ASK_TIMEOUT_MS = 120_000;

export class PermissionEngine {
  private readonly grants = new Map<string, Grant>();
  private readonly log: AuditEntry[] = [];
  private readonly now: () => number;
  private readonly autoAllowUpTo: RiskLevel;
  private readonly grantTtlMs: number;
  private readonly askTimeoutMs: number;
  private counter = 0;

  constructor(private readonly options: EngineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.autoAllowUpTo = options.autoAllowUpTo ?? DEFAULT_AUTO_ALLOW;
    this.grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  }

  /**
   * The one entry point. Classifies, applies policy, asks if needed, and records
   * the result before returning it.
   */
  async evaluate(action: ActionDescriptor): Promise<PolicyDecision> {
    const c = classify(action);

    if (c.forbidden) {
      return this.record(action, c, {
        verdict: "deny",
        classification: c,
        reason: c.reason,
        fromGrant: false,
      });
    }

    if (c.level <= this.autoAllowUpTo) {
      return this.record(action, c, {
        verdict: "allow",
        classification: c,
        reason: `level ${c.level} runs without asking`,
        fromGrant: false,
      });
    }

    const grant = this.lookupGrant(action.tool, c.level);
    if (grant) {
      return this.record(action, c, {
        verdict: grant.deny ? "deny" : "allow",
        classification: c,
        reason: grant.deny
          ? "you previously chose to always deny this"
          : "you previously allowed this",
        fromGrant: true,
      });
    }

    const choice = await this.askUser(action, c);

    if (choice === "allow_always" || choice === "deny_always") {
      // Recorded against the level the user actually saw. A later, riskier call
      // to the same tool will ask again rather than inheriting this answer.
      if (c.level <= NO_ALWAYS_ABOVE) {
        this.grants.set(this.key(action.tool), {
          tool: action.tool,
          level: c.level,
          expiresAt: this.now() + this.grantTtlMs,
          deny: choice === "deny_always",
        });
      }
    }

    const allowed = choice === "allow_once" || choice === "allow_always";
    return this.record(action, c, {
      verdict: allowed ? "allow" : "deny",
      classification: c,
      reason:
        choice === null
          ? "no answer, so I did not do it"
          : allowed
            ? "you approved it"
            : "you declined",
      fromGrant: false,
    });
  }

  /**
   * Ask, with a timeout that denies.
   *
   * `Promise.race` rather than trusting the UI to answer: a HUD that crashed
   * mid-prompt would otherwise leave the turn hanging forever, and an assistant
   * that hangs on a permission check is one whose permission checks get
   * disabled.
   */
  private async askUser(
    action: ActionDescriptor,
    c: Classification,
  ): Promise<ConsentChoice | null> {
    const ask = this.options.ask;
    if (!ask) return null;

    this.counter += 1;
    const options: ConsentChoice[] =
      c.level > NO_ALWAYS_ABOVE
        ? ["allow_once", "deny"]
        : ["allow_once", "allow_always", "deny", "deny_always"];

    const ctx: AskContext = {
      requestId: `perm-${this.counter}`,
      title: this.titleFor(action, c),
      // The model-supplied title is shown, but quoted and sanitised, and never
      // in place of Jarvis's own account of what the call does.
      detail: action.title
        ? `${describeAction(action, c)} — Hermes says: "${sanitiseForDisplay(action.title)}"`
        : describeAction(action, c),
      options,
      classification: c,
    };

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        ask(ctx).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.askTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private titleFor(action: ActionDescriptor, c: Classification): string {
    const tool = sanitiseForDisplay(action.tool, 40);
    const first = c.paths[0] ? ` ${sanitiseForDisplay(c.paths[0], 60)}` : "";
    return `Allow ${tool}${first}?`;
  }

  private key(tool: string): string {
    return tool.toLowerCase();
  }

  /**
   * Find a live grant that actually covers this action.
   *
   * The level check is the point: a grant given for a level 2 write does not
   * authorise a level 3 delete just because the tool name matches.
   */
  private lookupGrant(tool: string, level: RiskLevel): Grant | null {
    const g = this.grants.get(this.key(tool));
    if (!g) return null;
    if (g.expiresAt <= this.now()) {
      this.grants.delete(this.key(tool));
      return null;
    }
    if (level > g.level) return null;
    return g;
  }

  private record(
    action: ActionDescriptor,
    c: Classification,
    decision: PolicyDecision,
  ): PolicyDecision {
    const entry: AuditEntry = {
      at: this.now(),
      tool: sanitiseForDisplay(action.tool, 60),
      level: c.level,
      category: c.category,
      verdict: decision.verdict,
      reason: decision.reason,
    };
    this.log.push(entry);
    // Bounded: this runs for weeks at a time and an unbounded array is a slow
    // memory leak. The Activity view reads the tail anyway.
    if (this.log.length > 1000) this.log.splice(0, this.log.length - 1000);
    this.options.onAudit?.(entry);
    return decision;
  }

  /** Attach a checked outcome to the most recent entry for this tool. */
  recordOutcome(tool: string, outcome: ActionOutcome): void {
    for (let i = this.log.length - 1; i >= 0; i -= 1) {
      const entry = this.log[i];
      if (entry && entry.tool === sanitiseForDisplay(tool, 60)) {
        entry.outcome = outcome;
        return;
      }
    }
  }

  get audit(): readonly AuditEntry[] {
    return this.log;
  }

  /** Drop every stored grant. The "forget what I allowed" control. */
  revokeAll(): void {
    this.grants.clear();
  }

  get activeGrants(): readonly Grant[] {
    const live: Grant[] = [];
    for (const [k, g] of this.grants) {
      if (g.expiresAt <= this.now()) this.grants.delete(k);
      else live.push(g);
    }
    return live;
  }
}
