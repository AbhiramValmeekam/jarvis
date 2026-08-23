/**
 * The neural core's WebGL half: the sun, its rings, and the neuron field.
 *
 * Everything here is a child of the `<Canvas>` in `NeuralCore.tsx` and cannot be
 * rendered outside one. Two rules hold across the file:
 *
 *   - Nothing allocates in `useFrame`. Vectors, colours and matrices are made
 *     once and mutated, because this loop runs 60 times a second for as long as
 *     the HUD is open and a per-frame `new Vector3()` is 216 000 objects a hour
 *     for the garbage collector to find.
 *   - Live input arrives through refs, never props. A pointer that re-rendered
 *     React on every mousemove would re-render the whole HUD alongside it; the
 *     scene reads the ref inside the frame loop instead.
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import {
  approach,
  assemblyTilt,
  coreEnergy,
  handStale,
  orbitalZoom,
  shockAt,
  shockFor,
  surgeAt,
  type CoreLook,
  type Shock,
} from "../neural-core-model";

/** Live input, mutated outside React and read inside the frame loop. */
export interface PointerState {
  /** Pointer in clip space: -1 … 1, y up. Centre is 0, 0. */
  x: number;
  y: number;
  /** False when the pointer has left the window — the field then relaxes. */
  active: boolean;
}

/**
 * A tracked hand's aim, in radians, plus when it arrived.
 *
 * Angles rather than raw coordinates: the mapping from camera space to rotation
 * is a presentation rule, so it lives in `neural-core-model` and this file only
 * applies what it decided.
 */
export interface HandState {
  yaw: number;
  pitch: number;
  /** `performance.now()` when the frame reached the renderer. */
  at: number;
}

export interface SceneRefs {
  pointer: React.RefObject<PointerState>;
  /** Target zoom; 1 is the resting framing. `NeuralCore` owns the clamping. */
  zoom: React.RefObject<number>;
  /**
   * `performance.now()` of the last thing the user sent, or 0 if nothing has
   * been sent yet. A timestamp rather than a decaying level because every
   * consumer can then compute the same curve independently; see `surgeAt`.
   */
  pulse: React.RefObject<number>;
  /** Microphone RMS, 0 … 1. Only counts while the mic is genuinely open. */
  level: React.RefObject<number>;
  /** The tracked hand, or null when nothing is tracking. */
  hand: React.RefObject<HandState | null>;
}

/**
 * The hand's aim if one is actually steering, otherwise null.
 *
 * The staleness check is the whole reason this is a function and not a field
 * read: a tracker that stopped sending has not commanded the pose it last sent,
 * and a rig that holds that pose forever is indistinguishable from a frozen one.
 */
function handAim(refs: SceneRefs): HandState | null {
  const held = refs.hand.current;
  if (!held || handStale(performance.now(), held.at)) return null;
  return held;
}

/**
 * The pointer, if something is genuinely pointing.
 *
 * The subtlety is the hand: `setHand` writes the pointer as well as the aim, so a
 * tracker that dies leaves a perfectly valid-looking pointer behind at the last
 * place the hand was. Trusting it meant the rig never recentred — it dropped from
 * the hand's wide yaw to the cursor's narrower lean at the same coordinates and
 * held there, which the gesture probe caught as "still leaning at nothing". A
 * stale hand invalidates the pointer it wrote; a real mouse move clears the hand
 * and takes over from there.
 */
function activePointer(refs: SceneRefs): PointerState | null {
  const p = refs.pointer.current;
  if (!p?.active) return null;
  const held = refs.hand.current;
  if (held && handStale(performance.now(), held.at)) return null;
  return p;
}

/**
 * How hard the rig should be working right now, 0 … 1.
 *
 * Two things raise it and the louder wins: the decaying tail of the last message
 * sent, and the microphone's own level while the core is actually listening. The
 * voice half is scaled up because speech RMS lives around 0.1 – 0.3, and a
 * multiplier that small would not be visible on anything.
 */
function surgeOf(look: CoreLook, refs: SceneRefs): number {
  const sent = surgeAt(performance.now() / 1000, (refs.pulse.current ?? 0) / 1000);
  const voice = look.mode === "listening" ? Math.min(1, (refs.level.current ?? 0) * 1.8) : 0;
  return Math.max(sent, voice);
}

/**
 * The discharge from that same send, if one is still crossing the field.
 *
 * Reads the one timestamp `pulse()` writes, so the shock and the surge are two
 * views of one event rather than two things to fire in step.
 */
function shockOf(look: CoreLook, refs: SceneRefs): Shock {
  return shockFor(look, shockAt(performance.now() / 1000, (refs.pulse.current ?? 0) / 1000));
}


/**
 * Camera distance at zoom 1.
 *
 * Set so the outermost ring (radius 4.1) just clears the top and bottom of a
 * wide, short viewport: at a 45° vertical field of view, the visible half-height
 * here is ~4.55. Closer than this and the rings are cropped into arcs; further
 * and the core is a bead in the middle of a lot of nothing.
 */
const BASE_DISTANCE = 11;

/**
 * Pulls the camera in and out, and parallaxes it a little with the pointer.
 *
 * The zoom is eased rather than applied: a wheel notch is a step function, and
 * stepping the camera reads as a jump cut. `approach` makes the same notch feel
 * identical at 60 and 144 Hz.
 */
export function CameraRig({ refs, motion }: { refs: SceneRefs; motion: number }) {
  const camera = useThree((s) => s.camera);
  const distance = useRef(BASE_DISTANCE);

  useFrame((_, dt) => {
    const zoom = refs.zoom.current ?? 1;
    distance.current = approach(distance.current, BASE_DISTANCE / zoom, dt, 0.22);
    const p = activePointer(refs);
    // Parallax is deliberately tiny and eased slowly. A camera that tracks the
    // cursor 1:1 makes a HUD feel like it is on a gimbal. Halved again once
    // `AssemblyTilt` started leaning the scene toward the cursor as well — two
    // full-strength parallaxes on the same input is seasickness.
    //
    // And switched off entirely while a hand is steering. A hand crosses the whole
    // frame where a cursor makes small corrections, so the same gain that reads as
    // a slight lean under a mouse walks the core toward the edge of a 460-pixel
    // panel under a hand. Under a hand this is a pure rotation: the assembly turns
    // and the camera stays put.
    const sway = p && !handAim(refs) ? motion : 0;
    camera.position.x = approach(camera.position.x, (p?.x ?? 0) * 0.34 * sway, dt, 0.4);
    camera.position.y = approach(camera.position.y, (p?.y ?? 0) * 0.24 * sway, dt, 0.4);
    camera.position.z = distance.current;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

/**
 * Leans the entire assembly toward the cursor, and contracts it as zoom closes.
 *
 * This is the difference between a scene that reacts to the pointer and a scene
 * that acknowledges it: the field alone bending away from the cursor reads as
 * repulsion, while rotating the whole rig — sun, rings and field together, on one
 * shared transform — reads as the thing turning to face you.
 *
 * It has to be one group rather than a transform applied per component, or the
 * parts would shear against each other instead of holding their arrangement, and
 * the zoom contraction would let the camera through the particle shell. The cost
 * of that is `ParticleField` having to pull the pointer back into this group's
 * local space before the shader uses it; see `worldToLocal` there.
 */
export function AssemblyTilt({
  refs,
  children,
}: {
  refs: SceneRefs;
  children: ReactNode;
}) {
  const group = useRef<THREE.Group>(null);
  const scale = useRef(1);

  useFrame((_, dt) => {
    const node = group.current;
    if (!node) return;
    const p = activePointer(refs);
    const aim = handAim(refs);
    // A hand outranks the cursor and swings the rig much further — see `handTilt`.
    // Centred, not frozen, when neither is present: a rig left leaning at the
    // angle the cursor exited at looks like it is stuck.
    const tilt = aim
      ? { x: aim.pitch, y: aim.yaw }
      : p
        ? assemblyTilt(p.x, p.y)
        : { x: 0, y: 0 };
    // Slower than the field's response on purpose — the mass of the whole
    // assembly should feel like more than the mass of one particle. Slower still
    // under a hand: tracker output is jittery at the pixel level, and a long time
    // constant is what turns thirty noisy frames a second into one smooth turn.
    const tau = aim ? 0.32 : 0.55;
    node.rotation.x = approach(node.rotation.x, tilt.x, dt, tau);
    node.rotation.y = approach(node.rotation.y, tilt.y, dt, tau);

    // Same time constant as the camera's own zoom easing, so the assembly and
    // the camera arrive together; a faster one overshoots and the scene bounces.
    scale.current = approach(scale.current, orbitalZoom(refs.zoom.current ?? 1).scale, dt, 0.22);
    node.scale.setScalar(scale.current);
  });

  return <group ref={group}>{children}</group>;
}

// --- the core --------------------------------------------------------------

/**
 * Eases the bloom pass instead of letting React step it.
 *
 * This is the flash. `intensity={look.bloom}` as a prop is applied on the very
 * frame the state changes, so a single message walks idle → thinking → speaking →
 * idle and steps the whole post-processing pass 1.25 → 1.7 → 1.8 → 1.25 in four
 * hard cuts a second or two apart. Because bloom is a full-screen pass over a
 * translucent panel, that reads as the entire HUD flaring — the "shock" on send.
 * Same destination, reached over a third of a second, plus whatever `coreEnergy`
 * adds while the message is actually being worked on.
 *
 * Generic over the effect so this file does not have to import `postprocessing`
 * to name a single mutable number.
 */
export function BloomEnergy<T extends { intensity: number }>({
  look,
  refs,
  effect,
}: {
  look: CoreLook;
  refs: SceneRefs;
  effect: React.RefObject<T | null>;
}) {
  useFrame((_, dt) => {
    const node = effect.current;
    if (!node) return;
    node.intensity = approach(node.intensity, coreEnergy(look, surgeOf(look, refs)).bloom, dt, 0.35);
  });
  return null;
}

/**
 * A rim-lit shell. `pow(1 - dot(normal, view), k)` is the cheapest thing that
 * reads as a hot atmosphere around a star, and it costs one dot product per
 * fragment — which matters, because two of these are stacked over the sun.
 */
const FRESNEL_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRESNEL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uStrength;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = 1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);
    float glow = pow(rim, uPower) * uStrength;
    gl_FragColor = vec4(uColor * glow, glow);
  }
`;

function fresnelMaterial(color: string, power: number, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FRESNEL_VERTEX,
    fragmentShader: FRESNEL_FRAGMENT,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: power },
      uStrength: { value: strength },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    // Additive shells must not occlude what is behind them, including each other.
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/**
 * The sun at the centre: one solid, blown-out sphere for the bloom pass to find,
 * and two additive shells around it for the atmosphere.
 *
 * `toneMapped={false}` on the inner sphere is what makes the bloom bright rather
 * than merely present — tone mapping would compress the colour back under 1.0
 * before the luminance threshold ever saw it.
 */
export function CoreSphere({ look, motion, refs }: { look: CoreLook; motion: number; refs: SceneRefs }) {
  const group = useRef<THREE.Group>(null);
  const inner = useRef<THREE.MeshBasicMaterial>(null);
  // Built once and then mutated. The palette is intentionally *not* a dependency:
  // a new material per state change would recompile the shader mid-conversation,
  // which is a visible hitch. The colour is crossfaded in the frame loop instead.
  const corona = useMemo(() => fresnelMaterial(look.palette.glow, 2.2, 1.05), []);
  const halo = useMemo(() => fresnelMaterial(look.palette.glow, 1.5, 0.28), []);
  useEffect(() => () => [corona, halo].forEach((m) => m.dispose()), [corona, halo]);

  // Frozen at mount, and that is the point. A changed `color` prop is applied by
  // r3f the instant React re-renders, which overwrote the crossfade below with a
  // hard cut — the visible colour snap every time a message changed the state.
  // The frame loop is the only thing that moves this colour now.
  const initialCore = useMemo(() => look.palette.core, []);
  const coreColor = useMemo(() => new THREE.Color(look.palette.core), [look.palette.core]);
  const glowColor = useMemo(() => new THREE.Color(look.palette.glow), [look.palette.glow]);
  const scale = useRef(1);

  useFrame((state, dt) => {
    // Colour is crossfaded rather than switched: state changes are frequent
    // (idle → listening → thinking within a second) and a hard cut through four
    // hues in a second is a strobe.
    const step = 1 - Math.exp(-Math.min(dt, 0.25) / 0.18);
    inner.current?.color.lerp(coreColor, step);
    uniformColor(corona, "uColor")?.lerp(glowColor, step);
    uniformColor(halo, "uColor")?.lerp(glowColor, step);

    // Three things move the core: the state's swell (mic level rides on it), a
    // slow breath so an idle core is alive without implying activity, and the
    // surge from whatever was last sent.
    const breath = 1 + Math.sin(state.clock.elapsedTime * 0.6) * 0.02 * motion;
    const energy = coreEnergy(look, surgeOf(look, refs));
    scale.current = approach(scale.current, energy.swell * breath, dt, 0.12);
    group.current?.scale.setScalar(scale.current);
  });

  return (
    <group ref={group}>
      <mesh>
        <icosahedronGeometry args={[0.5, 5]} />
        <meshBasicMaterial ref={inner} color={initialCore} toneMapped={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.8, 48, 48]} />
        <primitive object={corona} attach="material" />
      </mesh>
      <mesh>
        <sphereGeometry args={[1.3, 32, 32]} />
        <primitive object={halo} attach="material" />
      </mesh>
    </group>
  );
}

/** Narrowing helper — a uniform's `value` is `any`, and this pins it once. */
function uniformColor(material: THREE.ShaderMaterial, name: string): THREE.Color | undefined {
  const value = material.uniforms[name]?.value;
  return value instanceof THREE.Color ? value : undefined;
}

// --- the rings -------------------------------------------------------------

interface RingSpec {
  radius: number;
  tube: number;
  /** Resting tilt, so the stack reads as a gyroscope rather than as concentric Os. */
  tilt: [number, number, number];
  /** The axis this ring precesses about, in world space. Its own, hence the look. */
  axis: [number, number, number];
  /** Turns per second about `axis`. Signs alternate so adjacent rings counter-rotate. */
  precess: number;
  /** Turns per second in the ring's own plane. Only visible on an arc — see `arc`. */
  roll: number;
  /** How much of the circle exists, in radians. `TAU` is a closed ring. */
  arc: number;
  segments: [number, number];
  opacity: number;
}

const TAU = Math.PI * 2;

/**
 * The ring stack, rebuilt as a structure rather than an arrangement.
 *
 * Radii are evenly spaced (0.7 apart) instead of 1.9 / 2.5 / 3.2 / 4.1, so the
 * gaps read as a measurement. Inclinations step by a clean 15° through 72° → 27°,
 * where the previous set was four unrelated triples and looked like it. And the
 * outer two are arcs rather than closed hoops: four full circles over a particle
 * field is where most of the old clutter came from, while a bracket that sweeps
 * reads as an instrument.
 *
 * Two things were learned by rendering it. Solid tubes rather than wireframe — at
 * this width a wireframe torus is a crosshatch of triangles, and four stacked was
 * noise standing in for detail — but *not* thin ones: at 0.011 a solid ring is a
 * hairline that the bloom pass loses entirely, so the tube is roughly doubled and
 * the opacities are up with it. And no ring sits at exactly 90°: edge-on, a torus
 * is a straight line across the core, which reads as a scratch on the panel rather
 * than as a ring seen from its plane.
 */
const RINGS: readonly RingSpec[] = [
  { radius: 2.1, tube: 0.022, tilt: [1.256, 0, 0], axis: [0, 1, 0.2], precess: 0.16, roll: 0, arc: TAU, segments: [128, 6], opacity: 0.92 },
  { radius: 2.8, tube: 0.019, tilt: [0.994, 0.42, 0], axis: [0.4, 1, 0], precess: -0.11, roll: 0, arc: TAU, segments: [160, 6], opacity: 0.7 },
  { radius: 3.5, tube: 0.026, tilt: [0.733, -0.52, 0], axis: [1, 0.25, 0], precess: 0.07, roll: 0.22, arc: Math.PI * 1.34, segments: [140, 6], opacity: 0.6 },
  { radius: 4.2, tube: 0.016, tilt: [0.471, 0.68, 0], axis: [0.2, -1, 0.35], precess: -0.05, roll: -0.14, arc: Math.PI * 0.86, segments: [120, 6], opacity: 0.42 },
];

/**
 * Four rings and a faceted shell, each on its own axis.
 *
 * Two rotations per ring, not one: it precesses about a world axis it does not
 * share with its neighbours, and — where it is an arc rather than a closed hoop —
 * it also rolls in its own plane. Precession alone looks like a spinning hoop; the
 * pair looks like a mechanism. A closed ring's roll is invisible by definition, so
 * those are left at 0 instead of burning a rotation nobody can see.
 *
 * Zoom is the third thing that moves them. `orbitalZoom` decides how much; all
 * this does is apply the `spread` half — a per-ring push back along the view axis,
 * so the stack opens into a tunnel as the camera closes instead of staying flat.
 * The radius half of the same decision belongs to `AssemblyTilt`, because the
 * field has to contract with the rings or the camera ends up inside it.
 */
export function Rings({ look, motion, refs }: { look: CoreLook; motion: number; refs: SceneRefs }) {
  const groups = useRef<(THREE.Group | null)[]>([]);
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const materials = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const shell = useRef<THREE.Mesh>(null);
  const shellMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const axes = useMemo(
    () => RINGS.map((r) => new THREE.Vector3(...r.axis).normalize()),
    [],
  );
  const ringColor = useMemo(() => new THREE.Color(look.palette.ring), [look.palette.ring]);
  // Frozen at mount for the same reason `CoreSphere`'s is: a changed `color` prop
  // is a hard cut that overwrites the crossfade below.
  const initialRing = useMemo(() => look.palette.ring, []);
  const spin = useRef(0);
  const spread = useRef(0);

  useFrame((_, dt) => {
    const step = 1 - Math.exp(-Math.min(dt, 0.25) / 0.18);
    // The whole stack's speed follows the state, eased — so "thinking" spins up
    // over a moment instead of jump-cutting to a faster rate. `coreEnergy` is
    // what makes a sent message or an open microphone spin it faster still.
    const energy = coreEnergy(look, surgeOf(look, refs));
    spin.current = approach(spin.current, energy.spin * motion, dt, 0.5);
    const rate = spin.current * Math.PI * 2 * Math.min(dt, 0.25);

    spread.current = approach(spread.current, orbitalZoom(refs.zoom.current ?? 1).spread, dt, 0.22);

    RINGS.forEach((ring, i) => {
      const axis = axes[i];
      const group = groups.current[i];
      if (group && axis) group.rotateOnWorldAxis(axis, ring.precess * rate);
      // Negative: away from the camera. Pushing the wider rings forward instead
      // would fly them past the near plane at full zoom.
      if (group) group.position.z = -spread.current * i;
      const mesh = meshes.current[i];
      if (mesh) mesh.rotation.z += ring.roll * rate;
      materials.current[i]?.color.lerp(ringColor, step);
    });

    if (shell.current) {
      shell.current.rotation.y += 0.06 * rate;
      shell.current.rotation.x -= 0.04 * rate;
    }
    shellMaterial.current?.color.lerp(ringColor, step);
  });

  return (
    <group>
      {RINGS.map((ring, i) => (
        <group
          key={ring.radius}
          ref={(g) => void (groups.current[i] = g)}
          rotation={ring.tilt}
        >
          <mesh ref={(m) => void (meshes.current[i] = m)}>
            <torusGeometry
              args={[ring.radius, ring.tube, ring.segments[1], ring.segments[0], ring.arc]}
            />
            <meshBasicMaterial
              ref={(m) => void (materials.current[i] = m)}
              color={initialRing}
              transparent
              opacity={ring.opacity}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* The containment shell: geometry rather than another circle, so the core
          reads as held inside something. Detail 0 — the bare 20-face icosahedron —
          after detail 1 rendered as eighty short edges tangled over the brightest
          part of the panel, which was the single messiest thing in the frame. One
          faceted cage at low opacity says the same thing and can be read. */}
      <mesh ref={shell}>
        <icosahedronGeometry args={[1.68, 0]} />
        <meshBasicMaterial
          ref={shellMaterial}
          color={initialRing}
          wireframe
          transparent
          opacity={0.16}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

// --- the neuron field ------------------------------------------------------

/**
 * The shells the field is built in.
 *
 * Discrete layers, where this used to be one continuous radius with a mild inward
 * bias. That bias is what made the field look clumsy: every radius between 1.85
 * and 4.8 was occupied, so there was no space anywhere in it, and the eye had
 * nothing to resolve except a haze that happened to be denser at the bottom of the
 * range. Three shells with real gaps between them read as structure — you can see
 * that the core is surrounded by something arranged, and you can see through it.
 *
 * Sizes taper outward so the layers separate by weight as well as by distance,
 * which is what keeps the outer shell from reading as a second inner one. The
 * innermost shell still clears the containment shell at 1.62 — inside it, points
 * read as a cloud sitting *on* the sun rather than as a field around it — and it
 * was pushed out to 2.4 after the first render of these layers, where a dense
 * shell at 2.08 fused with the corona into one bright donut.
 *
 * Counts rise outward, against the intuition that a field should be denser near
 * what it surrounds. A shell's *area* goes as r², so an even count per shell is
 * three very different densities: the inner shell overlaps into a lit mass while
 * the outer one is a thin sprinkle. Weighting toward the outside is what makes all
 * three read as the same material at different distances.
 */
const FIELD_LAYERS = [
  { radius: 2.4, share: 0.24, size: 1, jitter: 0.08 },
  { radius: 3.3, share: 0.33, size: 0.82, jitter: 0.1 },
  { radius: 4.15, share: 0.43, size: 0.64, jitter: 0.12 },
] as const;

/** The shell's bounds, which are the layers' own extremes plus their jitter. */
const FIELD_INNER = FIELD_LAYERS[0].radius - FIELD_LAYERS[0].jitter;
const FIELD_OUTER =
  FIELD_LAYERS[FIELD_LAYERS.length - 1]!.radius + FIELD_LAYERS[FIELD_LAYERS.length - 1]!.jitter;

/**
 * The field is displaced entirely on the GPU.
 *
 * The obvious implementation — walk the position array on the CPU each frame and
 * re-upload it — costs a buffer upload per frame plus the walk, and it is why most
 * particle fields on the web stall at a few thousand points. Here the base
 * positions are uploaded once and never touched; drift and pointer repulsion are
 * computed per vertex from `uTime` and `uMouse`, so the per-frame CPU cost of the
 * whole field is a handful of uniform writes.
 */
const FIELD_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform vec3 uMouse;
  uniform float uForce;
  uniform float uAgitation;
  uniform float uSize;
  uniform float uPixelRatio;
  // Where the discharge from the last send has reached, and how hard it is
  // hitting. Both are 0 when nothing is travelling, which costs the shader a
  // multiply by zero rather than a branch.
  uniform float uShockFront;
  uniform float uShockEnergy;
  attribute float aSeed;
  attribute float aScale;
  varying float vLit;
  varying float vDepth;
  varying float vFade;
  varying float vShock;

  void main() {
    vec3 p = position;
    float s = aSeed * 6.2831853;
    float t = uTime;

    // Organic drift: sines at incommensurable rates, one set per axis, phased by
    // the particle's own seed. Reads as Brownian motion at a fraction of the cost
    // of real noise, and never visibly repeats within a session.
    vec3 drift = vec3(
      sin(t * 0.33 + s) + 0.5 * sin(t * 0.71 + s * 1.7),
      cos(t * 0.29 + s * 1.3) + 0.5 * sin(t * 0.61 + s * 2.1),
      sin(t * 0.25 + s * 0.9) + 0.5 * cos(t * 0.53 + s * 1.4)
    );
    p += drift * 0.13 * uAgitation;

    // The discharge. Measured against the particle's resting radius rather than
    // its drifted one: read off the drifted p, each particle's own wander would
    // front into a band twice its width and make it crawl unevenly outwards.
    // Gaussian for the same reason the pointer force is — a hard edge reads as a
    // rendering seam sweeping the field, a soft one as something passing through.
    float rest = clamp((length(position) - ${FIELD_INNER.toFixed(3)}) / ${(FIELD_OUTER - FIELD_INNER).toFixed(3)}, 0.0, 1.0);
    float band = (rest - uShockFront) * 7.0;
    vShock = exp(-band * band) * uShockEnergy;
    // Knocked outwards as it passes, so the shells visibly take the hit instead
    // of only lighting up. Small: this is a jolt, not a shockwave that rebuilds
    // the field's shape.
    p += normalize(p + vec3(1e-4)) * vShock * 0.2;

    // Pointer force. The Gaussian falloff keeps the disturbance local, so the
    // field bends around the cursor rather than the whole sphere lurching; a
    // negative uForce attracts instead, with no other change.
    vec3 away = p - uMouse;
    float d = length(away);
    float falloff = exp(-d * d * 0.42);
    p += normalize(away + vec3(1e-4)) * falloff * uForce;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = -mv.z;
    // The assembly's own scale, read off the model-view matrix. Without it a
    // contracting assembly would keep its points at full screen size, so zooming
    // in would pack the same fat blobs into a smaller volume.
    float rig = length(modelViewMatrix[0].xyz);
    // Size attenuation by eye-space depth, so pulling the camera in makes near
    // particles genuinely bigger instead of merely more spread out. Capped:
    // uncapped, a particle that ends up close to the near plane balloons into a
    // screen-filling blur.
    gl_PointSize =
      uSize * aScale * uPixelRatio * rig * min(2.0, 6.0 / max(1.0, -mv.z)) * (1.0 + vShock * 0.7);
    vLit = falloff;
    // Fade out the particles the camera has come close to. At the resting
    // framing nothing is inside this range and the field is untouched; zoomed
    // in, the near face of the shell dissolves instead of smearing across the
    // core, which is what "clean when zoomed in" actually requires — you fly
    // through the front of the field rather than into it.
    vFade = smoothstep(1.6, 3.6, depth);
    // Normalised across the field's own shell, so the near/far colour ramp spends
    // its whole range on particles that exist. Interpolated from the layer table
    // rather than written twice: the two numbers went out of step the first time
    // the shells moved, and the ramp quietly stopped reaching its far colour.
    vDepth = clamp((length(p) - ${FIELD_INNER.toFixed(3)}) / ${(FIELD_OUTER - FIELD_INNER).toFixed(3)}, 0.0, 1.0);
  }
`;

const FIELD_FRAGMENT = /* glsl */ `
  uniform vec3 uColorNear;
  uniform vec3 uColorFar;
  uniform float uOpacity;
  varying float vLit;
  varying float vDepth;
  varying float vFade;
  varying float vShock;

  void main() {
    // Round, soft points straight from gl_PointCoord — no sprite texture, so
    // nothing here has to be decoded at startup or clear the renderer's CSP.
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d) * 4.0;
    if (r > 1.0) discard;
    float alpha = pow(1.0 - r, 1.8) * vFade;
    vec3 col = mix(uColorNear, uColorFar, vDepth) + uColorNear * vLit * 1.2;
    // The near colour rather than white: blending toward white is what turned the
    // old grey field colourless under bloom, and a discharge that flashes white
    // would do it again for as long as it lasts.
    col += uColorNear * vShock * 2.4;
    gl_FragColor = vec4(col, min(1.0, alpha * (1.0 + vShock * 0.8)) * uOpacity);
  }
`;

/**
 * The angle successive points advance by on each shell.
 *
 * This is the whole declutter, in one number. Random longitudes leave clumps and
 * bald patches — with a few thousand samples you see both, and "messy" is exactly
 * what that looks like. Advancing by the golden angle instead places every point
 * in the largest gap left by the ones before it, so the shell ends up evenly
 * spaced at any count, with no lattice for the eye to catch either.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function buildField(count: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);

  let i = 0;
  FIELD_LAYERS.forEach((layer, index) => {
    // The last shell takes the remainder, so rounding can never leave points
    // unwritten — an unwritten position is a particle sitting at the origin,
    // inside the sun, which is one very bright pixel that took a while to explain.
    const points =
      index === FIELD_LAYERS.length - 1 ? count - i : Math.round(count * layer.share);
    // Offset so the shells do not share a starting longitude, which would line
    // their first points up into a visible spoke through all three.
    const phase = index * 1.7;

    for (let j = 0; j < points && i < count; j += 1, i += 1) {
      // Even in cos-latitude rather than in latitude: the former is even in *area*,
      // which is what stops points piling into two bright polar caps.
      const u = 1 - (2 * (j + 0.5)) / points;
      const ring = Math.sqrt(Math.max(0, 1 - u * u));
      const phi = j * GOLDEN_ANGLE + phase;
      // Jittered off the exact shell, or three mathematically perfect spheres
      // read as glass rather than as neurons — and their moiré against the pixel
      // grid crawls when the assembly turns.
      const radius = layer.radius + (Math.random() * 2 - 1) * layer.jitter;

      positions[i * 3] = ring * Math.cos(phi) * radius;
      // Mildly lens-shaped, which lets the rings read as a plane the field lies in.
      positions[i * 3 + 1] = u * radius * 0.86;
      positions[i * 3 + 2] = ring * Math.sin(phi) * radius;
      seeds[i] = Math.random();
      // A twentieth of each shell is brighter and larger. Uniform sizes dust the
      // screen evenly; a light tail is what reads as individual neurons. Thinner
      // than the tenth it used to be, and multiplied by the layer's own taper —
      // the old tail put big points on the outer shell too, and those are the ones
      // that bloomed into the fog the layers exist to get rid of.
      const tail = Math.random() < 0.05 ? 1.15 + Math.random() * 0.35 : 0.5 + Math.random() * 0.4;
      scales[i] = tail * layer.size;
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
  // Stated rather than computed: the shader displaces vertices past whatever
  // three would measure here, and a culled field is a field that vanishes when
  // the camera comes close.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FIELD_OUTER + 2);
  return geometry;
}

export interface ParticleFieldProps {
  look: CoreLook;
  motion: number;
  refs: SceneRefs;
  /** Particle count. Changing it rebuilds the buffers, so it is not per-frame. */
  count: number;
  pixelRatio: number;
}

export function ParticleField({ look, motion, refs, count, pixelRatio }: ParticleFieldProps) {
  const points = useRef<THREE.Points>(null);
  const geometry = useMemo(() => buildField(count), [count]);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector3(0, 0, 0) },
      uForce: { value: 0 },
      uAgitation: { value: 0 },
      // Smaller than the 12 the single-layer field used. With three shells the
      // near one is what the eye lands on, and at 12 its points overlapped into a
      // lit mass — the exact clumping the layers were introduced to remove.
      uSize: { value: 9.5 },
      uPixelRatio: { value: pixelRatio },
      uOpacity: { value: 0.8 },
      uColorNear: { value: new THREE.Color(look.palette.particle) },
      uColorFar: { value: new THREE.Color(look.palette.ring) },
      uShockFront: { value: 0 },
      uShockEnergy: { value: 0 },
    }),
    [],
  );
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FIELD_VERTEX,
        fragmentShader: FIELD_FRAGMENT,
        uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Additive points that write depth punch holes in each other and in the
        // rings behind them; sorting thousands of them per frame is the
        // alternative, and it costs more than the artefact is worth.
        depthWrite: false,
      }),
    [uniforms],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => void (uniforms.uPixelRatio.value = pixelRatio), [uniforms, pixelRatio]);

  const near = useMemo(() => new THREE.Color(look.palette.particle), [look.palette.particle]);
  const far = useMemo(() => new THREE.Color(look.palette.ring), [look.palette.ring]);
  const mouseTarget = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.25);
    uniforms.uTime.value += step;

    // Where the pointer is, in the plane the core sits in. Derived from the
    // camera's own framing rather than a raycast: the camera looks at the origin
    // down -z, so the visible half-height at z = 0 is one tangent away, and a
    // raycaster would allocate per frame to reach the same answer.
    const pointer = activePointer(refs);
    const camera = state.camera;
    if (camera instanceof THREE.PerspectiveCamera) {
      const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * Math.max(0.1, camera.position.z);
      mouseTarget.set(
        (pointer?.x ?? 0) * halfHeight * camera.aspect,
        (pointer?.y ?? 0) * halfHeight,
        0,
      );
      // Into this object's own space, because `AssemblyTilt` rotates the group
      // above it: the shader compares `uMouse` against untransformed vertex
      // positions, so a world-space mouse would repel the wrong side of a tilted
      // field. `worldToLocal` reuses three's own scratch matrix — no allocation.
      points.current?.worldToLocal(mouseTarget);
    }
    // Fast, but still eased: an un-eased uMouse jitters the field with every
    // pixel of mouse movement, which looks like noise rather than like force.
    uniforms.uMouse.value.lerp(mouseTarget, 1 - Math.exp(-step / 0.05));

    // Force is not scaled by `motion`. Reduced-motion means "do not animate at
    // me", not "ignore my input" — the drift below is what that setting silences.
    uniforms.uForce.value = approach(uniforms.uForce.value, pointer ? 0.95 : 0, dt, 0.18);
    // The field's share of the surge: a sent message or an open microphone makes
    // the whole shell churn harder for a moment, then it settles back.
    const energy = coreEnergy(look, surgeOf(look, refs));
    uniforms.uAgitation.value = approach(uniforms.uAgitation.value, energy.agitation * motion, dt, 0.6);
    const opacity = 0.62 + 0.38 * Math.min(1, energy.agitation * 2);
    uniforms.uOpacity.value = approach(uniforms.uOpacity.value, opacity, dt, 0.4);

    // Written straight rather than eased through `approach`: the whole point of
    // the front is where it is *now*, and easing a position that is already a
    // function of time would only make it lag. Scaled by `motion`, so reduced
    // motion gets the send acknowledged by the surge alone.
    const shock = shockOf(look, refs);
    uniforms.uShockFront.value = shock.front;
    uniforms.uShockEnergy.value = shock.energy * motion;

    const fade = 1 - Math.exp(-step / 0.18);
    uniforms.uColorNear.value.lerp(near, fade);
    uniforms.uColorFar.value.lerp(far, fade);
  });

  return (
    <points ref={points} frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </points>
  );
}
