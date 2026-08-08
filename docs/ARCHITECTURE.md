# Jarvis — Architecture

Every decision here is traceable to a measurement in `HERMES_ANALYSIS.md` or a constraint
in `SECURITY_MODEL.md`. Where something is not built yet, it says so.

## 1. The governing constraint

Measured on this machine: **~16 s from prompt to first token** through Hermes.
Target for wake acknowledgement: **100–300 ms**.

That is a ~50× gap, so it cannot be closed by tuning. It is closed by **routing**: the
overwhelming majority of interactions must never reach Hermes at all.

```
                        USER says "Jarvis"
                               │
                    ┌──────────┴──────────┐
                    │  LOCAL WAKE WORD    │  no network, no Hermes
                    └──────────┬──────────┘
                               │  ack in <300ms (tone or "Yes?")
                    ┌──────────┴──────────┐
                    │  VAD → LOCAL STT    │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │ LOCAL INTENT ENGINE │
                    └──────┬───────┬──────┘
              high conf    │       │   low conf / complex
                           ▼       ▼
                  ┌─────────────┐  ┌──────────────────────┐
                  │ LOCAL TOOLS │  │ HERMES (via ACP)     │
                  │  <100ms     │  │  seconds — say so    │
                  └─────────────┘  └──────────┬───────────┘
                                              │
                              memory · skills · subagents · MCP · cron
                                              │
                                   ┌──────────┴──────────┐
                                   │ JARVIS PERMISSION   │
                                   │ (session/request_   │
                                   │  permission hook)   │
                                   └──────────┬──────────┘
                                              │
                        ┌─────────────┬───────┴──────┬─────────────┐
                        ▼             ▼              ▼             ▼
                    WINDOWS       BROWSER       TERMINAL     CLAUDE CODE
                                                              (coding)
```

## 2. Process model

The UI is **not** the assistant. Three process groups:

| Process | Lifetime | Contents |
|---|---|---|
| **Jarvis Runtime** (headless Node) | Windows login → logout | supervisor, wake word, VAD, STT, TTS, intent engine, permissions, context, scheduler bridge, IPC server, tray |
| **Hermes** (`hermes acp` child) | on demand, supervised | the agent brain |
| **Jarvis UI** (Electron) | user-controlled | HUD, Command Center — a *client* of the runtime |

Closing the window stops the UI only. Quitting from the tray stops the runtime.
Hermes is a child of the runtime, so it can never outlive it or be orphaned.

## 3. Layering — and the one rule

```
src/
  hermes/        HermesAdapter + ACP transport   ← the ONLY code that knows Hermes exists
  voice/         wake word, VAD, STT, TTS
  local-intents/ deterministic command handling
  permissions/   risk classification + user consent
  context/       active window, project registry
  coding/        ClaudeCodeManager
  system/        Windows tools (open, volume, battery, screenshot)
  notifications/ Windows toasts
  integrations/  MCP / external
  ui/            IPC contract shared with Electron
```

**Rule:** nothing outside `src/hermes/` imports the ACP protocol or spawns `hermes`.
Upstream is moving fast — the installed ACP server already differs from GitHub HEAD by
445 lines — so the blast radius of that churn is exactly one directory.

## 4. Transport decision

ACP (JSON-RPC 2.0 over stdio via `hermes acp`) over the two alternatives:

- **Rejected `hermes serve` for conversation** — its interactive chat paths (`/api/console`,
  `/api/pty`) go through `pty_bridge.py`, which is POSIX-only and `ImportError`s on native
  Windows. It *will* be used later as a read-only side channel for skills/cron/memory/MCP,
  which are plain Windows-safe JSON routes.
- **Rejected `hermes -z`** — no streaming, full process start per call.

ACP additionally gives session lifecycle, cancellation, and a **permission callback** in
one protocol, with no port to bind and no auth to manage.

## 5. Implemented so far (Phase 1)

`src/hermes/acp-protocol.ts` — bidirectional line-delimited JSON-RPC peer.
Handles split chunks, batched lines, out-of-order responses, inbound agent requests, and
non-JSON stdout noise. 12 unit tests.

`src/hermes/resolve-hermes.ts` — resolves the real `hermes` executable
(env override → known install path → PATH). Avoids `shell: true`; this alone cut handshake
time from **5,004 ms → 1,368 ms** and removed Node's DEP0190 arg-injection warning.

`src/hermes/hermes-adapter.ts` — `start`, `stop`, `healthCheck`, `createSession`,
`resumeSession`, `listSessions`, `streamMessage`, `sendMessage`, `cancel`.
Permission requests are **deny-by-default** when no handler is wired.

Proven live by `scripts/probe-hermes.ts`: handshake → session → streamed tokens → clean
shutdown, against real Hermes v0.18.2.

## 6. State machine

`IDLE → WAKE_DETECTED → LISTENING → UNDERSTANDING → (LOCAL_ACTION | THINKING) → EXECUTING → SPEAKING → CONVERSATION → IDLE`

`CONVERSATION` holds for 30 s (configurable) so follow-ups need no wake word. Any state
can be interrupted into `LISTENING` by barge-in.

Per jarvis-demo's lesson: **`SPEAKING` ends when playback ends, not when audio is sent** —
the audio consumer owns that transition, otherwise the state races the sound.

## 7. Idle budget

Always-available ≠ always-inferring. Idle should hold only: tray, wake-word detector,
scheduler timer, IPC server, small context state. Hermes is **not** kept warm for
inference; no screenshots, no vision, no browser, no Claude Code.

Real measurements go in `docs/PERFORMANCE.md` once Phase 3 lands. No targets will be
claimed as achieved without numbers.

## 8. Open decisions

| Decision | Status |
|---|---|
| Wake-word engine | Not chosen. Requires offline, low-CPU, Windows, tunable sensitivity. To be evaluated in Phase 3 against real CPU measurements |
| STT model | Likely faster-whisper small/distil; must be benchmarked, not assumed |
| TTS | Piper local default; cloud optional and off by default |
| Interactive model for Hermes | **Action required** — `tencent/hy3:free` at ~16 s to first token is too slow for anything conversational |
