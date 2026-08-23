import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_GESTURE_ENDPOINT,
  applyGestureCommand,
  connectGestureSocket,
  parseGesturePayload,
  rotationToFrame,
  type GestureSocketLike,
} from "../src/ui/gesture-socket.js";
import {
  HAND_MAX_PITCH,
  HAND_MAX_YAW,
  ZOOM_MAX,
  ZOOM_MIN,
  handTilt,
  handToPointer,
  type HandFrame,
} from "../src/ui/neural-core-model.js";

/** A stand-in for the core: records the calls the socket is allowed to make. */
function target() {
  const hands: (HandFrame | null)[] = [];
  const zooms: number[] = [];
  let pulses = 0;
  return {
    hands,
    zooms,
    get pulses() {
      return pulses;
    },
    setHand: (f: HandFrame | null) => void hands.push(f),
    setZoom: (z: number) => void zooms.push(z),
    pulse: () => void (pulses += 1),
  };
}

/** A WebSocket that never touches the network. */
class FakeSocket implements GestureSocketLike {
  static opened: FakeSocket[] = [];
  onopen: ((e?: unknown) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = 0;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  close(): void {
    this.closed += 1;
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const factory = (): ((endpoint: string) => GestureSocketLike) => {
  FakeSocket.opened = [];
  return (endpoint) => new FakeSocket(endpoint);
};

/** Where a frame actually aims the assembly, through the real mapping chain. */
function aimOf(frame: HandFrame): { pitch: number; yaw: number } {
  const p = handToPointer(frame);
  const tilt = handTilt(p.x, p.y);
  return { pitch: tilt.x, yaw: tilt.y };
}

describe("rotation intent", () => {
  it("lands the assembly at exactly the radians it was asked for", () => {
    // The claim the whole mapping exists to make: a payload asking for half of
    // full yaw gets half of full yaw, through the same path a mouse takes.
    for (const [rx, ry] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [0.5, -0.25],
      [-0.8, 0.6],
    ] as const) {
      const aim = aimOf(rotationToFrame(rx, ry));
      expect(aim.pitch).toBeCloseTo(rx * HAND_MAX_PITCH, 6);
      expect(aim.yaw).toBeCloseTo(ry * HAND_MAX_YAW, 6);
    }
  });

  it("reads radians when the producer says that is what it sent", () => {
    const aim = aimOf(rotationToFrame(0.25, -0.42, "radians"));
    expect(aim.pitch).toBeCloseTo(0.25, 6);
    expect(aim.yaw).toBeCloseTo(-0.42, 6);
  });

  it("clamps rather than letting a runaway tracker spin the rig", () => {
    const aim = aimOf(rotationToFrame(40, -40));
    expect(aim.pitch).toBeCloseTo(HAND_MAX_PITCH, 6);
    expect(aim.yaw).toBeCloseTo(-HAND_MAX_YAW, 6);
  });

  it("centres on a number that is not one", () => {
    // NaN from a division by an unseen landmark is the common case, and a rig
    // that swings to an edge on arithmetic nobody meant is the bug.
    const aim = aimOf(rotationToFrame(Number.NaN, Number.POSITIVE_INFINITY));
    expect(aim.pitch).toBeCloseTo(0, 6);
    expect(aim.yaw).toBeCloseTo(0, 6);
  });
});

describe("payload parsing", () => {
  it("takes the shape the master prompt specified", () => {
    const c = parseGesturePayload({ zoom: 1.8, rotationX: 0.3, rotationY: -0.4 });
    expect(c?.release).toBe(false);
    expect(c?.zoom).toBeCloseTo(1.8, 6);
    expect(aimOf(c!.frame!).yaw).toBeCloseTo(-0.4 * HAND_MAX_YAW, 6);
  });

  it("also takes raw camera coordinates, and prefers a measured pinch", () => {
    const c = parseGesturePayload({ x: 0.62, y: 0.44, pinch: 0.19 });
    expect(c?.frame).toEqual({ x: 0.62, y: 0.44, pinch: 0.19 });
    expect(c?.zoom).toBeNull();
  });

  it("parses a raw JSON line, so a stdout pipe needs no unwrapping", () => {
    const c = parseGesturePayload('{"rotationX":0,"rotationY":1,"zoom":2}');
    expect(c?.zoom).toBeCloseTo(2, 6);
    expect(aimOf(c!.frame!).yaw).toBeCloseTo(HAND_MAX_YAW, 6);
  });

  it("clamps zoom into the range the wheel is held to", () => {
    expect(parseGesturePayload({ zoom: 99 })?.zoom).toBeCloseTo(ZOOM_MAX, 6);
    expect(parseGesturePayload({ zoom: -5 })?.zoom).toBeCloseTo(ZOOM_MIN, 6);
  });

  it("treats zoom alone as a hand held still, not as letting go", () => {
    const c = parseGesturePayload({ zoom: 1.4 });
    expect(c).toEqual({ release: false, frame: null, zoom: 1.4 });
  });

  it("releases on an explicit release, and on null", () => {
    expect(parseGesturePayload({ release: true })?.release).toBe(true);
    expect(parseGesturePayload(null)?.release).toBe(true);
  });

  it("drops nonsense instead of releasing mid-gesture", () => {
    // A tracker restarting writes half a line. Snapping the rig back to centre
    // for one bad frame is worse than ignoring it.
    for (const bad of ["", "{", "not json", 7, true, {}, { rotationX: "left" }, []]) {
      expect(parseGesturePayload(bad)).toBeNull();
    }
  });
});

describe("applying a command", () => {
  it("sets the pose, then lets an explicit zoom overrule the pinch", () => {
    const t = target();
    applyGestureCommand(t, { release: false, frame: { x: 0.5, y: 0.5, pinch: 0.1 }, zoom: 2.1 });
    expect(t.hands).toHaveLength(1);
    expect(t.zooms).toEqual([2.1]);
  });

  it("releases without touching the zoom", () => {
    const t = target();
    applyGestureCommand(t, { release: true, frame: null, zoom: 2.1 });
    expect(t.hands).toEqual([null]);
    expect(t.zooms).toEqual([]);
  });

  it("never pulses — the wire cannot start a turn", () => {
    const t = target();
    applyGestureCommand(t, { release: false, frame: { x: 0.4, y: 0.4 }, zoom: 1.2 });
    applyGestureCommand(t, { release: true, frame: null, zoom: null });
    expect(t.pulses).toBe(0);
  });
});

describe("the socket", () => {
  it("does nothing at all without an endpoint", () => {
    const open = factory();
    const t = target();
    for (const endpoint of [undefined, null, "", "   "]) {
      connectGestureSocket(t, { endpoint, createSocket: open })();
    }
    expect(FakeSocket.opened).toHaveLength(0);
    // Not even a release: a component that never connected must not stamp on a
    // pose the mouse is holding.
    expect(t.hands).toEqual([]);
  });

  it("connects to the endpoint it was given and steers on each frame", () => {
    const open = factory();
    const t = target();
    const stop = connectGestureSocket(t, { endpoint: DEFAULT_GESTURE_ENDPOINT, createSocket: open });
    const socket = FakeSocket.opened[0]!;
    expect(socket.url).toBe(DEFAULT_GESTURE_ENDPOINT);
    socket.onopen?.();
    socket.deliver('{"rotationX":0.2,"rotationY":0.5,"zoom":1.7}');
    socket.deliver({ rotationX: -0.2, rotationY: -0.5 });
    expect(t.hands).toHaveLength(2);
    expect(t.zooms).toEqual([1.7]);
    expect(aimOf(t.hands[0]!).yaw).toBeCloseTo(0.5 * HAND_MAX_YAW, 6);
    stop();
  });

  it("hands control back the moment the tracker's socket closes", () => {
    const open = factory();
    const t = target();
    const stop = connectGestureSocket(t, { endpoint: "ws://127.0.0.1:9", createSocket: open });
    const socket = FakeSocket.opened[0]!;
    socket.deliver({ rotationX: 0.4, rotationY: 0.4 });
    expect(t.hands.at(-1)).not.toBeNull();
    socket.onclose?.();
    // Not after HAND_TIMEOUT_MS — now. A closed socket is a tracker that is gone.
    expect(t.hands.at(-1)).toBeNull();
    stop();
  });

  it("reports connect and disconnect to a host that asked", () => {
    const open = factory();
    const seen: boolean[] = [];
    const stop = connectGestureSocket(target(), {
      endpoint: "ws://127.0.0.1:9",
      createSocket: open,
      onStateChange: (c) => void seen.push(c),
    });
    const socket = FakeSocket.opened[0]!;
    socket.onopen?.();
    socket.onclose?.();
    expect(seen).toEqual([true, false]);
    stop();
  });
});

describe("reconnecting", () => {
  it("retries on a backoff, and resets it once a tracker comes back", () => {
    vi.useFakeTimers();
    try {
      const open = factory();
      const stop = connectGestureSocket(target(), {
        endpoint: "ws://127.0.0.1:9",
        createSocket: open,
        baseDelayMs: 100,
        maxDelayMs: 400,
      });
      expect(FakeSocket.opened).toHaveLength(1);

      // Nothing is listening yet: 100, then 200, then 400 and held there.
      FakeSocket.opened[0]!.onclose?.();
      vi.advanceTimersByTime(99);
      expect(FakeSocket.opened).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.opened).toHaveLength(2);

      FakeSocket.opened[1]!.onclose?.();
      vi.advanceTimersByTime(199);
      expect(FakeSocket.opened).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.opened).toHaveLength(3);

      FakeSocket.opened[2]!.onclose?.();
      vi.advanceTimersByTime(400);
      expect(FakeSocket.opened).toHaveLength(4);
      FakeSocket.opened[3]!.onclose?.();
      vi.advanceTimersByTime(400);
      expect(FakeSocket.opened).toHaveLength(5);

      // The tracker starts. The next drop must not wait the capped delay: a
      // script the user restarts by hand should be picked up promptly.
      FakeSocket.opened[4]!.onopen?.();
      FakeSocket.opened[4]!.onclose?.();
      vi.advanceTimersByTime(100);
      expect(FakeSocket.opened).toHaveLength(6);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts one failure per close, not one per error-and-close", () => {
    vi.useFakeTimers();
    try {
      const open = factory();
      const stop = connectGestureSocket(target(), {
        endpoint: "ws://127.0.0.1:9",
        createSocket: open,
        baseDelayMs: 100,
      });
      // A refused connection fires both, in this order. Doubling the backoff for
      // each would make the delay grow twice as fast as intended.
      FakeSocket.opened[0]!.onerror?.();
      FakeSocket.opened[0]!.onclose?.();
      vi.advanceTimersByTime(100);
      expect(FakeSocket.opened).toHaveLength(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps trying when the endpoint itself throws on construction", () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const stop = connectGestureSocket(target(), {
        endpoint: "ws://nope",
        baseDelayMs: 50,
        createSocket: () => {
          attempts += 1;
          throw new SyntaxError("bad url");
        },
      });
      expect(attempts).toBe(1);
      vi.advanceTimersByTime(50);
      expect(attempts).toBe(2);
      stop();
      vi.advanceTimersByTime(10_000);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops dead on teardown: no retry, and the hand is released", () => {
    vi.useFakeTimers();
    try {
      const open = factory();
      const t = target();
      const stop = connectGestureSocket(t, {
        endpoint: "ws://127.0.0.1:9",
        createSocket: open,
        baseDelayMs: 10,
      });
      const socket = FakeSocket.opened[0]!;
      socket.deliver({ rotationX: 0.5, rotationY: 0.5 });
      stop();
      expect(socket.closed).toBe(1);
      // Released, so an unmount mid-gesture cannot leave the rig at a dead
      // tracker's last pose.
      expect(t.hands.at(-1)).toBeNull();
      // And a close provoked by our own teardown must not schedule anything.
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores frames that arrive after teardown", () => {
    const open = factory();
    const t = target();
    const stop = connectGestureSocket(t, { endpoint: "ws://127.0.0.1:9", createSocket: open });
    const socket = FakeSocket.opened[0]!;
    stop();
    const before = t.hands.length;
    socket.deliver({ rotationX: 1, rotationY: 1 });
    expect(t.hands).toHaveLength(before);
  });
});
