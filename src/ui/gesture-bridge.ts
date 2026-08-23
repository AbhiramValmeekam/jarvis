/**
 * The connection point for an external hand tracker.
 *
 * `NeuralCoreHandle` is already the seam a tracker drives — but reaching it means
 * holding a React ref, and the thing that will actually be producing hand
 * positions is a Python script that has never heard of React. This module puts
 * the same three calls on a plain object hung off `window`, so whatever transport
 * carries the frames (an IPC message, a line of JSON off a child process' stdout,
 * a message event) only has to do this:
 *
 *   window.jarvisGesture?.hand({ x: 0.62, y: 0.44, pinch: 0.19 });
 *
 * Nothing here opens a socket or spawns anything. That is on purpose: the
 * transport is the host application's decision, and a renderer that quietly
 * listened on a port would be a network surface nobody asked for. This is the
 * half that cannot be written by the tracker's author — the mapping from camera
 * coordinates into the scene's own units — and no more.
 *
 * Everything crossing this boundary is untrusted: it comes from a process outside
 * the app, so every field is validated and clamped in `parseHandFrame` before any
 * of it reaches the frame loop.
 */

import type { HandFrame } from "./neural-core-model.js";

/** The part of `NeuralCoreHandle` a tracker needs. */
export interface GestureTarget {
  setHand(frame: HandFrame | null): void;
  setZoom(zoom: number): void;
  pulse(): void;
}

/** What gets published on the host object. */
export interface GestureBridge {
  /**
   * One camera frame. Accepts the object or the raw JSON line a producer printed,
   * so a stdout pipe needs no parsing on the way in. `null` releases the hand and
   * hands control back to the mouse.
   */
  hand(frame: HandFrame | string | null): void;
  /** Absolute zoom, for a producer that would rather map the gesture itself. */
  zoom(zoom: number): void;
  /** Fire the send surge — a gesture bound to "submit", say. */
  pulse(): void;
  /** Explicitly let go, identical to `hand(null)`. */
  release(): void;
  /** Bumped when the shape below changes, so a producer can check it found a peer. */
  readonly version: 1;
}

/** The minimum a host object has to look like. `window` satisfies it. */
export interface GestureHost {
  jarvisGesture?: GestureBridge | undefined;
}

/**
 * Validate one frame from outside the app.
 *
 * Returns null for anything unusable rather than throwing: this is called once
 * per camera frame from code with nowhere useful to put an exception, and a
 * tracker mid-restart emitting a half-written line must not take the HUD down.
 */
export function parseHandFrame(input: unknown): HandFrame | null {
  const raw: unknown = typeof input === "string" ? tryJson(input) : input;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const x = record["x"];
  const y = record["y"];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const frame: HandFrame = { x: x as number, y: y as number };
  // Present-but-unusable is treated as absent, which leaves the zoom alone. A
  // tracker that can see the palm but not the fingertips is the common case.
  const pinch = record["pinch"];
  if (Number.isFinite(pinch)) frame.pinch = pinch as number;
  return frame;
}

function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Publish the bridge on `host`, and return the function that removes it again.
 *
 * Any previous bridge is restored on dispose rather than deleted, so a remount
 * during development cannot leave the window without one.
 */
export function installGestureBridge(target: GestureTarget, host: GestureHost): () => void {
  const previous = host.jarvisGesture;
  const bridge: GestureBridge = {
    version: 1,
    hand(frame) {
      if (frame === null || frame === undefined) return void target.setHand(null);
      const parsed = parseHandFrame(frame);
      // A frame that failed validation is not a release: dropping one bad line
      // should not make the rig snap back to centre mid-gesture.
      if (parsed) target.setHand(parsed);
    },
    zoom(zoom) {
      if (Number.isFinite(zoom)) target.setZoom(zoom);
    },
    pulse() {
      target.pulse();
    },
    release() {
      target.setHand(null);
    },
  };
  host.jarvisGesture = bridge;
  return () => {
    if (host.jarvisGesture === bridge) host.jarvisGesture = previous;
  };
}
