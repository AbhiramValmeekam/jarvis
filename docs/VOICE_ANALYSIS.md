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

### 2.1 "Jarvis" alone, not just "Hey Jarvis"

The bundled model is named `hey_jarvis`, and the obvious assumption is that the
"hey" is load-bearing. Measured, it is not:

| Clip | Peak score | Result |
|---|---|---|
| "jarvis" | **0.988** | fired |
| "jarvis, what time is it" | **0.986** | fired |
| "travis, what time is it" | 0.028 | correctly silent |
| "the service is running" | 0.000 | correctly silent |

So the bare name is supported by lowering nothing: it is already 0.988 against a
0.5 threshold, and the words that rhyme with it are still two orders of
magnitude below. There is no `jarvis_v0.1.onnx` to install and none is needed.

What the bare name *does* cost is margin on a sloppy delivery. A hurried
"javis" scores ~0.23 — under the threshold, and a threshold low enough to catch
it would also catch "travis". Rather than lower the bar, a **soft band** sits
below it: 0.25–0.5 records provisionally, without announcing anything, and the
recording is only promoted to a wake if the transcript's first word really is
the name (`match_wake_name`, one edit's tolerance, must still start with a `j`).
Below 0.25 nothing happens at all. A false positive therefore costs one whisper
pass and produces no orb, no acknowledgement, and no event.

**One trap worth recording, because it cost 80 ms and was invisible.** The soft
band means an ordinary "Hey Jarvis" is normally *promoted*: the score crosses
0.25 a frame before it crosses 0.5, so the wake is announced from the promotion
path rather than the direct one. openWakeWord's `reset()` — called after a wake
so the same utterance cannot fire twice — re-primes its feature buffer by
running embeddings over four seconds of random noise, and that costs **76 ms
measured**. With the reset ahead of the emit, every real wake announced itself
80 ms late and `probe:voice` went from 3.4 ms to 73 ms. The event now goes out
first, as it already did on the direct path. `.research/marklag.py` attributes
it; the same measurement clears the gain stage of any part in it.

### 2.2 The VAD, not the wake word, was what broke voice on this machine

This is the reported bug — "Hey Jarvis" lights the orb and then nothing happens —
and the wake word was never the component at fault.

`Microphone Array (AMD Audio Device)`, the only input this box has, delivers a
normal speaking voice at a **peak frame RMS of ~0.007**. That is not a guess:
the runtime's own silence watch reported 0.0068 as the loudest frame in a 60 s
window, against the 0.002 floor it uses to decide a line is dead. The SAPI
fixtures above sit at 0.14–0.22, i.e. 20–30× hotter, which is why every
fixture-based measurement in this document looked healthy.

openWakeWord does not care — it scores 0.998 on a clip attenuated to any of
these levels. **silero VAD cares enormously, and not in a way a single-clip
test reveals**, because it is an RNN: at this level its verdict depends on what
it heard in the previous few seconds. Same 35-frame clip, same level, speech
frames counted:

| Peak RMS | After idle room tone | After hearing the acknowledgement through the speakers |
|---|---|---|
| 0.007 | 33 | **9** |
| 0.004 | 34 | **5** |
| 0.003 | 34 | **1** |
| 0.0015 | 35 | **0** |

The right-hand column is the live sequence. §5.3 explains that there is no
acoustic echo cancellation here, so when Jarvis says "Yes?" the microphone hears
it; that audio is the loudest thing this input ever receives, and it leaves the
VAD unable to call this microphone's speech speech for seconds afterwards.
`saw_speech` never goes true, the recording waits out the whole wake timeout,
and the utterance is discarded untranscribed.

The user's log shows exactly that, twice: wake at 13:34:09.077 → idle at
13:34:18.073 is **8.996 s against a 6 s timeout**. The extra ~3 s is `ack_ms`,
the gated window while the acknowledgement played — which is itself proof the
acknowledgement fired, i.e. that the VAD was already reporting silence at the
480 ms mark. No `understanding` state appeared either time. A typed request one
minute later went `understanding → local_action → conversation` normally, which
is why text worked and voice did not.

**Fix: a capture gain stage, calibrated on the user's voice only.** A 90th
percentile over a 10 s window, aiming at 0.08 peak RMS, capped at 24× and
re-scaled per frame to stay below clipping. The one non-obvious requirement is
that frames arriving while Jarvis is speaking must be *amplified but not
calibrated on* — this was predicted before it was measured and then confirmed:

| | Speech frames recovered (of 35) | Command delivered at |
|---|---|---|
| No gain | 9 / 5 / 1 / 0 | 0.007–0.0015 |
| Gain calibrated on everything | 12 / 5 / 4 / 0 | — |
| **Gain that skips Jarvis' own voice** | **20 / 17 / 22 / 19** | **0.038–0.084** |

Letting the acknowledgement into the percentile window drives the gain estimate
back toward 1.0 in precisely the case that needs it, so the naive version is
worth almost nothing. Reproduce with `.research/vadcheck.py`; the three
assertions in `--selftest` pin the same sequence.

### 2.3 Whisper does not return "" for silence

A related finding, from the same investigation. When the VAD marginally trips on
room tone and hands whisper ~1.3 s of non-speech, whisper does not answer with
an empty string — it answers with punctuation. Measured on the tail of
`hey_jarvis.wav`: `'//'`.

That is not harmless. A non-empty transcript is a request: it misses the local
intents, goes to the agent, and is answered out loud, so the user gets a reply
to something they never said. `has_words` gates it, and asks only whether the
transcript contains a letter or a digit anywhere — deliberately *not* a list of
whisper's favourite hallucinations, since "Thank you." is both one of those and
a thing a person says.

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
`tiny.en`, while `small.en` costs a second per utterance. Configurable via
`sttModel` in `jarvis.config.json`, because the right answer depends on the
microphone and the speaker; on a quiet input like §2.2's, `small.en` is the
single cheapest accuracy upgrade available.

**Load time is the real constraint, not inference.** 12 s to load means the
model must be resident in a long-lived process. This is the single strongest
argument for the sidecar being a daemon rather than a per-utterance script.

The transcribe column is the least stable number in this document, and
`PERFORMANCE.md`'s STT row says why: the same `base.en` call on the same clip
measures 488 ms with an idle machine and 550 ms with the packaged always-on
instance resident. Read it as "which model is cheaper", which is what it was
measured to answer, not as a millisecond figure to quote.

### 3.1 Decoder options, chosen on a degraded fixture rather than a clean one

The table above hides the problem: on clean 0.14-RMS speech every option
combination is correct, so nothing about it can guide a choice. Re-measured on
the fixture attenuated to this microphone's real level (§2.2) and mixed to 12 dB
SNR, "hey jarvis, what time is it" came back as:

| Options | Transcript |
|---|---|
| `beam_size=1`, no prompt, no filter | `'age-arvis, what time is it?'` |
| current defaults | `'Hey Jarvis. What time is it?'` |

Four changes, each for its own reason:

- **Peak-normalise the utterance first.** Distinct from the capture gain of
  §2.2: that one exists to make the VAD's *real-time* decision correct and is
  deliberately slow to move, while this sees a finished utterance, knows its
  true peak, and can be exact. Skipped entirely below a peak of 0.0005 —
  multiplying digital silence by 32 produces amplified dither, and whisper will
  confidently transcribe words out of it.
- **`beam_size=5`** (~20 ms on `base.en`). The name is the one word here that
  has to survive a bad microphone, and greedy decoding is where it dies.
- **`initial_prompt="Jarvis."`** — spelling, not instruction. It biases the
  decoder toward the word it will hear most often.
- **`condition_on_previous_text=False`.** Each utterance is independent; left
  on, whisper continues a sentence the user never started.
- **`vad_filter=True`**, with a retry without it when the result is empty. The
  filter is what stops "Thank you." appearing over a tail of room tone, but it
  can also swallow a whole quiet utterance — so one extra pass on the rare empty
  case is preferred to dropping what the user said. See §2.3 for the case where
  it returns something non-empty and still wrong.


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
