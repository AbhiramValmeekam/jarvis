"""Drive the Jarvis HUD's neural core with a hand, over the gesture socket.

This is the producer end of the bridge in `src/ui/gesture-socket.ts`. It owns the
camera and MediaPipe; the HUD owns the scene. Nothing about this file knows what
clip space is or what the zoom range is — it reports where the hand is and how
open the pinch is, and the renderer's own tested mapping turns that into motion.

What the gestures do:

  * spread the thumb and index finger  -> zoom in
  * bring them back together           -> zoom out
  * move the hand across the frame      -> the assembly turns (yaw), never slides
  * raise and lower it                  -> pitch
  * take the hand out of frame          -> release; the mouse takes over again

Direction of travel is deliberate: this dials *out* to the HUD, so the HUD is the
client and this is the server. The camera is only opened while a client is
connected, so nothing is watching the room when the HUD is not listening.

Run:
    .venv-vision/Scripts/python vision/hand_tracker.py            # serve on 8765
    .venv-vision/Scripts/python vision/hand_tracker.py --preview  # with a window
    .venv-vision/Scripts/python vision/hand_tracker.py --selftest # no camera

Then start the HUD with the socket switched on:
    $env:VITE_JARVIS_GESTURE_WS = "ws://127.0.0.1:8765"; npm run dev
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import mediapipe as mp
import websockets
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

# Landmark indices, from MediaPipe's hand model.
WRIST, THUMB_TIP, INDEX_MCP, INDEX_TIP = 0, 4, 5, 8
MIDDLE_MCP, RING_MCP, PINKY_MCP = 9, 13, 17
PALM = (WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP)

# The window the renderer calibrates zoom across (`neural-core-model.ts`):
# PINCH_MIN is fully zoomed out, PINCH_MAX fully in, both as a fraction of frame
# width. Measured spans are rescaled onto this so a real hand can reach both ends.
HUD_PINCH_MIN, HUD_PINCH_MAX = 0.05, 0.32


# --- the mapping, kept pure so `--selftest` can prove it without a camera -----


def palm_center(landmarks) -> tuple[float, float]:
    """The hand's position, averaged over the palm rather than a fingertip.

    A fingertip moves when the user pinches, which would swing the assembly every
    time they zoomed. The palm holds still through a pinch, so the two gestures
    stay independent.
    """
    xs = [landmarks[i].x for i in PALM]
    ys = [landmarks[i].y for i in PALM]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def pinch_span(landmarks, aspect: float) -> float:
    """Thumb-tip to index-tip distance, as a fraction of frame *width*.

    MediaPipe normalises x by width and y by height, so on a 4:3 frame a vertical
    centimetre and a horizontal one come back as different numbers. `aspect`
    (height / width) puts them back in the same unit, which is what the renderer's
    calibration assumes.
    """
    a, b = landmarks[THUMB_TIP], landmarks[INDEX_TIP]
    return math.hypot(a.x - b.x, (a.y - b.y) * aspect)


def calibrate(span: float, lo: float, hi: float) -> float:
    """Rescale a measured span onto the window the renderer calibrates against.

    Without this the gesture works but only over part of its range: a hand a foot
    from a 640-wide webcam spans about 0.03 closed and 0.26 wide open, so the top
    of the zoom range would need fingers wider than the hand. Clamped at both
    ends, because the honest answer to a mismeasured span is to sit at the limit.
    """
    if hi <= lo:
        return span
    t = min(1.0, max(0.0, (span - lo) / (hi - lo)))
    return HUD_PINCH_MIN + t * (HUD_PINCH_MAX - HUD_PINCH_MIN)


def smooth(previous: float | None, value: float, alpha: float) -> float:
    """One pole of exponential smoothing. Removes landmark jitter, not intent."""
    return value if previous is None else previous + alpha * (value - previous)


@dataclass
class Settings:
    port: int
    camera: int
    model: Path
    fps: float
    preview: bool
    mirror: bool
    pinch_lo: float
    pinch_hi: float
    alpha: float
    grace: float


class Tracker:
    """Camera plus model, opened on demand and closed when nobody is listening."""

    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.cap: cv2.VideoCapture | None = None
        self.landmarker: mp_vision.HandLandmarker | None = None
        self.x: float | None = None
        self.y: float | None = None
        self.pinch: float | None = None
        self.last_seen = 0.0

    def open(self) -> None:
        if self.cap is not None:
            return
        options = mp_vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(self.s.model)),
            running_mode=mp_vision.RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )
        self.landmarker = mp_vision.HandLandmarker.create_from_options(options)
        cap = cv2.VideoCapture(self.s.camera)
        if not cap.isOpened():
            self.landmarker.close()
            self.landmarker = None
            raise RuntimeError(f"camera {self.s.camera} would not open")
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self.cap = cap
        print(f"[tracker] camera {self.s.camera} open", flush=True)

    def close(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        if self.landmarker is not None:
            self.landmarker.close()
            self.landmarker = None
        if self.s.preview:
            cv2.destroyAllWindows()
        self.x = self.y = self.pinch = None
        print("[tracker] camera closed", flush=True)

    def read(self) -> dict | None:
        """One frame, as the payload the HUD understands — or None for no news.

        Returns `{"release": True}` exactly once when a tracked hand goes away, so
        the rig hands back to the mouse instead of holding the last pose. While no
        hand has been seen at all it returns None rather than repeating a release:
        a producer that shouts "let go" thirty times a second is noise.
        """
        assert self.cap is not None and self.landmarker is not None
        got, frame = self.cap.read()
        if not got:
            return None
        if self.s.mirror:
            # Only for a camera that already mirrors in hardware. The renderer
            # mirrors by default (`handToPointer`), which is what a selfie view
            # needs, so the usual case sends raw image coordinates.
            frame = cv2.flip(frame, 1)
        height, width = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self.landmarker.detect_for_video(image, int(time.monotonic() * 1000))
        hands = result.hand_landmarks

        if not hands:
            if self.x is not None and time.monotonic() - self.last_seen > self.s.grace:
                self.x = self.y = self.pinch = None
                print("[tracker] hand lost - the mouse has it back", flush=True)
                if self.s.preview:
                    self._preview(frame, None)
                return {"release": True}
            if self.s.preview:
                self._preview(frame, None)
            return None

        marks = hands[0]
        if self.x is None:
            print("[tracker] hand acquired", flush=True)
        cx, cy = palm_center(marks)
        span = calibrate(pinch_span(marks, height / width), self.s.pinch_lo, self.s.pinch_hi)
        self.x = smooth(self.x, cx, self.s.alpha)
        self.y = smooth(self.y, cy, self.s.alpha)
        self.pinch = smooth(self.pinch, span, self.s.alpha)
        self.last_seen = time.monotonic()
        if self.s.preview:
            self._preview(frame, marks)
        return {"x": self.x, "y": self.y, "pinch": self.pinch}

    def _preview(self, frame, marks) -> None:
        """A debug window. Off by default: the HUD is the real feedback."""
        height, width = frame.shape[:2]
        if marks is not None:
            for i, m in enumerate(marks):
                colour = (80, 220, 255) if i in (THUMB_TIP, INDEX_TIP) else (120, 120, 120)
                cv2.circle(frame, (int(m.x * width), int(m.y * height)), 4, colour, -1)
            a, b = marks[THUMB_TIP], marks[INDEX_TIP]
            cv2.line(
                frame,
                (int(a.x * width), int(a.y * height)),
                (int(b.x * width), int(b.y * height)),
                (80, 220, 255),
                2,
            )
        text = "no hand" if self.pinch is None else f"pinch {self.pinch:.3f}"
        cv2.putText(frame, text, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        # Mirrored for display only, so the user sees themselves the right way
        # round; the numbers sent to the HUD come from the unflipped frame.
        cv2.imshow("jarvis hand tracker", frame if self.s.mirror else cv2.flip(frame, 1))
        cv2.waitKey(1)


async def serve(settings: Settings) -> None:
    tracker = Tracker(settings)
    clients: set = set()
    period = 1.0 / settings.fps

    async def pump() -> None:
        """Read and broadcast for as long as anyone is connected."""
        while True:
            if not clients:
                await asyncio.sleep(0.1)
                continue
            payload = tracker.read()
            if payload is not None:
                line = json.dumps(payload)
                for ws in list(clients):
                    try:
                        await ws.send(line)
                    except Exception:
                        pass  # the handler below owns disconnects
            await asyncio.sleep(period)

    async def handler(ws) -> None:
        first = not clients
        clients.add(ws)
        print(f"[tracker] hud connected ({len(clients)} listening)", flush=True)
        try:
            if first:
                tracker.open()
            await ws.wait_closed()
        finally:
            clients.discard(ws)
            print(f"[tracker] hud disconnected ({len(clients)} listening)", flush=True)
            if not clients:
                tracker.close()

    async with websockets.serve(handler, "127.0.0.1", settings.port):
        print(
            f"[tracker] listening on ws://127.0.0.1:{settings.port} - "
            "the camera stays off until the HUD connects",
            flush=True,
        )
        await pump()


def selftest(settings: Settings) -> int:
    """Prove the mapping without a camera, including the direction of the pinch."""

    class L:  # a landmark, in the two fields this file reads
        def __init__(self, x: float, y: float) -> None:
            self.x, self.y = x, y

    def hand(cx: float, cy: float, gap: float):
        marks = [L(cx, cy) for _ in range(21)]
        marks[THUMB_TIP] = L(cx - gap / 2, cy)
        marks[INDEX_TIP] = L(cx + gap / 2, cy)
        return marks

    failures = []

    def check(name: str, ok: bool, detail: object = "") -> None:
        print(f"  {'ok  ' if ok else 'FAIL'} {name} {detail}", flush=True)
        if not ok:
            failures.append(name)

    closed = pinch_span(hand(0.5, 0.5, 0.02), 0.75)
    wide = pinch_span(hand(0.5, 0.5, 0.26), 0.75)
    check("spreading the fingers raises the span", wide > closed, f"{closed:.3f} -> {wide:.3f}")
    zoom_out = calibrate(closed, settings.pinch_lo, settings.pinch_hi)
    zoom_in = calibrate(wide, settings.pinch_lo, settings.pinch_hi)
    check(
        "and the calibrated span spans the HUD's whole zoom window",
        zoom_out <= HUD_PINCH_MIN + 1e-9 and zoom_in >= HUD_PINCH_MAX - 1e-9,
        f"{zoom_out:.3f} -> {zoom_in:.3f} (HUD wants {HUD_PINCH_MIN} … {HUD_PINCH_MAX})",
    )
    check(
        "a span outside the calibration clamps rather than running away",
        calibrate(1.0, settings.pinch_lo, settings.pinch_hi) == HUD_PINCH_MAX
        and calibrate(0.0, settings.pinch_lo, settings.pinch_hi) == HUD_PINCH_MIN,
    )
    # The pinch must not move the assembly: only the palm decides where it points.
    left = palm_center(hand(0.2, 0.5, 0.02))
    left_wide = palm_center(hand(0.2, 0.5, 0.26))
    check("a pinch does not move the hand's reported position", left == left_wide, left)
    check(
        "and moving the hand does move it",
        palm_center(hand(0.8, 0.5, 0.1))[0] > left[0],
    )
    # Aspect correction: the same finger gap held vertically must measure the same.
    flat = pinch_span([L(0.5, 0.5)] * 21, 0.75)
    horizontal = pinch_span(hand(0.5, 0.5, 0.1), 0.75)
    vertical = list(hand(0.5, 0.5, 0.0))
    vertical[THUMB_TIP], vertical[INDEX_TIP] = L(0.5, 0.5 - 0.1 / 2 / 0.75), L(
        0.5, 0.5 + 0.1 / 2 / 0.75
    )
    check(
        "a vertical pinch measures the same as a horizontal one",
        abs(pinch_span(vertical, 0.75) - horizontal) < 1e-9,
        f"{pinch_span(vertical, 0.75):.4f} vs {horizontal:.4f}",
    )
    check("a closed hand measures zero", flat == 0.0)
    check("smoothing starts at the first value", smooth(None, 0.4, 0.5) == 0.4)
    check("and eases toward later ones", smooth(0.0, 1.0, 0.5) == 0.5)
    check("the model file is where the tracker expects it", settings.model.is_file(), settings.model)
    print(f"{'ok' if not failures else 'FAILED: ' + ', '.join(failures)}", flush=True)
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--camera", type=int, default=0)
    p.add_argument("--model", type=Path, default=Path(__file__).with_name("hand_landmarker.task"))
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--preview", action="store_true", help="show the camera with landmarks drawn")
    p.add_argument("--mirror", action="store_true", help="for a camera that already mirrors")
    p.add_argument("--pinch-lo", type=float, default=0.03, help="span that means fully zoomed out")
    p.add_argument("--pinch-hi", type=float, default=0.26, help="span that means fully zoomed in")
    p.add_argument("--alpha", type=float, default=0.45, help="smoothing, 1 = none")
    p.add_argument("--grace", type=float, default=0.25, help="seconds before a lost hand releases")
    p.add_argument("--selftest", action="store_true", help="check the mapping, no camera needed")
    a = p.parse_args(argv)
    settings = Settings(
        port=a.port,
        camera=a.camera,
        model=a.model,
        fps=a.fps,
        preview=a.preview,
        mirror=a.mirror,
        pinch_lo=a.pinch_lo,
        pinch_hi=a.pinch_hi,
        alpha=a.alpha,
        grace=a.grace,
    )
    if a.selftest:
        return selftest(settings)
    if not settings.model.is_file():
        print(
            f"no hand model at {settings.model}. Download it once with:\n"
            "  curl -sSL -o vision/hand_landmarker.task https://storage.googleapis.com/"
            "mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            file=sys.stderr,
        )
        return 2
    try:
        asyncio.run(serve(settings))
    except KeyboardInterrupt:
        print("[tracker] stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
