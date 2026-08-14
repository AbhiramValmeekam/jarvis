"""
Jarvis voice daemon.

One long-lived process that owns the microphone. It exists as a separate
process for two reasons, both measured (docs/VOICE_ANALYSIS.md):

  1. The engines that meet the spec -- openWakeWord, faster-whisper, Piper --
     are Python-native. Reimplementing them in Node would be a second
     implementation of working code.
  2. Whisper takes ~12 s to load and Piper's first synthesis costs ~2.5 s.
     Both must be warm before the user says anything, so this cannot be a
     per-utterance script.

It speaks line-delimited JSON on stdio: events out on stdout, commands in on
stdin, human-readable logs on stderr. Same shape as the ACP transport already
proven in Phase 1, and supervised by the same bounded restart policy.

Audio never leaves this machine. ffmpeg -> local ONNX -> local whisper. The
only thing that crosses the network is text, and only once the runtime decides
to route it to Hermes.

Run standalone for debugging:
    .venv/Scripts/python.exe voice/daemon.py --selftest
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

# 16 kHz mono s16le everywhere. Both openWakeWord and whisper want exactly
# this, so there is no resampling anywhere in the hot path.
SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280          # 80 ms -- openWakeWord's native frame
BYTES_PER_SAMPLE = 2
VAD_FRAME = 320               # 20 ms; 1280 is an integer multiple of it

# The speak id reserved for the wake acknowledgement. The runtime filters
# playback events carrying it out of the state machine, so it must match
# WAKE_ACK_ID in src/voice/voice-protocol.ts exactly.
WAKE_ACK_ID = "wake-ack"
# Backstop for the ack gate below. Synthesis starts a beat after the command
# is issued, so the gate cannot simply watch `playback.active` -- it would open
# again in the gap and record the ack after all. Hold it shut this long while
# waiting for the first sample.
ACK_START_GRACE_MS = 1200
# And never longer than this in total, however wedged synthesis gets: a deaf
# microphone is a worse failure than a clipped acknowledgement.
ACK_MAX_MS = 4000

# `--device file:path.wav` swaps the microphone for a paced WAV feed. Only the
# probe uses it; a real run never sees this prefix.
FILE_DEVICE = "file:"

DEFAULTS = {
    "wake_word": "hey_jarvis",
    "wake_threshold": 0.5,
    "vad_threshold": 0.5,
    "stt_model": "base.en",
    "silence_ms": 700,         # end-of-utterance after this much non-speech
    "max_utterance_ms": 15000,  # hard stop; a stuck VAD must not record forever
    "min_utterance_ms": 300,   # shorter than this is a cough, not a sentence
    "prefix_ms": 500,          # pre-roll kept so the first word is not clipped
    "wake_timeout_ms": 6000,   # woke but nobody spoke
}


# --------------------------------------------------------------------------
# stdio plumbing
# --------------------------------------------------------------------------

_out_lock = threading.Lock()


def emit(**event: Any) -> None:
    """Write one event as a single line of JSON on stdout."""
    line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(line: str) -> None:
    """Human-readable diagnostics. stderr, so it can never corrupt the event
    stream that the runtime is parsing."""
    sys.stderr.write(f"[voice] {line}\n")
    sys.stderr.flush()


def now_ms() -> float:
    return time.perf_counter() * 1000.0


# --------------------------------------------------------------------------
# capture
# --------------------------------------------------------------------------

class Capture:
    """Microphone capture via ffmpeg's dshow backend.

    ffmpeg is used rather than a native binding because it is already present,
    needs no compiler, and is the same tool used for playback. Its stdout is a
    raw s16le stream that feeds the models with no conversion.

    Muting kills the ffmpeg process outright rather than discarding samples.
    That distinction matters: when the user mutes Jarvis, no audio should be
    reaching this process at all, and the OS microphone indicator should go
    out. Politely ignoring bytes we are still receiving would be a lie.

    **`start()` returning True is not proof of a working microphone.** `Popen`
    succeeds for any device name at all; ffmpeg only discovers that nothing
    answers to it afterwards, and says so on stderr before exiting. So the
    honest report comes from `_pump` noticing the stream ended, not from
    `start`. Capture is not retried after that -- a replugged headset needs a
    Jarvis restart -- which is a real limitation, and preferable to a silent
    reconnect loop against a device that may never come back.
    """

    def __init__(self, device: Optional[str], on_chunk: Callable[[bytes], None]) -> None:
        self.device = device
        self.on_chunk = on_chunk
        self.proc: Optional[subprocess.Popen[bytes]] = None
        self.thread: Optional[threading.Thread] = None
        self.running = False
        self.error: Optional[str] = None
        # ffmpeg's *first* complaint of the current process, kept because it is
        # the only thing that knows *why* a device would not open. `Popen`
        # succeeds for a device name nothing answers to -- the failure is
        # reported by the child, on stderr, after we have already declared
        # success. The first line is the cause and the ones after it are
        # wrappers: dshow says "Could not find audio only device with name
        # [...]" and ffmpeg then reduces that to "Error opening input files:
        # I/O error", which names nothing a user could act on. Measured against
        # a made-up device name, in that order.
        self.stderr_reason: Optional[str] = None
        # Whether any audio ever arrived. It separates "this device does not
        # exist" from "this device went away", which are different mistakes.
        self.chunks = 0

    @staticmethod
    def list_devices() -> list[str]:
        """Audio input devices, as ffmpeg names them."""
        try:
            r = subprocess.run(
                ["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                capture_output=True, text=True, timeout=20,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            log(f"could not list devices: {exc}")
            return []
        names: list[str] = []
        for line in r.stderr.splitlines():
            if '" (audio)' in line:
                start = line.find('"')
                end = line.find('"', start + 1)
                if start != -1 and end != -1:
                    names.append(line[start + 1:end])
        return names

    def start(self) -> bool:
        if self.running:
            return True
        device = self.device or (Capture.list_devices() or [None])[0]
        if not device:
            self.error = "no audio input device found"
            return False
        self.device = device
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "dshow", "-i", f"audio={device}",
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-",
        ]
        try:
            self.proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            self.error = f"could not start ffmpeg: {exc}"
            return False

        self.running = True
        self.error = None
        # Per ffmpeg process, not per Capture: unmuting starts a new child, and
        # a complaint from the previous one is not evidence about this one.
        self.stderr_reason = None
        self.chunks = 0
        self.thread = threading.Thread(target=self._pump, daemon=True, name="capture")
        self.thread.start()
        threading.Thread(target=self._drain_stderr, daemon=True, name="capture-err").start()
        return True

    def _pump(self) -> None:
        need = CHUNK_SAMPLES * BYTES_PER_SAMPLE
        stdout = self.proc.stdout if self.proc else None
        if stdout is None:
            return
        buf = b""
        while self.running:
            data = stdout.read(need - len(buf))
            if not data:
                break
            buf += data
            if len(buf) >= need:
                self.chunks += 1
                self.on_chunk(buf[:need])
                buf = buf[need:]
        if self.running:
            # ffmpeg died on its own -- device unplugged, driver reset, or a
            # pinned device that nothing on this machine answers to.
            #
            # This used to be a non-fatal `error` and nothing else, which left
            # the runtime still holding `capturing: true` from the `ready`
            # event: every subsystem read `available` while not one sample was
            # arriving. That is the §4 lie in its purest form, so the event is
            # now the one the runtime turns into status. `subsystem="capture"`
            # (rather than `wakeWord`) because STT and the VAD are just as dead,
            # and the sidecar keys `capturing = false` off exactly that name.
            #
            # ffmpeg's own line is what makes it actionable -- "Could not find
            # audio only device with name [...]" names the mistake, where
            # "capture stopped" only names the symptom. stderr is a separate
            # pipe with no ordering against stdout, so give the drain thread a
            # moment to catch up before quoting it.
            self.running = False
            time.sleep(0.3)
            device = self.device or "the default input"
            detail = self.stderr_reason or "ffmpeg exited without saying why"
            never = "delivered no audio at all" if self.chunks == 0 else "stopped delivering audio"
            self.error = f"{device} {never}: {detail}"
            emit(type="unavailable", subsystem="capture", reason=self.error)

    def _drain_stderr(self) -> None:
        stderr = self.proc.stderr if self.proc else None
        if stderr is None:
            return
        for raw in stderr:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                # `[dshow @ 000001de...] ` in front of every line is a pointer
                # value, so it is noise in a message and churn in a log a human
                # might diff. The text after it is the whole content.
                clean = re.sub(r"^\[[^\]]*\]\s*", "", line)
                if self.stderr_reason is None:
                    self.stderr_reason = clean
                log(f"ffmpeg: {clean}")

    def stop(self) -> None:
        self.running = False
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass
        self.proc = None


class FileCapture:
    """A WAV file in place of the microphone, for measurement.

    Latency has to be measured against something repeatable. A human saying
    "Jarvis" into the mic is the real thing, but it cannot be replayed, and the
    number it produces cannot be compared across runs or machines.

    This streams a 16 kHz mono WAV through the same callback the microphone
    feeds, paced to the wall clock, so a millisecond of audio costs a
    millisecond. Everything downstream is the real pipeline -- real VAD, real
    wake-word model, real transcription. What is missing is the driver and its
    buffer, which is why scripts/probe-voice.ts reports this as a floor and
    measures the live microphone path separately.
    """

    def __init__(
        self,
        path: str,
        on_chunk: Callable[[bytes], None],
        repeat: int = 1,
        gap_ms: int = 2000,
        lead_ms: int = 700,
        mark_ms: float = 0.0,
    ) -> None:
        self.path = path
        self.on_chunk = on_chunk
        self.repeat = max(1, repeat)
        self.gap_ms = max(0, gap_ms)
        self.lead_ms = max(0, lead_ms)
        # Offset within each replay whose delivery is the latency zero point:
        # the moment the user stopped speaking and started waiting.
        self.mark_ms = max(0.0, mark_ms)
        self.device = f"file:{os.path.basename(path)}"
        self.running = False
        self.error: Optional[str] = None
        self.thread: Optional[threading.Thread] = None
        self.audio = b""

    @staticmethod
    def list_devices() -> list[str]:
        return []

    def start(self) -> bool:
        if self.running:
            return True
        try:
            with wave.open(self.path, "rb") as w:
                if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (
                    SAMPLE_RATE, 1, BYTES_PER_SAMPLE,
                ):
                    self.error = (
                        f"{self.path} must be {SAMPLE_RATE} Hz mono 16-bit, got "
                        f"{w.getframerate()} Hz / {w.getnchannels()} ch / "
                        f"{w.getsampwidth() * 8}-bit"
                    )
                    return False
                self.audio = w.readframes(w.getnframes())
        except (OSError, wave.Error) as exc:
            self.error = f"could not read {self.path}: {exc}"
            return False

        self.running = True
        self.error = None
        self.thread = threading.Thread(target=self._pump, daemon=True, name="feed")
        self.thread.start()
        return True

    def _pump(self) -> None:
        chunk = CHUNK_SAMPLES * BYTES_PER_SAMPLE
        silence = bytes(chunk)
        chunk_ms = CHUNK_SAMPLES / SAMPLE_RATE * 1000.0

        # (pcm, mark index or None). The mark rides with the audio rather than
        # being timed separately, so the zero point is the exact chunk the
        # models saw — no clock comparison across threads.
        stream: list[tuple[bytes, Optional[int]]] = [
            (silence, None) for _ in range(int(self.lead_ms / chunk_ms))
        ]
        mark_at = int(self.mark_ms / chunk_ms) if self.mark_ms else None
        for i in range(self.repeat):
            n = 0
            for off in range(0, len(self.audio) - chunk + 1, chunk):
                stream.append((self.audio[off:off + chunk], i if n == mark_at else None))
                n += 1
            gap = self.gap_ms if i < self.repeat - 1 else max(self.gap_ms, 3000)
            stream.extend((silence, None) for _ in range(int(gap / chunk_ms)))

        # Pace against a fixed origin rather than sleeping per chunk, so drift
        # does not accumulate over a run long enough to be worth measuring.
        t0 = time.perf_counter()
        for i, (pcm, mark) in enumerate(stream):
            if not self.running:
                return
            due = t0 + (i + 1) * chunk_ms / 1000.0
            delay = due - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            if mark is not None:
                emit(type="feed_mark", index=mark)
            self.on_chunk(pcm)

        self.running = False
        emit(type="log", line=f"feed finished ({self.repeat}x {os.path.basename(self.path)})")

    def stop(self) -> None:
        self.running = False


# --------------------------------------------------------------------------
# playback
# --------------------------------------------------------------------------

class Playback:
    """Speaker output via ffplay, fed raw PCM on stdin.

    Killing the process is the barge-in primitive: audio stops within one
    buffer, with no cooperation needed from the synthesiser. Anything that
    required the TTS engine to notice a flag would be slower and would fail
    exactly when synthesis is blocked.
    """

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.proc: Optional[subprocess.Popen[bytes]] = None
        self.lock = threading.Lock()

    def open(self) -> bool:
        cmd = [
            "ffplay", "-hide_banner", "-loglevel", "error",
            "-nodisp", "-autoexit",
            "-f", "s16le", "-ar", str(self.sample_rate), "-ch_layout", "mono",
            "-i", "-",
        ]
        try:
            with self.lock:
                self.proc = subprocess.Popen(
                    cmd, stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            return True
        except OSError as exc:
            log(f"could not start ffplay: {exc}")
            return False

    def write(self, pcm: bytes) -> bool:
        with self.lock:
            proc = self.proc
        if proc is None or proc.stdin is None:
            return False
        try:
            proc.stdin.write(pcm)
            return True
        except (BrokenPipeError, OSError, ValueError):
            # Normal when playback was stopped mid-write by a barge-in.
            return False

    def finish(self) -> None:
        """Close the pipe and let queued audio drain."""
        with self.lock:
            proc = self.proc
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.stop()
        with self.lock:
            if self.proc is proc:
                self.proc = None

    def stop(self) -> None:
        """Cut audio immediately, discarding whatever is queued."""
        with self.lock:
            proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
        try:
            proc.kill()
        except OSError:
            pass

    @property
    def active(self) -> bool:
        with self.lock:
            return self.proc is not None and self.proc.poll() is None


# --------------------------------------------------------------------------
# daemon
# --------------------------------------------------------------------------

@dataclass
class Config:
    device: Optional[str] = None
    wake_word: str = DEFAULTS["wake_word"]
    wake_threshold: float = DEFAULTS["wake_threshold"]
    vad_threshold: float = DEFAULTS["vad_threshold"]
    stt_model: str = DEFAULTS["stt_model"]
    stt_dir: str = ".research/whisper"
    piper_voice: str = "models/piper/en_GB-alan-medium.onnx"
    silence_ms: int = DEFAULTS["silence_ms"]
    max_utterance_ms: int = DEFAULTS["max_utterance_ms"]
    min_utterance_ms: int = DEFAULTS["min_utterance_ms"]
    prefix_ms: int = DEFAULTS["prefix_ms"]
    wake_timeout_ms: int = DEFAULTS["wake_timeout_ms"]
    # Off by default: the microphone hears the speakers, so VAD-triggered
    # barge-in makes Jarvis interrupt itself on its own first syllable.
    # Proper support needs acoustic echo cancellation. Saying "Jarvis" over
    # the top works today and is the supported path.
    barge_in_on_speech: bool = False
    # Spoken when the wake word arrives with no command behind it (§63:
    # "Jarvis." -> "Yes?"). Set empty to disable the acknowledgement.
    ack_text: str = "Yes?"
    # How much continuous silence after the wake word counts as "they are
    # waiting for me". Below silence_ms, so the ack pre-empts end-of-utterance.
    ack_after_ms: int = 480
    conversation_ms: int = 30000
    # Measurement only; see FileCapture.
    feed_repeat: int = 1
    feed_gap_ms: int = 2000
    feed_mark_ms: float = 0.0


class VoiceDaemon:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.audio_q: "queue.Queue[bytes]" = queue.Queue(maxsize=200)
        self.capture: Any
        if cfg.device and cfg.device.startswith(FILE_DEVICE):
            self.capture = FileCapture(
                cfg.device[len(FILE_DEVICE):], self._on_chunk,
                repeat=cfg.feed_repeat, gap_ms=cfg.feed_gap_ms,
                mark_ms=cfg.feed_mark_ms,
            )
            log("microphone replaced by a file feed; this is a measurement run")
        else:
            self.capture = Capture(cfg.device, self._on_chunk)
        # Audio consumed, in milliseconds. Wall-clock deltas across processes
        # cannot separate detection lag from scheduling noise; this can.
        self.stream_ms = 0.0
        self.playback: Optional[Playback] = None
        self.stopping = threading.Event()

        self.muted = False
        self.listening = True
        self.conversation_open = False
        self.ptt_down = False

        # recording state
        self.recording = False
        self.rec: list[bytes] = []
        self.rec_started = 0.0
        self.silence_run = 0.0
        self.saw_speech = False
        # How much of `rec` is pre-roll rather than the user talking. Normally
        # cfg.prefix_ms; zero after the acknowledgement, which discards it.
        self.rec_prefix_ms = float(cfg.prefix_ms)

        # Wake acknowledgement. `acked` is per-recording so "Yes?" is said at
        # most once per wake; `ack_gating` holds the microphone shut while it
        # plays, because with no echo cancellation the mic hears it and would
        # otherwise transcribe Jarvis' own voice as the user's command.
        self.acked = False
        self.ack_gating = False
        self.ack_heard = False
        self.ack_until = 0.0
        self.ack_ms = 0.0

        self.prefix: list[bytes] = []
        self.prefix_max = max(1, int(cfg.prefix_ms / 80))

        self.owww = None
        self.vad = None
        self.stt = None
        self.tts = None
        self.tts_cfg = None
        self.tts_rate = 22050

        self.speak_thread: Optional[threading.Thread] = None
        self.speak_seq = 0
        # What is playing, so a barge-in can say what it interrupted. The
        # runtime needs it to tell an interrupted reply from an interrupted
        # acknowledgement: one cancels a turn, the other never had one.
        self.speak_id: Optional[str] = None
        self.level_counter = 0

    # --- model loading ----------------------------------------------------

    def load_models(self) -> None:
        t0 = now_ms()
        from openwakeword.model import Model as OwwModel
        from openwakeword.vad import VAD

        self.owww = OwwModel(
            wakeword_models=[self.cfg.wake_word], inference_framework="onnx"
        )
        self.vad = VAD()
        emit(type="log", line=f"wake word + vad ready in {now_ms() - t0:.0f} ms")

        t0 = now_ms()
        try:
            from faster_whisper import WhisperModel

            self.stt = WhisperModel(
                self.cfg.stt_model, device="cpu", compute_type="int8",
                download_root=self.cfg.stt_dir,
            )
            # Warm the graph so the first real utterance is not the slow one.
            import numpy as np

            list(self.stt.transcribe(np.zeros(SAMPLE_RATE, dtype="float32"), beam_size=1)[0])
            emit(type="log", line=f"stt '{self.cfg.stt_model}' ready in {now_ms() - t0:.0f} ms")
        except Exception as exc:  # noqa: BLE001 -- report, do not die
            self.stt = None
            emit(type="unavailable", subsystem="stt", reason=str(exc))

        t0 = now_ms()
        try:
            from piper import PiperVoice, SynthesisConfig

            if not os.path.exists(self.cfg.piper_voice):
                raise FileNotFoundError(
                    f"piper voice not found at {self.cfg.piper_voice} "
                    f"(run: python -m piper.download_voices en_GB-alan-medium --data-dir models/piper)"
                )
            self.tts = PiperVoice.load(self.cfg.piper_voice)
            self.tts_cfg = SynthesisConfig()
            self.tts_rate = self.tts.config.sample_rate
            # Measured: without this the first utterance costs 2.5 s instead
            # of 35 ms. See docs/VOICE_ANALYSIS.md section 4.
            for _ in self.tts.synthesize("ready", self.tts_cfg):
                pass
            emit(type="log", line=f"tts ready in {now_ms() - t0:.0f} ms (warmed)")
        except Exception as exc:  # noqa: BLE001
            self.tts = None
            emit(type="unavailable", subsystem="tts", reason=str(exc))

    # --- capture callback -------------------------------------------------

    def _on_chunk(self, pcm: bytes) -> None:
        try:
            self.audio_q.put_nowait(pcm)
        except queue.Full:
            # Dropping the oldest is better than growing without bound; a
            # backlog means detection is already too late to be useful.
            try:
                self.audio_q.get_nowait()
                self.audio_q.put_nowait(pcm)
            except queue.Empty:
                pass

    # --- main loop --------------------------------------------------------

    def run(self) -> None:
        self.load_models()

        started = self.capture.start()
        if not started:
            emit(type="unavailable", subsystem="wakeWord",
                 reason=self.capture.error or "microphone unavailable")

        emit(
            type="ready",
            wakeWord=self.cfg.wake_word if started else None,
            device=self.capture.device,
            sttModel=self.cfg.stt_model if self.stt else None,
            ttsVoice=os.path.basename(self.cfg.piper_voice) if self.tts else None,
            sampleRate=SAMPLE_RATE,
            capture=bool(started),
        )

        threading.Thread(target=self._read_commands, daemon=True, name="stdin").start()

        import numpy as np

        while not self.stopping.is_set():
            try:
                pcm = self.audio_q.get(timeout=0.25)
            except queue.Empty:
                continue
            if self.muted or not self.listening:
                continue
            self._process(np.frombuffer(pcm, dtype=np.int16), pcm)

        self.shutdown()

    def _process(self, samples, raw: bytes) -> None:
        import numpy as np

        # --- level, for the orb. Downsampled to ~6 Hz; the UI cannot use more
        # and every event costs an IPC round trip.
        self.level_counter += 1
        if self.level_counter % 2 == 0:
            rms = float(np.sqrt(np.mean((samples.astype(np.float32) / 32768.0) ** 2)))
            emit(type="level", rms=round(rms, 4))

        speech = float(self.vad.predict(samples, frame_size=VAD_FRAME))
        is_speech = speech > self.cfg.vad_threshold

        if self.recording:
            self._record(raw, is_speech)
            return

        # Pre-roll: keep the last half second so the first syllable after the
        # wake word is not lost while we decide to start recording.
        self.prefix.append(raw)
        if len(self.prefix) > self.prefix_max:
            self.prefix.pop(0)

        score = float(self.owww.predict(samples).get(self.cfg.wake_word, 0.0))
        if score > self.cfg.wake_threshold:
            self._on_wake(score)
            return

        speaking = self.playback is not None and self.playback.active

        # Opt-in only, and off by default. See Config.barge_in_on_speech: with
        # no echo cancellation the microphone hears the speakers, so this makes
        # Jarvis interrupt itself on its own first syllable.
        if speaking and is_speech and self.cfg.barge_in_on_speech:
            self.stop_speaking(reason="barge_in")
            emit(type="barge_in", trigger="speech")
            self._begin_recording(reason="barge_in")
            return

        # In conversation mode a follow-up needs no wake word -- speech alone
        # opens the utterance. Not while Jarvis is talking, or the tail of its
        # own reply would be transcribed as the user's next question.
        if (self.conversation_open or self.ptt_down) and is_speech and not speaking:
            self._begin_recording(reason="speech")

    def _on_wake(self, score: float) -> None:
        # Fire the event before anything else: this is the number the latency
        # budget is measured against, so no work belongs in front of it.
        emit(type="wake", score=round(score, 4))
        self.owww.reset()

        # Saying the wake word over a reply is the supported barge-in.
        if self.playback is not None and self.playback.active:
            self.stop_speaking(reason="barge_in")
            emit(type="barge_in", trigger="wake_word")

        self._begin_recording(reason="wake")

    def _begin_recording(self, reason: str) -> None:
        if self.recording:
            return
        self.recording = True
        self.rec = list(self.prefix)
        self.prefix.clear()
        self.rec_started = now_ms()
        self.silence_run = 0.0
        self.saw_speech = False
        # Only a bare wake word earns an acknowledgement. A push-to-talk press
        # or a conversation follow-up is the user already talking, and one is
        # enough per recording however long they pause.
        self.acked = reason != "wake"
        self.ack_gating = False
        self.ack_heard = False
        self.ack_until = 0.0
        self.ack_ms = 0.0
        # Pre-roll is real audio and counts toward the utterance. The ack path
        # below discards it and clears this, because after "Yes?" the recording
        # starts from silence and there is no wake word in front of it.
        self.rec_prefix_ms = float(self.cfg.prefix_ms)
        emit(type="speech_start", reason=reason)

    def _record(self, raw: bytes, is_speech: bool) -> None:
        chunk_ms = CHUNK_SAMPLES / SAMPLE_RATE * 1000.0

        # Wake acknowledgement gate. The microphone hears "Yes?" through the
        # speakers -- there is no echo cancellation -- so while the ack is
        # audible this audio is neither kept nor scored. Dropping it is what
        # lets the ack fill a silence without Jarvis then transcribing itself
        # as the user's command. `ack_ms` accumulates the gated time and comes
        # off `elapsed` below, so the ack does not spend the wake timeout.
        if self.ack_gating:
            self.ack_ms += chunk_ms
            playing = self.playback is not None and self.playback.active
            if playing:
                self.ack_heard = True
            # The grace only covers the wait for the *first* sample. Once audio
            # has started, `playback.active` is the truth and holding the gate
            # for the rest of the grace would eat the user's next words.
            if playing or (not self.ack_heard and now_ms() < self.ack_until):
                # Runaway guard: synthesis that never ends must not leave the
                # microphone deaf for good.
                if self.ack_ms < ACK_MAX_MS:
                    return
                self.stop_speaking(reason="ack_overrun")
            self.ack_gating = False
            self.ack_until = 0.0
            self.silence_run = 0.0
            return

        self.rec.append(raw)
        if is_speech:
            self.saw_speech = True
            self.silence_run = 0.0
        else:
            self.silence_run += chunk_ms
        elapsed = now_ms() - self.rec_started - self.ack_ms

        if self.ptt_down:
            return  # push-to-talk ends on key release, not on silence

        # Woke, but nobody actually said anything. Abandon rather than send a
        # few hundred milliseconds of room tone to the transcriber.
        if not self.saw_speech and elapsed >= self.cfg.wake_timeout_ms:
            self.recording = False
            self.rec = []
            emit(type="wake_timeout", ms=round(elapsed))
            return

        # A wake word with nothing behind it yet gets the acknowledgement
        # (§63: "Jarvis." -> "Yes?"). Timed on silence since the wake and
        # skipped the instant any speech is heard, so "Jarvis, open Chrome"
        # said in one breath is never talked over.
        if (
            not self.acked
            and self.cfg.ack_text
            and self.tts is not None
            and not self.saw_speech
            and elapsed >= self.cfg.ack_after_ms
        ):
            self.acked = True
            self.speak(self.cfg.ack_text, WAKE_ACK_ID)
            self.ack_gating = True
            self.ack_until = now_ms() + ACK_START_GRACE_MS
            # What is recorded so far is the pre-roll and the wake word itself.
            # Keeping it would prepend "Jarvis" to whatever is said next -- and
            # with it gone there is no pre-roll left to discount, so a short
            # command after the ack is not mistaken for a cough.
            self.rec = []
            self.rec_prefix_ms = 0.0
            return

        # Silence only ends an utterance that had speech in it; otherwise the
        # gap between the wake word and the command would end it immediately.
        if self.saw_speech and self.silence_run >= self.cfg.silence_ms:
            self._end_recording()
        elif elapsed >= self.cfg.max_utterance_ms:
            self._end_recording(truncated=True)


    def _end_recording(self, truncated: bool = False) -> None:
        if not self.recording:
            return
        self.recording = False
        audio = b"".join(self.rec)
        self.rec = []
        duration_ms = len(audio) / BYTES_PER_SAMPLE / SAMPLE_RATE * 1000.0
        emit(type="speech_end", ms=round(duration_ms), truncated=truncated)

        speech_ms = duration_ms - self.rec_prefix_ms
        if speech_ms < self.cfg.min_utterance_ms:
            emit(type="final", text="", reason="too_short", ms=0)
            return
        if self.stt is None:
            emit(type="unavailable", subsystem="stt", reason="speech-to-text is not loaded")
            return

        # Transcribe off the audio thread so capture never stalls.
        threading.Thread(
            target=self._transcribe, args=(audio,), daemon=True, name="stt"
        ).start()

    def _transcribe(self, audio: bytes) -> None:
        import numpy as np

        t0 = now_ms()
        try:
            pcm = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
            segments, _ = self.stt.transcribe(pcm, beam_size=1, language="en")
            text = "".join(s.text for s in segments).strip()
        except Exception as exc:  # noqa: BLE001
            emit(type="error", message=f"transcription failed: {exc}", fatal=False)
            return
        emit(type="final", text=text, ms=round(now_ms() - t0))

    # --- speaking ---------------------------------------------------------

    def speak(self, text: str, req_id: Optional[str]) -> None:
        if self.tts is None:
            emit(type="unavailable", subsystem="tts", reason="text-to-speech is not loaded",
                 id=req_id)
            return
        if not text.strip():
            emit(type="speaking_done", id=req_id, ms=0)
            return

        self.stop_speaking(reason="superseded")
        self.speak_seq += 1
        self.speak_id = req_id
        seq = self.speak_seq
        self.speak_thread = threading.Thread(
            target=self._speak_worker, args=(text, req_id, seq),
            daemon=True, name="tts",
        )
        self.speak_thread.start()

    def _speak_worker(self, text: str, req_id: Optional[str], seq: int) -> None:
        t0 = now_ms()
        player = Playback(self.tts_rate)
        if not player.open():
            emit(type="unavailable", subsystem="tts", reason="no audio output (ffplay)", id=req_id)
            return
        self.playback = player

        first = True
        try:
            for chunk in self.tts.synthesize(text, self.tts_cfg):
                if seq != self.speak_seq or self.stopping.is_set():
                    break
                if not player.write(chunk.audio_int16_bytes):
                    break
                if first:
                    first = False
                    emit(type="speaking_start", ms=round(now_ms() - t0), id=req_id)
        except Exception as exc:  # noqa: BLE001
            emit(type="error", message=f"synthesis failed: {exc}", fatal=False)
            player.stop()
            return

        if seq != self.speak_seq:
            return  # superseded or barged in; that path emits its own event
        player.finish()
        if self.playback is player:
            self.playback = None
        if self.speak_id == req_id:
            self.speak_id = None
        emit(type="speaking_done", id=req_id, ms=round(now_ms() - t0))

    def stop_speaking(self, reason: str = "stopped") -> None:
        # Bumping the sequence first makes the worker's next write a no-op, so
        # it cannot resurrect playback between the kill and its own exit.
        self.speak_seq += 1
        player, self.playback = self.playback, None
        stopped_id, self.speak_id = self.speak_id, None
        if player is not None:
            player.stop()
            emit(type="speaking_stopped", reason=reason, id=stopped_id)

    # --- commands ---------------------------------------------------------

    def _read_commands(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError as exc:
                emit(type="error", message=f"bad command json: {exc}", fatal=False)
                continue
            try:
                self._dispatch(cmd)
            except Exception as exc:  # noqa: BLE001
                emit(type="error", message=f"command failed: {exc}", fatal=False)
        # stdin closed: the runtime is gone, so there is nobody left to serve.
        self.stopping.set()

    def _dispatch(self, cmd: dict[str, Any]) -> None:
        kind = cmd.get("type")

        if kind == "speak":
            self.speak(str(cmd.get("text", "")), cmd.get("id"))

        elif kind == "stop_speaking":
            self.stop_speaking(reason=str(cmd.get("reason", "stopped")))

        elif kind == "set_muted":
            self.muted = bool(cmd.get("muted"))
            if self.muted:
                # Stop capture at the source. Muted must mean the microphone is
                # not being read, not that we are discarding what we read.
                self.stop_speaking(reason="muted")
                self.capture.stop()
                self._reset_listen_state()
            elif not self.capture.running:
                self.capture.start()
            emit(type="muted", muted=self.muted, capturing=self.capture.running)

        elif kind == "set_listening":
            self.listening = bool(cmd.get("enabled"))
            if not self.listening:
                self._reset_listen_state()
            emit(type="listening", listening=self.listening)

        elif kind == "set_conversation":
            self.conversation_open = bool(cmd.get("open"))
            emit(type="conversation", open=self.conversation_open)

        elif kind == "ptt":
            down = bool(cmd.get("down"))
            if down and not self.ptt_down:
                self.ptt_down = True
                self.stop_speaking(reason="push_to_talk")
                self._begin_recording(reason="push_to_talk")
            elif not down and self.ptt_down:
                self.ptt_down = False
                self._end_recording()

        elif kind == "ping":
            emit(type="pong", id=cmd.get("id"))

        elif kind == "shutdown":
            self.stopping.set()

        else:
            emit(type="error", message=f"unknown command: {kind!r}", fatal=False)

    def _reset_listen_state(self) -> None:
        self.recording = False
        self.rec = []
        self.prefix.clear()
        self.saw_speech = False
        self.acked = False
        self.ack_gating = False
        self.ack_heard = False
        self.ack_until = 0.0
        self.ack_ms = 0.0
        if self.owww is not None:
            self.owww.reset()

    def shutdown(self) -> None:
        self.stop_speaking(reason="shutdown")
        self.capture.stop()
        emit(type="stopped")


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def selftest(cfg: Config) -> int:
    """Prove the pieces work without needing a microphone or a human.

    Uses Windows SAPI to synthesise "hey jarvis", feeds it through the real
    wake-word model, and transcribes it with the real STT model.
    """
    import numpy as np

    ok = True
    d = VoiceDaemon(cfg)
    d.load_models()

    path = os.path.join(".research", "audio", "jarvis_cmd.wav")
    if not os.path.exists(path):
        print(f"missing fixture {path}; run scripts/make-voice-fixtures.ps1")
        return 1

    with wave.open(path, "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    audio = np.concatenate([np.zeros(SAMPLE_RATE, dtype=np.int16), audio])

    peak = 0.0
    for i in range(0, len(audio) - CHUNK_SAMPLES, CHUNK_SAMPLES):
        peak = max(peak, float(d.owww.predict(audio[i:i + CHUNK_SAMPLES]).get(cfg.wake_word, 0.0)))
    print(f"wake peak       {peak:.3f}   {'PASS' if peak > cfg.wake_threshold else 'FAIL'}")
    ok &= peak > cfg.wake_threshold

    if d.stt is not None:
        pcm = audio.astype(np.float32) / 32768.0
        segs, _ = d.stt.transcribe(pcm, beam_size=1, language="en")
        text = "".join(s.text for s in segs).strip()
        print(f"transcript      {text!r}   {'PASS' if 'jarvis' in text.lower() else 'FAIL'}")
        ok &= "jarvis" in text.lower()
    else:
        print("transcript      SKIPPED (stt unavailable)")
        ok = False

    print(f"tts             {'PASS' if d.tts is not None else 'FAIL'}")
    ok &= d.tts is not None

    devices = Capture.list_devices()
    print(f"input devices   {devices}   {'PASS' if devices else 'FAIL'}")
    ok &= bool(devices)

    return 0 if ok else 1


def probe_audio(cfg: Config, path: str) -> int:
    """Measure the models against one WAV, in audio time, and print JSON.

    Two numbers matter and neither can be got from wall clock alone:

      speechEndMs -- where the wake word actually stops, per the real VAD. It is
        the only defensible zero point for latency: the user has finished
        speaking and is now waiting.
      wakeMs -- where the wake-word model crosses threshold. It lands *after*
        speechEndMs because openWakeWord needs the tail of the word before it
        will commit, and that wait is part of what the user feels.

    Both are positions in the file, so they are identical on every machine and
    every run. scripts/probe-voice.ts turns them into the latency budget.
    """
    import numpy as np

    d = VoiceDaemon(cfg)
    d.load_models()

    with wave.open(path, "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (
            SAMPLE_RATE, 1, BYTES_PER_SAMPLE,
        ):
            print(json.dumps({"error": f"{path} is not 16 kHz mono 16-bit"}))
            return 1
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)

    chunk_ms = CHUNK_SAMPLES / SAMPLE_RATE * 1000.0
    wake_ms: Optional[float] = None
    peak = 0.0
    speech_end_ms = 0.0
    costs: list[float] = []

    for i in range(0, len(audio) - CHUNK_SAMPLES + 1, CHUNK_SAMPLES):
        frame = audio[i:i + CHUNK_SAMPLES]
        end_ms = (i + CHUNK_SAMPLES) / SAMPLE_RATE * 1000.0

        if float(d.vad.predict(frame, frame_size=VAD_FRAME)) > cfg.vad_threshold:
            speech_end_ms = end_ms

        t0 = now_ms()
        score = float(d.owww.predict(frame).get(cfg.wake_word, 0.0))
        costs.append(now_ms() - t0)
        peak = max(peak, score)
        if wake_ms is None and score > cfg.wake_threshold:
            wake_ms = end_ms

    stt_ms = None
    text = None
    if d.stt is not None:
        t0 = now_ms()
        segs, _ = d.stt.transcribe(audio.astype(np.float32) / 32768.0, beam_size=1, language="en")
        text = "".join(s.text for s in segs).strip()
        stt_ms = round(now_ms() - t0, 1)

    tts_first_ms = None
    tts_total_ms = None
    if d.tts is not None:
        t0 = now_ms()
        for chunk in d.tts.synthesize("Yes?", d.tts_cfg):
            if tts_first_ms is None:
                tts_first_ms = round(now_ms() - t0, 1)
        tts_total_ms = round(now_ms() - t0, 1)

    costs.sort()
    print(json.dumps({
        "file": os.path.basename(path),
        "durationMs": round(len(audio) / SAMPLE_RATE * 1000.0, 1),
        "frameMs": chunk_ms,
        "speechEndMs": round(speech_end_ms, 1),
        "wakeMs": round(wake_ms, 1) if wake_ms is not None else None,
        "wakePeak": round(peak, 4),
        "detectionLagMs": round(wake_ms - speech_end_ms, 1) if wake_ms is not None else None,
        "inferenceMs": {
            "median": round(costs[len(costs) // 2], 2) if costs else None,
            "p95": round(costs[int(len(costs) * 0.95)], 2) if costs else None,
            "max": round(costs[-1], 2) if costs else None,
        },
        "sttMs": stt_ms,
        "transcript": text,
        "ttsFirstAudioMs": tts_first_ms,
        "ttsTotalMs": tts_total_ms,
    }))
    return 0 if wake_ms is not None else 1


def main() -> int:
    p = argparse.ArgumentParser(description="Jarvis voice daemon")
    p.add_argument("--device")
    p.add_argument("--wake-word", default=DEFAULTS["wake_word"])
    p.add_argument("--wake-threshold", type=float, default=DEFAULTS["wake_threshold"])
    p.add_argument("--vad-threshold", type=float, default=DEFAULTS["vad_threshold"])
    p.add_argument("--stt-model", default=DEFAULTS["stt_model"])
    p.add_argument("--stt-dir", default=".research/whisper")
    p.add_argument("--piper-voice", default="models/piper/en_GB-alan-medium.onnx")
    p.add_argument("--silence-ms", type=int, default=DEFAULTS["silence_ms"])
    p.add_argument("--barge-in-on-speech", action="store_true")
    p.add_argument("--ack-text", default=Config.ack_text,
                   help="spoken on a bare wake word; empty disables it")
    p.add_argument("--ack-after-ms", type=int, default=Config.ack_after_ms)
    p.add_argument("--list-devices", action="store_true")
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--probe-audio", metavar="WAV",
                   help="measure the models against one WAV and print JSON")
    p.add_argument("--feed-repeat", type=int, default=1,
                   help="with --device file:..., how many times to replay it")
    p.add_argument("--feed-gap-ms", type=int, default=2000)
    p.add_argument("--feed-mark-ms", type=float, default=0.0,
                   help="offset in the fed WAV to emit feed_mark at (latency zero point)")
    p.add_argument("--wake-timeout-ms", type=int, default=DEFAULTS["wake_timeout_ms"])
    a = p.parse_args()

    cfg = Config(
        device=a.device,
        wake_word=a.wake_word,
        wake_threshold=a.wake_threshold,
        vad_threshold=a.vad_threshold,
        stt_model=a.stt_model,
        stt_dir=a.stt_dir,
        piper_voice=a.piper_voice,
        silence_ms=a.silence_ms,
        barge_in_on_speech=a.barge_in_on_speech,
        ack_text=a.ack_text,
        ack_after_ms=a.ack_after_ms,
        feed_repeat=a.feed_repeat,
        feed_gap_ms=a.feed_gap_ms,
        feed_mark_ms=a.feed_mark_ms,
        wake_timeout_ms=a.wake_timeout_ms,
    )

    if a.list_devices:
        print(json.dumps(Capture.list_devices(), indent=2))
        return 0
    if a.selftest:
        return selftest(cfg)
    if a.probe_audio:
        return probe_audio(cfg, a.probe_audio)

    daemon = VoiceDaemon(cfg)
    try:
        daemon.run()
    except KeyboardInterrupt:
        daemon.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
