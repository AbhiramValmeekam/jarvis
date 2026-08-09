# Jarvis — Implementation Plan

Phase N is complete only when its functionality **actually runs and is verified**.
Scaffolding is not completion. Status is updated from real test output.

---

## Phase 0 — Analysis ✅ COMPLETE

- [x] Environment verified: Windows 11 (26200), Node 24.18.0, npm 11.16.0, git 2.52.0,
      Python 3.11.15, Claude Code 2.1.222, uv 0.11.28
- [x] Hermes Agent inspected from source *and* from the live install (v0.18.2)
- [x] jarvis-demo inspected (`f79e0fb`)
- [x] `HERMES_ANALYSIS.md`, `JARVIS_DEMO_ANALYSIS.md`, `ARCHITECTURE.md`,
      `SECURITY_MODEL.md`, `IMPLEMENTATION_PLAN.md` written
- [x] Project structure established on `E:\jarvis`

**Key finding:** ~16 s to first token through Hermes. Local-first routing is a hard
requirement, not an optimisation.

---

## Phase 1 — Hermes integration ✅ COMPLETE

- [x] Hermes verified running (`hermes -z` → `HERMES_OK`)
- [x] ACP transport implemented (line-delimited JSON-RPC 2.0, bidirectional)
- [x] Executable resolver — no `shell: true` (handshake 5,004 ms → 1,368 ms)
- [x] `HermesAdapter`: start/stop/healthCheck/createSession/resumeSession/listSessions/
      streamMessage/sendMessage/cancel
- [x] Permission callback wired, **deny-by-default**
- [x] 12 unit tests passing; typecheck clean
- [x] **Live proof:** `npm run probe:hermes` → handshake → session → streamed tokens →
      clean shutdown against real Hermes v0.18.2

Deferred to later phases (deliberately, not silently): memory/skills/subagent/cron
wrappers land with the phases that consume them, via the `hermes serve` REST side channel.

---

## Phase 2 — Desktop core ✅ COMPLETE

- [x] Headless runtime process, independent of UI
- [x] IPC server (named pipe) + typed contract, authenticated with a per-run token
- [x] Hermes supervisor: health check, **bounded** restart with backoff, no crash loops
- [x] State machine (§6 of ARCHITECTURE.md)
- [x] System tray with all documented states
- [x] Start-with-Windows (HKCU Run key, no admin required), start minimised
- [x] Close window ≠ quit; only tray Quit stops the runtime
- [x] Sleep / resume / lock / unlock handling
- [x] Electron + React + TS + Vite + Tailwind shell
- [x] 175 unit tests passing; both typechecks clean

**Live proof:**

| Probe | Proves |
|---|---|
| `npm run probe:supervisor` | real `taskkill /f` on Hermes → respawn (pid 12884 → 26616), new session, agent answers `RECOVERED_OK` |
| `npm run probe:runtime` | runtime outlives UI attach/detach; real agent turn over IPC (`RUNTIME_OK`, 15,710 ms); second instance refused; quit revokes the token |
| `npm run probe:shell` | real Electron shell starts a runtime, **shell killed → runtime and Hermes both keep running**, a fresh shell reattaches to the *same* runtime, autostart not silently enabled |
| `scripts/shot-renderer.mjs` | the HUD actually renders — offline, listening, thinking and muted states captured to PNG |

**Gate: MET.** Runtime survives UI close (probe:runtime), a real Hermes kill
(probe:supervisor), an outright shell kill (probe:shell), and a suspend/resume
cycle (`supervisor.suspend()/resume()`, covered by unit tests).

### Two honest caveats

- **Start-with-Windows is not on by default yet.** The spec asks for default ON,
  but a dev run has no stable executable to register — the Run key would point at
  `node_modules/electron/dist/electron.exe` and break on the next reinstall. The
  tray toggle is live and works; enabling it by default belongs with the
  installer in Phase 12, where a real install path exists.
- **`taskkill /t` on the shell also stops the runtime.** `/t` walks the process
  tree, and the runtime is spawned as a (detached) child. A crash kills one
  process and the runtime survives — that is what `probe:shell` verifies. An
  explicit tree kill, or Task Manager's "End task", is a deliberate
  stop-everything action and is treated as one.

**Not built in this phase (and reported as such by the runtime):** wake word,
STT and TTS all returned `{state: "unavailable", detail: "not implemented yet
(Phase 3)"}`, and the HUD said "Voice is not wired up yet" rather than showing a
microphone that did nothing. *Superseded by Phase 3 below, which replaced these
with a real engine; the HUD now reports actual capture state.*

---

## Phase 3 — Voice ✅

- [x] Wake-word provider interface; engine evaluated on measured CPU, not assumption
      — openWakeWord, 3.5 ms p95 inference per 80 ms frame (`docs/PERFORMANCE.md`)
- [x] VAD (speech start/end/interruption) — Silero via `openwakeword.vad`, 20 ms frames
- [x] Local STT provider (faster-whisper), configurable model
- [x] Local TTS provider (Piper default), interruptible
- [x] Barge-in — speech during playback stops it at the frame
- [x] Conversation mode (30 s default)
- [x] Push-to-talk — `push_to_talk` over IPC, hold semantics not toggle

The engine runs as a supervised Python sidecar (`voice/daemon.py`) speaking
line-delimited JSON, not in-process: the audio stack is CPython-native, and a
mic-driver crash must not take the runtime with it. Restart policy and
suspend/resume are the same bounded supervisor Hermes gets.

**Gate: met.** `npm run probe:voice` measures wake→ack against a replayed WAV
fixture, so the zero point is the exact audio frame the models saw rather than a
wall clock. **Median 3.4 ms** (min 2.6, max 3.5) against a 100–300 ms target;
runtime overhead 0.0–0.1 ms. Published with what it excludes in
`docs/PERFORMANCE.md`, including the fixed 80 ms of openWakeWord lookahead that
makes the user-perceived figure ≈83 ms, and a list of four things still
unmeasured.

---

## Phase 4 — Local commands ◻

- [ ] `LocalIntentEngine` with confidence scoring and a Hermes fallback threshold
- [ ] App launch, volume, mute, screenshot, lock, battery, CPU/RAM, time
- [ ] Path safety (canonicalisation + allow-list)
- [ ] Fully functional with networking disabled

**Gate:** every listed command works offline, without Hermes running.

---

## Phase 5 — Hermes computer control + permissions ◻

- [ ] Risk classifier (levels 0–4)
- [ ] Action preview UI + scoped consent
- [ ] Observe → Act → Verify wrapper
- [ ] Undo history (Recycle Bin, not permanent delete)
- [ ] Audit log + Activity view

## Phase 6 — Context ◻
Active app/window, project registry, conversation context, on-request screen capture.

## Phase 7 — Claude Code ◻
`ClaudeCodeManager` using the verified headless contract
(`-p --output-format json --resume <id> -- <text>`), async background tasks, status
streaming, test verification. Jarvis stays responsive while a build runs.

## Phase 8 — Memory + skills ◻
Hermes memory/skills via REST; Jarvis memory UI; project aliases; secret redaction filter.

## Phase 9 — Tasks + automation ◻
Hermes cron/subagents, notifications, proactive assistant (default MINIMAL).

## Phase 10 — MCP ◻
Server management, per-tool permissions, relevance-based tool selection.

## Phase 11 — UI polish ◻
Orb states, HUD, activity timeline, Command Center.

## Phase 12 — Hardening ◻
Prompt-injection tests, permission tests, performance, sleep/resume, crash recovery,
offline mode, installer, Windows startup, acceptance tests §62–§72.

---

## Open actions

| # | Action | Why |
|---|---|---|
| 1 | Configure a faster interactive model for Hermes | ~16 s to first token on `tencent/hy3:free` is unusable conversationally |
| 2 | `gh auth login` (optional) | The `gh` CLI token is invalid. `git push` works fine via Git Credential Manager; only `gh`-based operations (PRs, issues) are affected |
