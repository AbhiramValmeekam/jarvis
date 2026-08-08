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

## Phase 2 — Desktop core ◻ NEXT

- [ ] Headless runtime process, independent of UI
- [ ] IPC server (named pipe) + typed contract
- [ ] Hermes supervisor: health check, **bounded** restart with backoff, no crash loops
- [ ] State machine (§6 of ARCHITECTURE.md)
- [ ] System tray with all documented states
- [ ] Start-with-Windows (default ON), start minimised
- [ ] Close window ≠ quit; only tray Quit stops the runtime
- [ ] Sleep / resume / lock / unlock handling
- [ ] Electron + React + TS + Vite + Tailwind shell

**Gate:** runtime survives UI close, Hermes kill, and a sleep/resume cycle.

---

## Phase 3 — Voice ◻

- [ ] Wake-word provider interface; engine evaluated on measured CPU, not assumption
- [ ] VAD (speech start/end/interruption)
- [ ] Local STT provider (faster-whisper / whisper.cpp), configurable model
- [ ] Local TTS provider (Piper default), interruptible
- [ ] Barge-in
- [ ] Conversation mode (30 s default)
- [ ] Push-to-talk

**Gate:** measured wake→ack latency written to `PERFORMANCE.md`. Target 100–300 ms;
the real number gets published whether or not it hits the target.

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
