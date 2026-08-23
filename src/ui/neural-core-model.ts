/**
 * Presentation rules for the neural core, kept separate from React and from
 * WebGL so they can be tested without a DOM or a GPU.
 *
 * This is `hud-model`'s sibling, and it defers to it: `orbMode` decides what is
 * true, and everything here only decides how that truth looks in three
 * dimensions. A prettier core is not allowed to be a less honest one — the
 * amber scheme is dropped for red on `error` and drained to bronze-grey when the
 * runtime is gone, because a golden sun over a dead runtime is the failure this
 * project forbids.
 */

import { orbLook, type HudFacts, type OrbMode } from "./hud-model.js";

export interface CorePalette {
  /** The sun itself — near-white at the centre of the bloom. */
  core: string;
  /** The halo the bloom pass smears outward. */
  glow: string;
  /** Wireframe rings. Dimmer than the core, or they compete with it. */
  ring: string;
  /** The neuron field. */
  particle: string;
}

export interface CoreLook {
  mode: OrbMode;
  palette: CorePalette;
  /** Ring rotation multiplier. 0 means genuinely still, not slowly drifting. */
  spin: number;
  /** Bloom strength for the core. */
  bloom: number;
  /** Core radius multiplier — mic level rides on this while listening. */
  swell: number;
  /** How much the particle field churns; 0 is a frozen field. */
  agitation: number;
  /** The same words the 2D orb would have used. */
  label: string;
}

const PALETTES: Record<OrbMode, CorePalette> = {
  // Live states: one calibrated mid-tone neon orange, shifted a little per state
  // rather than re-picked. Two failure modes were being steered between — muddy
  // browns (the original #b06a1e ring read as dusty next to the core) and blown
  // out near-whites (#fffbe8 cores, which the bloom pass turned into a colourless
  // flare). So `core` is a warm amber-cream rather than white, and every glow,
  // ring and particle hue keeps a full red channel with the blue held under 0.3 —
  // that ratio is what "clean orange" is, and it is what the range test pins.
  idle: { core: "#ffc978", glow: "#ff7f1a", ring: "#ff751c", particle: "#ff9838" },
  listening: { core: "#ffd68c", glow: "#ff8f26", ring: "#ff8420", particle: "#ffa74e" },
  thinking: { core: "#ffbb61", glow: "#ff6d12", ring: "#ff6414", particle: "#ff8b26" },
  speaking: { core: "#ffd083", glow: "#ff861f", ring: "#ff7b1d", particle: "#ff9f42" },
  // Not amber, on purpose. Red is the one colour in this UI that must not be
  // mistaken for a warm idle glow.
  error: { core: "#ffc0b4", glow: "#ff3a22", ring: "#ff2f18", particle: "#ff6a52" },
  // Dimmed rather than drained. These used to be warm greys, on the argument that
  // hue reads "nothing is running" better than brightness does — but a grey core
  // is the only thing on screen that is not orange, and the bloom pass turns a
  // grey particle field into a colourless one. So the hue stays in the family and
  // brightness carries the state instead: every channel here is held well under
  // the live values above, which is what the range test now pins.
  offline: { core: "#a8763c", glow: "#8f4c14", ring: "#6b350c", particle: "#985f22" },
  muted: { core: "#b8813f", glow: "#96521a", ring: "#733a10", particle: "#8f5a20" },
  deaf: { core: "#b07c3d", glow: "#934f17", ring: "#6f380e", particle: "#8d5620" },
};

/**
 * Per-mode energy. Deliberately flat data — the interesting part is the table.
 *
 * Bloom sits lower than it used to across the board. These are the *resting*
 * numbers, and `coreEnergy` lifts them while something is actually being
 * processed; baking the peak in here meant the glow was always at its loudest,
 * which is how a warm core becomes a washed-out one.
 */
const ENERGY: Record<OrbMode, Omit<CoreLook, "mode" | "palette" | "label">> = {
  idle: { spin: 0.35, bloom: 1.25, swell: 1, agitation: 0.35 },
  listening: { spin: 0.7, bloom: 1.9, swell: 1, agitation: 1 },
  thinking: { spin: 1.6, bloom: 1.7, swell: 1, agitation: 0.8 },
  speaking: { spin: 0.9, bloom: 1.8, swell: 1, agitation: 0.75 },
  error: { spin: 0.15, bloom: 1.2, swell: 0.9, agitation: 0.2 },
  // Still, not slow. A core that keeps turning after the runtime dies reads as
  // "working on it".
  offline: { spin: 0, bloom: 0.3, swell: 0.82, agitation: 0.05 },
  muted: { spin: 0.12, bloom: 0.42, swell: 0.9, agitation: 0.12 },
  deaf: { spin: 0.12, bloom: 0.42, swell: 0.9, agitation: 0.12 },
};

/**
 * What the core should look like, given what is actually happening.
 *
 * `level` only moves anything while the mic is genuinely open, for the same
 * reason `orbScale` ignores it elsewhere: a core pulsing to a level meter that
 * is not being fed is animation pretending to be evidence.
 */
export function coreLook(f: HudFacts, level = 0): CoreLook {
  const look = orbLook(f);
  const energy = ENERGY[look.mode];
  const palette = PALETTES[look.mode];
  const swell =
    look.mode === "listening" ? energy.swell * (1 + clamp01(level) * 0.3) : energy.swell;
  return { mode: look.mode, palette, label: look.label, ...energy, swell };
}

/**
 * Motion scale for the OS "reduce motion" setting.
 *
 * Reduced motion does not mean a blank canvas — the core still renders, it just
 * stops orbiting and drifting. `styles.css` makes the same call for the 2D orb.
 */
export function motionScale(reducedMotion: boolean): number {
  return reducedMotion ? 0 : 1;
}

// --- energy surges ---------------------------------------------------------

/** How long a message's surge takes to fade to ~37% of its peak, in seconds. */
export const SURGE_TAU = 1.6;

/**
 * How strong a surge that fired at `firedAt` is at `now` — both in seconds.
 *
 * Stateless on purpose. Every part of the scene derives the same curve from the
 * same timestamp, so there is no shared decaying number to keep in step and no
 * dependence on which `useFrame` callback happens to run first. A `firedAt` of 0
 * means "nothing has fired", which is the state the HUD starts in.
 */
export function surgeAt(now: number, firedAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(firedAt) || firedAt <= 0) return 0;
  const age = now - firedAt;
  // A future timestamp is a clock that moved, not a surge that has not started.
  if (age < 0) return 1;
  return Math.exp(-age / SURGE_TAU);
}

/** Modes where something is genuinely happening. A surge is only honest in these. */
const LIVE: readonly OrbMode[] = ["idle", "listening", "thinking", "speaking"];

export interface CoreEnergy {
  spin: number;
  bloom: number;
  agitation: number;
  swell: number;
}

/**
 * The core's energy with any surge folded in — what a message or a voice does to
 * the rig while it is being processed.
 *
 * Multipliers on the mode's own numbers rather than replacements, so a surge
 * makes what is already happening more emphatic instead of inventing a state that
 * isn't. And gated to live modes for the reason the rest of this file exists: a
 * message typed at a dead runtime must not spin the rings up as though something
 * on the other end received it. Nothing did.
 */
export function coreEnergy(look: CoreLook, surge: number): CoreEnergy {
  const s = LIVE.includes(look.mode) ? clamp01(surge) : 0;
  return {
    spin: look.spin * (1 + s * 1.5),
    bloom: look.bloom * (1 + s * 0.35),
    // Capped above 1: the field's drift is already at 1 while listening, and the
    // surge is what pushes it past its resting maximum.
    agitation: Math.min(1.4, look.agitation * (1 + s * 1.1)),
    swell: look.swell * (1 + s * 0.1),
  };
}

// --- the discharge ---------------------------------------------------------

/** Seconds the shock takes to cross the field, innermost shell to rim. */
export const SHOCK_TRANSIT = 0.85;

/** How much of that transit the front spends brightening rather than fading. */
const SHOCK_ATTACK = 0.12;

/**
 * A discharge travelling out through the shells.
 *
 * `front` is where it is, on the same 0 … 1 the field normalises its own radius
 * to — 0 is the innermost shell, 1 the rim. `energy` is how hard it is hitting,
 * which is not the same curve: it snaps up over the first tenth of the transit
 * and eases off over the rest, so the front arrives at the rim already spent
 * instead of vanishing mid-flight at full brightness.
 */
export interface Shock {
  front: number;
  energy: number;
}

/** Nothing travelling. Shared so the frame loop compares against one object. */
export const SHOCK_REST: Shock = { front: 0, energy: 0 };

/**
 * Where a discharge fired at `firedAt` has reached by `now` — both in seconds.
 *
 * Stateless for the same reason `surgeAt` is: every consumer derives the same
 * front from the same timestamp, so there is no travelling number to keep in
 * step between frame callbacks. Shares `pulse`'s timestamp rather than taking
 * one of its own — a send is one event, and two clocks for it would drift.
 */
export function shockAt(now: number, firedAt: number): Shock {
  if (!Number.isFinite(now) || !Number.isFinite(firedAt) || firedAt <= 0) return SHOCK_REST;
  const age = now - firedAt;
  // Past the rim, or a clock that moved backwards. Neither is a live front.
  if (age < 0 || age > SHOCK_TRANSIT) return SHOCK_REST;
  const u = age / SHOCK_TRANSIT;
  const energy =
    u < SHOCK_ATTACK ? u / SHOCK_ATTACK : Math.pow(1 - (u - SHOCK_ATTACK) / (1 - SHOCK_ATTACK), 1.6);
  return { front: u, energy: clamp01(energy) };
}

/**
 * The same discharge, gated on there being a runtime that received the message.
 *
 * A narrower gate than `coreEnergy`'s: the live-mode list excludes `muted` and
 * `deaf`, but those describe the microphone, not the far end. A message typed
 * with voice switched off was still sent and still landed, and swallowing its
 * acknowledgement is what made the core look broken. `offline` is the one state
 * where nothing received it, and that is the one where nothing fires.
 */
export function shockFor(look: CoreLook, shock: Shock): Shock {
  return look.mode === "offline" ? SHOCK_REST : shock;
}

// --- zoom ------------------------------------------------------------------

/** Closer than this and the core fills the window; further and it is a speck. */
export const ZOOM_MIN = 0.65;
export const ZOOM_MAX = 2.6;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * Wheel/pinch to zoom, multiplicatively.
 *
 * Multiplicative rather than additive so one notch of the wheel feels the same
 * whether you are near or far — additive steps crawl when close and jump when
 * distant. Deltas are treated as a magnitude, not a pixel count, because a
 * trackpad, a wheel and a `deltaMode: LINE` mouse disagree wildly about scale;
 * the tanh keeps a single 500-pixel fling from crossing the whole range.
 *
 * The delta is negated because the browser's sign is the opposite of the
 * gesture's meaning: scrolling up is a negative `deltaY`, and scrolling up is
 * how every map and every viewer on this platform zooms *in*.
 */
export function zoomByWheel(current: number, deltaY: number): number {
  if (!Number.isFinite(deltaY)) return clampZoom(current);
  return clampZoom(current * Math.exp(-Math.tanh(deltaY / 240) * 0.28));
}

/** Vertical drag to zoom — the gesture a hand-tracked pinch maps onto. */
export function zoomByDrag(startZoom: number, dragPixels: number, viewportHeight: number): number {
  const height = viewportHeight > 0 ? viewportHeight : 1;
  return clampZoom(startZoom * Math.exp((dragPixels / height) * 1.6));
}

/** How hard the assembly contracts as the camera closes in. */
export const ZOOM_SCALE_FALLOFF = 0.35;
/** World units each ring is pushed behind the one inside it, per unit of zoom. */
export const RING_SPREAD = 1.6;

/**
 * What zoom does to the assembly, beyond moving the camera.
 *
 * Moving the camera alone is not a perspective shift, and at this fov it is worse
 * than that: the camera reaches 11 / 2.6 ≈ 4.2 at full zoom, which is *inside*
 * the particle shell, so the field ends up between the viewer and the core as a
 * wall of blurred near points. That is what the first zoomed-in render looked
 * like.
 *
 * So zoom drives two more things. `scale` contracts the whole assembly, which is
 * what keeps the camera outside the field and stops the rings cropping — the
 * camera closes by 2.6× while the assembly shrinks to ~0.72, leaving a real
 * ~1.8× magnification. `spread` separates the rings along the view axis, turning
 * four concentric hoops into a tunnel receding behind the core; that is where the
 * sense of depth comes from rather than from raw size. Zoomed out, `spread` is 0
 * and the stack is the flat gyroscope it started as.
 */
export function orbitalZoom(zoom: number): { scale: number; spread: number } {
  const z = clampZoom(zoom);
  return {
    scale: Math.pow(z, -ZOOM_SCALE_FALLOFF),
    spread: Math.max(0, z - 1) * RING_SPREAD,
  };
}

// --- cursor tilt -----------------------------------------------------------

/** Peak tilt of the whole assembly, in radians (~19°). */
export const MAX_TILT = 0.34;

/**
 * Euler angles that lean the whole assembly toward the cursor.
 *
 * Signs are what make this read as leaning *into* the pointer rather than
 * shying away from it: with the cursor top-right, the assembly's top-right has
 * to come toward the viewer, so +x pointer rotates negatively about y and +y
 * pointer rotates positively about x.
 *
 * Not scaled by `motionScale`, for the same reason the field's pointer force
 * isn't: reduced motion means "do not animate at me", not "ignore my input".
 * What that setting silences is the drift and the orbiting, both of which happen
 * on their own.
 */
export function assemblyTilt(pointerX: number, pointerY: number): { x: number; y: number } {
  return {
    x: clampAxis(pointerY) * MAX_TILT,
    y: -clampAxis(pointerX) * MAX_TILT,
  };
}

// --- hand tracking ---------------------------------------------------------

/**
 * One frame from a hand tracker, in the units a tracker actually produces.
 *
 * Deliberately shaped like MediaPipe's output rather than like this scene's: the
 * point of this seam is that a Python script does not have to know what clip
 * space is, what the zoom range is, or which way the assembly leans. It sends
 * where the hand is and how open the pinch is; everything below turns that into
 * the numbers the frame loop already reads.
 */
export interface HandFrame {
  /** Hand centre in the camera image, 0 … 1, origin top-left. */
  x: number;
  y: number;
  /**
   * Thumb-tip to index-tip distance as a fraction of frame width. Omitted means
   * "no pinch measured", which leaves the zoom exactly where the user left it —
   * a tracker that loses the fingers must not slam the camera to a default.
   */
  pinch?: number;
}

/** Where the assembly should be aimed, in radians. */
export interface HandAim {
  /** About the world y axis — what lateral hand movement drives. */
  yaw: number;
  /** About the world x axis. */
  pitch: number;
}

/**
 * A tracker frame as a pointer, in the same clip space the mouse arrives in.
 *
 * Mirrored by default because a hand tracker is nearly always run on a selfie
 * view: the user's hand moving to their right moves *left* in the raw image, and
 * a core that leans away from the hand feels broken rather than inverted. A
 * producer that already flips its frame passes `mirrored: false`.
 */
export function handToPointer(
  frame: HandFrame,
  mirrored = true,
): { x: number; y: number; active: boolean } {
  const x = clampAxis((frac(frame.x) * 2 - 1) * (mirrored ? -1 : 1));
  // Flipped: image y runs down, clip space runs up.
  const y = clampAxis(-(frac(frame.y) * 2 - 1));
  return { x, y, active: true };
}

/**
 * A frame coordinate, guarded. A missing or unusable number is centred rather
 * than 0 — treating it as 0 would read as a hand pinned to the frame's edge, and
 * the rig would swing hard over to a tracker's arithmetic mistake.
 */
function frac(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/** Fingers this close together (fraction of frame width) is fully zoomed out. */
export const PINCH_MIN = 0.05;
/** And this far apart is fully zoomed in. Beyond it the hand has left the frame. */
export const PINCH_MAX = 0.32;

/**
 * Pinch span to an absolute zoom.
 *
 * Geometric across the range rather than linear, for the same reason
 * `zoomByWheel` multiplies: a centimetre of finger travel should mean the same
 * ratio near and far. Spreading the fingers zooms *in*, which is the gesture
 * every touch surface on this platform has already taught the user.
 *
 * A span outside the calibrated range clamps rather than extrapolating — a
 * tracker that briefly reports a 0.9 pinch has mismeasured, and the honest
 * response is to sit at full zoom, not to fly through the core.
 */
export function pinchZoom(pinch: number): number {
  if (!Number.isFinite(pinch)) return 1;
  const t = Math.min(1, Math.max(0, (pinch - PINCH_MIN) / (PINCH_MAX - PINCH_MIN)));
  return clampZoom(ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, t));
}

/** Peak yaw a hand at the edge of frame commands, in radians (~49°). */
export const HAND_MAX_YAW = 0.85;
/** Peak pitch. Smaller than yaw: the rings are a plane, and over-pitching hides them. */
export const HAND_MAX_PITCH = 0.5;

/**
 * Where a hand aims the assembly.
 *
 * This is the one thing the tracker must not be allowed to do by translation. A
 * hand crossing the frame that *moved* the rig would walk the core out of a
 * 460-pixel-wide panel and leave the user waving at an empty window; the same
 * hand rotating it keeps every part on screen and reads as the thing turning to
 * face them. So lateral movement is yaw, and nothing here touches position.
 *
 * Signs match `assemblyTilt` so a mouse and a hand agree about which way is
 * which — the near side follows the input. The range is wider than the cursor's
 * ±19° because a hand has a whole frame to move in and a much coarser reach.
 */
export function handTilt(pointerX: number, pointerY: number): { x: number; y: number } {
  return {
    x: clampAxis(pointerY) * HAND_MAX_PITCH,
    y: -clampAxis(pointerX) * HAND_MAX_YAW,
  };
}

/** How long a hand may go unseen before the rig stops holding its pose, in ms. */
export const HAND_TIMEOUT_MS = 450;

/**
 * Whether the last hand frame is too old to steer by.
 *
 * A tracker that dies mid-gesture — the process crashed, the camera was claimed
 * by a meeting — otherwise leaves the assembly frozen at whatever angle its last
 * frame commanded, which looks exactly like a hung renderer. Going stale hands
 * control back to the mouse and lets the rig recentre.
 */
export function handStale(now: number, seenAt: number): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(seenAt) || seenAt <= 0) return true;
  // A frame stamped in the future is a clock disagreement, not a stale frame.
  return now - seenAt > HAND_TIMEOUT_MS;
}

// --- frame loop ------------------------------------------------------------

/**
 * Frame-rate independent easing towards a target.
 *
 * Every smoothed value in the scene goes through this rather than the usual
 * `current += (target - current) * 0.1`, which silently changes speed with the
 * frame rate: the same code eases twice as fast on a 120 Hz panel, and lurches
 * after a dropped frame. `tau` is the time constant in seconds — the time to
 * close ~63% of the remaining gap — so the feel is pinned to the clock instead.
 */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return current;
  if (tau <= 0) return target;
  // Clamped: a tab that was hidden for a minute hands back one enormous dt, and
  // an unclamped exponent would teleport everything on the first visible frame.
  const step = 1 - Math.exp(-Math.min(dt, 0.25) / tau);
  return current + (target - current) * step;
}

/**
 * How many particles to spend on a canvas of this size.
 *
 * Scaled by area rather than fixed, because this component is mounted in a
 * 460 × 680 HUD panel today and could be a full-screen dashboard tomorrow, and
 * one number cannot be right for both. The ceiling is what a shared laptop GPU
 * holds at 60 fps with a bloom pass on top; the floor is what still reads as a
 * field rather than as confetti.
 */
export function particleBudget(width: number, height: number): number {
  const area = Math.max(0, width) * Math.max(0, height);
  if (area === 0) return PARTICLE_MIN;
  const scaled = Math.round(area / 90);
  return Math.min(PARTICLE_MAX, Math.max(PARTICLE_MIN, scaled));
}

export const PARTICLE_MIN = 2_400;
export const PARTICLE_MAX = 7_000;

/**
 * Device pixel ratio to render at.
 *
 * Capped at 1.75 rather than passed through: this HUD runs on Windows laptops at
 * 125–150% scaling, where honouring the full ratio quadruples the fragment cost
 * of the bloom pass for a glow that is blurred anyway.
 */
export function renderScale(devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(1.75, Math.max(1, dpr));
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Clip-space axis guard: −1 … 1, and a non-number is treated as centred. */
function clampAxis(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : 0;
}
