/**
 * Doing something, then checking it actually happened.
 *
 * Every layer below this one reports success the way the thing it called
 * reported success. That is a chain of claims, and this project has already been
 * burned by it twice: `Verbs.DoIt()` restores a file from the Recycle Bin and
 * returns nothing at all, so the undo layer marked a step undone whether or not
 * the file came back — and 18 green unit tests agreed with it, because a fake
 * runner returns whatever it is told to. The fix in both cases was the same
 * shape: stop trusting the report, go and look.
 *
 * That is all this file is. An action is described as three parts —
 *
 *   observe   what does the world look like now?
 *   act       do the thing
 *   verify    is the world different in the way it should be?
 *
 * — and the verdict comes from the third, never from the second. An `act` that
 * resolves without throwing is not evidence of anything.
 *
 * **The outcomes are deliberately not two.** "It worked", "it threw", and "it
 * said nothing was wrong but nothing changed" are three different situations for
 * a user, and collapsing the third into either of the others is how an assistant
 * ends up saying "done" about work it did not do. There is a fourth, `unchecked`,
 * for when the verification itself could not run: not knowing is its own answer
 * and it must never be rounded up to success.
 *
 * **Verification runs even when the action throws.** A half-finished action is
 * the case where knowing the state matters most — a file may have been moved
 * before the error, and reporting a clean failure would send the user looking in
 * the wrong place.
 */

/** What `verify` concluded, and why. */
export type VerifyVerdict =
  | { ok: true; detail?: string }
  | { ok: false; reason: string };

export type ActionOutcome =
  /** Acted, and the world changed the way it was supposed to. */
  | "verified"
  /** Acted without error, but the check says nothing changed. */
  | "unconfirmed"
  /** The action itself failed. */
  | "failed"
  /** The check could not run, so nothing is known either way. */
  | "unchecked";

export interface ActionReport {
  description: string;
  outcome: ActionOutcome;
  /** A sentence for the Activity view. Never claims more than was checked. */
  detail: string;
  /** How long act() took, for the performance budget. */
  tookMs: number;
  /** Present when act() threw. */
  error?: string;
}

export interface VerifiedActionSpec<T> {
  /** What this does, in the user's terms. */
  description: string;
  /**
   * Read the relevant state. Must not change anything — it runs before *and*
   * after, and an observer with side effects would make the comparison
   * meaningless.
   */
  observe: () => Promise<T> | T;
  act: () => Promise<void> | void;
  /**
   * Did it work? Returning `ok: false` is a real answer, not an error — it means
   * the check ran and the world did not change.
   */
  verify: (before: T, after: T) => VerifyVerdict | Promise<VerifyVerdict>;
}

export interface RunOptions {
  /** Ceiling on the whole thing. */
  timeoutMs?: number;
  now?: () => number;
  /** Some changes are not visible instantly. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bound `act` in time.
 *
 * The timeout does not cancel the work — nothing here can, since `act` is an
 * opaque callback. It stops *waiting* for it, which is the part that matters:
 * an always-on assistant that blocks forever on one stuck PowerShell call is
 * down, and a hung action still gets verified afterwards. That verification is
 * the honest answer, because a slow action that eventually succeeded and one
 * that never will are indistinguishable from here.
 */
async function withTimeout(work: Promise<void> | void, ms: number): Promise<void> {
  if (!(work instanceof Promise)) return work;
  // No extra handler is attached to `work`. `Promise.race` subscribes to every
  // input, so when the timeout wins, the abandoned action's later rejection is
  // already delivered to a listener and never reaches `unhandledRejection` — a
  // measured fact about the runtime, not an assumption. Adding a defensive
  // `.catch` here would read as though it were load-bearing when it is not.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    // Otherwise a fast action would hold the event loop open for the full
    // timeout, which for the default is half a minute per call.
    if (timer) clearTimeout(timer);
  }
}

/**
 * Would the check have passed before the action ran?
 *
 * Asked only on the one ambiguous path — `act` threw, yet the verdict is ok —
 * where the answer decides between "noisy but it worked" and "it never ran and
 * the check cannot tell". Safe to ask, because `verify` is a comparison over two
 * observations and this passes it the same one twice; a verifier that reads
 * anything else was already broken.
 *
 * A verifier that throws here has told us nothing, so this says "yes, already
 * satisfied" and lets the caller fall back to the action's own error — the
 * conservative answer when the alternative is claiming success.
 */
async function alreadySatisfied<T>(spec: VerifiedActionSpec<T>, before: T): Promise<boolean> {
  try {
    return (await spec.verify(before, before)).ok;
  } catch {
    return true;
  }
}

/**
 * Run an action and report what is actually known about it afterwards.
 *
 * Never throws for an action that failed — the failure is the return value,
 * because a thrown error would put the caller back in the business of guessing
 * what state the machine is in. It throws only if the spec itself is unusable.
 */
export async function runVerified<T>(
  spec: VerifiedActionSpec<T>,
  opts: RunOptions = {},
): Promise<ActionReport> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();

  // If the *first* observation fails there is no baseline, so nothing that
  // happens afterwards can be verified. Say that plainly rather than acting
  // blind and reporting a confident-sounding result.
  let before: T;
  try {
    before = await spec.observe();
  } catch (err) {
    return {
      description: spec.description,
      outcome: "unchecked",
      detail: `could not read the state beforehand, so nothing was done: ${message(err)}`,
      tookMs: now() - started,
    };
  }

  let actError: string | null = null;
  try {
    await withTimeout(spec.act(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    actError = message(err);
  }

  const tookMs = now() - started;
  if (opts.settleMs) await sleep(opts.settleMs);

  // Deliberately runs even when act() threw: a half-finished action is exactly
  // when the user most needs to know what the machine looks like now.
  let after: T;
  try {
    after = await spec.observe();
  } catch (err) {
    return {
      description: spec.description,
      outcome: actError ? "failed" : "unchecked",
      detail: actError
        ? `it failed, and the state could not be read afterwards: ${actError}`
        : `it ran, but the state could not be read afterwards, so this is unconfirmed: ${message(err)}`,
      tookMs,
      ...(actError ? { error: actError } : {}),
    };
  }

  let verdict: VerifyVerdict;
  try {
    verdict = await spec.verify(before, after);
  } catch (err) {
    return {
      description: spec.description,
      outcome: actError ? "failed" : "unchecked",
      detail: actError
        ? `it failed: ${actError}`
        : `it ran, but the check could not be completed: ${message(err)}`,
      tookMs,
      ...(actError ? { error: actError } : {}),
    };
  }

  // An action that threw but still had the intended effect is reported as done,
  // with the error kept. A noisy tool that works is a different problem from a
  // quiet one that doesn't, and the user cares about the outcome.
  //
  // Unless the check could not have told the difference. If the condition was
  // *already* true before anything ran, an "ok" verdict is not evidence that the
  // action worked — and a throw usually means it did not. This is not
  // hypothetical: `undo` on a snapshot restore threw "the saved copy is gone"
  // while its verifier asked "does the file exist?", which it always did, since
  // a snapshot backs up a file that is still there. The precondition failure
  // came back as "verified". So when both are true, ask the check what it would
  // have said beforehand.
  if (verdict.ok && actError && (await alreadySatisfied(spec, before))) {
    return {
      description: spec.description,
      outcome: "failed",
      detail: `it did not work: ${actError}`,
      tookMs,
      error: actError,
    };
  }

  if (verdict.ok) {
    return {
      description: spec.description,
      outcome: "verified",
      detail: verdict.detail ?? "done, and confirmed",
      tookMs,
      ...(actError ? { error: actError } : {}),
    };
  }

  if (actError) {
    return {
      description: spec.description,
      outcome: "failed",
      detail: `it did not work: ${actError}`,
      tookMs,
      error: actError,
    };
  }

  return {
    description: spec.description,
    outcome: "unconfirmed",
    // The wording matters. "Done" would be a lie, and "failed" would be a guess:
    // the tool reported no error, and the check found no change. Both facts go
    // to the user, because only they know which one to believe.
    detail: `it reported no error, but ${verdict.reason}`,
    tookMs,
  };
}

/**
 * Whether this outcome may be described to the user as having worked.
 *
 * One place, so no caller has to remember that `unconfirmed` and `unchecked` are
 * not successes. Both are cases where saying "done" would be a claim nobody
 * checked.
 */
export function isConfirmed(outcome: ActionOutcome): boolean {
  return outcome === "verified";
}

/** A ready-made verifier for "this path should exist now" (or should not). */
export function existenceVerifier(
  path: string,
  want: "present" | "absent",
): (before: boolean, after: boolean) => VerifyVerdict {
  return (_before, after) => {
    const good = want === "present" ? after : !after;
    if (good) return { ok: true, detail: `${path} is now ${want}` };
    return {
      ok: false,
      reason: want === "present" ? `${path} is still not there` : `${path} is still there`,
    };
  };
}
