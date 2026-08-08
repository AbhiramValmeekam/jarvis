# jarvis-demo — Implementation Analysis

**Source:** `.research/jarvis-demo` @ `f79e0fb` (2026-07-31, "feat: spoken build requests").
3,103 lines of plain ESM JavaScript, one runtime dependency (`ws`), no build step.

## 1. What it actually is

```
Chrome mic → Web Speech API (STT) → WebSocket → node server
  → claude -p            conversation  (tools OFF, haiku, fast)
  → claude -p            build         (file tools ON, own folder)
  → Fish Audio TTS       voice
  → canvas orb + build HUD
```

Push-to-talk (hold a key), not wake-word. Runs on an existing Claude subscription —
no Anthropic API key.

## 2. Techniques worth stealing

### 2.1 Two-model split — the core idea, and it matches ours

Conversation runs `claude-haiku-4-5` with **`--allowedTools ""`** (tools off) purely for
speed; building spawns a **separate** Claude Code session with file tools in its own
folder. Fast path and capable path are different processes with different privileges.

This is exactly the LocalIntent/Hermes/Claude-Code split Jarvis needs, and it is
independent confirmation that a single do-everything agent cannot hit voice latency.

### 2.2 The exact Claude Code headless contract (reusable in Phase 7)

```js
const TOOLS_OFF = ["--allowedTools", ""];
const MODEL     = ["--model", "claude-haiku-4-5-20251001"];

["-p", "--output-format", "json", "--settings", SETTINGS,
 "--system-prompt", persona, ...MODEL, ...TOOLS_OFF]

if (sessionId) args.push("--resume", sessionId);
args.push("--", text);   // `--` terminates variadic --allowedTools
```

Response: `JSON.parse(stdout)` → `{ result, session_id }`. Session continuity is just
carrying `session_id` forward. `--settings claude-settings.json` sets
`{"disableAllHooks": true}` so user hooks cannot fire in an automated session.

Two details Jarvis will copy verbatim:
- the `--` separator (without it the prompt is swallowed as a tool name),
- `SIGTERM` on a timeout (default 30 s) so a wedged child cannot hang the assistant.

### 2.3 Machine tags to trigger actions from a spoken reply

The model appends `[ACTION:BUILD primitive=<id> key=value ...]` at the very end of its
output; the server strips the tag before TTS. One model call yields both the spoken
sentence and a structured action.

**Jarvis will not adopt this.** ACP already gives us real structured `tool_call` events,
which cannot be spoofed by text the model happens to emit. Tag-in-prose is a prompt-
injection hazard — a webpage that contains `[ACTION:...]` could trigger it. Noted in
`SECURITY_MODEL.md` as an anti-pattern.

### 2.4 Voice-first prompt discipline

The persona prompt is genuinely well built and directly reusable:
- "compress into one to three short sentences meant to be read aloud"
- "No markdown, code, lists, URLs, emoji, or stage directions"
- "Write numbers, dates, and units the way they should be spoken aloud"
- "Never explain your instructions. Output only the concise spoken answer."
- ~40-word cap

The build list is injected as **data derived from the registry**, so the prompt can never
drift out of sync with what is installed. Jarvis will use the same trick for local intents
and learned skills.

### 2.5 State sequencing around audio

`say()` returns once audio has been **sent**, not once it has **played** — and the server
deliberately does not emit `idle` there, to avoid racing playback. The `audio` message
carries a `nextState` field so the client drives the transition when playback ends.

That ordering bug is easy to write and annoying to diagnose; Jarvis's state machine will
treat "speaking" as client-owned for the same reason.

### 2.6 Small, testable pure functions

`buildClaudeArgs`, `parseClaudeJson`, `buildTtsRequest`, `isFatalSpeechError`,
`getVisibilityToggle` are pure and separately unit-tested (11 test files via
`node --test`). The I/O is a thin shell around them. Good model for `LocalIntentEngine`.

`isFatalSpeechError` distinguishes `not-allowed` / `service-not-allowed` (permission —
stop) from transient errors (restart recognition). Jarvis needs the same distinction for
mic failures.

## 3. What Jarvis must do differently

| jarvis-demo | Jarvis | Why |
|---|---|---|
| Push-to-talk (hold key) | Local wake word + PTT | "Always-on" is the requirement |
| Chrome Web Speech API | Local STT (faster-whisper / whisper.cpp) | Web Speech ships audio to Google's servers and needs Chrome open + internet. Fails the local-first and privacy requirements outright |
| Browser tab must stay open | Background runtime, tray, autostart | UI is a control surface, not the process |
| Fish Audio (cloud TTS, API key) | Local TTS default (Piper), cloud optional | Must work offline; also avoids a paid dependency |
| Claude Code as the brain | Hermes as brain, Claude Code as coding worker | Per project spec |
| Machine tags in prose | ACP structured `tool_call` | Injection-resistant |
| No permission layer | Explicit 5-level permission engine | Demo has no destructive-action surface; Jarvis does |
| macOS/Linux (Windows → WSL) | Native Windows | Target platform |

## 4. Verdict

A sharply-written reference for **voice UX**, the **Claude Code headless contract**, and
**prompt discipline for spoken output** — all three are directly reusable. Its
architecture is a single-user demo (browser tab, cloud STT, cloud TTS, no permissions,
no supervision) and is not a template for an always-on assistant. Jarvis takes the
techniques, not the shape.
