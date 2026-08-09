/**
 * Screen capture, on request, with consent that cannot be made standing.
 *
 * This is the most invasive thing Jarvis can do. A screenshot is not "context":
 * it is everything visible at that instant — an unread message, a password
 * manager left open, a colleague's face on a call, a bank balance. And unlike
 * the window reader, which extracts a process name and a redacted title, there
 * is no way to sanitise pixels. Whatever is on the screen is in the image.
 *
 * So the rules here are stricter than anywhere else in the project, and they are
 * structural rather than advisory:
 *
 *   1. **Every capture is asked about, every time.** There is no `allow_always`
 *      path. A standing grant to capture the screen is a screen recorder with a
 *      polite name, and no consent dialog that appears once can meaningfully
 *      authorise an unbounded number of future captures.
 *   2. **There is no continuous mode.** Not disabled, not gated — absent. This
 *      module exposes `captureOnce` and nothing else, so "start streaming my
 *      screen" cannot be implemented by flipping a flag someone left in. §50
 *      says never secretly stream audio; a video feed of the desktop is the same
 *      promise and gets the same answer.
 *   3. **The user is told where it goes.** If the image will be sent to a hosted
 *      model, the consent text says so, because "can I see your screen" and "can
 *      I upload a photograph of your screen to a server" are different questions
 *      and only one of them is being asked honestly.
 *   4. **Nothing is retained.** The image is handed to the caller for one turn.
 *      This module keeps no copy, writes no file, and holds no history — the
 *      most recent capture is not available to the next turn.
 *
 * The capture itself is a dependency, so the policy above is testable without a
 * display. What this file owns is the decision, not the pixels.
 */
import type { AskContext, ConsentChoice } from "../permissions/permission-engine.js";

/** Why a capture is being requested, in the user's words. */
export interface CaptureRequest {
  /**
   * What the capture is for, shown verbatim in the consent prompt.
   *
   * Required, and deliberately not defaulted: a prompt that says "Jarvis wants
   * to see your screen" with no reason is a prompt users learn to click through.
   */
  reason: string;
  /**
   * Where the image will go.
   *
   * `"local"` — it stays on this machine and is never transmitted.
   * `"agent"`  — it is sent to the agent, which may be a hosted model. This is
   *              the case that changes what the user is actually agreeing to,
   *              so it changes what the prompt says.
   */
  destination: "local" | "agent";
}

export type CaptureRefusal =
  | "denied"
  | "no-consent-path"
  | "too-soon"
  | "session-limit"
  | "capture-failed";

export type CaptureResult =
  | { ok: true; image: Uint8Array; format: "png"; at: number }
  | { ok: false; refusal: CaptureRefusal; speech: string };

/** The answer to a capture prompt. Two options, on purpose — see below. */
export type CaptureConsent = "allow_once" | "deny";

export interface CaptureDeps {
  /**
   * Ask the user, and wait.
   *
   * Returns `"deny"` or `null` when there is nobody to ask. `null` is not an
   * error and is never treated as consent: an always-on assistant spends most
   * of its life with no window open, and "nobody answered" must read as no.
   *
   * The return type has no `allow_always`. That is the enforcement — a UI cannot
   * offer a standing grant for this because there is no value it could send
   * back that would mean one.
   */
  ask: (prompt: CapturePrompt) => Promise<CaptureConsent | null>;
  /** Take the picture. Only called after consent. */
  capture: () => Promise<Uint8Array>;
  now: () => number;
  onLog?: (line: string) => void;
}

/** What the user is shown. Assembled here so the wording cannot drift per caller. */
export interface CapturePrompt {
  title: string;
  detail: string;
  /** True when the image leaves the machine, so the UI can mark it clearly. */
  leavesMachine: boolean;
}

export interface CaptureOptions {
  /**
   * Shortest gap between two captures.
   *
   * Not a performance limit. Consent-per-capture is only a real protection if a
   * capture takes long enough that a user would notice a run of them; without a
   * floor, an agent in a loop could ask fifteen times in a second and the
   * fifteen prompts would be indistinguishable from one.
   */
  minIntervalMs?: number;
  /**
   * Captures allowed before the runtime restarts.
   *
   * A backstop against a persuaded or looping agent. Reaching it is not a
   * failure to work around — it means something has gone wrong, and the correct
   * response is for a human to look.
   */
  sessionLimit?: number;
}

export const MIN_CAPTURE_INTERVAL_MS = 2_000;
export const SESSION_CAPTURE_LIMIT = 20;

/**
 * The gate every screen capture passes through.
 *
 * Deliberately not part of the general permission engine. That engine's whole
 * design is that repeated approvals can become a grant — which is right for
 * launching an app and wrong for photographing the desktop. Rather than carve an
 * exception into it and rely on the exception surviving future edits, screen
 * capture gets an object that has no grant concept to begin with.
 */
export class ScreenCapture {
  private lastAt = 0;
  private taken = 0;
  private readonly minIntervalMs: number;
  private readonly sessionLimit: number;

  constructor(
    private readonly deps: CaptureDeps,
    options: CaptureOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? MIN_CAPTURE_INTERVAL_MS;
    this.sessionLimit = options.sessionLimit ?? SESSION_CAPTURE_LIMIT;
  }

  /** How many captures have been taken. For the HUD, so this is never invisible. */
  get count(): number {
    return this.taken;
  }

  /**
   * Ask, then capture once.
   *
   * The only entry point. There is no `start`, no `subscribe`, and no interval —
   * see the header. Order matters: the rate limits are checked *before* the
   * prompt, so a looping caller cannot flood the user with dialogs and hope one
   * is accepted by accident.
   */
  async captureOnce(request: CaptureRequest): Promise<CaptureResult> {
    const at = this.deps.now();

    if (this.taken >= this.sessionLimit) {
      this.log(`capture refused: session limit (${this.sessionLimit}) reached`);
      return {
        ok: false,
        refusal: "session-limit",
        speech: "I've taken too many screenshots this session. Restart me if that was expected.",
      };
    }

    if (this.lastAt !== 0 && at - this.lastAt < this.minIntervalMs) {
      this.log("capture refused: too soon after the last one");
      return {
        ok: false,
        refusal: "too-soon",
        speech: "That's too soon after the last screenshot.",
      };
    }

    const choice = await this.deps.ask(promptFor(request));
    if (choice !== "allow_once") {
      // `null` — nobody to ask — lands here with `deny`. Absence of a person is
      // absence of consent.
      this.log(`capture ${choice === "deny" ? "denied" : "unanswerable"}`);
      return {
        ok: false,
        refusal: choice === "deny" ? "denied" : "no-consent-path",
        speech:
          choice === "deny"
            ? "Okay, I won't."
            : "I can't ask permission for that right now, so I won't.",
      };
    }

    // Counted at the point of capture, not of asking: a denied prompt has not
    // photographed anything, and letting refusals consume the budget would let
    // an agent exhaust the allowance without the user ever agreeing to one.
    this.lastAt = at;
    this.taken += 1;

    let image: Uint8Array;
    try {
      image = await this.deps.capture();
    } catch (err) {
      this.log(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        refusal: "capture-failed",
        speech: "I couldn't capture the screen.",
      };
    }

    // Logged every time, without exception. A capture that leaves no trace is
    // indistinguishable from a covert one, and the log is the only artefact the
    // user can check afterwards. The image is not in it.
    this.log(
      `captured screen (${image.byteLength} bytes, destination=${request.destination}, ${this.taken}/${this.sessionLimit})`,
    );

    return { ok: true, image, format: "png", at };
  }

  private log(line: string): void {
    this.deps.onLog?.(line);
  }
}

/**
 * Route capture prompts through the runtime's existing consent UI.
 *
 * The HUD already knows how to show a permission request and send an answer
 * back, and building a second dialog for this would mean a second thing to get
 * right. What is *not* reused is the grant model: this offers the broker exactly
 * two options, and — the line that matters — narrows the answer on the way back,
 * so `allow_always` arriving from a UI that offers it anyway is read as `deny`.
 *
 * That narrowing is deliberately here rather than in `ScreenCapture`. The class
 * cannot be handed a standing grant because its type has no word for one; this
 * function is the only place a four-valued answer meets that two-valued type, so
 * it is the only place the conversion could go wrong.
 */
export function viaConsentBroker(
  ask: (ctx: AskContext) => Promise<ConsentChoice | null>,
  options: { id?: () => string } = {},
): (prompt: CapturePrompt) => Promise<CaptureConsent | null> {
  let n = 0;
  const nextId = options.id ?? (() => `screen-capture-${(n += 1)}`);

  return async (prompt) => {
    const choice = await ask({
      requestId: nextId(),
      title: prompt.title,
      detail: prompt.detail,
      // Two, and never more. The UI renders what it is given, so a standing
      // grant is not offered in the first place — the narrowing below is the
      // second line of defence, not the first.
      options: ["allow_once", "deny"],
      classification: {
        // 3 when the pixels leave the machine: outward-facing, and the level the
        // engine is configured never to auto-allow. 2 when they do not, which is
        // still above the auto-allow line — every capture is asked about.
        level: prompt.leavesMachine ? 3 : 2,
        category: prompt.leavesMachine ? "network" : "read",
        reason: prompt.leavesMachine
          ? "a picture of the whole screen would be sent off this machine"
          : "a picture of the whole screen would be taken",
        forbidden: false,
        // No path: nothing is written. An empty list is the honest answer, and
        // the HUD already renders that case without a file section.
        paths: [],
      },
    });

    // `allow_always`, `deny_always`, and `null` all land on the same answer. A
    // capture is authorised by exactly one value.
    return choice === "allow_once" ? "allow_once" : choice === null ? null : "deny";
  };
}

/**
 * The words the user actually reads.
 *
 * Built here rather than by each caller so the disclosure cannot be weakened by
 * a future call site that phrases it more conveniently. The destination is
 * stated plainly: "I'll send it to the agent" is the part the user is really
 * being asked about, and burying it would make the consent worthless.
 */
export function promptFor(request: CaptureRequest): CapturePrompt {
  const leavesMachine = request.destination === "agent";
  const where = leavesMachine
    ? "The image will be sent to the agent, which may run in the cloud."
    : "The image stays on this machine.";

  return {
    title: "Capture your screen?",
    detail: `${request.reason}\n\n${where} Everything currently visible will be in it.`,
    leavesMachine,
  };
}
