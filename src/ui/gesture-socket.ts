/**
 * The transport half of the gesture seam: a socket to a Python hand tracker.
 *
 * `gesture-bridge.ts` deliberately stops short of opening anything — it maps
 * camera coordinates into the scene's units and puts the result on `window`,
 * and says in as many words that the transport is the host application's
 * decision. This module is that decision, made explicitly and kept separate so
 * the mapping stays usable without it.
 *
 * It connects *out* to a tracker that is already listening, which is the shape
 * an OpenCV script wants anyway:
 *
 *     # python side, ~15 lines with `websockets`
 *     async def emit(ws):
 *         while True:
 *             ws.send(json.dumps({"rotationX": ry, "rotationY": rx, "zoom": z}))
 *
 * Two payload shapes are accepted, because the two producers want different
 * things and neither should have to convert:
 *
 *   `{ rotationX, rotationY, zoom }`  — intent, −1 … 1 per axis (or radians with
 *      `rotationUnit: "radians"`), and an absolute zoom. What a script that has
 *      already done its own smoothing sends.
 *   `{ x, y, pinch }`                 — raw camera coordinates, the `HandFrame`
 *      shape `parseHandFrame` already validates. What a script that would rather
 *      hand over landmarks and let this side do the mapping sends.
 *
 * `{ "release": true }`, `null`, or simply going quiet gives control back to the
 * mouse — the last one for free, since the scene already ignores a hand pose
 * older than `HAND_TIMEOUT_MS`.
 *
 * Three properties this has to have, and the reasons they are not optional:
 *
 *   - **Off unless asked for.** No endpoint, no socket. A renderer that dialled
 *     a local port on its own would be a channel nobody opted into, and the
 *     always-on case is a HUD sitting there for weeks.
 *   - **Nothing here can do anything but move the camera.** The socket calls
 *     `setHand` and `setZoom` and nothing else. `pulse()` is reachable through
 *     the window bridge but not from the wire, and no path from here sends a
 *     prompt or triggers an action, so the worst a hostile local process can do
 *     with port 8765 is spin the orb.
 *   - **It cannot throw into the frame loop.** Every field is validated and
 *     clamped, a malformed line is dropped rather than treated as a release, and
 *     a socket that dies reconnects on a backoff instead of taking the HUD down.
 */

import {
  HAND_MAX_PITCH,
  HAND_MAX_YAW,
  clampZoom,
  type HandFrame,
} from "./neural-core-model.js";
import { parseHandFrame, type GestureTarget } from "./gesture-bridge.js";

/** Where a tracker is assumed to be listening when none is named. */
export const DEFAULT_GESTURE_ENDPOINT = "ws://127.0.0.1:8765";

/** What a rotation field means. Normalised intent unless the producer says otherwise. */
export type RotationUnit = "normalized" | "radians";

/** One payload, validated and mapped into the calls the handle already takes. */
export interface GestureCommand {
  /**
   * Let go: the rig recentres and the mouse takes over. Distinct from `frame:
   * null`, which only means this payload carried no pose — a zoom-only message
   * from a hand held still must not release the hand it is holding.
   */
  release: boolean;
  /** The pose to hold, or null when this payload carried none. */
  frame: HandFrame | null;
  /** An absolute zoom to apply after the pose, or null to leave it alone. */
  zoom: number | null;
}

/**
 * A rotation intent as the camera coordinates that produce it.
 *
 * The point of going *back* through the frame shape rather than writing yaw and
 * pitch straight onto the rig: `setHand` is the path that already exists, and it
 * eases, mirrors, times out and hands back to the mouse. A second entry point
 * that set the tilt directly would be a second set of those behaviours to keep
 * in agreement, and the first bug in this feature was exactly that kind of
 * divergence.
 *
 * So this inverts `handToPointer` ∘ `handTilt`: feed the result to `setHand` and
 * the assembly ends up at `rotationX` radians of pitch and `rotationY` of yaw,
 * to the clamp. `tests/gesture-socket.test.ts` asserts the round trip rather
 * than trusting the arithmetic here.
 */
export function rotationToFrame(
  rotationX: number,
  rotationY: number,
  unit: RotationUnit = "normalized",
): HandFrame {
  const pitch = axis(rotationX, unit === "radians" ? HAND_MAX_PITCH : 1);
  const yaw = axis(rotationY, unit === "radians" ? HAND_MAX_YAW : 1);
  // Mirrored on the x axis to match `handToPointer`'s selfie-view assumption:
  // the hand moving right must lean the assembly right, not away from it.
  return { x: (1 + yaw) / 2, y: (1 - pitch) / 2 };
}

/** One axis of intent, normalised and clamped. Unusable reads as centred. */
function axis(n: number, scale: number): number {
  if (!Number.isFinite(n) || scale === 0) return 0;
  return Math.min(1, Math.max(-1, n / scale));
}

/**
 * One payload from the tracker, in whichever shape it came.
 *
 * Returns null for anything unusable, which the caller drops. Deliberately not a
 * release: a tracker mid-restart writing half a line must not make the rig snap
 * back to centre in the middle of a gesture.
 */
export function parseGesturePayload(
  input: unknown,
  unit: RotationUnit = "normalized",
): GestureCommand | null {
  const raw: unknown = typeof input === "string" ? tryJson(input) : input;
  // A line that would not parse is not a release. `tryJson` reports failure with
  // a sentinel rather than null for exactly this: the literal text `null` *is* a
  // release, and a half-written line from a restarting tracker is not, and both
  // would arrive as null if the distinction were thrown away here.
  if (raw === UNPARSABLE) return null;
  if (raw === null || raw === undefined) return RELEASE;
  if (typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record["release"] === true) return RELEASE;

  const zoomField = record["zoom"];
  const zoom = Number.isFinite(zoomField) ? clampZoom(zoomField as number) : null;

  // The native shape wins when it is present, because it carries more: `pinch`
  // is a measurement, where `zoom` is already somebody's interpretation of one.
  const native = parseHandFrame(record);
  if (native) return { release: false, frame: native, zoom };

  const rx = record["rotationX"];
  const ry = record["rotationY"];
  if (Number.isFinite(rx) || Number.isFinite(ry)) {
    return {
      release: false,
      frame: rotationToFrame(Number(rx) || 0, Number(ry) || 0, unit),
      zoom,
    };
  }
  // Zoom on its own is legitimate — a pinch with the hand held still.
  if (zoom !== null) return { release: false, frame: null, zoom };
  return null;
}

const RELEASE: GestureCommand = { release: true, frame: null, zoom: null };

/** Returned by `tryJson` when the text was not JSON at all. */
const UNPARSABLE = Symbol("unparsable");

function tryJson(line: string): unknown {
  if (line.trim() === "") return UNPARSABLE;
  try {
    return JSON.parse(line);
  } catch {
    return UNPARSABLE;
  }
}

/** Apply one command to the core. The only two calls this module ever makes. */
export function applyGestureCommand(target: GestureTarget, command: GestureCommand): void {
  if (command.release) return void target.setHand(null);
  if (command.frame) target.setHand(command.frame);
  // After the pose, not before: `setHand` writes the zoom itself when the frame
  // carried a `pinch`, and an explicit `zoom` is the producer overruling that.
  if (command.zoom !== null) target.setZoom(command.zoom);
}

// --- transport --------------------------------------------------------------

/**
 * The little of a WebSocket this module uses.
 *
 * Structural rather than the DOM type on purpose: every other module under
 * `src/ui` that the Node-side `tsconfig.json` also compiles stays free of DOM
 * types so it can be unit-tested without a browser, and the tests here drive a
 * fake through this interface rather than standing up a real server.
 */
export interface GestureSocketLike {
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface GestureSocketOptions {
  /** Where the tracker is listening. Omitted or empty means: do not connect. */
  endpoint?: string | null | undefined;
  /** How to read `rotationX`/`rotationY`. Default normalised −1 … 1. */
  rotationUnit?: RotationUnit;
  /** Opens a socket. Injected by the tests; defaults to the global WebSocket. */
  createSocket?: (endpoint: string) => GestureSocketLike;
  /** First retry delay. Doubles per failure up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Told about connect/disconnect, for a host that wants to show it. */
  onStateChange?: (connected: boolean) => void;
}

/**
 * Connect to a tracker and steer the core with what it sends.
 *
 * Returns the teardown, which is unconditional: it cancels a pending retry,
 * closes the socket, and releases the hand, so a component unmounting mid-gesture
 * cannot leave the rig frozen at the last pose a dead tracker sent.
 *
 * Never throws. A refused connection, a garbage frame and a tracker that was
 * never started are all the same event as far as the HUD is concerned — the mouse
 * keeps working and the retry timer keeps trying, quietly.
 */
export function connectGestureSocket(
  target: GestureTarget,
  options: GestureSocketOptions = {},
): () => void {
  const endpoint = options.endpoint?.trim();
  if (!endpoint) return () => {};

  const base = options.baseDelayMs ?? 800;
  const max = options.maxDelayMs ?? 10_000;
  const unit = options.rotationUnit ?? "normalized";
  const open = options.createSocket ?? defaultSocketFactory();
  if (!open) return () => {};

  let socket: GestureSocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;

  const connect = (): void => {
    if (disposed) return;
    let next: GestureSocketLike;
    try {
      next = open(endpoint);
    } catch {
      // A malformed endpoint throws synchronously on construction. Retrying is
      // still right: the string comes from configuration, and the alternative is
      // a HUD that silently never tries again after one typo is fixed.
      return retry();
    }
    socket = next;

    next.onopen = () => {
      attempt = 0;
      options.onStateChange?.(true);
    };
    next.onmessage = (event) => {
      const command = parseGesturePayload(event?.data, unit);
      // Dropped, not released — see `parseGesturePayload`.
      if (command) applyGestureCommand(target, command);
    };
    next.onerror = () => {
      // Nothing: a WebSocket error is always followed by a close, and handling
      // both would count one failure twice and double the backoff each time.
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      options.onStateChange?.(false);
      // The handback. Staleness would get there on its own after
      // HAND_TIMEOUT_MS, but a tracker whose socket just closed is gone now, and
      // holding its last pose for another 450 ms reads as a stuck HUD.
      target.setHand(null);
      retry();
    };
  };

  const retry = (): void => {
    if (disposed || timer) return;
    const delay = Math.min(max, base * Math.pow(2, attempt));
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    // Never hold the process open for a retry. Matters for the probes, which
    // exit when their work is done rather than when the event loop drains.
    timer.unref?.();
  };

  connect();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    const held = socket;
    socket = null;
    if (held) {
      // Detached first: closing fires `onclose`, and a handler that still ran
      // would schedule a retry for a socket the caller has just disowned.
      held.onopen = held.onclose = held.onerror = null;
      held.onmessage = null;
      try {
        held.close();
      } catch {
        /* already gone */
      }
    }
    target.setHand(null);
  };
}

/**
 * The platform WebSocket, or null where there isn't one.
 *
 * Looked up through `globalThis` rather than named directly so this module stays
 * compilable without the DOM lib, and returns null under Node so
 * `connectGestureSocket` degrades to a no-op instead of a crash.
 */
function defaultSocketFactory(): ((endpoint: string) => GestureSocketLike) | null {
  const ctor = (globalThis as { WebSocket?: new (url: string) => GestureSocketLike }).WebSocket;
  if (typeof ctor !== "function") return null;
  return (endpoint: string) => new ctor(endpoint);
}
