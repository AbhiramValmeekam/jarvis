# Performance

Measured numbers only. Every figure here was produced by a script in this repo
against the real components, and the command that produced it is named next to
it. Nothing on this page is an estimate or a target — targets live in
`IMPLEMENTATION_PLAN.md`, and where a measurement misses one it says so.

Re-measure with:

```
npm run probe:voice          # replayed fixture, deterministic — the numbers below
npm run probe:voice:live     # real microphone, real human voice
```

## Machine

| | |
|---|---|
| CPU | AMD Ryzen 5 5600H (6c/12t, 3.3 GHz) |
| RAM | 16 GB |
| GPU | inference is CPU-only; no CUDA path is used |
| OS | Windows 11 Home Single Language 10.0.26200 |
| Python | 3.11 in `.venv` |
| Date | 2026-08-09 |

A slower laptop will be slower. What should hold across machines is the shape:
model lookahead dominates, and Jarvis' own code is a rounding error.

## Wake → acknowledgement

**The number: 3.4 ms median.** From the last audio frame of "Jarvis" reaching the
models, to the UI being told to light the orb.

`probe:voice`, 5 replays of `.research/audio/hey_jarvis.wav` through the real
`JarvisRuntime` and the real supervised daemon:

| | median | min | max |
|---|---|---|---|
| speech end → `state: wake_detected` broadcast | **3.4 ms** | 2.6 ms | 3.5 ms |
| runtime only (`wake` event → broadcast) | 0.0 ms | 0.0 ms | 0.1 ms |

Budget was 100–300 ms. It is met with two orders of magnitude to spare, which is
worth stating plainly rather than celebrating: the budget was set for the whole
perceived response, and this measures the first visible acknowledgement. It is
the part a user reads as "it heard me", and it is effectively instant.

The runtime column is the honest self-assessment. Parsing the line, stepping the
state machine, and broadcasting to attached UIs costs ~0 ms; the pipeline's
latency is not in the TypeScript.

### Where the perceived delay actually is

Timed in audio position, not wall-clock, so it is identical on every run and
every machine — `probe:voice` step 1:

| stage | cost | what it is |
|---|---|---|
| wake model lookahead | **80 ms** | openWakeWord needs the frame *after* the word ends before it will commit |
| wake inference | 3.5 ms p95 per 80 ms frame | 4% of one frame's real-time budget |
| Jarvis wake→ack | 3.4 ms | the table above |
| STT (`base.en`, 1.5 s clip) | ~315 ms | faster-whisper, int8, CPU |
| TTS to first audio | ~28 ms | Piper `en_GB-alan-medium`, streamed |

So from a user's point of view: the orb lights ~83 ms after they stop saying the
wake word (80 ms of it the model's, 3.4 ms Jarvis'), and a short command is
transcribed ~315 ms after they stop speaking it.

**This excludes the audio driver.** The fixture is fed from disk at real-time
pace, which is what makes the number reproducible; it also means the WASAPI
capture buffer is not in it. `probe:voice:live` includes the driver and reports
`ack + detection lag` for comparison, but its zero point is a human's judgement
of when they stopped talking, so it corroborates rather than replaces this.

## Model load

`probe:voice` step 2, cold process, from `npm run probe:voice` output:

| | |
|---|---|
| wake word + VAD | ~1.2 s |
| STT (`base.en`) | ~1.1 s |
| TTS (warmed with a throwaway synth) | ~1.5 s |
| **daemon ready** | **~3.9 s** |

Loaded concurrently at startup, so the daemon is listening ~4 s after the
runtime starts it. The runtime serves IPC before this finishes and reports voice
as `starting` until the daemon says the microphone is open — the tray and HUD
never claim a live mic that does not exist yet.

## Not yet measured

Named so the gaps are visible rather than implied:

- **Wake→spoken-reply**, end to end. Needs Hermes in the loop; its first-token
  latency is the dominant term and Phase 3 does not gate on it.
- **False accepts per hour** of the wake word. Needs hours of ambient audio.
- **Idle CPU and RAM** of the always-on runtime, over a working day.
- **Barge-in cut-off time** — how long audio keeps playing after the interrupt.
  Correctness is covered by `tests/runtime-voice.test.ts`; the duration is not.
