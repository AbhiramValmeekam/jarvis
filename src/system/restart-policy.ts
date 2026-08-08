/**
 * Bounded restart policy.
 *
 * Requirement: "Never create infinite restart loops." A supervised worker that
 * dies repeatedly must eventually stay dead and surface an error rather than
 * burn CPU forever — which matters more than usual here because Jarvis runs
 * whenever the laptop is on.
 *
 * Policy: exponential backoff with jitter, capped attempts inside a rolling
 * window. Crashes older than the window are forgotten, so a process that is
 * healthy for a long stretch and then dies once is not punished for failures
 * that happened hours ago.
 */

export interface RestartPolicyOptions {
  /** Max restarts allowed within `windowMs` before giving up. */
  maxRestarts?: number;
  /** Rolling window over which restarts are counted. */
  windowMs?: number;
  /** Delay before the first restart. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs?: number;
  /** Fraction of jitter applied to each delay (0 disables). */
  jitter?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable randomness for tests. */
  random?: () => number;
}

export type RestartDecision =
  | { restart: true; delayMs: number; attempt: number }
  | { restart: false; reason: string; attempt: number };

const DEFAULTS = {
  maxRestarts: 5,
  windowMs: 60_000,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.2,
};

export class RestartPolicy {
  private readonly crashes: number[] = [];
  private readonly opts: Required<Omit<RestartPolicyOptions, "now" | "random">>;
  private readonly now: () => number;
  private readonly random: () => number;
  /** Set when the policy has permanently given up. */
  private trippedReason: string | null = null;

  constructor(options: RestartPolicyOptions = {}) {
    this.opts = {
      maxRestarts: options.maxRestarts ?? DEFAULTS.maxRestarts,
      windowMs: options.windowMs ?? DEFAULTS.windowMs,
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      jitter: options.jitter ?? DEFAULTS.jitter,
    };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** True once the policy has given up and will not permit further restarts. */
  get isTripped(): boolean {
    return this.trippedReason !== null;
  }

  get reason(): string | null {
    return this.trippedReason;
  }

  /** Number of crashes still inside the rolling window. */
  get recentCrashCount(): number {
    this.prune();
    return this.crashes.length;
  }

  /**
   * Record a crash and decide what to do next.
   * Call exactly once per unexpected exit.
   */
  recordCrash(): RestartDecision {
    const t = this.now();
    this.prune(t);
    this.crashes.push(t);
    const attempt = this.crashes.length;

    if (this.trippedReason) {
      return { restart: false, reason: this.trippedReason, attempt };
    }

    if (attempt > this.opts.maxRestarts) {
      this.trippedReason =
        `gave up after ${this.opts.maxRestarts} restarts within ` +
        `${Math.round(this.opts.windowMs / 1000)}s`;
      return { restart: false, reason: this.trippedReason, attempt };
    }

    // Exponential backoff: base * 2^(attempt-1), capped.
    const raw = this.opts.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(raw, this.opts.maxDelayMs);
    // Jitter spreads retries so a shared upstream failure doesn't synchronise.
    const spread = capped * this.opts.jitter;
    const delayMs = Math.max(
      0,
      Math.round(capped - spread / 2 + this.random() * spread),
    );

    return { restart: true, delayMs, attempt };
  }

  /**
   * Clear crash history after a sustained healthy period.
   * Also un-trips the policy, so a manual "Restart Jarvis" can recover.
   */
  reset(): void {
    this.crashes.length = 0;
    this.trippedReason = null;
  }

  private prune(t = this.now()): void {
    const cutoff = t - this.opts.windowMs;
    while (this.crashes.length > 0 && this.crashes[0]! < cutoff) {
      this.crashes.shift();
    }
  }
}
