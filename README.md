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

## Layout

```
src/hermes/        HermesAdapter + ACP transport — the only code coupled to Hermes
src/voice/         wake word, VAD, STT, TTS            (Phase 3)
src/local-intents/ deterministic fast path             (Phase 4)
src/permissions/   risk classification + consent       (Phase 5)
src/context/       active window, project registry     (Phase 6)
src/coding/        ClaudeCodeManager                   (Phase 7)
apps/runtime/      headless always-on runtime          (Phase 2)
apps/desktop/      Electron HUD                        (Phase 2/11)
```
