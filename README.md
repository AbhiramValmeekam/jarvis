# Jarvis

An always-on, local-first personal AI assistant for Windows, built on
[Hermes Agent](https://github.com/NousResearch/hermes-agent).

**Status: Phase 1 of 12 complete.** Hermes integration is live and verified.
See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for exactly what works
and what does not — nothing here is claimed as done unless it has been run.

## The idea

Turn on laptop → Jarvis exists. Say "Jarvis" → it responds. Ask → it understands.
Tell it to do something → it acts, verifies, and reports back.

Always *available*, not always burning CPU on inference.

## Architecture in one line

```
wake word (local) → VAD → STT (local) → intent router
    ├── simple  → local deterministic action        (<100ms)
    └── complex → Hermes Agent via ACP → tools / subagents / Claude Code
```

The routing exists because it has to: measured latency through Hermes on this machine is
**~16 s to first token**, against a **100–300 ms** target for wake acknowledgement.
Full reasoning in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Docs

| Doc | Contents |
|---|---|
| [HERMES_ANALYSIS.md](docs/HERMES_ANALYSIS.md) | Hermes's real interfaces, verified against a live v0.18.2 install |
| [JARVIS_DEMO_ANALYSIS.md](docs/JARVIS_DEMO_ANALYSIS.md) | What to reuse from jarvis-demo, and what not to |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, layering, state machine |
| [SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Permission levels, prompt-injection stance, threat table |
| [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phase-by-phase status |

## Requirements

- Windows 11 · Node ≥ 22 · Python 3.11
- [Hermes Agent](https://hermes-agent.nousresearch.com/) installed
  (`iex (irm https://hermes-agent.nousresearch.com/install.ps1)`)
- Claude Code (for the Phase 7 coding worker)

## Verify the Hermes link

```bash
npm install
npm run probe:hermes     # real agent turn: handshake → session → streamed reply
npm test                 # protocol unit tests
```

`probe:hermes` prints measured handshake, first-token, and total-turn latency.

Every phase has a probe that runs its code against real Windows rather than fixtures,
because unit tests over a fake shell prove the parsing and say nothing about whether
the PowerShell is right. `npm run probe:context` covers Phase 6 (45 checks) and takes
no screenshot: it stubs the display and proves the consent policy. `npm run probe:tasks`
(Phase 9, 14 checks) reads the real Hermes cron directory, cross-checks the scheduler
verdict against `hermes cron status`, and fingerprints the directory before and after a
full Jarvis run — read-only proven by observation, and it is safe to run with a Jarvis
already running, because it never binds the IPC pipe or publishes the runtime token.
`npm run probe:mcp` (Phase 10, 17 checks) does the same for Hermes' `config.yaml`:
cross-checks the server count against `hermes mcp list`, fingerprints the file by size,
mtime *and* content hash across a full run, and greps a serialised IPC view to prove no
env value or URL token ever reaches the wire. It also re-asserts, against Hermes' own
source, that ACP's `mcpServers` parameter is additive — so if a future version makes it
subtractive, the probe fails and the docs get corrected instead of quietly going stale.

Two probes cost something and therefore ask first, and neither is part of
`npm run verify`: `npm run probe:capture` touches your screen, and
`npm run probe:coding` spends a few cents delegating a real task to Claude Code in a
throwaway git repository under `%TEMP%` (deleted afterwards). Use
`npm run probe:coding:offline` for the contract half with nothing spawned. That probe
is why `src/coding/resolve-npm.ts` exists: on its first live run the verification step
died with `spawn EINVAL`, because `npm` on Windows is a batch shim Node will not spawn
directly — every finished task was being reported as a broken build, and the unit tests
could not see it because they inject the runner.

## Layout

```
src/hermes/        HermesAdapter + ACP transport — the only code coupled to Hermes
src/ipc/           named-pipe protocol, token auth      (Phase 2)
src/runtime/       headless always-on runtime           (Phase 2)
src/desktop/       Electron shell, tray, preload bridge (Phase 2/11)
src/voice/         wake word, VAD, STT, TTS             (Phase 3)
src/local-intents/ deterministic fast path              (Phase 4)
src/system/        Windows integration, autostart        (Phase 4)
src/permissions/   risk classification + consent        (Phase 5)
src/context/       window, projects, screen capture     (Phase 6)
src/coding/        delegation + independent work check  (Phase 7)
src/memory/        Jarvis' own store + skill catalog    (Phase 8)
src/tasks/         read-only view of Hermes' cron       (Phase 9)
src/notifications/ what deserves to interrupt you       (Phase 9)
src/mcp/           read-only view of Hermes' MCP config (Phase 10)
src/ui/            HUD components                       (Phase 2/11)
```
