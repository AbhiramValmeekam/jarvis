import { describe, it, expect } from "vitest";
import { orbLook } from "../src/ui/hud-model.js";
import {
  approach,
  assemblyTilt,
  clampZoom,
  coreEnergy,
  coreLook,
  handStale,
  handTilt,
  handToPointer,
  motionScale,
  orbitalZoom,
  particleBudget,
  pinchZoom,
  renderScale,
  shockAt,
  shockFor,
  surgeAt,
  zoomByDrag,
  zoomByWheel,
  HAND_MAX_PITCH,
  HAND_MAX_YAW,
  HAND_TIMEOUT_MS,
  MAX_TILT,
  PARTICLE_MAX,
  PARTICLE_MIN,
  PINCH_MAX,
  PINCH_MIN,
  SHOCK_TRANSIT,
  SURGE_TAU,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../src/ui/neural-core-model.js";
import type { HudFacts } from "../src/ui/hud-model.js";

const facts = (over: Partial<HudFacts> = {}): HudFacts => ({
  connected: true,
  state: "idle",
  muted: false,
  listening: true,
  hermesState: "ready",
  ...over,
});

/** `#rrggbb` → the three channels as 0 … 1. */
const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

/** HSL saturation — how far the colour is from grey. */
const saturation = (hex: string): number => {
  const rgb = channels(hex);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const lightness = (max + min) / 2;
  const spread = 1 - Math.abs(2 * lightness - 1);
  return spread === 0 ? 0 : (max - min) / spread;
};

/** The strongest channel — how hot the colour is, independent of its hue. */
const brightest = (hex: string): number => Math.max(...channels(hex));

/** Ring radii, mirroring `RINGS` in `neural-scene.tsx`, innermost first. */
const RINGS = [1.9, 2.5, 3.2, 4.1] as const;

/**
 * How large ring `i` appears on screen at this zoom, as a fraction of the camera
 * distance — the same arithmetic `CameraRig` and `Rings` perform between them:
 * the camera sits at 11 / zoom, the assembly contracts by `scale`, and ring `i`
 * is pushed `i * spread` further back inside it.
 */
const apparent = (radius: number, i: number, zoom: number): number => {
  const { scale, spread } = orbitalZoom(zoom);
  return (radius * scale) / (11 / zoom + i * spread * scale);
};

/** Largest ÷ smallest — how nested a set of apparent sizes still is. */
const spreadOf = (sizes: number[]): number => Math.max(...sizes) / Math.min(...sizes);


describe("core look", () => {  it("inherits the orb's honesty rules rather than restating them", () => {
    // The 3D core must not become a second, laxer source of truth: if the orb
    // would say "muted", so does this, whatever the runtime's last state was.
    expect(coreLook(facts({ muted: true, state: "listening" })).mode).toBe("muted");
    expect(coreLook(facts({ connected: false, state: "speaking" })).mode).toBe("offline");
    expect(coreLook(facts({ state: "executing" })).mode).toBe("thinking");
    expect(coreLook(facts({ voiceState: "stopped", capturing: false })).mode).toBe("deaf");
  });

  it("stops the rings dead when the runtime is gone", () => {
    // Not "slows them". A core still turning after the runtime died reads as
    // work in progress, which is the one thing it must never imply.
    expect(coreLook(facts({ connected: false })).spin).toBe(0);
    expect(coreLook(facts()).spin).toBeGreaterThan(0);
  });

  it("keeps the label the orb would have used", () => {
    expect(coreLook(facts({ connected: false })).label).toBe("Runtime not connected");
    // Not a literal phrase: the wake-word wording belongs to hud-model, which has
    // already changed it once (it now offers the shortest phrase the daemon answers
    // to). What this file is entitled to pin is that the core repeats it verbatim.
    const woken = facts({ wakeWord: "hey_jarvis" });
    expect(coreLook(woken).label).toBe(orbLook(woken).label);
  });

  it("drops the amber scheme for red on error, and drains it when nothing runs", () => {
    const error = coreLook(facts({ state: "error" })).palette;
    const idle = coreLook(facts()).palette;
    const offline = coreLook(facts({ connected: false })).palette;
    expect(error.glow).not.toBe(idle.glow);
    expect(offline.glow).not.toBe(idle.glow);
    // Warm and bright is reserved for states that are actually happening.
    expect(coreLook(facts({ connected: false })).bloom).toBeLessThan(coreLook(facts()).bloom);
  });

  it("keeps every live hue a saturated orange, and every dead one drained", () => {
    // The refinement this pins: the live palette is neon orange rather than the
    // dusty browns it started as. It is a range check rather than a list of hex
    // strings so the colours can still be tuned — what must not change is that
    // "running" is vivid and "not running" is not, since that contrast is the
    // only thing telling the two apart at a glance. Both halves are orange now;
    // the contrast lives in brightness rather than in hue.
    const live = [
      coreLook(facts()),
      coreLook(facts({ state: "listening" })),
      coreLook(facts({ state: "thinking" })),
      coreLook(facts({ state: "speaking" })),
    ];
    for (const look of live) {
      for (const hex of [look.palette.glow, look.palette.ring, look.palette.particle]) {
        expect(saturation(hex)).toBeGreaterThan(0.7);
        expect(brightest(hex)).toBeGreaterThan(0.9);
      }
    }

    const dead = [
      coreLook(facts({ connected: false })),
      coreLook(facts({ muted: true })),
      coreLook(facts({ voiceState: "stopped", capturing: false })),
    ];
    for (const look of dead) {
      for (const hex of [look.palette.glow, look.palette.ring, look.palette.particle]) {
        // Dimmed, not drained: the dead states stay in the orange family so the
        // HUD has one colour, and brightness alone carries "nothing running".
        expect(brightest(hex)).toBeLessThan(0.6);
        expect(saturation(hex)).toBeGreaterThan(0.5);
      }
    }
  });

  it("swells to the microphone only while the microphone is open", () => {
    const listening = coreLook(facts({ state: "listening" }), 1).swell;
    const quiet = coreLook(facts({ state: "listening" }), 0).swell;
    expect(listening).toBeGreaterThan(quiet);
    // Same level, mic not listening: nothing moves. A core pulsing to a meter
    // that is not being fed is animation pretending to be evidence.
    expect(coreLook(facts({ state: "thinking" }), 1).swell).toBe(
      coreLook(facts({ state: "thinking" }), 0).swell,
    );
    expect(coreLook(facts({ state: "listening" }), Number.NaN).swell).toBe(quiet);
    // Clamped, for the same reason `orbScale` clamps: an RMS spike must not
    // throw the core through the front of the camera.
    expect(coreLook(facts({ state: "listening" }), 40).swell).toBe(listening);
  });
});

describe("energy surges", () => {
  it("peaks the moment something is sent and fades on its own", () => {
    expect(surgeAt(10, 10)).toBeCloseTo(1, 6);
    expect(surgeAt(10 + SURGE_TAU, 10)).toBeCloseTo(Math.exp(-1), 6);
    // Well past the tail it is effectively nothing — the rig has to end up back
    // where it started, or every message would leave it permanently louder.
    expect(surgeAt(10 + SURGE_TAU * 8, 10)).toBeLessThan(0.01);
  });

  it("is nothing at all before the first message", () => {
    // 0 is the starting value of the timestamp ref, not a time.
    expect(surgeAt(10, 0)).toBe(0);
    expect(surgeAt(Number.NaN, 10)).toBe(0);
    expect(surgeAt(10, Number.NaN)).toBe(0);
    // A clock that jumped backwards should read as "just fired", not as silence.
    expect(surgeAt(9, 10)).toBe(1);
  });

  it("spins up, glows harder and churns more while a turn is live", () => {
    const rest = coreEnergy(coreLook(facts({ state: "thinking" })), 0);
    const surged = coreEnergy(coreLook(facts({ state: "thinking" })), 1);
    expect(surged.spin).toBeGreaterThan(rest.spin);
    expect(surged.bloom).toBeGreaterThan(rest.bloom);
    expect(surged.agitation).toBeGreaterThan(rest.agitation);
    expect(surged.swell).toBeGreaterThan(rest.swell);
    // At rest it is exactly the mode's own numbers, so nothing here can drift the
    // resting look away from the table above.
    const look = coreLook(facts({ state: "thinking" }));
    expect(rest).toEqual({
      spin: look.spin,
      bloom: look.bloom,
      agitation: look.agitation,
      swell: look.swell,
    });
  });

  it("will not animate a runtime that is not there", () => {
    // The honesty rule, applied to the new input: typing into a HUD with no
    // runtime behind it must not spin the rings up as though something received
    // the message. Nothing did.
    for (const dead of [
      facts({ connected: false }),
      facts({ muted: true }),
      facts({ voiceState: "stopped", capturing: false }),
      facts({ state: "error" }),
    ]) {
      const look = coreLook(dead);
      expect(coreEnergy(look, 1)).toEqual(coreEnergy(look, 0));
    }
    expect(coreEnergy(coreLook(facts({ connected: false })), 1).spin).toBe(0);
  });

  it("is bounded, so a surge cannot outrun the states it decorates", () => {
    const listening = coreLook(facts({ state: "listening" }));
    // A surge is a fraction, and anything outside 0 … 1 is clamped to it — the
    // mic level feeding this is a measurement, and measurements spike.
    expect(coreEnergy(listening, 40)).toEqual(coreEnergy(listening, 1));
    expect(coreEnergy(listening, -5)).toEqual(coreEnergy(listening, 0));
    expect(coreEnergy(listening, Number.NaN)).toEqual(coreEnergy(listening, 0));
    // The field's drift has a hard ceiling: past it the shader's displacement
    // scatters particles out of the shell entirely.
    expect(coreEnergy(listening, 1).agitation).toBeLessThanOrEqual(1.4);
  });
});

describe("motion", () => {
  it("silences autonomous movement when the OS asks for it", () => {
    expect(motionScale(true)).toBe(0);
    expect(motionScale(false)).toBe(1);
  });
});

describe("zoom", () => {
  it("stays inside the range whatever it is handed", () => {
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(-99)).toBe(ZOOM_MIN);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(1.4)).toBeCloseTo(1.4);
  });

  it("zooms in on a scroll up and out on a scroll down", () => {
    // Scrolling up is a negative deltaY and means "closer", which is the
    // direction every map and image viewer on this platform agrees on. The
    // assertion is on the zoom number: bigger is closer, because `CameraRig`
    // divides the base distance by it.
    expect(zoomByWheel(1, -120)).toBeGreaterThan(1);
    expect(zoomByWheel(1, 120)).toBeLessThan(1);
    expect(zoomByWheel(1, 0)).toBe(1);
  });

  it("cannot be flung past the range by one enormous delta", () => {
    // A trackpad fling and a `deltaMode: LINE` mouse disagree about scale by
    // two orders of magnitude, so the response is bounded rather than linear.
    expect(zoomByWheel(1, 100_000)).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(zoomByWheel(1, -100_000)).toBeLessThanOrEqual(ZOOM_MAX);
    expect(zoomByWheel(1, Number.NaN)).toBe(1);
  });

  it("feels the same near and far — one notch is a ratio, not a step", () => {
    const near = zoomByWheel(1, -100) / 1;
    const far = zoomByWheel(2, -100) / 2;
    expect(near).toBeCloseTo(far, 6);
  });

  it("drags up to zoom in, and scales the gesture to the viewport", () => {
    expect(zoomByDrag(1, 200, 800)).toBeGreaterThan(1);
    expect(zoomByDrag(1, -200, 800)).toBeLessThan(1);
    // Same pixels on a shorter viewport is a bigger fraction of it, so a bigger
    // gesture — which is what makes this map onto a hand at any camera distance.
    expect(zoomByDrag(1, 200, 400)).toBeGreaterThan(zoomByDrag(1, 200, 800));
    expect(zoomByDrag(1, 200, 0)).toBeLessThanOrEqual(ZOOM_MAX);
  });
});

describe("orbital zoom", () => {
  it("does nothing at the resting framing", () => {
    // Zoom 1 is the state the ring radii and tilts were authored against, so it
    // has to be the identity or the stack no longer matches its own spec.
    const rest = orbitalZoom(1);
    expect(rest.scale).toBeCloseTo(1, 6);
    expect(rest.spread).toBe(0);
  });

  it("pulls the assembly in and opens the stack up as the camera closes", () => {
    const near = orbitalZoom(ZOOM_MAX);
    expect(near.scale).toBeLessThan(1);
    expect(near.spread).toBeGreaterThan(0);
  });

  it("still magnifies overall, despite the assembly shrinking", () => {
    // The contraction must not eat the zoom: the camera closes by z, the
    // assembly shrinks by scale, and the product is what the user actually sees.
    for (const zoom of [1.4, 2, ZOOM_MAX]) {
      expect(zoom * orbitalZoom(zoom).scale).toBeGreaterThan(1.15);
    }
  });

  it("keeps the camera outside the particle shell at every zoom", () => {
    // The failure this exists to prevent, found by screenshot: at full zoom the
    // camera sits at 11 / 2.6 ≈ 4.2, which is inside the field's 4.8 outer
    // radius, so the field became a wall of blurred near points in front of the
    // core. The assembly has to contract faster than the camera closes.
    for (const zoom of [ZOOM_MIN, 1, 1.8, 2.2, ZOOM_MAX]) {
      expect(4.8 * orbitalZoom(zoom).scale).toBeLessThan(11 / zoom);
    }
  });

  it("keeps the outer ring inside the frame at full zoom", () => {
    // The other framing failure: rings that grow until they crop against the
    // panel edges. At zoom z the camera sits at 11/z, the outer ring is pushed
    // back by 3 * spread, and the visible half-height at that depth is
    // tan(22.5°) * (camera - ring z). The ring must fit inside it.
    for (const zoom of [1, 1.5, 2, ZOOM_MAX]) {
      const { scale, spread } = orbitalZoom(zoom);
      const camera = 11 / zoom;
      const radius = 4.1 * scale;
      const halfHeight = Math.tan((45 * Math.PI) / 360) * (camera + 3 * spread * scale);
      expect(radius).toBeLessThan(halfHeight);
    }
  });

  it("turns the nested stack into a tunnel rather than a bigger flat stack", () => {
    // What "immersive perspective shift" has to mean geometrically. At rest the
    // four rings are nested — the outermost covers a bit over twice the screen
    // radius of the innermost. Zoomed in they converge on nearly the same apparent
    // size at increasing depth, which is what a tunnel is: the near ring grows
    // into the frame while the far one is pushed back to meet it. Without this the
    // rings could satisfy every other test here by scaling together, which is
    // exactly the flat gyroscope look being replaced.
    expect(spreadOf(RINGS.map((r, i) => apparent(r, i, 1)))).toBeGreaterThan(2);
    expect(spreadOf(RINGS.map((r, i) => apparent(r, i, ZOOM_MAX)))).toBeLessThan(1.25);

    // And the near end genuinely closes in — the innermost ring and the core both
    // grow, so the tunnel is entered rather than merely flattened.
    expect(apparent(RINGS[0], 0, ZOOM_MAX)).toBeGreaterThan(apparent(RINGS[0], 0, 1) * 1.5);
  });

  it("stays flat when zoomed out, and never leans on an unclamped zoom", () => {
    expect(orbitalZoom(ZOOM_MIN).spread).toBe(0);
    expect(orbitalZoom(ZOOM_MIN).scale).toBeGreaterThan(1);
    expect(orbitalZoom(Number.NaN)).toEqual(orbitalZoom(1));
    expect(orbitalZoom(999)).toEqual(orbitalZoom(ZOOM_MAX));
  });
});

describe("assembly tilt", () => {
  it("is level when the cursor is centred", () => {
    // Compared numerically rather than structurally: negating a zero gives -0,
    // which `toEqual` calls a difference and every renderer treats as zero.
    const tilt = assemblyTilt(0, 0);
    expect(tilt.x).toBeCloseTo(0, 10);
    expect(tilt.y).toBeCloseTo(0, 10);
  });

  it("leans into the cursor rather than away from it", () => {
    // Cursor top-right: the assembly's top-right corner has to come toward the
    // viewer. Rotating +x toward +z is a negative rotation about y, and lifting
    // +y toward +z is a positive rotation about x — get either sign wrong and the
    // rig visibly shies away from the pointer.
    const topRight = assemblyTilt(1, 1);
    expect(topRight.y).toBeLessThan(0);
    expect(topRight.x).toBeGreaterThan(0);
    const bottomLeft = assemblyTilt(-1, -1);
    expect(bottomLeft.y).toBeGreaterThan(0);
    expect(bottomLeft.x).toBeLessThan(0);
  });

  it("is bounded, whatever it is handed", () => {
    // A hand tracker is entitled to hand this 4.2 or a NaN; neither may flip the
    // assembly onto its back.
    for (const [x, y] of [[9, -9], [Number.NaN, Number.NaN], [1, 1], [-1, -1]]) {
      const tilt = assemblyTilt(x as number, y as number);
      expect(Math.abs(tilt.x)).toBeLessThanOrEqual(MAX_TILT);
      expect(Math.abs(tilt.y)).toBeLessThanOrEqual(MAX_TILT);
    }
    expect(assemblyTilt(Number.NaN, Number.NaN).x).toBeCloseTo(0, 10);
    expect(assemblyTilt(Number.NaN, Number.NaN).y).toBeCloseTo(0, 10);
  });

  it("scales smoothly with the cursor instead of snapping at the edges", () => {
    expect(Math.abs(assemblyTilt(0.5, 0).y)).toBeLessThan(Math.abs(assemblyTilt(1, 0).y));
  });
});

describe("frame loop", () => {
  it("eases at the same rate whatever the frame rate is", () => {
    // The bug this function exists to prevent: `x += (target - x) * 0.1` closes
    // twice as much ground per second at 120 Hz as at 60, so the same code feels
    // different on different machines. Sixty 16.6 ms steps and a hundred and
    // twenty 8.3 ms steps must land in the same place.
    let sixty = 0;
    for (let i = 0; i < 60; i += 1) sixty = approach(sixty, 1, 1 / 60, 0.2);
    let oneTwenty = 0;
    for (let i = 0; i < 120; i += 1) oneTwenty = approach(oneTwenty, 1, 1 / 120, 0.2);
    expect(sixty).toBeCloseTo(oneTwenty, 4);
  });

  it("closes roughly 63% of the gap in one time constant", () => {
    expect(approach(0, 1, 0.2, 0.2)).toBeCloseTo(0.632, 2);
  });

  it("does not teleport after a long stall", () => {
    // A window hidden for a minute hands back one enormous dt on the first
    // visible frame. Unclamped, everything in the scene would snap at once.
    expect(approach(0, 1, 60, 0.2)).toBeLessThan(1);
    expect(approach(0, 1, 60, 0.2)).toBe(approach(0, 1, 0.25, 0.2));
  });

  it("ignores a dt that cannot have happened", () => {
    expect(approach(0.5, 1, 0, 0.2)).toBe(0.5);
    expect(approach(0.5, 1, -1, 0.2)).toBe(0.5);
    expect(approach(0.5, 1, Number.NaN, 0.2)).toBe(0.5);
    expect(approach(0.5, 1, 0.016, 0)).toBe(1);
  });
});

describe("budgets", () => {
  it("spends more particles on a bigger canvas, within limits", () => {
    const panel = particleBudget(460, 620);
    const fullScreen = particleBudget(2560, 1440);
    expect(panel).toBeGreaterThanOrEqual(PARTICLE_MIN);
    expect(fullScreen).toBeGreaterThan(panel);
    expect(fullScreen).toBeLessThanOrEqual(PARTICLE_MAX);
  });

  it("survives a canvas that has not been laid out yet", () => {
    expect(particleBudget(0, 0)).toBe(PARTICLE_MIN);
    expect(particleBudget(-100, 200)).toBe(PARTICLE_MIN);
  });

  it("caps the pixel ratio instead of honouring a 3x display", () => {
    // 150% Windows scaling would otherwise quadruple the fragment cost of a
    // bloom pass whose output is blurred anyway.
    expect(renderScale(1)).toBe(1);
    expect(renderScale(1.5)).toBeCloseTo(1.5);
    expect(renderScale(3)).toBe(1.75);
    expect(renderScale(0)).toBe(1);
    expect(renderScale(Number.NaN)).toBe(1);
  });
});

describe("hand tracking", () => {
  it("maps a mirrored camera frame into clip space", () => {
    // Centre of frame is centre of clip space, whichever way it is mirrored.
    const centre = handToPointer({ x: 0.5, y: 0.5 });
    expect(centre.x).toBeCloseTo(0, 10);
    expect(centre.y).toBeCloseTo(0, 10);
    expect(centre.active).toBe(true);
    // A hand on the user's right lands on the left of an unflipped image, so a
    // mirrored frame has to come out positive or the core leans away from them.
    expect(handToPointer({ x: 0.1, y: 0.5 }).x).toBeGreaterThan(0);
    expect(handToPointer({ x: 0.1, y: 0.5 }, false).x).toBeLessThan(0);
    // Image y runs down and clip space runs up.
    expect(handToPointer({ x: 0.5, y: 0.1 }).y).toBeGreaterThan(0);
  });

  it("clamps a hand that the tracker put outside the frame", () => {
    const wild = handToPointer({ x: 4, y: -3 });
    expect(wild.x).toBeGreaterThanOrEqual(-1);
    expect(wild.x).toBeLessThanOrEqual(1);
    expect(wild.y).toBeGreaterThanOrEqual(-1);
    expect(wild.y).toBeLessThanOrEqual(1);
    // A frame the tracker could not measure is centred, not pinned to an edge.
    const broken = handToPointer({ x: Number.NaN, y: Number.NaN });
    expect(broken.x).toBeCloseTo(0, 10);
    expect(broken.y).toBeCloseTo(0, 10);
    expect(broken.active).toBe(true);
  });

  it("turns a pinch into zoom, spreading to zoom in", () => {
    expect(pinchZoom(PINCH_MIN)).toBeCloseTo(ZOOM_MIN, 5);
    expect(pinchZoom(PINCH_MAX)).toBeCloseTo(ZOOM_MAX, 5);
    expect(pinchZoom((PINCH_MIN + PINCH_MAX) / 2)).toBeGreaterThan(ZOOM_MIN);
    expect(pinchZoom(0.2)).toBeGreaterThan(pinchZoom(0.1));
  });

  it("clamps a mismeasured pinch instead of flying through the core", () => {
    expect(pinchZoom(-5)).toBe(ZOOM_MIN);
    expect(pinchZoom(0.95)).toBe(ZOOM_MAX);
    expect(pinchZoom(Number.NaN)).toBe(1);
  });

  it("keeps a pinch geometric, so travel means a ratio not a distance", () => {
    // The same span of finger movement is the same *multiple* of zoom wherever
    // it happens — the property `zoomByWheel` has, for the same reason.
    const step = (PINCH_MAX - PINCH_MIN) / 4;
    const low = pinchZoom(PINCH_MIN + step) / pinchZoom(PINCH_MIN);
    const high = pinchZoom(PINCH_MIN + step * 3) / pinchZoom(PINCH_MIN + step * 2);
    expect(low).toBeCloseTo(high, 5);
  });

  it("rotates further than the cursor does, and never translates", () => {
    // The point of the whole hand path: lateral movement is yaw. A hand crossing
    // the frame would walk a translating rig out of a 460-pixel panel.
    expect(handTilt(1, 0).y).toBeCloseTo(-HAND_MAX_YAW, 5);
    expect(handTilt(-1, 0).y).toBeCloseTo(HAND_MAX_YAW, 5);
    expect(handTilt(0, 1).x).toBeCloseTo(HAND_MAX_PITCH, 5);
    expect(Math.abs(handTilt(1, 1).y)).toBeGreaterThan(Math.abs(assemblyTilt(1, 1).y));
    // Same signs as the cursor's, so a mouse and a hand agree about which way is
    // which — whichever is driving, the near side follows the input.
    expect(Math.sign(handTilt(0.7, 0.3).x)).toBe(Math.sign(assemblyTilt(0.7, 0.3).x));
    expect(Math.sign(handTilt(0.7, 0.3).y)).toBe(Math.sign(assemblyTilt(0.7, 0.3).y));
  });

  it("keeps pitch shallower than yaw so the rings stay readable", () => {
    expect(HAND_MAX_PITCH).toBeLessThan(HAND_MAX_YAW);
  });

  it("lets go of a hand that stopped arriving", () => {
    expect(handStale(1_000, 1_000 - HAND_TIMEOUT_MS + 1)).toBe(false);
    expect(handStale(1_000, 1_000 - HAND_TIMEOUT_MS - 1)).toBe(true);
    // Nothing has ever been tracked.
    expect(handStale(1_000, 0)).toBe(true);
    expect(handStale(1_000, Number.NaN)).toBe(true);
    // A frame stamped in the future is a clock disagreement, not a dead tracker.
    expect(handStale(1_000, 5_000)).toBe(false);
  });
});

describe("the discharge a send fires", () => {
  it("starts at the innermost shell and reaches the rim, once", () => {
    // Fired at t = 10, sampled across the transit.
    expect(shockAt(10, 10).front).toBe(0);
    expect(shockAt(10 + SHOCK_TRANSIT / 2, 10).front).toBeCloseTo(0.5, 5);
    expect(shockAt(10 + SHOCK_TRANSIT, 10).front).toBeCloseTo(1, 9);
    // And then it is gone rather than parked at the rim, which would leave the
    // outer shell permanently lit after the first message of the session.
    expect(shockAt(10 + SHOCK_TRANSIT + 0.001, 10)).toEqual({ front: 0, energy: 0 });
  });

  it("moves outwards and never backwards while it is travelling", () => {
    let previous = -1;
    for (let i = 0; i <= 20; i += 1) {
      const front = shockAt(10 + (SHOCK_TRANSIT * i) / 20, 10).front;
      expect(front).toBeGreaterThan(previous);
      previous = front;
    }
  });

  it("snaps up and eases off, so it is spent by the time it lands", () => {
    const attack = shockAt(10.02, 10).energy;
    const peak = shockAt(10 + SHOCK_TRANSIT * 0.12, 10).energy;
    const late = shockAt(10 + SHOCK_TRANSIT * 0.85, 10).energy;
    expect(attack).toBeLessThan(peak);
    expect(peak).toBeCloseTo(1, 5);
    expect(late).toBeLessThan(peak);
    // Reaching the rim dark is the point: a front at full brightness that simply
    // stops reads as a dropped frame rather than as a discharge dissipating.
    expect(shockAt(10 + SHOCK_TRANSIT, 10).energy).toBeCloseTo(0, 9);
  });

  it("does not fire on a clock that has not fired, or one that moved", () => {
    expect(shockAt(10, 0)).toEqual({ front: 0, energy: 0 });
    expect(shockAt(10, Number.NaN)).toEqual({ front: 0, energy: 0 });
    expect(shockAt(Number.NaN, 10)).toEqual({ front: 0, energy: 0 });
    // A send stamped in the future has not crossed anything yet.
    expect(shockAt(10, 20)).toEqual({ front: 0, energy: 0 });
  });

  it("fires with the microphone off, and stays dark with no runtime", () => {
    const travelling = shockAt(10.2, 10);
    expect(travelling.energy).toBeGreaterThan(0);
    // Voice off is a microphone state. The message still went somewhere, so the
    // field still acknowledges it — this is the case `coreEnergy`'s live-mode
    // gate swallows, and the reason this gate is its own function.
    expect(shockFor(coreLook(facts({ voiceState: "stopped", capturing: false })), travelling)).toEqual(
      travelling,
    );
    expect(shockFor(coreLook(facts({ muted: true })), travelling)).toEqual(travelling);
    // Nothing received it, so nothing shows.
    expect(shockFor(coreLook(facts({ connected: false })), travelling)).toEqual({
      front: 0,
      energy: 0,
    });
  });
});
