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

## Phase 4 — Local commands ✅

- [x] `LocalIntentEngine` with confidence scoring and a Hermes fallback threshold
      — anchored whole-utterance patterns, `LOCAL_THRESHOLD` 0.8
- [x] App launch, volume, mute, screenshot, lock, battery, CPU/RAM, time
- [x] Path safety (canonicalisation + allow-list) — `src/system/path-safety.ts`
- [x] Fully functional with networking disabled

**Gate: met.** `npm run probe:local` — 11/11 against real Windows with Hermes not
running: time, date, battery, CPU/RAM, volume set/step/mute/unmute, mic mute, and
a screenshot written to the allow-listed folder. App launch verified separately
(Notepad started and confirmed in `tasklist`); `lock` is not fired automatically
because it would interrupt the session — `npm run probe:local:all` includes both.
`open the pod bay doors` and `summarise my unread email` route to the agent, and
bare `mute` asks which device rather than guessing.

Two defects surfaced here that the unit tests could not, both because those tests
inject a fake `run`:

- PowerShell rejects positional arguments after `-EncodedCommand`, so every audio
  call failed. The operation and level now travel in the environment, like the
  screenshot path already did — read as data, never parsed as script.
- The performance-counter path `\Processor(_Total)\% Processor Time` was in a
  plain template literal, where `\P` and `\%` are silently dropped by JS. It
  needed `String.raw`.

The local layer is deliberately consulted *before* the Hermes availability check,
on both the spoken and typed paths. Putting the agent check first would make the
whole offline guarantee conditional on the thing it exists to be independent of.

---

## Phase 5 — Hermes computer control + permissions ✅

- [x] Risk classifier (levels 0–4)
- [x] Action preview UI + scoped consent
- [x] Observe → Act → Verify wrapper
- [x] Undo history (Recycle Bin, not permanent delete)
- [x] Audit log + Activity view

The wrapper reports four outcomes, not two: `verified`, `unconfirmed`, `failed`,
`unchecked`. The third and fourth are the point. "It returned without an error"
is a claim by the thing being checked, and this project has already shipped that
mistake twice — `Verbs.DoIt()` returns nothing, so a failed Recycle Bin restore
marked the step undone, and eighteen green unit tests agreed because a fake
runner returns whatever it is told to. `undo` now sets `undone` from the disk.

Writing it surfaced a third instance of the same bug, in the wrapper itself: a
verifier whose condition is already true before the action cannot detect that the
action never ran. A snapshot restore threw "the saved copy is gone" while its
check asked "does the file exist?" — which it always did — and the precondition
failure came back as `verified`. When `act` throws and the verdict is ok, the
check is now re-run against the before-state; if it would have passed anyway, the
evidence is not evidence.

The Activity view inherits that vocabulary rather than flattening it. Most entries
have no outcome at all and never will — Jarvis approves Hermes' tool calls but
does not run them — so the view renders "not checked" where a conventional log
would render a green tick or a blank. An empty list under a dropped link says the
list may be stale rather than implying a quiet day, and refusals carry the row
accent and the count on the closed button, because a refusal nobody can see is not
a record of one. The wire carries an explicit projection of the audit entry, never
the tool arguments (§53), asserted by a test that greps the response for a secret
in a path.

Caveat on the word "verified" for this last item: the model, the wire, and the
Electron bridge are all covered by tests, including four end-to-end over the real
pipe, and `electron-vite build` compiles the renderer. Nobody has clicked the
button. That is the one link in this chain still resting on a claim rather than an
observation, and it is worth saying so on the page that grades the phase.

## Phase 6 — Context ✅
Active app/window, project registry, conversation context, on-request screen capture.

- ✅ **Active app/window** — `window-facts.ts`, `active-window.ts`, the `window.active`
  intent. Titles are redacted for secrets before they leave the reader, and the audit
  line carries the process but never the title (§53).
- ✅ **Project registry** — `project-registry.ts` scans user-nominated roots from
  `config.json`; `project.list` / `project.open` open a project by spoken name. The
  path handed to the shell is always the registry's own `dir`, never the utterance.
  A name matching two projects is asked about, not guessed.
- ✅ **Conversation context** — `conversation-context.ts` holds the subject of recent
  turns so "open it" resolves. Referents are canonical keys from a registry or a live
  read, never spoken text; they expire with the conversation window, and only an
  open-shaped verb can act on one. Nothing spoken is stored — a `Turn` has no field
  for a transcript (§50, §52).
- ✅ **On-request screen capture** — `screen-capture.ts` is a gate, not a camera:
  every capture is asked about every time, and there is no `allow_always` value a UI
  could send back. Deliberately outside the permission engine, whose design is that
  repeated approvals become a standing grant — consent for pixels cannot be made
  standing. There is no continuous mode: `captureOnce` is the only entry point, so
  "stream my screen" is absent rather than disabled (§50, applied to pixels). The
  prompt states where the image goes before it goes there; the rate limit and session
  cap are checked *before* the prompt, so a looping caller cannot flood the user with
  dialogs; a refusal costs nothing from the session budget; `null` from a UI that is
  not attached reads as no. Image bytes reach the agent and nothing else — the audit
  boundary strips them so a screenshot can never land in a log file (§53).

Verified by `npm run probe:context` (45/45 on real hardware), not only by fixtures.
That probe stubs the display on purpose: it proves the *policy*, and demonstrating
consent by photographing whoever runs it would be the wrong way round. The PowerShell
that takes the real picture has its own opt-in probe, `npm run probe:capture`, which
asks before it captures and is not part of `verify` for that reason.

## Phase 7 — Claude Code ✅
Delegated coding work as a background job, and a second opinion on whether it happened.

- ✅ **The headless contract, re-derived** — `claude-cli.ts`. The reference notes were
  wrong in three places, each found by running the installed CLI rather than trusting
  the notes: `--allowedTools` is retired in favour of `--tools`; the model those notes
  pin returns 503 from this gateway; and without `--permission-mode` a write is put to
  a prompt nobody can answer in headless mode. All three exit 0. Two of them are
  fixtures in `tests/claude-cli.test.ts`, copied verbatim from real runs, so a
  regression cannot pass. `CodingResult` has no `ok` field — its best verdict is
  `reported`, meaning the agent says it is done.
- ✅ **Background jobs** — `claude-code-manager.ts`. `start` resolves as soon as the
  child exists (10 ms measured, against a task that ran 15 s), so Jarvis keeps
  listening while a build runs. Bounded concurrency, a spend ceiling, a timeout that
  SIGTERMs and reports partial changes as still on disk, and `cancelAll` on shutdown so
  no coding agent outlives the assistant. `cwd` must be a directory the registry
  already found: a sentence off a microphone cannot aim a file-writing agent at
  `C:\Windows` or at whatever a webpage suggested (§52). `acceptEdits`, never
  `bypassPermissions` — a task needing `Bash` comes back `refused` rather than quietly
  doing less.
- ✅ **Test verification** — `work-check.ts`, and the reason this phase is not just a
  process wrapper. Two observations, neither of which asks the agent anything: the
  working-tree diff (a set difference, not a count — an agent that deletes one file and
  creates another leaves the total identical) and the project's own check. **The check
  command is pinned before delegation.** `npm test` runs whatever `package.json` says,
  and the process that just had write access is the coding agent; if `package.json`
  changed during the task the check does not run at all and the work comes back
  `unchecked` for a person to read. Otherwise Jarvis would launder a prompt-injected
  command through its own verification step (§52). `detectCheckScript` also uses a
  fixed allow-list, so a project cannot nominate an arbitrary command by naming it
  something else.
- ✅ **Both answers reach the UI** — `CodingJobView` carries `status` (what the agent
  claims) and `check` (what Jarvis found) as separate fields. A view that showed only
  the first would print "done" over a broken build. The agent's prose never crosses the
  wire: it is untrusted content from a process that just read a repository (§52).

Verified by `npm run probe:coding` (18/18 on real hardware) — a real delegated task in
a throwaway git repository under `%TEMP%`, deleted afterwards. It spends a few cents and
asks before it does, so it is not part of `verify`; `npm run probe:coding:offline` runs
the contract half with nothing spawned.

That probe earned its place on its first live run, by failing. `npm` on Windows is a
batch shim, and Node has refused to spawn `.cmd` without a shell since the fix for
CVE-2024-27980 — so the check died with `spawn EINVAL` and reported every completed
task as breaking the build. The unit tests could not see it: they inject the runner.
Fixed in `resolve-npm.ts`, which runs npm's own JS entry point through `node` and
resorts to the shim (with a shell) only when there is nothing to run directly. A second
defect surfaced with it: `nodeRunner`'s options had no `cwd` field at all, so the real
runner silently dropped it and would have graded *Jarvis' own repository* as the
delegated work's verdict.

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
