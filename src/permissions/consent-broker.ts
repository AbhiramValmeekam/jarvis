/**
 * Getting the question in front of a human, and getting an answer back.
 *
 * The permission engine decides; this decides *how the asking happens*. It is a
 * separate object because the two have different failure modes: the engine's
 * job is to be correct, and this one's job is to never wedge — a pending
 * question with nobody to answer it must resolve, not hang.
 *
 * Every outstanding request is tracked with its own timer, so:
 *
 * - No UI attached → the send fails and the answer is `null` immediately. An
 *   always-on assistant spends most of its life with no window open, and that
 *   must read as "cannot ask", not as "wait forever".
 * - UI attached but nobody at the keyboard → the timer fires and the entry is
 *   deleted. The engine treats `null` as a denial.
 * - UI closed mid-question → `cancelAll` resolves the leftovers.
 *
 * The map is bounded for the same reason the audit log is: this process runs
 * for weeks, and an entry that is never resolved and never deleted is a leak
 * that eventually matters.
 */
import type { AskContext, ConsentChoice } from "./permission-engine.js";
import type { Classification } from "./risk-model.js";

export interface BrokerOptions {
  /**
   * Put the request in front of whatever UI is attached. Returns false when
   * there is nobody to show it to — which is a denial, not an error.
   */
  send: (req: {
    requestId: string;
    title: string;
    detail: string;
    /** Kept as consent choices, not strings, so the caller can narrow them. */
    options: readonly ConsentChoice[];
    /**
     * Forwarded so the UI can show what is actually at stake. The broker does
     * not read it — it belongs to the engine's verdict, and passing it through
     * untouched keeps this object free of any say in the decision.
     */
    classification: Classification;
  }) => boolean;
  /** How long a question stays open. Slightly under the engine's own timeout. */
  timeoutMs?: number;
  /** Cap on simultaneous open questions. */
  maxPending?: number;
  onLog?: (line: string) => void;
}

export const DEFAULT_BROKER_TIMEOUT_MS = 110_000;
export const DEFAULT_MAX_PENDING = 8;

interface Pending {
  requestId: string;
  title: string;
  askedAt: number;
  settle: (choice: ConsentChoice | null) => void;
  timer: NodeJS.Timeout;
}

export class ConsentBroker {
  private readonly pendingMap = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(private readonly options: BrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  /** The function to hand to `PermissionEngine`'s `ask` option. */
  ask = (ctx: AskContext): Promise<ConsentChoice | null> => {
    if (this.pendingMap.size >= this.maxPending) {
      // A flood of questions is itself a reason to refuse. Queueing them would
      // train the user to click through a backlog.
      this.options.onLog?.(
        `permission: refusing ${ctx.requestId}, ${this.pendingMap.size} already open`,
      );
      return Promise.resolve(null);
    }

    const shown = this.options.send({
      requestId: ctx.requestId,
      title: ctx.title,
      detail: ctx.detail,
      options: ctx.options,
      classification: ctx.classification,
    });
    if (!shown) {
      this.options.onLog?.(`permission: nobody to ask about ${ctx.requestId}`);
      return Promise.resolve(null);
    }

    return new Promise<ConsentChoice | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingMap.delete(ctx.requestId);
        this.options.onLog?.(`permission: ${ctx.requestId} timed out unanswered`);
        resolve(null);
      }, this.timeoutMs);
      timer.unref?.();

      this.pendingMap.set(ctx.requestId, {
        requestId: ctx.requestId,
        title: ctx.title,
        askedAt: Date.now(),
        settle: resolve,
        timer,
      });
    });
  };

  /**
   * Deliver a user's answer.
   *
   * Returns false for an id that is not open, which the caller reports as a bad
   * request rather than silently accepting: a decision arriving for an unknown
   * or already-settled question is either a stale click or a forged frame, and
   * neither should authorise anything.
   */
  resolve(requestId: string, choice: ConsentChoice): boolean {
    const p = this.pendingMap.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pendingMap.delete(requestId);
    p.settle(choice);
    return true;
  }

  /** Resolve every open question as unanswered. Used on detach and shutdown. */
  cancelAll(reason: string): number {
    const n = this.pendingMap.size;
    for (const p of [...this.pendingMap.values()]) {
      clearTimeout(p.timer);
      this.pendingMap.delete(p.requestId);
      p.settle(null);
    }
    if (n > 0) this.options.onLog?.(`permission: cancelled ${n} open question(s): ${reason}`);
    return n;
  }

  /** What is currently waiting on a human, for the status snapshot. */
  get pending(): ReadonlyArray<{ requestId: string; title: string; askedAt: number }> {
    return [...this.pendingMap.values()].map((p) => ({
      requestId: p.requestId,
      title: p.title,
      askedAt: p.askedAt,
    }));
  }
}
