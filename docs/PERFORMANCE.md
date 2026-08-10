# Performance

Measured numbers only. Every figure here was produced by a script in this repo
against the real components, and the command that produced it is named next to
it. Nothing on this page is an estimate or a target — targets live in
`IMPLEMENTATION_PLAN.md`, and where a measurement misses one it says so.

Re-measure with:

```
npm run probe:voice          # replayed fixture, deterministic — the numbers below
npm run probe:voice:live     # real microphone, real human voice
npm run probe:idle           # CPU, RAM and liveness of the always-on runtime, idle
```

## Machine

| | |
|---|---|
| CPU | AMD Ryzen 5 5600H (6c/12t, 3.3 GHz) |
| RAM | 16 GB |
| GPU | inference is CPU-only; no CUDA path is used |
| OS | Windows 11 Home Single Language 10.0.26200 |
| Python | 3.11 in `.venv` |
| Date | 2026-08-10 |

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

## Idle cost

**The number: 0.02% of one core, and RSS that does not grow.** This is the claim
the README makes in its second paragraph — always *available*, not always burning
CPU on inference — and it is the one a user can check for themselves in Task
Manager, which makes it the worst one to be wrong about.

`npm run probe:idle`, which starts the real `JarvisRuntime` with the microphone
off, Hermes lazy, and Hermes' cron/config/memory paths pointed at a temp fixture,
then does nothing for a measured window:

| window | CPU (% of one core) | RSS start → end |
|---|---|---|
| 60 s | 0.02% | 79.0 → 69.4 MB |
| 120 s | 0.012% | 61.7 → 55.7 MB |
| 300 s | 0.037% | 79.6 → 72.5 MB |

Under a tenth of a percent of one core, against a 2% gate. RSS *falls* across
every window — that is the garbage collector reclaiming boot allocations, not a
measurement error, and it is the shape you want: a leak would show as a number
climbing with the window length, and 60 s / 120 s / 300 s all end 7–10 MB lower
than they start.

CPU varies by a factor of three between runs because the true figure is close
enough to zero that a few OS scheduling decisions move it. The honest statement
is an upper bound: **well under 0.1% of one core**, i.e. below the resolution at
which "idle" is a meaningful word.

### What makes this measurement trustworthy

An idle process and a *dead* one produce identical CPU and memory numbers, so the
window is not purely idle. A scheduled job is present in the fixture from the
start, and partway through the window it is given a failed run. The probe then
requires the notification a user would actually receive:

```
PASS  noticed a scheduled job failing while idle — cheap, not asleep  Task failed: nightly backup
PASS  said nothing else while idle                                    no unprompted notifications
```

Checked through the user-visible notification rather than an internal poll
counter, because a counter can tick while the feature is broken. The second line
matters as much as the first: a notification nobody needed is a cost too.

### The five negatives (§72)

Asserted as a *diff* across the window — process names that appeared, not process
names present. A whole-machine scan reads as rigour and is not: this probe is
normally run from Claude Code, so `claude` is already in the list, and a browser
the user opened themselves is not a finding.

| §72 requirement | result |
|---|---|
| Claude Code not running unnecessarily | no `claude` process appeared |
| Hermes not continuously inferring | no `hermes`/`python` process appeared |
| No screenshots captured continuously | 0 captures, counted at the `captureScreen` seam |
| No microphone audio uploaded (§50) | no audio sidecar appeared |
| Browser automation not active | no `chromedriver`/`msedgedriver`/`geckodriver` appeared |

Screen capture is counted at the seam rather than inferred from processes,
because Windows capture is an in-process API call and would leave nothing behind
to find. Overriding that seam replaces the pixels only — consent, the rate limit
and the session cap stay in force — so a non-zero count would be a real
unrequested capture rather than a bypassed guard.

**What this does not cover.** The Electron shell's own resident set is not in
these figures — this measures the runtime process, which is the part that polls,
watches and schedules. Voice idle cost is measured separately by `probe:voice`,
since an always-open microphone is a different cost with a different gate. And a
working day is longer than five minutes: the leak evidence here is three windows
up to 300 s, not eight hours.

## Not yet measured

Named so the gaps are visible rather than implied:

- **Wake→spoken-reply**, end to end. Needs Hermes in the loop; its first-token
  latency is the dominant term and Phase 3 does not gate on it.
- **False accepts per hour** of the wake word. Needs hours of ambient audio.
- **Idle cost over a working day.** Measured up to 300 s above, which is enough to
  rule out a busy wait and a fast leak, and not enough to rule out a slow one.
- **The Electron shell's own footprint.** The idle figures above are the runtime
  process; the window and tray are not in them.
- **GPU.** Nothing here uses one — inference is CPU-only int8 on this machine, so
  there is no GPU figure to report rather than an unmeasured one.
- **Barge-in cut-off time** — how long audio keeps playing after the interrupt.
  Correctness is covered by `tests/runtime-voice.test.ts`; the duration is not.
