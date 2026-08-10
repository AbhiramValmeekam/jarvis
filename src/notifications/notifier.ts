/**
 * Notifications: the only way Jarvis speaks first.
 *
 * Everything else in this system is a reply. A notification is Jarvis deciding,
 * unprompted, that something is worth interrupting a person for — so the design
 * question is not "how do we show a toast", it is "what earns an interruption".
 * `docs/IMPLEMENTATION_PLAN.md` answers it for us: proactive assistance is
 * **MINIMAL by default**, and this module is where that default is enforced
 * rather than merely intended.
 *
 * Three rules make it hold:
 *
 * 1. **Category, not caller, decides.** A caller cannot mark its own message
 *    important. It states what kind of thing happened and the level in force
 *    decides whether that kind interrupts. This is the difference between a
 *    policy and a convention: a convention is broken by the next feature that
 *    feels urgent about itself.
 * 2. **Repeats are suppressed.** A dead scheduler is dead on every poll. The
 *    naive version of this file toasts once a minute forever, which trains the
 *    user to dismiss Jarvis without reading — the failure mode that makes every
 *    *later* notification useless too.
 * 3. **Text is sanitised (§52).** A job name is derived from an agent's prompt
 *    (`cron/jobs.py:1185`), and a toast is a UI surface that renders outside our
 *    window, past our HUD's escaping. Untrusted text goes through
 *    `sanitiseForDisplay` on the way in, not at the far end where a second sink
 *    could forget.
 *
 * The sink is injected. This module never imports Electron — it runs in the
 * headless runtime, which has no `Notification` and must not gain a dependency
 * on a window existing. Delivery is the shell's job; deciding is this one's.
 */
import { sanitiseForDisplay } from "../permissions/risk-model.js";

/**
 * How much Jarvis is allowed to say on its own initiative.
 *
 * `minimal` is the default and is not a euphemism for "some": it admits exactly
 * the categories where silence would leave the user believing something is
 * working when it is not.
 */
export type NotifyLevel = "off" | "minimal" | "normal";

/**
 * What kind of event this is. The caller's only say in whether it is shown.
 *
 * Kept small on purpose. Every new category is a new opportunity to interrupt
 * someone, so adding one should feel like a decision, not like naming a string.
 */
export type NotifyCategory =
  /** A scheduled job ran and failed, or the scheduler itself is not running. */
  | "task-failed"
  /** A scheduled job completed normally. */
  | "task-done"
  /** A delegated coding task finished — work the user started and walked away from. */
  | "coding-done"
  /** Something Jarvis needs the user to decide or fix. */
  | "attention"
  /** Ordinary progress. Never shown below `normal`. */
  | "info";

/**
 * Categories that survive `minimal`.
 *
 * The test each one passes: *if Jarvis stays quiet, does the user go on
 * believing something happened that did not?* A failed job, a dead scheduler and
 * an unanswered question all fail that test. A job that succeeded does not —
 * the user asked for it to run, it ran, and the list is there when they want it
 * (§4 is about not faking success, not about announcing it).
 */
const MINIMAL_CATEGORIES: ReadonlySet<NotifyCategory> = new Set<NotifyCategory>([
  "task-failed",
  "coding-done",
  "attention",
]);

/**
 * How long the same `key` stays suppressed after being shown.
 *
 * Half an hour is chosen against the failure it prevents: the task watcher polls
 * on a minute cadence, so an uncapped repeat would produce 48 identical toasts
 * in a day. It is also short enough that a condition the user deliberately left
 * unfixed reasserts itself occasionally rather than disappearing forever.
 */
export const REPEAT_COOLDOWN_MS = 30 * 60_000;

/** Bounds the dedup table. Keys are per-condition, so this is generous. */
const MAX_KEYS = 200;

export interface JarvisNotification {
  /**
   * Stable identity of the *condition*, not the moment.
   *
   * `ticker-stalled` rather than `ticker-stalled-at-14:32`: the point of the key
   * is that the second occurrence recognises the first.
   */
  key: string;
  category: NotifyCategory;
  /** Sanitised. */
  title: string;
  /** Sanitised. */
  body: string;
  at: number;
}

/** What a caller hands in. Text is untrusted until this module has run. */
export interface NotifyRequest {
  key: string;
  category: NotifyCategory;
  title: string;
  body?: string;
}

/** Why a notification did not appear. Returned, never silently swallowed. */
export type NotifyOutcome =
  | { shown: true; notification: JarvisNotification }
  | { shown: false; reason: "level" | "duplicate" | "no-sink" };

export interface NotifierOptions {
  level?: NotifyLevel;
  /** Delivery. Absent means nothing is shown — and `notify` says so. */
  sink?: (n: JarvisNotification) => void;
  now?: () => number;
  cooldownMs?: number;
}

export class Notifier {
  private level: NotifyLevel;
  private readonly sink: ((n: JarvisNotification) => void) | undefined;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  /** key → epoch ms it was last shown. */
  private readonly lastShown = new Map<string, number>();

  constructor(opts: NotifierOptions = {}) {
    this.level = opts.level ?? "minimal";
    this.sink = opts.sink;
    this.now = opts.now ?? Date.now;
    this.cooldownMs = opts.cooldownMs ?? REPEAT_COOLDOWN_MS;
  }

  setLevel(level: NotifyLevel): void {
    this.level = level;
  }

  getLevel(): NotifyLevel {
    return this.level;
  }

  private allowed(category: NotifyCategory): boolean {
    if (this.level === "off") return false;
    if (this.level === "normal") return true;
    return MINIMAL_CATEGORIES.has(category);
  }

  /**
   * Show something, or explain why not.
   *
   * Order matters and is deliberate: the level gate runs *before* the cooldown
   * is recorded. A suppressed-by-level notification must not consume the key's
   * cooldown, or raising the level to `normal` would leave the user in silence
   * until the window expired — a setting that appears not to work.
   */
  notify(req: NotifyRequest): NotifyOutcome {
    if (!this.allowed(req.category)) return { shown: false, reason: "level" };

    const at = this.now();
    const previous = this.lastShown.get(req.key);
    if (previous !== undefined && at - previous < this.cooldownMs) {
      return { shown: false, reason: "duplicate" };
    }

    // Recorded even when there is no sink. "Nothing is attached" is a delivery
    // problem; the decision to show it was still taken here, and a shell that
    // attaches mid-cooldown should not receive a backlog of stale conditions.
    this.remember(req.key, at);
    if (!this.sink) return { shown: false, reason: "no-sink" };

    const notification: JarvisNotification = {
      key: sanitiseForDisplay(req.key, 60),
      category: req.category,
      title: sanitiseForDisplay(req.title, 80),
      body: sanitiseForDisplay(req.body ?? "", 200),
      at,
    };
    this.sink(notification);
    return { shown: true, notification };
  }

  /**
   * Let a resolved condition notify again immediately.
   *
   * Without this, a scheduler that dies, gets fixed, and dies again an hour
   * later stays silent the second time — the cooldown would still be running.
   * The watcher calls this when it observes the condition clear.
   */
  clear(key: string): void {
    this.lastShown.delete(key);
  }

  private remember(key: string, at: number): void {
    this.lastShown.set(key, at);
    if (this.lastShown.size <= MAX_KEYS) return;
    // Insertion-ordered, so the first key is the oldest write. Evicting it costs
    // at most one extra toast for a condition nobody has seen in a long time.
    const oldest = this.lastShown.keys().next();
    if (!oldest.done) this.lastShown.delete(oldest.value);
  }
}

/** Parse a config value into a level, or undefined if it is not one. */
export function parseNotifyLevel(raw: unknown): NotifyLevel | undefined {
  return raw === "off" || raw === "minimal" || raw === "normal" ? raw : undefined;
}
