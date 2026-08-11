# Performance

Measured numbers only. Every figure here was produced by a script in this repo
against the real components, and the command that produced it is named next to
it. Nothing on this page is an estimate or a target — targets live in
`IMPLEMENTATION_PLAN.md`, and where a measurement misses one it says so.

Re-measure with:

```
npm run probe:voice          # replayed fixture, deterministic — the numbers below
npm run probe:voice:live     # real microphone, real human voice
npm run probe:ack            # wake acknowledgement: audible, and never heard back
npm run probe:idle           # CPU, RAM and liveness of the always-on runtime, idle
npm run probe:install        # the packaged binary, launched the way a Run key launches it
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

### The audible acknowledgement — 610 ms

Two different things on this page are called an "ack", so: everything above is the
**visual** one, the orb lighting at ~83 ms. This is the **audible** one — §63's
*"Jarvis." → "Yes?"* — and it is 180× slower, which is fine, because a spoken reply
is bounded by synthesis rather than by inference.

`probe:ack`, real daemon and real Piper against `hey_jarvis.wav`:

| | measured |
|---|---|
| wake → first audio of "Yes?" | **610 ms** |
| wake → acknowledgement finished | 2 427 ms |
| wake → wake timeout (nobody spoke) | 7 997 ms |

The third row is the one that shows the design is right rather than merely working.
The wake timeout is a 6 s budget for the user to speak, and it fired at ~8 s — the
~2.1 s Jarvis spent talking was excluded from it, so hearing "Yes?" does not cost the
user part of their time to answer. Had it not been excluded, a user who waited politely
for Jarvis to finish would have under 4 s left to say anything.

The 610 ms is dominated by a deliberate ~480 ms wait, not by synthesis: Jarvis pauses
after the wake word to find out whether the user is still talking. Saying "Jarvis, what
time is it" in one breath must not be answered with "Yes?" over the top of the question,
and that is a measured behaviour, not an intention — the second fixture proves the
acknowledgement is withheld entirely when a command follows.

Not measured here, and worth stating: the ack holds the microphone gate shut while it is
audible, because there is no echo cancellation. The gate opens on playback ending rather
than after a fixed grace, so the cost to the user is the ack's real duration and nothing
more.

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

**What this does not cover.** The figures above are the *dev* runtime started as
plain Node with the microphone off. What a user actually runs is the packaged
build, with a shell and a live daemon — measured separately below. Voice idle cost
is measured by `probe:voice`, since an always-open microphone is a different cost
with a different gate. And a working day is longer than five minutes: the leak
evidence here is three windows up to 300 s, not eight hours.

## Packaged footprint

**The number: 251 MB across four processes, of which the always-on half is 57 MB.**

`npm run probe:install`, which launches `dist\win-unpacked\Jarvis.exe --minimized`
from `C:\Windows\System32` — the working directory a Run-key launch actually gets —
and reads RSS out of `Get-CimInstance Win32_Process` once the runtime is up and
voice has reported the microphone open. So this is the whole application, doing the
thing it exists to do, not a trimmed configuration.

| role | pid parent | RSS | what it is |
|---|---|---|---|
| shell | — | 75 MB | Electron browser process: tray, and the window when shown |
| helper:gpu-process | shell | 77 MB | Chromium's GPU process, for the HUD |
| helper:utility | shell | 41 MB | Chromium's network service |
| **runtime** | shell | **57 MB** | the assistant — the only one that must outlive the UI |

The split is the point. Killing the shell reclaims 193 MB and Jarvis keeps
listening (`probe:shell` step 4 asserts exactly this), so the cost of the UI is a
cost the user only pays while they want a UI.

### 95 MB that was being spent on rendering that never happens

The first packaged build measured **395 MB**, and the runtime side of it was 202 MB
rather than 57 MB. The cause was not a leak: the shell re-launched its own binary
with `--runtime`, which starts a full Electron *browser* process, and Chromium
spawns a GPU process and a network utility process on the way up whether or not
anything will ever draw. An assistant that never opens a window was carrying 82 MB
of GPU process and 49 MB of network service to do nothing.

| build | processes | total RSS | the always-on side |
|---|---|---|---|
| `Jarvis.exe --runtime` | 6 | 395 MB | 71 + 82 (gpu) + 49 (utility) = **202 MB** |
| … + `disable-gpu` switches | 6 | 359 MB | 71 + 46 + 49 = **166 MB** |
| `Jarvis.exe runtime.js`, `ELECTRON_RUN_AS_NODE=1` | 4 | **251 MB** | **57 MB**, no helpers |

The switches were the obvious fix and the wrong one: by the time `process.argv` is
read Electron has already begun its browser bootstrap, so the most they could do was
shrink the GPU process, not prevent it. The real fix was to stop asking for a browser
at all — build `src/runtime/main.ts` as its own entry (`electron.vite.config.ts`) and
launch the same executable as plain Node. What makes that legal is a fact rather than
a hope: nothing under `src/runtime/**` imports `electron`, and if that ever changes
the packaged runtime fails to boot and says so.

`probe:install` asserts the shape, not just the number — that exactly one shell and
one runtime exist, that no GPU helper is parented to the runtime, and that the
helpers which do exist belong to the shell. A total that happened to be low for
another reason would still fail those.

### What this does not include

The 57 MB runtime here has voice **live** — wake word, STT and TTS models resident —
where the 55–79 MB in the idle table above has the microphone off. The two are not
the same measurement and should not be read as a contradiction: the packaged number
is the honest one for an installed Jarvis, and the idle table is the one that isolates
Jarvis' own code from the models. Neither includes disk: `dist\win-unpacked` is
349 MB, and voice reuses the 473 MB `.venv` and the Whisper cache already in the dev
tree rather than shipping copies.

## Not yet measured

Named so the gaps are visible rather than implied:

- **Wake→spoken-reply**, end to end. Needs Hermes in the loop; its first-token
  latency is the dominant term and Phase 3 does not gate on it.
- **False accepts per hour** of the wake word. Needs hours of ambient audio.
- **Idle cost over a working day.** Measured up to 300 s above, which is enough to
  rule out a busy wait and a fast leak, and not enough to rule out a slow one.
- **Packaged idle cost over time.** The packaged table is a single reading taken
  once the app is up, not a window: it establishes what an installed Jarvis costs,
  not whether that figure holds for eight hours.
- **GPU.** Nothing here uses one — inference is CPU-only int8 on this machine, so
  there is no GPU figure to report rather than an unmeasured one.
- **Barge-in cut-off time** — how long audio keeps playing after the interrupt.
  Correctness is covered by `tests/runtime-voice.test.ts`; the duration is not.
