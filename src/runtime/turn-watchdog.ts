/**
 * A clock on an agent turn, so silence eventually means something.
 *
 * Written because of a measured defect, not a hypothetical one. A typed turn
 * that asked Hermes to read two files was accepted in 5 ms, emitted one
 * `tool_call`, and then produced **nothing for 423 seconds** — no reply, no
 * error, no `reply_done`. Jarvis' own log stopped dead at
 * `tools.file_tools: Creating new local environment for task default...`, and a
 * `bash.exe --noprofile --norc -c "exit 0"` child spawned at that instant was
 * still alive 25 minutes later with 0 s of CPU time, having outlived the 15 s
 * `subprocess.run` timeout that was supposed to reap it. The wedge is inside
 * Hermes' `LocalEnvironment.init_session`
 * (`tools/environments/local.py:1104`), below anything Jarvis owns.
 *
 * Jarvis' own failing was the part worth fixing here: `runAgentTurn` did a bare
 * `await supervisor.streamMessage(...)` with no deadline anywhere beneath it, so
 * a wedged agent produced an assistant that sat in THINKING forever and told the
 * user nothing. Cancelling recovered everything in 1 ms — the recovery worked,
 * nobody was firing it.
 *
 * Three properties this object exists to have:
 *
 * 1. **Progress resets the clock, so length is not the offence.** A turn that
 *    streams thoughts, tool calls and text for ten minutes is working; a turn
 *    that says nothing for ten minutes is not. Deadlines measured from the
 *    *start* of a turn are how you kill the healthy long turn that Phase 12's
 *    previous fix was about (`acceptPrompt`), and this must not reintroduce it.
 * 2. **A human being asked a question is not a stall.** While a permission
 *    dialog is open the clock does not run at all — no machine deadline is
 *    defensible for someone reading a question, and `ConsentBroker` already
 *    bounds that wait at 110 s of its own.
 * 3. **It cannot itself wedge.** The timer is re-armed from a monotonic-ish
 *    elapsed check rather than trusted to fire exactly once, so a laptop that
 *    slept through the deadline is judged on time actually elapsed.
 */

export interface TurnWatchdogOptions {
  /** Silence, in ms, after which the turn is considered dead. */
  timeoutMs: number;
  /** Silence, in ms, after which it is worth saying so. Optional. */
  noticeMs?: number;
  /** Fired once, at `timeoutMs` of unbroken silence. */
  onStall: (silentMs: number) => void;
  /** Fired once, at `noticeMs`. The turn keeps running. */
  onNotice?: (silentMs: number) => void;
  /**
   * When this returns true the clock is held. Used for "a human is being asked
   * something", where waiting is the correct behaviour rather than a symptom.
   */
  isPaused?: () => boolean;
  /** Injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
}

/**
 * How long a turn may say nothing at all before Jarvis cancels it.
 *
 * Eleven minutes, and the number is borrowed rather than invented: Hermes caps a
 * *foreground* command at `FOREGROUND_MAX_TIMEOUT = 600` seconds
 * (`tools/terminal_tool.py:107`) and refuses a larger one outright, so no single
 * tool call Hermes is bounding can legitimately be silent for longer than that.
 * The extra minute is slack, deliberately paid so that a genuine ten-minute
 * build is never killed one second before it returns — losing ten minutes of a
 * user's work to a watchdog would be a worse bug than the one this fixes.
 *
 * Anything past this is not slow, it is wedged: the reproduction above sat at
 * 25 minutes and counting.
 */
export const DEFAULT_TURN_STALL_MS = 660_000;

/**
 * When silence becomes worth mentioning.
 *
 * A minute of nothing is not yet a failure — plenty of real turns think for
 * that long — but it is the point at which the honest thing is to say so
 * instead of leaving the orb spinning on a promise.
 */
export const DEFAULT_TURN_NOTICE_MS = 60_000;

/** How often the clock re-checks while it is held open by a question. */
const PAUSED_RECHECK_MS = 5_000;

/** Never arm a timer tighter than this; a busy loop is not a watchdog. */
const MIN_ARM_MS = 25;

export class TurnWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private last: number;
  private noticed = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (t: NodeJS.Timeout) => void;

  constructor(private readonly options: TurnWatchdogOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t));
    this.last = this.now();
    this.arm(this.nextCheckMs());
  }

  /**
   * The agent said something. Anything at all counts — a thought, a tool call, a
   * single token of text — because the question this answers is "is it alive",
   * not "is it making the progress I wanted".
   */
  progress(): void {
    if (this.stopped) return;
    const hadNoticed = this.noticed;
    this.last = this.now();
    // A notice already given is not retracted, but the next silence earns its
    // own: a turn that goes quiet twice is reported twice.
    this.noticed = false;
    // Only re-arm when the pending timer is now aimed too far ahead. Before a
    // notice it is already sitting at or before the notice mark and the tick
    // re-computes from elapsed time, so the common case — one call per streamed
    // token — touches no timers at all. After a notice it is aimed at the stall
    // mark, which is minutes away, and the next silence would go unreported.
    if (hadNoticed) {
      if (this.timer) this.clearTimer(this.timer);
      this.arm(this.nextCheckMs());
    }
  }

  /** Turn the clock off. Safe to call twice; the finally-block calls it once. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Silence so far, in ms. For the log line and the failure message. */
  get silentMs(): number {
    return this.now() - this.last;
  }

  private nextCheckMs(): number {
    const notice = this.options.noticeMs;
    if (notice !== undefined && !this.noticed && notice < this.options.timeoutMs) {
      return notice;
    }
    return this.options.timeoutMs;
  }

  private arm(ms: number): void {
    this.timer = this.setTimer(() => this.tick(), Math.max(MIN_ARM_MS, ms));
    // Unref'd on purpose: a pending watchdog must never be the reason this
    // process refuses to exit.
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped) return;

    // Held open by a question on screen. The elapsed clock is reset rather than
    // merely paused, so a user who takes 100 s to read a permission dialog
    // gives the agent its whole budget afterwards instead of a fraction of it.
    if (this.options.isPaused?.()) {
      this.last = this.now();
      this.arm(Math.min(PAUSED_RECHECK_MS, this.nextCheckMs()));
      return;
    }

    const silent = this.now() - this.last;
    if (silent >= this.options.timeoutMs) {
      this.stopped = true;
      this.options.onStall(silent);
      return;
    }

    const notice = this.options.noticeMs;
    if (notice !== undefined && !this.noticed && silent >= notice) {
      this.noticed = true;
      this.options.onNotice?.(silent);
    }

    // Re-armed from elapsed time, not from a fresh full interval: a timer that
    // fired late (a slept laptop, a blocked event loop) must not restart the
    // whole wait.
    this.arm(this.nextCheckMs() - silent);
  }
}
