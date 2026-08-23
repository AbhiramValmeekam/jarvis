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
from collections import deque
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

# How long a provisional recording -- one opened by a wake score in the soft band
# -- may run without the VAD hearing anything before it is transcribed and either
# confirmed or dropped. Short, because until it resolves the pre-roll buffer is
# not being kept and a genuine wake word would arrive with no run-up.
MAYBE_WAKE_LEASH_MS = 1000

# `--device file:path.wav` swaps the microphone for a paced WAV feed. Only the
# probe uses it; a real run never sees this prefix.
FILE_DEVICE = "file:"

DEFAULTS = {
    "wake_word": "hey_jarvis",
    "wake_threshold": 0.5,
    # Below the threshold but too high to be nothing. See `Gain` on why this
    # band exists and `match_wake_name` on what decides it.
    "wake_soft_threshold": 0.25,
    "vad_threshold": 0.5,
    "stt_model": "base.en",
    "stt_beam": 5,
    "silence_ms": 700,         # end-of-utterance after this much non-speech
    "max_utterance_ms": 15000,  # hard stop; a stuck VAD must not record forever
    "min_utterance_ms": 300,   # shorter than this is a cough, not a sentence
    "prefix_ms": 500,          # pre-roll kept so the first word is not clipped
    "wake_timeout_ms": 6000,   # woke but nobody spoke
}

# --------------------------------------------------------------------------
# gain
#
# Measured on this machine on 2026-08-15, and the reason this section exists:
# `Microphone Array (AMD Audio Device)` -- the only input the box has -- delivers
# a normal speaking voice at a peak frame RMS of ~0.007 (the runtime's own
# silence watch reported 0.0068 as the loudest frame in a 60 s window, against
# the 0.002 floor it uses to decide the line is dead). The SAPI fixtures sit at
# 0.14-0.22, i.e. 20-30x hotter.
#
# openWakeWord does not care: it scores 0.998 on a clip attenuated to any of
# these levels. silero VAD cares enormously, and it is the VAD that decides
# whether anything was said after the wake word. But it is not a simple
# threshold -- it is an RNN, and at this level its verdict depends on what it
# heard in the previous few seconds. Same 35-frame clip, same level, speech
# frames counted (.research/vadcheck.py):
#
#   peak RMS   after idle floor   after hearing the ack through the speakers
#   0.007            33                          9
#   0.004            34                          5
#   0.003            34                          1
#   0.0015           35                          0
#
# The right-hand column is the live sequence, and it is what the log shows.
# `_record` plays the wake acknowledgement `ack_after_ms` (480 ms) after the
# wake if the VAD has heard nothing yet; the microphone then hears "Yes?" out of
# the speakers, because there is no echo cancellation. From that point the VAD
# stops calling this microphone's speech speech, `saw_speech` never goes true,
# and `_record` waits out `wake_timeout_ms` and discards the utterance. In
# runtime.log, twice: wake at 13:34:09.077 -> idle at 13:34:18.073, 8.996 s for
# a 6 s timeout, the extra ~3 s being `ack_ms` -- which is itself proof the ack
# fired, i.e. that the VAD was already silent at 480 ms. No `understanding`
# state either time. That is the reported bug: "Hey Jarvis" lights the orb and
# then nothing happens.
#
# So the fix is to stop asking the VAD to work at 0.007 -- and, critically, not
# to calibrate on Jarvis' own voice. Gain that includes the ack in its estimate
# is worthless (12/5/4/0 frames for the four levels above: the loud playback
# drags the percentile up and the gain back down to ~1.0). Gain that skips it
# restores 20/17/22/19 frames and delivers the command at 0.038-0.084 peak RMS,
# on target. `_process` is where that exclusion happens.
# --------------------------------------------------------------------------

# Where a speaking voice should land. High enough that the VAD's verdict stops
# depending on what it heard a moment ago (measured above), and far enough from
# full scale that a shout does not clip.
MIC_TARGET_RMS = 0.08
# A quiet device needs ~11x. The cap is set well above that and still short of
# the point where a room's own hiss would start reading as speech.
MIC_GAIN_MAX = 24.0
# A frame quieter than this is room tone, and room tone says nothing about how
# loud a voice is. Calibrating on it is what would turn a dead microphone into a
# loud one -- see `Gain.frame`, which is also what keeps the sidecar's
# dead-input detection (SILENCE_FLOOR_RMS) meaningful.
MIC_CALIBRATE_FLOOR = 0.0015
# How many above-floor frames the estimate is taken over: 125 x 80 ms = 10 s of
# actual voice.
GAIN_WINDOW_FRAMES = 125
# And which frame in that window counts as "how loud this person is". Measured
# reason for a percentile rather than the maximum: with the maximum, one door
# slam at 0.9 pins the estimate for as long as it takes to decay -- more than
# three minutes at any half-life long enough to span a sentence. At the 90th
# percentile the same slam is one frame in 125 and is ignored within a second of
# speech, while a genuinely loud voice (which is most frames, not one) still
# moves it.
GAIN_PERCENTILE = 0.9
# Don't move the gain for less than this proportional change. Without it the
# value would jitter on every syllable and the log line would be unreadable.
GAIN_HYSTERESIS = 0.15
# Amplified audio is limited to this much of full scale, per frame. Clipping is
# the one way make-up gain can make transcription *worse* than leaving the audio
# alone, so the gain is never allowed to cause it.
GAIN_CLIP_CEILING = 0.98


# --------------------------------------------------------------------------
# stdio plumbing
# --------------------------------------------------------------------------

_out_lock = threading.Lock()

# UTF-8 on both streams, set here rather than inherited.
#
# `emit` writes JSON with `ensure_ascii=False`, so a transcript containing a
# non-ASCII word -- which whisper will produce the moment the user says anything
# that is not English -- reaches stdout as real UTF-8. On Windows a process whose
# stdout it not a UTF-8 stream raises `UnicodeEncodeError` on that write, and
# since it happens inside the audio path it would kill voice mid-utterance.
#
# The sidecar does pass `PYTHONIOENCODING=utf-8`, so this is not the difference
# between working and not in production. It is the difference between the
# encoding being a property of this process and a property of whoever launched
# it: `--selftest`, `--probe-audio` and a hand-run debug session all inherit the
# console codepage (cp1252 here) instead, and used to fail on exactly the
# fixtures that check non-English input survives.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError, OSError):
        # Not a real text stream (captured, redirected to a pipe wrapper, or
        # already detached). Nothing to do, and nothing worth failing over.
        pass


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
# gain and name matching
# --------------------------------------------------------------------------

class Gain:
    """Make-up gain for an input that is simply too quiet.

    This is not automatic gain control in the broadcast sense -- there is no
    compression and no per-syllable riding. It answers one question: how many
    times too quiet is this microphone, so the VAD sees what it was trained on?

    Four properties make it safe to leave on:

      1. **It only calibrates on frames that could be a voice.** Anything below
         `MIC_CALIBRATE_FLOOR` is ignored entirely, so a silent room cannot walk
         the gain up to the cap, and a dead input stays at 1.0 -- which is what
         keeps `SILENCE_FLOOR_RMS` in the sidecar an honest test of the
         microphone rather than a test of our own amplification.
      2. **It only calibrates on frames that could be *the user's* voice.**
         `_process` withholds anything the microphone picks up while Jarvis is
         speaking. That audio is the loudest thing this input ever hears, and
         letting it in makes the gain useless in exactly the case that needs it
         -- measured, in the table above `MIC_TARGET_RMS`.
      3. **The estimate is a percentile, not a peak.** One bang cannot deafen it
         (see `GAIN_PERCENTILE`), and a voice that is genuinely loud brings it
         down within a second.
      4. **It never clips.** Whatever the estimate says, no frame is amplified
         past `GAIN_CLIP_CEILING` of full scale.

    The wake word is a free calibration signal: by the time someone has finished
    saying "Jarvis" the gain is already set for the command behind it.
    """

    def __init__(self, fixed: Optional[float] = None,
                 target: float = MIC_TARGET_RMS, maximum: float = MIC_GAIN_MAX) -> None:
        # A configured number is an instruction, not a starting point: it is
        # never adjusted, so a user who measured their own device gets exactly
        # what they asked for.
        self.fixed = fixed
        self.target = target
        self.maximum = maximum
        self.value = fixed if fixed is not None else 1.0
        self.recent: deque[float] = deque(maxlen=GAIN_WINDOW_FRAMES)
        self.level = 0.0

    @property
    def auto(self) -> bool:
        return self.fixed is None

    def frame(self, rms: float) -> Optional[float]:
        """Feed one frame's pre-gain RMS. Returns the new gain if it changed."""
        if self.fixed is not None:
            return None
        if rms < MIC_CALIBRATE_FLOOR:
            return None
        self.recent.append(rms)
        ordered = sorted(self.recent)
        # While the window is still filling this lands on or near the loudest
        # frame seen, which is the conservative end -- the gain starts low and
        # only relaxes upward as evidence accumulates. No special case needed.
        self.level = ordered[min(len(ordered) - 1, int(len(ordered) * GAIN_PERCENTILE))]
        want = min(self.maximum, max(1.0, self.target / self.level))
        if abs(want - self.value) <= GAIN_HYSTERESIS * self.value:
            return None
        self.value = want
        return want

    def apply(self, samples):
        """Scale int16 samples, backing off rather than clipping."""
        import numpy as np

        if self.value <= 1.0 or samples.size == 0:
            return samples
        # int32 first: abs(-32768) does not fit in an int16 and would come back
        # negative, which would read as headroom that is not there.
        peak = int(np.max(np.abs(samples.astype(np.int32))))
        scale = self.value
        if peak > 0:
            scale = min(scale, GAIN_CLIP_CEILING * 32767.0 / peak)
        if scale <= 1.0:
            return samples
        return (samples.astype(np.float32) * scale).astype(np.int16)


def normalise_for_stt(audio: bytes, target_peak: float = 0.9, max_gain: float = 32.0):
    """Bring one utterance up to full scale before transcribing it.

    Separate from `Gain` on purpose. The capture gain exists to make the VAD's
    decision correct in real time, and it is deliberately slow to move; this
    looks at a finished utterance, knows its true peak, and can be exact. On the
    degraded fixtures it is worth a garbled name -- 'age-arvis, what time is it'
    became 'Hey Jarvis. What time is it?' at 12 dB SNR -- and costs nothing
    measurable.

    Left alone when there is effectively no signal: multiplying digital silence
    by 32 produces amplified dither, and whisper will confidently transcribe
    words out of it.
    """
    import numpy as np

    pcm = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
    peak = float(np.max(np.abs(pcm))) if pcm.size else 0.0
    if peak <= 0.0005:
        return pcm
    return np.clip(pcm * min(max_gain, target_peak / peak), -1.0, 1.0)


# Words that may sit in front of the name without changing what was meant.
# "and" and the hesitations are here because whisper inserts them: a recording
# that opens mid-breath routinely comes back as "Uh, Jarvis...".
NAME_FILLERS = frozenset({"hey", "hi", "hello", "ok", "okay", "yo", "oh", "uh", "um", "and", "a"})
NAME_CORE = "jarvis"
_STRIP = ".,!?;:'\"()[]-–—"


def _edit_distance(a: str, b: str) -> int:
    """Levenshtein distance. Inputs are single words, so the naive version is
    the right one -- it is called at most a few times per utterance."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def is_name_token(token: str) -> bool:
    """Whether one transcribed word is Jarvis being addressed.

    Whisper spells the name several ways on quiet or accented audio -- measured:
    'javis', 'jervis', 'jarvi'. Each is one edit from the real thing, so one edit
    is what is allowed, and only when the word still starts with a j. Two edits
    would let in 'travis' (measured at a wake score of 0.028, i.e. a word a room
    can say without meaning this), and the whole point of matching on the
    transcript is to be *more* selective than the acoustic model, not less.
    """
    tok = token.strip(_STRIP).lower()
    if tok.endswith("'s"):
        tok = tok[:-2]
    # Whisper spells initialisms out: "J.A.R.V.I.S." is the same word.
    if "." in tok:
        tok = tok.replace(".", "")
    if not tok:
        return False
    if tok == NAME_CORE:
        return True
    return len(tok) >= 5 and tok[0] == "j" and _edit_distance(tok, NAME_CORE) <= 1


def match_wake_name(text: str, aliases: tuple[tuple[str, ...], ...] = ()) -> Optional[str]:
    """If `text` opens by addressing Jarvis, return what was asked after it.

    Returns None when the name is not there at all, and "" when the name *was*
    the whole utterance -- the caller has to tell those apart, because one is
    noise to ignore and the other is a person waiting for "Yes?".

    This is what makes "Jarvis" work as well as "Hey Jarvis" on the way in, and
    what stops a misheard name reaching the intent rules: `normalise` in
    src/local-intents/intent-model.ts strips a literal leading "jarvis", so
    "Jervis, open Chrome" would otherwise match nothing and go to the agent as a
    sentence about somebody called Jervis.
    """
    tokens = [t for t in re.split(r"\s+", text.strip().lower()) if t.strip(_STRIP)]
    if not tokens:
        return None

    for alias in aliases:
        n = len(alias)
        if n and [t.strip(_STRIP) for t in tokens[:n]] == list(alias):
            return " ".join(tokens[n:]).lstrip(_STRIP + " ").strip()

    at = 0
    # At most two: "hey jarvis" and "ok so jarvis" are being addressed, but a
    # sentence with the name four words in is talking *about* Jarvis.
    while at < len(tokens) and at < 2 and tokens[at].strip(_STRIP) in NAME_FILLERS:
        at += 1
    if at >= len(tokens) or not is_name_token(tokens[at]):
        return None
    return " ".join(tokens[at + 1:]).lstrip(_STRIP + " ").strip()


def has_words(text: str) -> bool:
    """Whether a transcript contains anything a person could have said.

    Whisper does not answer "" when it is given something that is not speech --
    it answers punctuation. Measured, on the tail of `hey_jarvis.wav` after the
    VAD marginally called room tone speech: `'//'`. Passed on, that is a
    request: it goes to the local intents, misses, goes to the agent, and is
    answered out loud. The user gets a reply to something they never said, which
    is worse than being ignored.

    The test is deliberately only "is there a letter or a digit anywhere", not a
    list of whisper's favourite silence hallucinations. "Thank you." is one of
    those, and it is also a thing a person says to an assistant; a blocklist of
    real English would suppress real speech. `isalnum` is Unicode-aware, so this
    does not quietly assume the user speaks English.
    """
    return any(ch.isalnum() for ch in text)


def transcribe_pcm(stt: Any, pcm, beam: int) -> str:
    """One utterance through whisper, with the options that were measured to
    help. Shared by the daemon, `--selftest` and `--probe-audio`, so the numbers
    published in PERFORMANCE.md are the ones a user actually gets.

    Measured on a fixture attenuated to this microphone's level: with
    `beam_size=1` and no prompt, "hey jarvis, what time is it" came back as
    `'age-arvis, what time is it?'`; with these options, `'Hey Jarvis. What time
    is it?'`. The wider beam costs ~20 ms on `base.en`.
    """
    common = dict(
        language="en",
        beam_size=beam,
        # Each utterance is independent. Left on, whisper conditions on the
        # previous window's text and will happily continue a sentence the user
        # never started.
        condition_on_previous_text=False,
    )
    segments, _ = stt.transcribe(
        pcm,
        # Drops the leading and trailing silence that whisper otherwise
        # hallucinates words into ("Thank you." over a tail of room tone is the
        # classic). Not trusted blindly -- see the retry below.
        vad_filter=True,
        # Spelling, not instruction: it biases the decoder toward the name it
        # will hear most often, which is the one word here that has to survive a
        # bad microphone.
        initial_prompt="Jarvis.",
        **common,
    )
    text = "".join(s.text for s in segments).strip()
    if not text:
        # The filter can swallow a whole quiet utterance. Rather than report
        # silence, ask again without it: one extra pass on the rare empty case,
        # against dropping what the user actually said.
        segments, _ = stt.transcribe(pcm, **common)
        text = "".join(s.text for s in segments).strip()
    return text


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
    # The band below `wake_threshold` where the acoustic model thinks it might
    # have heard the name but will not commit. Audio in this band is recorded
    # and transcribed, and only counts as a wake if the *transcript* contains
    # the name (`match_wake_name`). Measured: a clearly spoken "jarvis" scores
    # 0.988 and needs none of this, but a quiet or clipped one lands at 0.226 --
    # above nothing (a wrong word like "travis" scores 0.028) and below the
    # threshold. Set to 0 to turn the band off and require a hard score.
    wake_soft_threshold: float = DEFAULTS["wake_soft_threshold"]
    # Extra spellings of the name to accept in a transcript, each already split
    # into words: (("hey", "jarv"),). For a user whose accent whisper renders
    # some consistent way that `is_name_token` will not allow.
    wake_aliases: tuple[tuple[str, ...], ...] = ()
    vad_threshold: float = DEFAULTS["vad_threshold"]
    # None means measure the microphone and make up the difference; a number is
    # a fixed multiplier and is never adjusted. See `Gain`.
    mic_gain: Optional[float] = None
    stt_model: str = DEFAULTS["stt_model"]
    stt_beam: int = DEFAULTS["stt_beam"]
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
        # A recording nobody has been told about yet: the wake score was in the
        # soft band, so it is being kept on the chance that the transcript
        # confirms the name. Nothing is emitted for a provisional recording
        # unless it is confirmed or promoted -- a false one must be invisible.
        self.provisional = False
        self.provisional_score = 0.0
        # Whether this wake cycle has already been re-armed after hearing the
        # name on its own. Bounds the ack loop at one: with no echo
        # cancellation, "Yes?" that leaks back as "Jarvis" would otherwise ack
        # itself forever.
        self.rearmed = False
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

        self.gain = Gain(cfg.mic_gain)
        # Logged once, and only when it actually changes, so a quiet microphone
        # leaves a trace in the log rather than being silently compensated for.
        self.gain_logged = 0.0
        # A soft threshold at or above the hard one would mean every wake takes
        # the slow transcript-confirmed path. Refuse it rather than obey it.
        self.soft_wake = 0.0 < self.cfg.wake_soft_threshold < self.cfg.wake_threshold

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

        rms = float(np.sqrt(np.mean((samples.astype(np.float32) / 32768.0) ** 2)))

        # Is Jarvis talking? Asked here, before the gain, because the answer
        # decides whether this frame may be calibrated on. `ack_gating` is
        # included because it covers the window between asking for the ack and
        # the first sample arriving, when `playback.active` is still false and
        # what the microphone hears is about to be a loudspeaker.
        speaking = (self.playback is not None and self.playback.active) or self.ack_gating

        # Gain next: everything below this line -- VAD, wake word, and the audio
        # that reaches whisper -- has to see the same signal, and on this machine
        # the raw signal is too quiet for the VAD to reliably call it speech (see
        # the table above `MIC_TARGET_RMS`). The gain is *applied* to every frame,
        # including Jarvis' own; it is only *calibrated* on the user's.
        changed = None if speaking else self.gain.frame(rms)
        if changed is not None and abs(changed - self.gain_logged) > 0.5:
            self.gain_logged = changed
            log(f"input gain {changed:.1f}x (voice level {self.gain.level:.4f})")
        samples = self.gain.apply(samples)
        if self.gain.value > 1.0:
            raw = samples.tobytes()

        # --- level, for the orb. Downsampled to ~6 Hz; the UI cannot use more
        # and every event costs an IPC round trip. Deliberately the *pre-gain*
        # figure: the sidecar's silence watch decides from this whether the
        # microphone is dead, and amplified silence must not read as sound.
        self.level_counter += 1
        if self.level_counter % 2 == 0:
            emit(type="level", rms=round(rms, 4), gain=round(self.gain.value, 2))

        speech = float(self.vad.predict(samples, frame_size=VAD_FRAME))
        is_speech = speech > self.cfg.vad_threshold

        if self.recording:
            # Keep scoring through a provisional recording. openWakeWord ramps
            # up over several frames, so the frame that first crossed the soft
            # band is routinely the leading edge of a phrase that is about to
            # cross the real one -- without this, every genuine "hey jarvis"
            # would take the slow transcript-confirmed path and lose its "Yes?".
            if self.provisional:
                score = float(self.owww.predict(samples).get(self.cfg.wake_word, 0.0))
                if score > self.cfg.wake_threshold:
                    self._promote(score)
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
            return

        # Might have been the name. Record and let the transcript decide.
        # Suppressed while Jarvis is speaking, where the microphone is mostly
        # hearing Jarvis, and in conversation mode, where the clause above has
        # already opened a recording that needs no name in front of it.
        if (
            self.soft_wake
            and self.stt is not None
            and score > self.cfg.wake_soft_threshold
            and not speaking
            and not self.conversation_open
            and not self.ptt_down
        ):
            self._begin_recording(reason="maybe_wake", provisional=True)
            self.provisional_score = score

    def _on_wake(self, score: float) -> None:
        # Fire the event before anything else: this is the number the latency
        # budget is measured against, so no work belongs in front of it.
        emit(type="wake", score=round(score, 4))
        self.owww.reset()

        # Saying the wake word over a reply is the supported barge-in.
        if self.playback is not None and self.playback.active:
            self.stop_speaking(reason="barge_in")
            emit(type="barge_in", trigger="wake_word")

        self.rearmed = False
        self._begin_recording(reason="wake")

    def _promote(self, score: float) -> None:
        """A provisional recording whose audio has now cleared the real
        threshold. Tell the runtime and carry on as an ordinary wake -- including
        the acknowledgement, which is the whole reason this exists rather than
        letting the transcript sort it out a second later.

        The buffer is trimmed back to the usual pre-roll and the clock restarted,
        so a promoted wake is indistinguishable from a fresh one: without that, a
        provisional recording that had been open for five seconds would inherit a
        wake timeout that has almost expired.

        The emit comes before `owww.reset()` for the reason `_on_wake` states,
        and it is not a micro-optimisation: openWakeWord's reset re-primes its
        feature buffer by running embeddings over four seconds of random noise,
        which costs **76 ms measured** (`.research/marklag.py`). With the reset
        first, every promoted wake -- which is every ordinary "Hey Jarvis", since
        the score crosses the soft band a frame before the real one -- announced
        itself 80 ms late: probe:voice went from 3.4 ms to 73 ms.
        """
        self.provisional = False
        emit(type="wake", score=round(score, 4), via="promoted")
        self.owww.reset()
        emit(type="speech_start", reason="wake")
        self.rec = self.rec[-self.prefix_max:]
        self.rec_started = now_ms()
        self.rec_prefix_ms = float(self.cfg.prefix_ms)
        self.silence_run = 0.0
        self.saw_speech = False
        self.ack_ms = 0.0
        # The ack is still owed: nothing has been said after the name yet, and
        # `_begin_recording` suppressed it because a provisional recording must
        # stay silent.
        self.acked = False
        self.rearmed = False

    def _begin_recording(self, reason: str, provisional: bool = False) -> None:
        if self.recording:
            return
        self.recording = True
        self.provisional = provisional
        self.rec = list(self.prefix)
        self.prefix.clear()
        self.rec_started = now_ms()
        self.silence_run = 0.0
        self.saw_speech = False
        # Only a bare wake word earns an acknowledgement. A push-to-talk press
        # or a conversation follow-up is the user already talking, and one is
        # enough per recording however long they pause. A provisional recording
        # gets none: it has not been established that anyone said the name, and
        # answering "Yes?" to a television is worse than being slow.
        self.acked = reason != "wake"
        self.ack_gating = False
        self.ack_heard = False
        self.ack_until = 0.0
        self.ack_ms = 0.0
        # Pre-roll is real audio and counts toward the utterance. The ack path
        # below discards it and clears this, because after "Yes?" the recording
        # starts from silence and there is no wake word in front of it.
        self.rec_prefix_ms = float(self.cfg.prefix_ms)
        if not provisional:
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

        # A provisional recording is on a short leash. If the soft score was
        # noise, this throws it away within a second and re-arms; if it was a
        # quietly spoken name, the name is sitting in the pre-roll and the
        # transcript is the only thing that can tell the two apart -- so it is
        # transcribed rather than discarded. `_transcribe` emits nothing unless
        # it finds the name.
        if self.provisional and not self.saw_speech and elapsed >= MAYBE_WAKE_LEASH_MS:
            self._end_recording()
            return

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
        provisional = self.provisional
        self.provisional = False
        audio = b"".join(self.rec)
        self.rec = []
        duration_ms = len(audio) / BYTES_PER_SAMPLE / SAMPLE_RATE * 1000.0
        # A provisional recording has not been announced, so there is no
        # `speech_start` for this to close and nothing on the other side that
        # would know what to do with it. `_transcribe` emits the whole burst at
        # once if the name turns out to be there.
        if not provisional:
            emit(type="speech_end", ms=round(duration_ms), truncated=truncated)

        speech_ms = duration_ms - self.rec_prefix_ms
        if speech_ms < self.cfg.min_utterance_ms:
            if not provisional:
                emit(type="final", text="", reason="too_short", ms=0)
            return
        if self.stt is None:
            if not provisional:
                emit(type="unavailable", subsystem="stt",
                     reason="speech-to-text is not loaded")
            return

        # Transcribe off the audio thread so capture never stalls.
        threading.Thread(
            target=self._transcribe, args=(audio, provisional, duration_ms),
            daemon=True, name="stt",
        ).start()

    def _transcribe(self, audio: bytes, provisional: bool = False,
                    duration_ms: float = 0.0) -> None:
        t0 = now_ms()
        try:
            text = transcribe_pcm(self.stt, normalise_for_stt(audio), self.cfg.stt_beam)
        except Exception as exc:  # noqa: BLE001
            if not provisional:
                emit(type="error", message=f"transcription failed: {exc}", fatal=False)
            return

        ms = round(now_ms() - t0)

        # No word in it, no command in it -- see `has_words`. Reported as an
        # empty `final` rather than silently dropped, because the runtime is
        # sitting in `understanding` waiting for this and needs to be let go.
        if not has_words(text):
            if provisional:
                log(f"soft wake {self.provisional_score:.2f} not confirmed: {text[:60]!r}")
            else:
                emit(type="final", text="", reason="no_speech", ms=ms)
            return
            if provisional:
                log(f"soft wake {self.provisional_score:.2f} not confirmed: {text[:60]!r}")
            else:
                emit(type="final", text="", reason="no_speech", ms=ms)
            return

        stripped = match_wake_name(text, self.cfg.wake_aliases)

        if provisional:
            # Nothing was announced for this recording, so if the name is not
            # there this is where it ends -- no event, no state change, no orb.
            if stripped is None:
                log(f"soft wake {self.provisional_score:.2f} not confirmed: {text[:60]!r}")
                return
            emit(type="wake", score=round(self.provisional_score, 4), via="transcript")
            if not stripped:
                # They said the name and stopped. Acknowledge and listen, which
                # is exactly what a hard wake with nothing behind it does.
                if self._can_rearm():
                    self.rearmed = True
                    self._rearm_after_name()
                return
            emit(type="speech_start", reason="wake")
            emit(type="speech_end", ms=round(duration_ms), truncated=False)
            emit(type="final", text=stripped, heard=text, ms=ms)
            return

        if stripped == "" and not self.rearmed and self._can_rearm():
            # The wake word was heard, and so was the name, and nothing else.
            # `_record` acknowledges this case the moment it can see it coming;
            # getting here means the user's pause was too short for that, so it
            # is answered now instead of being sent on as a request to do
            # something about somebody called Jarvis.
            self.rearmed = True
            self._rearm_after_name()
            return

        emit(type="final", text=text if stripped is None else stripped,
             heard=text, ms=ms)

    def _can_rearm(self) -> bool:
        """Is re-arming after a bare name worth doing?

        Only if there is an acknowledgement to play. The whole point of the
        re-arm is to answer "Yes?" and listen; with `ack_text` empty or no TTS
        loaded it would instead open a silent recording the user has no way of
        knowing about, and swallow the next wake word while it ran.
        """
        return bool(self.cfg.ack_text) and self.tts is not None

    def _rearm_after_name(self) -> None:
        """Heard the name on its own: say "Yes?" and open the microphone again.

        Nothing is duplicated here -- it starts an ordinary post-wake recording
        and lets `_record` run the acknowledgement, gate the microphone while it
        plays, and time out if nobody follows up. The clock is wound back by
        `ack_after_ms` because the pause that clause waits for has already
        happened: it is how we knew the utterance had ended. That comes off the
        wake timeout too, which is the right trade at 480 ms of 6 s.
        """
        self._begin_recording(reason="wake")
        self.rec_started -= self.cfg.ack_after_ms

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
        self.provisional = False
        self.rearmed = False
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

    Uses the SAPI fixtures (scripts/make-voice-fixtures.ps1), so the real
    wake-word model, the real VAD and the real STT model are all exercised on a
    genuine audio path rather than handed a mocked score.

    Four claims are checked, and each one is here because it broke or was
    doubted:

      * "hey jarvis" fires, and so does a bare "jarvis" -- there is no `jarvis`
        model, so this is the only evidence that one phrase does both.
      * near misses do not fire, at either threshold. A soft band that let
        "travis" in would be worse than no soft band.
      * the name matcher accepts what whisper actually writes and refuses what
        it writes for other words.
      * gain restores the VAD on audio attenuated to this machine's real level,
        which is the reported bug.
    """
    import numpy as np

    ok = True
    d = VoiceDaemon(cfg)
    d.load_models()

    def load(name: str):
        path = os.path.join(".research", "audio", f"{name}.wav")
        if not os.path.exists(path):
            return None
        with wave.open(path, "rb") as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        # A second of silence in front: openWakeWord needs to see the phrase
        # arrive, not start mid-word on the first frame.
        return np.concatenate([np.zeros(SAMPLE_RATE, dtype=np.int16), pcm])

    def wake_peak(audio) -> float:
        d.owww.reset()
        peak = 0.0
        for i in range(0, len(audio) - CHUNK_SAMPLES + 1, CHUNK_SAMPLES):
            peak = max(peak, float(
                d.owww.predict(audio[i:i + CHUNK_SAMPLES]).get(cfg.wake_word, 0.0)
            ))
        return peak

    def check(label: str, passed: bool, detail: str) -> None:
        nonlocal ok
        ok &= passed
        print(f"{label:<26}{detail:<34}{'PASS' if passed else 'FAIL'}")

    missing = [n for n in ("hey_jarvis", "jarvis_cmd", "name_only", "name_cmd",
                           "travis", "service") if load(n) is None]
    if missing:
        print(f"missing fixtures {missing}; run scripts/make-voice-fixtures.ps1")
        return 1

    # --- wake word: both phrases fire, near misses do not ------------------
    for name in ("hey_jarvis", "jarvis_cmd", "name_only", "name_cmd"):
        peak = wake_peak(load(name))
        check(f"wake {name}", peak > cfg.wake_threshold, f"{peak:.3f} > {cfg.wake_threshold}")

    floor = cfg.wake_soft_threshold if d.soft_wake else cfg.wake_threshold
    for name in ("travis", "service"):
        peak = wake_peak(load(name))
        check(f"silent on {name}", peak <= floor, f"{peak:.3f} <= {floor}")

    # --- the transcript-side name matcher ---------------------------------
    cases: list[tuple[str, Optional[str]]] = [
        ("Hey Jarvis, what time is it?", "what time is it?"),
        ("Jarvis, what time is it?", "what time is it?"),
        ("jarvis", ""),
        ("Uh, Jarvis, open Chrome.", "open chrome."),
        ("J.A.R.V.I.S., lock the computer", "lock the computer"),
        # Misspellings whisper actually produced on quiet audio.
        ("Javis, what time is it", "what time is it"),
        ("Jervis, open Chrome", "open chrome"),
        # And what must not match: another word, and the name used as a subject
        # rather than an address.
        ("Travis, what time is it", None),
        ("The service is running", None),
        ("I told Sarah that Jarvis can do it", None),
        ("", None),
    ]
    for text, want in cases:
        got = match_wake_name(text, cfg.wake_aliases)
        check("name match", got == want, f"{text[:22]!r} -> {got!r}")

    # --- what whisper returns for "that was not speech" -------------------
    # The left column is what it actually produced on non-speech; the right is
    # what a person plausibly said. Nothing here is a blocklist of phrases --
    # `has_words` only asks whether there is a letter or a digit at all.
    for text, want in [
        ("//", False), ("...", False), (" ", False), ("", False),
        ("♪♪♪", False), ("-", False), ("?!", False),
        ("Thank you.", True), ("no", True), ("9", True), ("Jarvis", True),
        # Not English, and not this daemon's business to reject.
        ("ハイ", True),
    ]:
        check("has words", has_words(text) == want, f"{text[:12]!r} -> {has_words(text)}")

    # --- gain, against the sequence that actually breaks ------------------
    # The live failure is not "the VAD is deaf at 0.007" -- fed a quiet command
    # after nothing but room tone it does fine. It is "the VAD is deaf at 0.007
    # once the microphone has heard the acknowledgement through the speakers".
    # So the fixture is the whole sequence, in order: room tone, "Yes?" at
    # loudspeaker level, then the command at the level this machine delivers.
    #
    # Three conditions, and all three assertions matter. The first is the bug.
    # The third is why `_process` withholds Jarvis' own voice from calibration:
    # gain that calibrates on the ack lets the loud playback drag the percentile
    # up, comes back down to ~1.0, and fixes nothing. Measured 2026-08-15:
    # 10, 11 and 23 of 35 frames.
    #
    # `load` pads a second of silence in front for the wake-word checks. It has
    # to come off here: a second of digital zeros between the ack and the command
    # is not what happens -- the user talks over the ack or straight after it --
    # and it would both dilute the ratios and let the VAD partly recover.
    clip = load("jarvis_cmd")[SAMPLE_RATE:]

    def peak_frame_rms(audio) -> float:
        peak = 0.0
        for i in range(0, len(audio) - CHUNK_SAMPLES + 1, CHUNK_SAMPLES):
            frame = audio[i:i + CHUNK_SAMPLES].astype(np.float32) / 32768.0
            peak = max(peak, float(np.sqrt(np.mean(frame ** 2))))
        return peak

    def at_level(target: float):
        scale = target / max(peak_frame_rms(clip), 1e-9)
        return np.clip(clip.astype(np.float32) * scale, -32768, 32767).astype(np.int16)

    quiet = at_level(0.007)        # this microphone, a normal speaking voice
    ack = at_level(0.05)           # Jarvis' own "Yes?", heard in the near field
    tone = (np.random.default_rng(11).normal(0, 0.0001 * 32768.0, SAMPLE_RATE * 20)
            ).astype(np.int16)     # 20 s of a realistic idle floor
    n_command = len(quiet) // CHUNK_SAMPLES

    def command_frames(gain: Optional[Gain], calibrate_on_ack: bool) -> int:
        """Speech frames the VAD finds in the command, having been fed the room
        tone and the ack first. Mirrors `_process`: the gain is applied to every
        frame and calibrated only on frames that could be the user."""
        # The VAD is an RNN. Reset, or the previous condition leaks into this one
        # and the comparison means nothing -- which is the mistake that produced
        # the wrong diagnosis the first time round.
        d.vad.reset_states()
        found = 0
        for label, audio in (("tone", tone), ("ack", ack), ("command", quiet)):
            for i in range(0, len(audio) - CHUNK_SAMPLES + 1, CHUNK_SAMPLES):
                frame = audio[i:i + CHUNK_SAMPLES]
                if gain is not None:
                    if label != "ack" or calibrate_on_ack:
                        rms = float(np.sqrt(
                            np.mean((frame.astype(np.float32) / 32768.0) ** 2)))
                        gain.frame(rms)
                    frame = gain.apply(frame)
                speech = float(d.vad.predict(frame, frame_size=VAD_FRAME))
                if label == "command" and speech > cfg.vad_threshold:
                    found += 1
        return found

    without = command_frames(None, False)
    poisoned = command_frames(Gain(), True)
    fixed = command_frames(Gain(), False)
    check("vad loses the command after the ack", without < n_command / 3,
          f"{without} of {n_command} frames")
    check("gain recovers it", fixed >= n_command * 0.45,
          f"{fixed} of {n_command} frames")
    check("calibrating on the ack would not", poisoned < n_command / 2,
          f"{poisoned} of {n_command} frames")

    # --- the rest of the pipeline -----------------------------------------
    if d.stt is not None:
        text = transcribe_pcm(
            d.stt, normalise_for_stt(load("jarvis_cmd").tobytes()), cfg.stt_beam
        )
        check("transcript", "jarvis" in text.lower(), repr(text[:30]))
    else:
        check("transcript", False, "stt unavailable")

    check("tts", d.tts is not None, "piper loaded" if d.tts else "not loaded")

    devices = Capture.list_devices()
    check("input devices", bool(devices), f"{len(devices)} found")

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
        text = transcribe_pcm(d.stt, normalise_for_stt(audio.tobytes()), cfg.stt_beam)
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


def _mic_gain_arg(value: str) -> Optional[float]:
    """`auto` (measure it) or a fixed multiplier. See `Gain`."""
    v = value.strip().lower()
    if v in ("", "auto"):
        return None
    try:
        g = float(v)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected 'auto' or a number, got {value!r}")
    if not 0.1 <= g <= 64.0:
        raise argparse.ArgumentTypeError(f"gain {g} is outside 0.1-64")
    return g


def _alias_args(values: Optional[list[str]]) -> tuple[tuple[str, ...], ...]:
    """Turn `--wake-alias "hey jarv"` into the token tuples match_wake_name wants."""
    out: list[tuple[str, ...]] = []
    for raw in values or []:
        words = tuple(w for w in re.split(r"\s+", raw.strip().lower()) if w)
        # Four words in is a sentence, not a name, and an empty alias would
        # match every utterance.
        if words and len(words) <= 3:
            out.append(words)
    return tuple(out)


def main() -> int:
    p = argparse.ArgumentParser(description="Jarvis voice daemon")
    p.add_argument("--device")
    p.add_argument("--wake-word", default=DEFAULTS["wake_word"])
    p.add_argument("--wake-threshold", type=float, default=DEFAULTS["wake_threshold"])
    p.add_argument("--wake-soft-threshold", type=float,
                   default=DEFAULTS["wake_soft_threshold"],
                   help="score band that is confirmed from the transcript; 0 disables")
    p.add_argument("--wake-alias", action="append", metavar="PHRASE",
                   help="extra spelling of the name to accept in a transcript")
    p.add_argument("--vad-threshold", type=float, default=DEFAULTS["vad_threshold"])
    p.add_argument("--mic-gain", type=_mic_gain_arg, default=None,
                   help="'auto' (default) or a fixed input multiplier")
    p.add_argument("--stt-model", default=DEFAULTS["stt_model"])
    p.add_argument("--stt-beam", type=int, default=DEFAULTS["stt_beam"])
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
        wake_soft_threshold=a.wake_soft_threshold,
        wake_aliases=_alias_args(a.wake_alias),
        vad_threshold=a.vad_threshold,
        mic_gain=a.mic_gain,
        stt_model=a.stt_model,
        stt_beam=a.stt_beam,
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
