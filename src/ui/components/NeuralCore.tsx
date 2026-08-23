/**
 * The neural core — the HUD's centrepiece.
 *
 * A 3D restatement of `Orb`, and it obeys the same rule: everything it shows is
 * derived from `HudFacts` through `neural-core-model`, so it cannot animate its
 * way into implying something that isn't happening. A spinning golden core over a
 * dead runtime would be the exact lie the 2D orb was built to avoid.
 *
 * This file owns the DOM side — the canvas, the input, and when to draw at all.
 * `neural-scene.tsx` owns everything inside the canvas.
 *
 * Three things here matter more than the visuals:
 *
 *   - **It stops when nobody is looking.** Closing this window hides it (§13), so
 *     without gating, a 60 fps WebGL loop would keep the GPU process busy for the
 *     rest of the session behind a hidden window. `frameloop` is cut to "never"
 *     the moment the document is hidden.
 *   - **Input never re-renders React.** Pointer and zoom live in refs the frame
 *     loop reads. A `setState` per mousemove would re-render the conversation,
 *     the Command Center and the permission dialog forty times a second.
 *   - **It degrades instead of disappearing.** No WebGL — a remote session, a
 *     blocklisted driver — falls back to the 2D orb rather than a black hole.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import type { BloomEffect } from "postprocessing";
import { Orb } from "./Orb";
import type { HudFacts } from "../hud-model";
import {
  clampZoom,
  coreLook,
  handStale,
  handToPointer,
  handTilt,
  motionScale,
  particleBudget,
  pinchZoom,
  renderScale,
  zoomByDrag,
  zoomByWheel,
  type HandFrame,
} from "../neural-core-model";
import { installGestureBridge } from "../gesture-bridge";
import {
  DEFAULT_GESTURE_ENDPOINT,
  connectGestureSocket,
  type RotationUnit,
} from "../gesture-socket";
import {
  BloomEnergy,
  CameraRig,
  CoreSphere,
  ParticleField,
  Rings,
  AssemblyTilt,
  type HandState,
  type PointerState,
} from "./neural-scene";

/**
 * The seam a hand tracker plugs into.
 *
 * OpenCV work belongs nowhere near this file: whatever produces a hand position —
 * a Python sidecar over the existing pipe, or MediaPipe in a worker — only has to
 * call these methods with normalised numbers. They all go straight into the refs
 * the frame loop already reads, so a hand drives the core through exactly the
 * path a mouse does, and no part of the scene needs to know which one is talking.
 *
 * `setHand` is the one a tracker wants; `setPointer`/`setZoom` remain for a
 * producer that would rather do its own mapping. A tracker that cannot hold a
 * React ref reaches the same object through `window.jarvisGesture`, which this
 * component installs on mount — see `gesture-bridge.ts`.
 */
export interface NeuralCoreHandle {
  /** Pointer in clip space: -1 … 1, y up. `active: false` lets the field relax. */
  setPointer(x: number, y: number, active?: boolean): void;
  /** Absolute zoom, clamped to the same range the wheel is held to. */
  setZoom(zoom: number): void;
  /**
   * One tracked-hand frame, in camera coordinates — the call a hand tracker makes
   * and the only one it needs. It does three things at once, because they are one
   * gesture: the hand becomes the pointer (so the field bends around it), its
   * lateral position becomes yaw and its height becomes pitch (so the assembly
   * *turns* rather than sliding off the panel), and a measured pinch becomes an
   * absolute zoom. Every one of those lands on the refs the frame loop already
   * eases, so a hand and a mouse drive the same machinery at the same smoothness.
   *
   * `null` releases: the rig recentres and the mouse takes over again. A hand that
   * simply stops arriving does the same thing on its own after `HAND_TIMEOUT_MS`.
   */
  setHand(frame: HandFrame | null): void;
  /**
   * Something was just sent. Surges the rig's energy for a moment — faster rings,
   * a hotter glow, a busier field — then lets it decay back on its own.
   *
   * Deliberately not derived from the conversation: the core is told that a turn
   * started, rather than watching a message list, so the same call works for a
   * typed message, a voice turn, or anything else that starts real work.
   */
  pulse(): void;
}

export interface NeuralCoreProps {
  facts: HudFacts;
  /** Microphone RMS, 0 … 1. Only moves anything while the mic is genuinely open. */
  level?: number;
  /** Classes for the fill container. Defaults to filling whatever contains it. */
  className?: string;
  /** The state caption under the core. Off when the host draws its own. */
  showLabel?: boolean;
  /** Force the loop to stop — for a host that knows it is off-screen. */
  paused?: boolean;
  /**
   * Where an external hand tracker is listening, e.g. `ws://127.0.0.1:8765`.
   *
   * Left out, the value of `VITE_JARVIS_GESTURE_WS` is used; with neither, no
   * socket is opened. Off by default on purpose — see `gesture-socket.ts`.
   */
  gestureEndpoint?: string | null;
  /** How to read `rotationX`/`rotationY` off that socket. Default normalised. */
  gestureRotationUnit?: RotationUnit;
}

export const NeuralCore = forwardRef<NeuralCoreHandle, NeuralCoreProps>(function NeuralCore(
  {
    facts,
    level = 0,
    className,
    showLabel = true,
    paused = false,
    gestureEndpoint,
    gestureRotationUnit = "normalized",
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const pointer = useRef<PointerState>({ x: 0, y: 0, active: false });
  const zoom = useRef(1);
  // Null until a tracker sends something, and back to null when it lets go. The
  // scene falls through to the mouse whenever this is null or has gone stale.
  const hand = useRef<HandState | null>(null);
  // 0 means "nothing has been sent yet", which is where every session starts.
  const pulse = useRef(0);
  // The mic level as a ref as well as a prop: the scene reads it inside the frame
  // loop to drive the surge, and a ref keeps that read off React's critical path.
  const levelRef = useRef(level);
  const drag = useRef<{ id: number; startY: number; startZoom: number } | null>(null);

  const size = useElementSize(host);
  const visible = useDocumentVisible();
  const reducedMotion = useReducedMotion();

  const look = coreLook(facts, level);
  const motion = motionScale(reducedMotion);
  const dpr = useMemo(
    () => renderScale(typeof window === "undefined" ? 1 : window.devicePixelRatio),
    [],
  );

  // Quantised, because changing the count rebuilds three buffers: dragging a
  // window edge must not reallocate the field on every pixel.
  const widthStep = Math.round(size.width / 48);
  const heightStep = Math.round(size.height / 48);
  const count = useMemo(
    () => particleBudget(widthStep * 48, heightStep * 48),
    [widthStep, heightStep],
  );

  const api = useMemo<NeuralCoreHandle>(
    () => ({
      setPointer(x, y, active = true) {
        pointer.current = { x: clampAxis(x), y: clampAxis(y), active };
      },
      setZoom(next) {
        zoom.current = clampZoom(next);
      },
      setHand(frame) {
        if (!frame) {
          hand.current = null;
          pointer.current = { ...pointer.current, active: false };
          return;
        }
        const aimed = handToPointer(frame);
        pointer.current = aimed;
        const tilt = handTilt(aimed.x, aimed.y);
        // Stamped on arrival, not from the producer: a tracker's clock is not this
        // renderer's, and staleness here means "nothing has reached us lately",
        // which is the only version of the question this side can answer.
        hand.current = { pitch: tilt.x, yaw: tilt.y, at: performance.now() };
        // Left alone when unmeasured. A tracker that can see the palm but not the
        // fingertips must not drag the camera back to a default every frame.
        if (frame.pinch !== undefined) zoom.current = pinchZoom(frame.pinch);
      },
      pulse() {
        pulse.current = performance.now();
      },
    }),
    [],
  );

  useImperativeHandle(ref, () => api, [api]);

  // The window-level bridge, so a producer that cannot reach a React ref still
  // can. Torn down on unmount, and it restores whatever was there before it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    return installGestureBridge(api, window as unknown as Parameters<typeof installGestureBridge>[1]);
  }, [api]);

  // And the socket, for a tracker that would rather talk over a port than reach
  // into the page. Same `api` the mouse and the window bridge drive, so nothing
  // downstream knows or cares which one is talking — and with no endpoint
  // configured this effect does nothing at all, which is the default.
  const socketEndpoint = gestureEndpoint ?? configuredGestureEndpoint();
  useEffect(() => {
    if (!socketEndpoint) return;
    return connectGestureSocket(api, {
      endpoint: socketEndpoint,
      rotationUnit: gestureRotationUnit,
    });
  }, [api, socketEndpoint, gestureRotationUnit]);

  useEffect(() => void (levelRef.current = level), [level]);

  // Tracked on the window rather than the canvas, deliberately. This component is
  // mounted *behind* the conversation, and a listener on the canvas would go deaf
  // the moment the cursor crossed a chat bubble — the core would freeze exactly
  // where the user is most likely to be looking.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      // A live tracker wins. Not the other way round: hand frames arrive thirty
      // times a second, so letting the mouse interrupt would make one stray desk
      // bump fight the hand for the rest of the gesture. The mouse gets control
      // back on its own the moment the hand goes stale.
      if (hand.current && !handStale(performance.now(), hand.current.at)) return;
      // Past that, the tracker is gone as far as this rig is concerned. Clearing
      // it here is what actually hands control back: the scene treats a pointer
      // written by a stale hand as no pointer at all, so leaving the ref set
      // would make the first real mouse move do nothing.
      hand.current = null;
      const box = host.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;
      pointer.current = {
        x: clampAxis(((e.clientX - box.left) / box.width) * 2 - 1),
        // Flipped: clip space has y up, the DOM has y down.
        y: clampAxis(-(((e.clientY - box.top) / box.height) * 2 - 1)),
        active: true,
      };
      const held = drag.current;
      if (held && held.id === e.pointerId) {
        zoom.current = zoomByDrag(held.startZoom, held.startY - e.clientY, box.height);
      }
    };
    const onLeave = (): void => {
      pointer.current = { ...pointer.current, active: false };
    };
    const onUp = (): void => void (drag.current = null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("pointerleave", onLeave);
    // A window that loses focus has no cursor in it as far as the user is
    // concerned, and a field frozen mid-repulsion looks broken.
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  // Non-passive, and on the host element only: the wheel has to be preventable
  // here (or the whole frameless window rubber-bands), and it must stay the
  // conversation's wheel when the cursor is over the conversation.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoom.current = zoomByWheel(zoom.current, e.deltaY);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  // Resolution is given up before frames are. `PerformanceMonitor` reports a
  // 0…1 factor from measured fps against the display's own refresh rate, and a
  // slightly softer core at 60 fps beats a sharp one at 34 — this HUD sits over
  // whatever else the user is doing, and stutter is what they will notice.
  const [factor, setFactor] = useState(1);
  const renderDpr = Math.round(dpr * (0.6 + 0.4 * factor) * 100) / 100;

  const refs = useMemo(() => ({ pointer, zoom, pulse, level: levelRef, hand }), []);
  const active = visible && !paused;
  // Read once. The live value is eased onto the effect by `BloomEnergy`, because
  // passing it as a prop is what made the whole panel flare on every state change.
  const initialBloom = useMemo(() => look.bloom, []);
  const bloom = useRef<BloomEffect | null>(null);

  return (
    <div
      ref={host}
      // `no-drag` matters: without it this canvas would inherit the title bar's
      // drag region in some layouts, and every zoom drag would move the window.
      className={`no-drag relative overflow-hidden ${className ?? "h-full w-full"}`}
      onPointerDown={(e) => {
        drag.current = { id: e.pointerId, startY: e.clientY, startZoom: zoom.current };
      }}
    >
      {/* The deep black the palette was chosen against, with a warm floor so the
          core is not a bright disc pasted onto a hard cut. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_44%,#1b0f01_0%,#080502_48%,#000000_100%)]" />

      <Canvas
        dpr={renderDpr}
        // The whole point of the gating: "never" stops the loop dead rather than
        // throttling it, so a hidden HUD costs nothing at all.
        frameloop={active ? "always" : "never"}
        camera={{ fov: 45, near: 0.1, far: 60, position: [0, 0, 9] }}
        gl={{
          alpha: true,
          // Off on purpose: the bloom pass blurs every edge it would have
          // smoothed, and MSAA on a full-screen composer is pure cost.
          antialias: false,
          stencil: false,
          powerPreference: "high-performance",
        }}
        fallback={
          <div className="grid h-full w-full place-items-center">
            <Orb facts={facts} level={level} />
          </div>
        }
      >
        <PerformanceMonitor
          factor={1}
          flipflops={3}
          onChange={({ factor: f }) => setFactor(f)}
          onFallback={() => setFactor(0)}
        />

        <CameraRig refs={refs} motion={motion} />
        {/* One shared transform for the whole rig. The camera stays outside it —
            a tilt applied to the camera would swing the framing, where a tilt
            applied to the assembly leans the assembly, which is the ask. */}
        <AssemblyTilt refs={refs}>
          <CoreSphere look={look} motion={motion} refs={refs} />
          <Rings look={look} motion={motion} refs={refs} />
          <ParticleField look={look} motion={motion} refs={refs} count={count} pixelRatio={renderDpr} />
        </AssemblyTilt>
        <BloomEnergy look={look} refs={refs} effect={bloom} />

        <EffectComposer multisampling={0} enableNormalPass={false}>
          {/* mipmapBlur is what makes the halo wide and cheap at the same time:
              the blur runs on a mip chain, so its radius costs almost nothing.
              The threshold stays above the field's own brightness — drop it far
              enough to catch the particles as well as the sun and the whole
              scene fuses into one white cloud, which is what the first render of
              this file looked like. Intensity is set once here and then eased by
              `BloomEnergy`: as a live prop it stepped on every state change, and
              a full-screen pass that steps is a flash across the whole panel. */}
          <Bloom
            ref={bloom}
            intensity={initialBloom}
            luminanceThreshold={0.52}
            luminanceSmoothing={0.28}
            mipmapBlur
            radius={0.7}
          />
          <Vignette offset={0.32} darkness={0.55} />
        </EffectComposer>
      </Canvas>

      {showLabel && (
        <p
          className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm font-medium tracking-wide transition-colors duration-500"
          style={{ color: look.palette.core }}
        >
          {look.label}
        </p>
      )}
    </div>
  );
});

// --- DOM plumbing ----------------------------------------------------------

function clampAxis(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(-1, n));
}

/**
 * The tracker endpoint from configuration, or null for "do not connect".
 *
 * Two sources, in order, and a hard-coded default in neither: the socket stays
 * opt-in because an always-on HUD that dialled a local port on its own would be
 * a channel nobody asked for.
 *
 *   - `VITE_JARVIS_GESTURE_WS` in `.env.local` — baked in at build time, which is
 *     what a developer running a tracker on their own machine wants.
 *   - `window.jarvisGestureEndpoint`, set by a preload before the app mounts —
 *     for a host that decides at launch rather than at build. The probe uses this
 *     to test the real socket against the built renderer.
 *
 * `"true"` or `"1"` in either means `DEFAULT_GESTURE_ENDPOINT`, so the common
 * case does not have to repeat the port.
 */
function configuredGestureEndpoint(): string | null {
  return (
    readEndpoint(import.meta.env?.["VITE_JARVIS_GESTURE_WS"]) ??
    readEndpoint(
      typeof window === "undefined"
        ? undefined
        : (window as { jarvisGestureEndpoint?: unknown }).jarvisGestureEndpoint,
    )
  );
}

function readEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  return value === "true" || value === "1" ? DEFAULT_GESTURE_ENDPOINT : value;
}

/**
 * The host element's box, so the particle budget can follow it.
 *
 * `ResizeObserver` rather than a window resize listener, because this component
 * is sized by its container: opening the Command Center changes how much of the
 * HUD the core gets without the window changing size at all.
 */
function useElementSize(ref: React.RefObject<HTMLElement | null>): {
  width: number;
  height: number;
} {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Whether this document is on screen at all.
 *
 * The one hook that keeps the always-on promise honest. Closing the HUD hides the
 * window rather than destroying it, so this component stays mounted for the rest
 * of the session — and Chromium reports a hidden Electron window as
 * `visibilityState: "hidden"`, which is the signal that stops the loop.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const read = (): void => setVisible(document.visibilityState !== "hidden");
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  return visible;
}

/** The same OS setting `styles.css` honours for the 2D orb. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const read = (e: MediaQueryListEvent): void => setReduced(e.matches);
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return reduced;
}
