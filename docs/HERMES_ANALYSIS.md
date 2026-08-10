# Hermes Agent — Implementation Analysis

**Status:** verified against a live install, not from documentation.

| Fact | Value |
|---|---|
| Installed version | **v0.18.2** (`2026.7.7.2`), upstream `6564f319` |
| Install root | `%LOCALAPPDATA%\hermes\hermes-agent` |
| Install method | git + `uv` venv, Python 3.11.15 |
| Upstream clone analysed | `074f3dce` (2026-08-07) in `.research/hermes-agent` |
| Repo scale | 3,906 `.py`, 1,371 `.ts`, 640 `.tsx` |
| ACP SDK | `agent-client-protocol` **0.9.0**, `PROTOCOL_VERSION = 1` |

> **The installed build and the GitHub HEAD are not identical.** `acp_adapter/server.py`
> is 2,065 lines installed vs 2,510 in HEAD. Jarvis integrates against the **installed**
> copy and probes capabilities at runtime rather than assuming HEAD's surface.

---

## 1. Entry points (`pyproject.toml [project.scripts]`)

```
hermes       = hermes_cli.main:main       # CLI / TUI / everything
hermes-agent = run_agent:main             # direct agent loop
hermes-acp   = acp_adapter.entry:main     # ACP JSON-RPC over stdio
```

Relevant `hermes` flags: `-z PROMPT` (one-shot, non-interactive), `--resume SESSION`,
`--continue`, `-m/--model`, `-t/--toolsets`, `--yolo`, `--safe-mode`, `--tui`, `--cli`.

## 2. Integration surfaces evaluated

Three ways to drive Hermes programmatically. Jarvis chose **ACP**.

### (a) ACP over stdio — **CHOSEN**

`hermes acp` speaks JSON-RPC 2.0, one JSON object per line, stdout reserved for
protocol traffic and stderr for logs (`acp_adapter/entry.py` documents this
explicitly). It is the editor-integration path (Zed/VS Code/JetBrains).

**Why chosen:** it is the only *interactive, streaming* agent surface that works on
**native Windows**, it needs no port/auth, its lifetime is bound to our child process,
and it exposes sessions, streaming, cancel, permissions, and MCP in one protocol.

Verified methods (client → agent):

| Method | Purpose |
|---|---|
| `initialize` | handshake; returns `agentInfo`, `agentCapabilities`, `authMethods` |
| `session/new` | `{cwd, mcpServers}` → `{sessionId, models, modes}` |
| `session/load` / `session/resume` / `session/fork` / `session/list` | session lifecycle |
| `session/prompt` | send turn; streams updates; resolves with `stopReason` |
| `session/cancel` | interrupt the running turn |
| `session/set_model` / `session/set_mode` / `session/set_config_option` | runtime config |

Agent → client (Hermes calls **us**):

| Method | Notes |
|---|---|
| `session/update` | notification — the streaming channel |
| `session/request_permission` | **the permission hook Jarvis binds to** |
| `fs/read_text_file`, `fs/write_text_file` | only if we advertise `fs` capability |
| `terminal/create\|output\|kill\|release\|wait_for_exit` | only if we advertise `terminal` |

**Wire format gotcha:** keys are camelCase (pydantic `by_alias=True`), but the
`sessionUpdate` discriminator *values* are snake_case. Variants:
`agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `tool_call`,
`tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`,
`session_info_update`, `usage_update`, `config_option_update`.

Permission option ids map to Hermes approval semantics
(`acp_adapter/permissions.py`): `allow_once` → once, `allow_session` → session,
`allow_always` → always, `deny`/`deny_always` → deny.

### (b) `hermes serve` — HTTP + WebSocket, port 9119

Large FastAPI surface (`hermes_cli/web_server.py`, 17,812 lines) plus routers for
`cron`, `git`, `mcp`, `profiles`, `sessions`, `skills`, `tools`. Useful endpoints:
`/api/health`, `/api/status`, `/api/system/stats`, `/api/skills`, `/api/cron/jobs`,
`/api/mcp/servers`, `/api/memory`, `/api/tools/toolsets`, `/api/tools/computer-use/status`.
WebSockets: `/api/ws`, `/api/events`, `/api/pub`, `/api/console`, `/api/pty`.

**Windows blocker for chat:** `/api/console` and `/api/pty` route through
`hermes_cli/pty_bridge.py`, which imports `fcntl`/`termios`/`ptyprocess` and states it is
**POSIX-only** — on native Windows it raises `ImportError` and the dashboard shows a
"use WSL" banner. So this transport is **not** viable as Jarvis's conversation channel.

**Jarvis may still use `serve` later** as a read-only side channel for MCP management
(Phase 10), where those REST routes are pure JSON and Windows-safe. It would be a
*supplement* to ACP, not a replacement.

**Corrected in Phase 8 — this paragraph originally listed skills and memory here too, and
both were wrong:**

- `GET /api/memory` (`web_server.py:11807`) returns **status only**: `{active, providers,
  builtin_files:{memory,user}}` — a provider name and two byte counts. There is **no route
  that reads or writes an individual memory**, and `hermes memory` on the CLI has only
  `setup / status / off / reset`. Memory writes happen exclusively **inside an agent turn**
  via `tools/memory_tool.py`: `§`-delimited entries in
  `%LOCALAPPDATA%\hermes\memories\{MEMORY,USER}.md`, char limits 2200 / 1375, an `msvcrt`
  lock on a sibling `.lock`, and a `threat_patterns.first_threat_message()` scan on every
  write. So Jarvis keeps its **own** store and reads Hermes' files read-only; teaching
  Hermes something durable is a separate, explicit agent turn.
- Skills need no server. They are plain `SKILL.md` files with YAML frontmatter under
  `%LOCALAPPDATA%\hermes\skills` (102 here); reading them directly costs no process, no
  session token, and none of the ~3.07 s `hermes skills list` takes — and that command
  prints a Rich table that truncates names to `songwriting-and-ai-mu…` anyway. Reading disk
  also means "what can you do?" still answers with Hermes down.

**Corrected in Phase 9 — cron is closed for `serve` too.** The filesystem answered it
before Phase 10 ever asked. The cron ticker lives **only inside the gateway**
(`hermes_cli/cron.py:66`: "there is no standalone cron daemon… the most common cron support
report"), so the question "will my jobs fire?" is answered by two files, not by a route:
`%LOCALAPPDATA%\hermes\cron\jobs.json` and the raw-epoch `ticker_heartbeat` /
`ticker_last_success`. Reading them directly still answers with the gateway down — which is
exactly when the question gets asked — and keeps `serve`'s `/api/fs/write-text` and
`/api/credentials/pool` surface out of it. What remains on the `serve` candidate list is
MCP server management alone.

One caveat worth keeping in mind for Phase 10: standing up `serve` to list some files
means running a process whose route surface also includes `/api/files/read`,
`/api/fs/write-text` and `/api/credentials/pool`. It is token-gated, so this is not an open
door — but it is a great deal of blast radius for a question the filesystem may answer.

### (c) `hermes -z PROMPT` — one-shot CLI

Works (measured 18s wall clock). No streaming, no session reuse, full process startup
per call. Fine as an offline fallback/diagnostic; unusable for conversation.

## 3. Capabilities Hermes already provides (do not rebuild)

| Capability | Access |
|---|---|
| Skills (self-improving, agentskills.io) | `hermes skills {browse,search,install,inspect,list,audit,publish,...}`, `GET/POST /api/skills` |
| Memory | built-in `MEMORY.md`/`USER.md` always active; external providers (honcho, mem0, openviking, hindsight, holographic, retaindb, byterover) via `hermes memory setup`. **Writes happen only inside an agent turn** (`tools/memory_tool.py`) — no REST or CLI route adds an entry |
| Scheduler / automations | `hermes cron {list,create,edit,pause,resume,run,remove,tick}`, `/api/cron/*`. **The ticker runs only inside the gateway** (`hermes_cli/cron.py:66`) — with no gateway, `next_run_at` passes and nothing fires. Jarvis reads `cron/jobs.json` and the two heartbeat files directly and never writes them; creating a job goes through an agent turn, where `cron/lifecycle_guard.py` can refuse it |
| MCP | `hermes mcp {add,remove,list,test,serve,catalog,install}`, `/api/mcp/servers` — Hermes can also *be* an MCP server |
| Sessions (SQLite store) | `hermes sessions {list,export,delete,prune,archive,stats,browse}` |
| Toolsets | `hermes tools {list,enable,disable}` |
| Computer use | `hermes computer-use {install,status,doctor,permissions}` — cua-driver binary, **Windows supported** |
| Subagents / parallel work | built into the agent loop |
| Terminal backends | local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox |
| Model routing | 300+ models via Nous Portal / OpenRouter / OpenAI / custom endpoints |

Jarvis builds **none** of these. It builds wake word, voice, low-latency local intents,
Windows integration, permission UX, always-on supervision, and the HUD.

## 4. Current configuration on this machine

```yaml
model:
  default: tencent/hy3:free
  provider: nous
  base_url: https://inference-api.nousresearch.com/v1
agent:
  max_turns: 60
  reasoning_effort: medium
```

## 5. Measured latency — the decisive finding

Real numbers from `scripts/probe-hermes.ts` against the live install:

| Metric | Run 1 | Run 2 (after spawn fix) |
|---|---|---|
| ACP handshake (spawn → `initialize` return) | 5,004 ms | **1,368 ms** |
| First streamed token | 15,467 ms | 16,435 ms |
| Full turn | 16,122 ms | 16,483 ms |

The handshake improvement came from resolving the real executable instead of spawning
through `cmd.exe` (also removed Node's DEP0190 warning).

**Implication, and it drives the whole architecture:** ~16 s to first token on
`tencent/hy3:free` makes Hermes **categorically unusable** for the "say Jarvis → reply in
100–300 ms" experience. This is not a tuning problem; it is a routing problem.

Therefore:
1. Wake acknowledgement is **local** and never consults Hermes.
2. The `LocalIntentEngine` must resolve common commands **without Hermes** — this is a
   hard requirement, not an optimisation.
3. Hermes is reserved for genuinely complex reasoning, where a multi-second wait is
   acceptable and should be covered by a spoken "working on it".
4. A faster model should be configured for interactive use. Recorded in
   `docs/PERFORMANCE.md` as an open action.

## 6. Constraints and risks

- **Do not fork.** Integrate via `HermesAdapter` only; upstream moves fast (HEAD is
  ~1 month ahead of the installed build and the ACP server already differs by 445 lines).
- **Version drift.** `initialize` returns `agentInfo.version`; Jarvis records it and must
  degrade gracefully rather than assume a capability exists.
- **stdout is sacred.** Any stray print from a plugin corrupts framing. The Jarvis peer
  ignores non-JSON lines defensively instead of tearing down the session.
- **Deny-by-default.** With no permission handler wired, `session/request_permission`
  returns `deny`. Jarvis never auto-approves.
- **`--yolo` is never used** by Jarvis.
