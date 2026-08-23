import { describe, it, expect } from "vitest";
import {
  installGestureBridge,
  parseHandFrame,
  type GestureHost,
  type GestureTarget,
} from "../src/ui/gesture-bridge.js";
import type { HandFrame } from "../src/ui/neural-core-model.js";

/** A stand-in for `NeuralCoreHandle`, recording what a tracker would have driven. */
function target(): GestureTarget & { hands: (HandFrame | null)[]; zooms: number[]; pulses: number } {
  const calls = {
    hands: [] as (HandFrame | null)[],
    zooms: [] as number[],
    pulses: 0,
    setHand(frame: HandFrame | null) {
      calls.hands.push(frame);
    },
    setZoom(zoom: number) {
      calls.zooms.push(zoom);
    },
    pulse() {
      calls.pulses += 1;
    },
  };
  return calls;
}

describe("parseHandFrame", () => {
  it("takes a frame from an object or from the JSON line a producer printed", () => {
    expect(parseHandFrame({ x: 0.4, y: 0.6, pinch: 0.2 })).toEqual({
      x: 0.4,
      y: 0.6,
      pinch: 0.2,
    });
    expect(parseHandFrame('{"x":0.4,"y":0.6,"pinch":0.2}')).toEqual({
      x: 0.4,
      y: 0.6,
      pinch: 0.2,
    });
  });

  it("rejects anything it cannot steer by", () => {
    // A tracker mid-restart emits half-written lines, and a renderer that threw
    // on one would take the HUD down over a partial frame.
    expect(parseHandFrame('{"x":0.4,"y":')).toBeNull();
    expect(parseHandFrame("")).toBeNull();
    expect(parseHandFrame(null)).toBeNull();
    expect(parseHandFrame(42)).toBeNull();
    expect(parseHandFrame({ y: 0.5 })).toBeNull();
    expect(parseHandFrame({ x: "0.4", y: "0.6" })).toBeNull();
    expect(parseHandFrame({ x: Number.NaN, y: 0.5 })).toBeNull();
  });

  it("treats an unmeasurable pinch as absent rather than as zero", () => {
    // Zero would be a full zoom-out command. "I can see the palm but not the
    // fingertips" has to leave the camera where the user put it.
    expect(parseHandFrame({ x: 0.5, y: 0.5, pinch: null })).toEqual({ x: 0.5, y: 0.5 });
    expect(parseHandFrame({ x: 0.5, y: 0.5, pinch: "wide" })).toEqual({ x: 0.5, y: 0.5 });
    expect(parseHandFrame({ x: 0.5, y: 0.5 })?.pinch).toBeUndefined();
  });

  it("drops fields nobody asked for", () => {
    // Untrusted input from another process: only the two or three numbers this
    // scene understands are carried across.
    expect(parseHandFrame({ x: 0.5, y: 0.5, exec: "rm -rf /", at: 12 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });
});

describe("installGestureBridge", () => {
  it("publishes one object a producer can find and call", () => {
    const host: GestureHost = {};
    const core = target();
    installGestureBridge(core, host);

    expect(host.jarvisGesture?.version).toBe(1);
    host.jarvisGesture?.hand({ x: 0.7, y: 0.3, pinch: 0.2 });
    host.jarvisGesture?.hand('{"x":0.2,"y":0.8}');
    host.jarvisGesture?.zoom(1.4);
    host.jarvisGesture?.pulse();

    expect(core.hands).toEqual([{ x: 0.7, y: 0.3, pinch: 0.2 }, { x: 0.2, y: 0.8 }]);
    expect(core.zooms).toEqual([1.4]);
    expect(core.pulses).toBe(1);
  });

  it("releases on null, but not on a frame it failed to parse", () => {
    const host: GestureHost = {};
    const core = target();
    installGestureBridge(core, host);

    host.jarvisGesture?.hand(null);
    host.jarvisGesture?.release();
    expect(core.hands).toEqual([null, null]);

    // One corrupt line must not snap the rig back to centre mid-gesture.
    host.jarvisGesture?.hand("{oops");
    expect(core.hands).toHaveLength(2);
  });

  it("ignores a zoom that is not a number", () => {
    const host: GestureHost = {};
    const core = target();
    installGestureBridge(core, host);
    host.jarvisGesture?.zoom(Number.NaN);
    host.jarvisGesture?.zoom("2" as unknown as number);
    expect(core.zooms).toEqual([]);
  });

  it("puts back whatever it displaced, so a remount cannot strand a producer", () => {
    const previous = { version: 1 } as NonNullable<GestureHost["jarvisGesture"]>;
    const host: GestureHost = { jarvisGesture: previous };

    const dispose = installGestureBridge(target(), host);
    expect(host.jarvisGesture).not.toBe(previous);
    dispose();
    expect(host.jarvisGesture).toBe(previous);
  });

  it("leaves a newer bridge alone when an older one is disposed", () => {
    // Strict mode mounts twice; the second install must survive the first
    // teardown, or the window is left with no bridge at all.
    const host: GestureHost = {};
    const disposeFirst = installGestureBridge(target(), host);
    installGestureBridge(target(), host);
    const second = host.jarvisGesture;
    disposeFirst();
    expect(host.jarvisGesture).toBe(second);
  });
});
