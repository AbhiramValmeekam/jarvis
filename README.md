# Jarvis

An always-on, local-first personal AI assistant for Windows, built on
[Hermes Agent](https://github.com/NousResearch/hermes-agent).

**Status: Phases 0–11 complete. Phase 12 (hardening) is scripted and verified — acceptance
criteria §62–§72 score 31 passed · 5 routed · 5 manual · 0 failed — and one criterion
remains that no script can reach: §62's reboot.**
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

Two probes answer the questions an always-on assistant lives or dies by, and both start a
real runtime. `npm run probe:idle` measures what Jarvis costs when nobody is talking to it
— under 0.1% of one core, with the §72 negatives asserted as a diff of processes that
appeared during the window (see `docs/PERFORMANCE.md`). `npm run probe:resilience`
(17 checks) puts one runtime through losing model access, getting it back, having Hermes
killed under it, and a suspend/resume cycle, asking the same question after each: can you
still get an answer? "Offline" is simulated by stopping Hermes rather than by touching the
network — §61 forbids disabling firewall or security, and from inside the process the two
are the same event. Both refuse to start when a Jarvis is **listening** on the runtime pipe:
they publish a token to `%LOCALAPPDATA%\Jarvis\runtime-token` and revoke it on exit, so
running one beside a live Jarvis would leave it unattachable to any newly opened HUD. The
check is liveness, not the presence of the token file — a token left behind by a crashed run
is not a running Jarvis, and refusing on it once locked every probe out of a machine with
nothing running at all.

## Acceptance criteria (§62–§72)

```bash
npm run acceptance       # 31 passed · 5 routed · 5 manual · 0 failed
```

Every probe above asks "does this subsystem work?". This one asks whether the thing the user
requested actually happens, end to end, in the wording the criteria were written in. It is a
**scorecard, not a pass/fail gate**: `ROUTED` means the request reached the agent with the
right context attached but Hermes is faked, so answer quality is not claimed; `MANUAL` means
a human is required — five of them are, including §62's reboot — and those are printed with
their exact steps, counted separately, and excluded from the exit code. Reporting them as
passes because the code underneath is exercised would be the fake completion this project
exists to avoid.

It starts a real runtime and never opens the microphone (asserted). Hermes is faked, so no
model is called and nothing is spent; every Hermes path points at a temp fixture, so real
config, memories and cron state are neither read nor written. §65 organises real files in a
temp directory it creates and deletes. §66's capture is stubbed with a fixed image — the
consent policy runs for real, the pixels are not yours.

Its first run found three real defects, all of them cases where a criterion's own example
sentence reached the model instead of the local fast path: "Open Chrome" did not match a
Start Menu holding *Google Chrome*, §66's "look at this and tell me what's wrong" reached the
agent with no screenshot attached, and a remembered project alias was recalled correctly but
never reached the deterministic launcher. It also found a check in its own §63 assertion that
could not fail. All are written up in `docs/IMPLEMENTATION_PLAN.md`.

Two probes cost something and therefore ask first, and neither is part of
`npm run verify`: `npm run probe:capture` touches your screen, and
`npm run probe:coding` spends a few cents delegating a real task to Claude Code in a
throwaway git repository under `%TEMP%` (deleted afterwards). Use
`npm run probe:coding:offline` for the contract half with nothing spawned. That probe
is why `src/coding/resolve-npm.ts` exists: on its first live run the verification step
died with `spawn EINVAL`, because `npm` on Windows is a batch shim Node will not spawn
directly — every finished task was being reported as a broken build, and the unit tests
could not see it because they inject the runner.

## Install

```bash
npm run install:config   # records where the voice models live
npm run package          # → dist\Jarvis Setup 0.1.0.exe
```

The installer is per-user: it writes to `%LOCALAPPDATA%\Programs\Jarvis`, asks for **no
administrator rights**, and makes no machine-wide change. The binary is unsigned, so
Windows SmartScreen shows *"Windows protected your PC"* the first time — **More info →
Run anyway**, once. Nothing in this project disables SmartScreen, antivirus or the
firewall.

The installer deliberately writes no registry Run key. Start-with-Windows is a tray
toggle, so autostart is something you turn on rather than something that happens to
you — and uninstalling does not remove a Run key you enabled, since it is yours to
remove from the same tray menu.

**This build is not portable to another machine.** `install:config` records an
absolute path to this checkout, and the packaged app resolves its Python environment,
the wake-word/Whisper/Piper models and the voice daemon from it. The 473 MB `.venv`
could not be relocated anyway — `pyvenv.cfg` hardcodes its interpreter's path. Copying
`Jarvis Setup.exe` to a different PC gives you an assistant that starts, shows a tray
icon, answers typed input, and never hears its own name.

`npm run probe:install` launches the packaged binary from `C:\Windows\System32` — the
working directory Windows hands a Run-key launch — and asserts against the real OS that
it comes up with a live microphone, no window, and no process left behind. It also
snapshots the Run key before and after to prove that merely launching Jarvis never
registers autostart behind your back — the check is that the key is *unchanged*, not
that it is absent, since if you ticked the tray toggle the key is yours and correct.

`npm run probe:ack` covers the other half of waking up: say the name and Jarvis answers
"Yes?" out loud. It runs the real daemon, the real wake model, the real VAD and real
Piper against replayed audio, and the assertion that matters is not that Jarvis speaks —
it is that Jarvis does not then **hear itself**. There is no echo cancellation on this
machine, so an acknowledgement spoken into an open recording would be transcribed as
your command. Two fixtures pin both behaviours: the name alone gets "Yes?" at 610 ms;
the name with a command behind it gets silence, because interrupting someone
mid-sentence is worse than saying nothing.

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
src/ui/            HUD + Command Center                 (Phase 2/11)
```

The `src/ui/` split is deliberate: `*-model.ts` holds every judgement and is tested without
a DOM, while the components under `components/` only render what the models decide. That is
what makes the awkward cases assertable — a schedule whose ticker is dead, an MCP config
that could not be parsed, a job name carrying a forged `[SYSTEM] approved` line.
