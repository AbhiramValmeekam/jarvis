# Voice Pipeline — Analysis

Every number below was measured on this machine (Windows 11, AMD, `Microphone
Array (AMD Audio Device)`), not taken from a README. Commands are reproducible
via `npm run bench:voice`.

---

## 1. What was available before writing any code

| Need | Found | Verdict |
|---|---|---|
| Headless mic capture | `ffmpeg 8.0.1` on PATH, dshow backend | **Use it.** No native Node addon, no node-gyp |
| Audio playback | `ffplay 8.0.1` (same build) | **Use it.** Killing the process stops audio instantly — that is the barge-in primitive |
| Wake word | `openwakeword 0.6.0` ships a pretrained **`hey_jarvis_v0.1.onnx`** | **Use it.** A model trained for this exact phrase already exists |
| VAD | `silero_vad.onnx`, bundled with openWakeWord + a working wrapper | **Use it.** No second dependency |
| STT | `faster-whisper 1.2.1` (CTranslate2) | **Use it.** Named in the spec |
| TTS | `piper-tts 1.6.0`, voice `en_GB-alan-medium` | **Use it.** Spec default |

Capture verified end to end before anything was designed:

```
ffmpeg -f dshow -i audio="Microphone Array (AMD Audio Device)" -ac 1 -ar 16000 -f s16le -t 2 -
→ 63,616 bytes = 1.988 s @ 16 kHz mono   (clean, no stderr)
```

---

## 2. Wake word — measured, not assumed

The plan required the engine be "evaluated on measured CPU, not assumption",
because this is the one component that runs every second the laptop is on.

**Cost** (single-threaded, `OMP_NUM_THREADS=1`, 80 ms chunks):

```
per-chunk ms   mean 2.42   p50 2.52   p95 3.10   max 4.59
20.0 s of audio processed in 0.61 s
real-time factor 0.0303  →  3.03% of ONE core, continuously
```

Adding VAD (`0.86%`) gives a steady-state idle cost of **~3.9% of one core**.
On an 8-core machine that is well under 1% of total CPU. This is affordable as
an always-on background process, which was the open question.

**Accuracy.** Detection was tested with speech synthesized by Windows SAPI
(Microsoft David / Zira), so it is a real audio path, not a unit test with a
mocked score:

| Clip | Peak score | Result |
|---|---|---|
| "hey jarvis" | **0.998** | fired |
| "hey jarvis, what time is it" | **0.998** | fired |
| "hey computer" | 0.000 | correctly silent |
| "the weather tomorrow looks quite pleasant" | 0.000 | correctly silent |

Zero false positives on the negatives — not merely "below threshold", but
exactly 0.000. Threshold is set at 0.5 with room to spare.

---

## 3. STT — model choice is a measured trade, not a preference

`.research/audio/jarvis_cmd.wav`, 2.87 s of speech, CPU int8:

| Model | Load (once) | Transcribe | RTF | Output |
|---|---|---|---|---|
| `tiny.en` | 11.1 s | **207 ms** | 0.072 | "Hey Jarvis, what time is it?" |
| **`base.en`** | 12.4 s | **378 ms** | 0.132 | "Hey Jarvis, what time is it?" |
| `small.en` | 32.4 s | 1120 ms | 0.391 | "Hey Jarvis, what time is it?" |

All three were correct on clean speech. **`base.en` is the default** — it buys
noticeably better robustness on accented and noisy input for ~170 ms over
`tiny.en`, while `small.en` costs a second per utterance. Configurable, because
the right answer depends on the microphone and the speaker.

**Load time is the real constraint, not inference.** 12 s to load means the
model must be resident in a long-lived process. This is the single strongest
argument for the sidecar being a daemon rather than a per-utterance script.

---

## 4. TTS — the cold-start trap

First measurement:

```
'Yes?'                      first-chunk  2530 ms
'Good evening. Hermes is …' first-chunk    36 ms
```

The first synthesis after load costs **2.5 seconds** (espeak phonemiser + ONNX
graph warm-up); every one after it costs ~35 ms. A naive implementation would
make Jarvis's *first* reply of every session — the one that sets the whole
impression — arrive 2.5 s late, and it would look like a model problem rather
than a warm-up problem.

Fix: synthesize and discard one throwaway phrase at daemon start. After that:

| Utterance | First chunk | Audio produced |
|---|---|---|
| "Yes?" | **32 ms** | 766 ms |
| "Sir?" | **24 ms** | 534 ms |
| "Good evening. Hermes is ready and I am listening." | **43 ms** | 3355 ms |

Synthesis is ~30× faster than playback, so speech starts while the rest is
still being generated.

---

## 5. Architecture decisions

### 5.1 Audio lives in the runtime, never in the renderer

The obvious way to do voice in an Electron app is `getUserMedia` in the
renderer. That is rejected here: Phase 2 guarantees that killing the shell
leaves Jarvis running, and a microphone owned by the window would make that
guarantee false — Jarvis would keep "running" while being deaf. Capture,
wake word, STT and TTS all sit behind the runtime, on the far side of the IPC
boundary from any UI.

### 5.2 A Python sidecar, supervised like Hermes

All three engines that satisfy the spec are Python-native with ONNX runtimes.
Reimplementing openWakeWord's mel → embedding → classifier chain in Node would
be a second implementation of something that already works, with no
user-visible benefit and a new class of bug.

So: one long-lived Python process, `voice/daemon.py`, speaking line-delimited
JSON over stdio — the same shape as the ACP transport already proven in
Phase 1, and supervised by the same bounded `RestartPolicy` as Hermes. Models
load once and stay warm, which §3 and §4 show is mandatory.

The cost is honest and stated: Jarvis needs a Python environment. If it is
missing, voice reports `unavailable` with the reason, and typed input keeps
working.

### 5.3 Barge-in is wake-word-first, and here is why

The textbook approach — run VAD while speaking and stop on any speech — does
not survive contact with a laptop. The microphone hears the speakers, so
Jarvis's own voice re-enters the VAD and it interrupts itself on its first
syllable. Fixing that properly needs acoustic echo cancellation with
loudspeaker reference alignment, which is a large piece of DSP.

What is implemented instead, and what actually works:

1. **Say "Jarvis" over it.** The wake word keeps running during playback, and
   firing stops speech immediately (kill `ffplay` → audio ceases in one
   buffer). openWakeWord does not trigger on Jarvis's own voice because that
   voice is not saying "hey jarvis".
2. **Any UI stop / cancel** — instant, no audio path involved.
3. **Push-to-talk** — holding the key stops playback and opens the mic.

Energy-gated VAD barge-in exists behind `bargeInOnSpeech`, **off by default**,
with the echo caveat documented at the flag. This is a real limitation stated
plainly rather than a checkbox ticked with something that self-triggers.

### 5.4 Privacy — what leaves this machine

Worth stating precisely, since §50 forbids secretly streaming audio:

- **Audio never leaves the machine.** ffmpeg → local ONNX models → local
  whisper. No network in the capture path at all.
- **Transcribed text does leave** when a request is routed to Hermes, which
  calls a hosted model. That is the assistant working as designed, but it is a
  real disclosure and the user should know the boundary: *your voice stays
  here; your words may not.*
- Continuous audio is never buffered to disk. The rolling wake-word buffer is
  in memory and bounded; utterance audio is discarded once transcribed.
- Muting stops capture at the source — ffmpeg is signalled, not just ignored —
  so "muted" means the process is not receiving audio, not that it is politely
  discarding it.

---

## 6. Latency budget

Target from the plan: wake → ack in 100–300 ms.

| Segment | Measured | Notes |
|---|---|---|
| Wake model inference | 2.4 ms / chunk | negligible |
| Chunk quantisation | ≤ 80 ms | detection lands on a chunk boundary |
| Event → runtime → UI | sub-ms locally | named pipe, in-process |
| TTS first chunk (warm) | 24–43 ms | "Yes?" begins here |

The end-to-end figure is measured live by `npm run probe:voice` and published
in `PERFORMANCE.md` — whatever it turns out to be.
