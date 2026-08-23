/**
 * The Jarvis runtime: the always-on process.
 *
 * This is the thing that exists because the laptop is on. It owns Hermes, the
 * voice pipeline, the assistant state machine, and the IPC server. It has no
 * window and no dependency on Electron — a UI attaching or detaching is
 * invisible to it, which is what makes "close window ≠ quit" true by
 * construction rather than by a handler somebody remembered to write.
 *
 * The microphone lives here, not in the renderer, for the same reason: an
 * assistant whose ears belong to a window would go deaf when the window
 * closed, and Phase 2 promises it does not.
 *
 * Honesty rule (§4): subsystems not yet implemented report `unavailable` with
 * a reason. Nothing here pretends to work.
 */
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath, dirname } from "node:path";
import { HermesSupervisor, type SupervisorOptions } from "../system/hermes-supervisor.js";
import type { HermesStreamEvent, StopReason } from "../hermes/acp-types.js";
import { AssistantStateMachine } from "./state-machine.js";
import { describeAgentFailure, TurnStalledError, type AgentFailure } from "./agent-failure.js";
import {
  TurnWatchdog,
  DEFAULT_TURN_STALL_MS,
  DEFAULT_TURN_NOTICE_MS,
} from "./turn-watchdog.js";
import {
  VoiceSidecar,
  SILENCE_VERDICT_MS,
  type VoiceSidecarOptions,
} from "../voice/voice-sidecar.js";
import { WAKE_ACK_ID, type VoiceEvent } from "../voice/voice-protocol.js";
import { speakable } from "../voice/speakable.js";
import { PipeServer, type HandledRequest } from "../ipc/pipe-server.js";
import { generateToken, publishToken, revokeToken } from "../ipc/token.js";
import type {
  ActivityEntry,
  CodingJobView,
  DemoView,
  EpisodeView,
  McpView,
  MemoryView,
  MissionDetailView,
  MissionsView,
  ProposalResult,
  RuntimeStatus,
  ServerEvent,
  SkillsView,
  SubsystemStatus,
  TasksView,
  ToolPolicyEntry,
  ToolsView,
  WorldView,
} from "../ipc/contract.js";
import { FORGET_EVERYTHING, IPC_PROTOCOL_VERSION } from "../ipc/contract.js";
import {
  LocalIntentEngine,
  type EngineDeps,
  type EngineOptions,
  type LocalDecision,
} from "../local-intents/engine.js";
import {
  nodeRunner,
  nodeLauncher,
  defaultScreenshotRoots,
  encodePwsh,
} from "../local-intents/executors.js";
import { defaultStartMenuRoots } from "../system/app-catalog.js";
import { ActiveWindow } from "../context/active-window.js";
import { ScreenCapture, viaConsentBroker } from "../context/screen-capture.js";
import { windowsCapturePng } from "../context/capture-png.js";
import { ClaudeCodeManager, type CodingJob, type SpawnFn } from "../coding/claude-code-manager.js";
import { speakResult } from "../coding/claude-cli.js";
import {
  snapshotWork,
  checkWork,
  speakCheck,
  type WorkCheck,
  type WorkSnapshot,
} from "../coding/work-check.js";
import {
  aliasesFromMemory,
  applyAliases,
  buildRegistry,
  type DirEntry,
  type ProjectEntry,
} from "../context/project-registry.js";
import { loadConfig, configFilePath } from "../context/config.js";
import { MemoryStore, MAX_ENTRIES, MAX_TOTAL_CHARS, type MemoryEntry } from "../memory/memory-store.js";
import { readHermesMemory } from "../memory/hermes-memory.js";
import { EpisodicStore, type Episode } from "../memory/episodic-store.js";
import { ProfileStore, isProfileKey, profileKeys } from "../memory/profile-store.js";
import { LearningQueue, lessonsFromMission } from "../memory/learning.js";
import { Retriever, toMemoryRefs } from "../memory/retrieval.js";
import { VectorIndex, memoryDir, type Embedder } from "../memory/vector-index.js";
import { buildWorld, describeWorld, MAX_WORLD_MISSIONS, type World } from "../world/world-model.js";
import { suggest } from "../world/proactive.js";
import { ProactiveQueue, worldDir, type ProactiveProposal } from "../world/proposal-store.js";
import { toProposalView, toWorldView } from "../world/world-view.js";
import { createEmbedder } from "../llm/embeddings.js";
import { loadSkills, summariseSkills, type Skill } from "../memory/skill-catalog.js";
import { fenceMemories, selectMemories, withMemoryContext } from "../memory/memory-prompt.js";
import { Notifier, parseNotifyLevel, type NotifyLevel } from "../notifications/notifier.js";
import { TaskWatcher } from "../tasks/task-watcher.js";
import { speakTasks } from "../tasks/speak-tasks.js";
import { speakMcp } from "../mcp/speak-mcp.js";
import { readTasks, type TaskSnapshot } from "../tasks/cron-store.js";
import { readMcpServers, type McpServer, type McpSnapshot } from "../mcp/mcp-store.js";
import { selectServers } from "../mcp/tool-selection.js";
import {
  PermissionEngine,
  NO_ALWAYS_ABOVE,
  type AuditEntry,
  type EngineOptions as PermissionOptions,
} from "../permissions/permission-engine.js";
import {
  RISK_CATEGORIES,
  isRiskCategory,
  sanitiseForDisplay,
  type RiskCategory,
} from "../permissions/risk-model.js";
import { ConsentBroker } from "../permissions/consent-broker.js";
import {
  toActionDescriptor,
  toOutcomeId,
  fromIpcDecision,
  toIpcOptions,
} from "../permissions/action-bridge.js";
import { assessDemos, type DemoFacts } from "../demo/demo-catalog.js";
import {
  inspectDemoWorkspace,
  prepareDemoWorkspace,
  resetDemoWorkspace,
  type DemoWorkspaceState,
} from "../demo/demo-workspace.js";
import { buildToolRegistry } from "../tools/default-tools.js";
import { findYouTubeVideo } from "../tools/net/youtube-search.js";
import type { MockCommsStore } from "../tools/adapters/comms.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  MissionOrchestrator,
  type MissionLimits,
  type MissionUpdate,
} from "../missions/orchestrator.js";
import { nodeProcessRunner, type ProcessRunner } from "../tools/process-run.js";
import { DeterministicPlanner } from "../missions/plan-builder.js";
import { DeterministicReplanner } from "../missions/replanner.js";
import { LlmPlanner } from "../missions/llm-planner.js";
import { LlmReplanner } from "../missions/llm-replanner.js";
import { createProvider, type LlmSettings } from "../llm/factory.js";
import { loadEnv } from "../llm/env.js";
import type { LLMProvider } from "../llm/provider.js";
import { MissionStore } from "../missions/mission-store.js";
import {
  toMissionDetailView,
  toMissionStepView,
  toMissionView,
  toTraceView,
  toVisionProposalView,
} from "../missions/mission-view.js";
import { buildTrace, traceGap } from "../missions/trace.js";
import {
  isEmptyMissionRequest,
  MISSION_OFFER_TIMEOUT_MS,
  NOTHING_TO_DO,
  OFFER_DECLINED,
  OFFER_EXPIRED,
  offerSentence,
  readConfirmation,
  readMissionRequest,
} from "../missions/spoken-objective.js";
import {
  proposalSentence,
  proposeFromScreen,
  type VisionOutcome,
} from "../missions/vision-objective.js";
import {
  MISSION_NOT_STARTED,
  MISSION_STARTED,
  spokenReport,
} from "../missions/mission-speech.js";
import { buildReport } from "../missions/mission-report.js";
import { attributeTool } from "../agents/roles.js";
import { isTerminal, type Mission, type MissionMemoryRef } from "../missions/mission-model.js";

export interface RuntimeOptions {
  cwd?: string;
  pipeName?: string;
  hermesPath?: string;
  restart?: SupervisorOptions["restart"];
  /**
   * How long a turn may produce *nothing at all* before Jarvis cancels it.
   *
   * Silence, not duration — see `runtime/turn-watchdog.ts`. Lowered by tests to
   * milliseconds; absent means `DEFAULT_TURN_STALL_MS`.
   */
  turnStallMs?: number;
  /** Silence, in ms, after which the wait is worth a log line. */
  turnNoticeMs?: number;
  /** Skip starting Hermes on boot; it starts on first real need. */
  lazyHermes?: boolean;
  /** Adapter factory, injected by tests to avoid spawning a real agent. */
  createAdapter?: SupervisorOptions["createAdapter"];
  /** Voice configuration. `enabled: false` leaves the mic untouched. */
  voice?: VoiceSidecarOptions & { enabled?: boolean };
  /** Local-intent engine options: catalog source and audit sink. */
  localIntents?: EngineOptions;
  /** Permission policy. Defaults are deliberately strict; see the engine. */
  permissions?: PermissionOptions;
  /** Machine-facing overrides for local actions. Injected by tests. */
  localDeps?: Partial<EngineDeps>;
  /**
   * Where to look for the user's projects.
   *
   * Overrides the config file when supplied, which is what tests use. Absent
   * *and* no config file means no scan happens at all — not scanning is the
   * safe default, since the alternative is an assistant that crawls a disk
   * looking for source code nobody asked it to find.
   */
  projectRoots?: readonly string[];
  /** Directory listing for the registry. Injected by tests to avoid real I/O. */
  readProjectDir?: (dir: string) => readonly DirEntry[];
  /**
   * Where Jarvis' own memory file lives.
   *
   * A seam for tests and the probe, so neither writes the real store. Absent
   * means `%LOCALAPPDATA%\Jarvis\memory.json`, beside the config file.
   */
  memoryPath?: string;
  /**
   * Where the Phase 16 memory layers live, as a directory.
   *
   * One seam for four files (`vectors.json`, `episodes.json`, `profile.json`,
   * `proposals.json`) rather than four options: they are written together, a test
   * that redirected three of them would leave the fourth pointing at the user's real
   * profile, and that is the one mistake in this list with a consequence outside the
   * test. Absent means `%LOCALAPPDATA%\Jarvis\memory\`.
   */
  memoryDir?: string;
  /**
   * Where the world model keeps its suggestion queue.
   *
   * One file (`proposals.json`), beside memory rather than inside it: a suggestion is
   * about the machine's current state and expires in two days, where a memory is meant
   * to outlive everything. Absent means `%LOCALAPPDATA%\Jarvis\world\`.
   */
  worldDir?: string;
  /**
   * An embedder injected whole, so no test and no probe needs a model.
   *
   * Absent means `createEmbedder` decides from the environment — which with no
   * `OPENAI_BASE_URL` set is the local lexical one, labelled as lexical.
   */
  embedder?: Embedder;
  /**
   * Where the installed skills are, as `[userDir, bundledDir]`.
   *
   * Injected by tests. Absent means the real Hermes skill roots — which are read
   * and never written, like everything else this runtime knows about Hermes'
   * files.
   */
  skillRoots?: readonly [string, string];
  /**
   * Where Hermes' cron state lives, as a directory.
   *
   * A seam for tests and the probe. Absent means the real
   * `%LOCALAPPDATA%\hermes\cron` — read and never written, like every other
   * Hermes file this runtime knows about.
   */
  cronDir?: string;
  /**
   * Where Hermes' `config.yaml` lives.
   *
   * A seam for tests and the probe. Absent means the real
   * `%LOCALAPPDATA%\hermes\config.yaml`. Read and never written — `mcp-store.ts`
   * has no write path, which matters more here than for the other Hermes files
   * this runtime reads: the `mcp_servers` block holds commands Hermes will
   * execute, and Hermes screens them on save (`hermes_cli/mcp_security.py`).
   */
  hermesConfigPath?: string;
  /**
   * Where Hermes' own memory files live, as a directory.
   *
   * A seam for tests and the probe. Absent means the real
   * `%LOCALAPPDATA%\hermes\memories`. Read-only, and here that is enforced by
   * absence rather than by discipline: `hermes-memory.ts` has no write path at
   * all, because Hermes writes those files under an `msvcrt` lock and a second
   * writer could corrupt notes the user dictated to the agent.
   */
  hermesMemoryDir?: string;
  /**
   * How much Jarvis may say on its own initiative.
   *
   * Absent means the config file, and absent from that means `minimal`. Proactive
   * assistance defaults down, not up: an assistant that has to be told to be
   * quiet has already interrupted someone to learn it.
   */
  notifyLevel?: NotifyLevel;
  /** Delivery for notifications. Absent means the attached UI, via IPC. */
  notifySink?: (n: { key: string; category: string; title: string; body: string; at: number }) => void;
  /** Poll interval for the scheduled-task watcher. Shortened by tests. */
  taskPollMs?: number;
  /**
   * Where the pixels come from. The camera, never the gate.
   *
   * Overriding this replaces the screenshot itself; consent, the disclosure
   * wording, the rate limit and the session cap all stay exactly as they are,
   * because they live in `ScreenCapture` and nothing here can reach them. That
   * is the point of the seam: a test — and `scripts/probe-context.ts` on real
   * hardware — can prove the *policy* end to end without photographing the
   * user's desktop, and cannot accidentally prove it with the policy switched
   * off.
   */
  captureScreen?: () => Promise<Uint8Array>;
  /** Path to the Claude Code CLI. Overridden in tests with a stub script. */
  claudePath?: string;
  /** Spawn used for coding jobs. Injected by tests; production spawns the real CLI. */
  spawnCoding?: SpawnFn;
  /**
   * Runs `git` and `npm` for the post-task check.
   *
   * A seam for tests only. Note what it does *not* reach: which command gets
   * run is decided in `work-check.ts` from a script name pinned before the agent
   * started, so overriding this changes who executes the check, never what the
   * check is willing to execute.
   */
  runCheck?: (
    file: string,
    args: readonly string[],
    opts: { cwd: string; timeoutMs?: number; shell?: boolean; maxBufferBytes?: number },
  ) => Promise<string>;
  /**
   * Where mission records are written.
   *
   * A seam for tests and `probe:mission`, which must not write beside the real
   * ones. Absent means `%LOCALAPPDATA%\Jarvis\missions`.
   */
  missionDir?: string;
  /**
   * The directories a mission's steps may act inside.
   *
   * Overrides `missionRoots` from the config file, which is what tests use.
   * Absent from both means the project registry's own directories — never the
   * whole disk, and never a path a step nominated for itself.
   */
  missionRoots?: readonly string[];
  /** Mission ceilings. Lowered by tests; config's `maxMissionSteps` also lands here. */
  missionLimits?: Partial<MissionLimits>;
  /**
   * Runs the programs the `terminal` and `git` tools invoke.
   *
   * A seam for tests, and narrower than it looks: the allowlist, the argv shape
   * and the root confinement all live in the adapters, so replacing this changes
   * who executes a command and never which commands may be executed.
   */
  runTool?: ProcessRunner;
  /**
   * Hosts the network tools may reach past the private-address guard.
   *
   * Overrides `webAllowHosts` from the config file. `probe:web` is what this is for:
   * a probe serves its fixtures on `127.0.0.1`, which the guard refuses by design,
   * so allowing exactly that one `host:port` is how the probe exercises the real
   * client instead of a stub — and it exercises the allowlist while it is there.
   */
  webAllowHosts?: readonly string[];
  /** Where the mock outbox and calendar are written. Probes point this at `%TEMP%`. */
  commsStore?: MockCommsStore;
  onLog?: (line: string) => void;
}

/**
 * What the local layer did with an utterance, from the caller's point of view.
 *
 * Two states rather than a boolean because a turn can be handled locally and
 * still not be finished — see `tryLocal`. The image travels in the return value
 * and never onto the instance: `context/screen-capture.ts` promises that nothing
 * is retained, and a field on the runtime holding the last screenshot would
 * quietly break that promise from the outside.
 */
type LocalTurn =
  | { done: true }
  | { done: false; image?: TurnImage };

/** A screenshot travelling with one turn, and never held anywhere. See `LocalTurn`. */
type TurnImage = { kind: "image"; data: Uint8Array; mimeType: string };

const NOT_YET_IMPLEMENTED = (phase: string): SubsystemStatus => ({
  state: "unavailable",
  detail: `not implemented yet (${phase})`,
});

/**
 * Directory listing for catalog discovery.
 *
 * Wrapped rather than passed directly so the catalog sees plain names and never
 * a `Dirent`, and so an unreadable directory surfaces as a throw the walker
 * already handles rather than as a runtime crash at startup.
 */
const readDirSync = (dir: string): readonly string[] => readdirSync(dir);

/**
 * Directory listing for the project registry, which needs to know which entries
 * are directories.
 *
 * `withFileTypes` rather than a `statSync` per entry: the registry walks two
 * levels of a developer's project folder, and one syscall per name there is a
 * measurable cost at boot for information the directory read already has.
 */
const readDirEntries = (dir: string): readonly DirEntry[] =>
  readdirSync(dir, { withFileTypes: true }).map((d) => ({
    name: d.name,
    isDirectory: d.isDirectory(),
  }));

/** Rows served when the client does not ask for a number. */
const DEFAULT_ACTIVITY_ROWS = 200;

/** Ceiling on one `get_activity` response, whatever the client asks for. */
const MAX_ACTIVITY_ROWS = 500;

/**
 * How many episodes the Memory page is sent, out of up to `MAX_EPISODES` on disk.
 *
 * Forty is what a person scrolls; the true total travels beside them as
 * `episodeCount`, so a capped list never reads as the whole history.
 */
const MEMORY_VIEW_EPISODES = 40;

/** Missions served when a client does not ask for a number, and the ceiling. */
const DEFAULT_MISSION_ROWS = 20;
const MAX_MISSION_ROWS = 50;

/**
 * One episode, projected.
 *
 * Listed field by field for the same reason `toActivityEntry` is: `Episode` is
 * internal, and the next field added to it should not reach a window because a
 * spread carried it there.
 */
function toEpisodeView(e: Episode): EpisodeView {
  return {
    id: e.id,
    at: e.at,
    kind: e.kind,
    title: e.title,
    outcome: e.outcome,
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
    ...(e.tools !== undefined ? { tools: [...e.tools] } : {}),
    ...(e.missionId !== undefined ? { missionId: e.missionId } : {}),
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    ...(e.redacted === true ? { redacted: true } : {}),
  };
}

/**
 * The engine's audit entry, narrowed to what goes on the wire.
 *
 * An explicit projection rather than sending the entry as-is. `AuditEntry` is
 * internal and free to grow a field; if that happened, spreading it would
 * publish the new field to every attached client without anyone deciding to —
 * and the thing most likely to be added to an audit record is the arguments,
 * which is exactly what must not leave (§53). Listing the fields means adding
 * one is a choice someone makes on purpose.
 */
function toActivityEntry(e: AuditEntry): ActivityEntry {
  return {
    at: e.at,
    tool: e.tool,
    level: e.level,
    category: e.category,
    verdict: e.verdict,
    reason: e.reason,
    ...(e.outcome ? { outcome: e.outcome } : {}),
  };
}

export class JarvisRuntime extends EventEmitter {
  readonly supervisor: HermesSupervisor;
  readonly machine: AssistantStateMachine;
  readonly voice: VoiceSidecar;
  readonly localIntents: LocalIntentEngine;
  readonly permissions: PermissionEngine;
  /**
   * The decider for a mission's steps, and a second engine on purpose.
   *
   * Not the same instance as `permissions`, for three reasons that all point the
   * same way. The per-class policy a user writes in `missionPolicy` is about what
   * an *autonomous loop* may do and must not silently re-govern a turn they are
   * sitting in front of. A stored "always allow" given during a conversation is an
   * answer about that conversation, and inheriting it into an unattended mission
   * would be the widening §52 forbids. And because every question this engine asks
   * came from a mission step, the request id it hands to the broker identifies the
   * step exactly — which is what makes `approve_step` answerable without guessing.
   *
   * Both engines audit through the same sink, so the Activity view stays one list.
   */
  readonly missionPermissions: PermissionEngine;
  readonly consent: ConsentBroker;
  /**
   * The tools a mission may choose from.
   *
   * Public so a probe can list them without a pipe. Built once: the set of things
   * an autonomous loop can do is not a per-mission decision.
   */
  readonly tools: ToolRegistry;
  /** The objective loop. Costs a closure and nothing else while idle. */
  readonly missions: MissionOrchestrator;
  /**
   * Reads the foreground window on request.
   *
   * A field rather than a local so the cache is shared, and public so a probe
   * can drive it. Constructing it does nothing — no handle, no timer, no poll.
   */
  readonly activeWindow = new ActiveWindow();
  /**
   * The gate every screen capture passes through.
   *
   * Public so the HUD can show the count — a capture tally the user cannot see
   * is a capture tally that protects nobody. Constructed in the body rather than
   * here because it needs the consent broker, which is built there.
   */
  readonly screen: ScreenCapture;
  /**
   * Delegated coding work.
   *
   * Its `allowedRoots` is the project registry, not a path from an utterance:
   * the manager can only be aimed at a directory the user nominated in config.
   * Constructed here because it needs nothing from the consent broker — a coding
   * task is asked for out loud and confirmed before it starts, in `startCoding`.
   */
  readonly coding: ClaudeCodeManager;
  /**
   * What Jarvis independently established about each finished coding job.
   *
   * Kept beside the job rather than inside `CodingResult`, because the result is
   * the agent's account of itself and this is the second opinion. Merging them
   * would make it possible to write a "success" into the same field the check
   * reads, which is the mistake `verified-action.ts` exists to prevent.
   */
  private codingChecks = new Map<string, WorkCheck>();
  /**
   * The state of each project before its coding job started.
   *
   * Held here rather than on the job because it must be captured *before*
   * delegation — including the test script, read while the agent still has no
   * write access to name it. Deleted when the job settles, so a long session
   * does not accumulate a copy of every package.json it has seen.
   */
  private codingSnapshots = new Map<string, WorkSnapshot>();
  /**
   * The user's projects, scanned once on first use.
   *
   * Lazy for the same reason the app catalog is: this reads directories the
   * user nominated, and a slow or sleeping disk must not sit between the
   * process starting and the runtime being reachable. `null` means "not scanned
   * yet"; an empty array means "scanned, and there was nothing" — which are
   * different states, and collapsing them would make "no projects configured"
   * indistinguishable from "the scan has not happened".
   */
  private projectsCache: readonly ProjectEntry[] | null = null;
  /**
   * The scan with remembered aliases folded in, and the memory state it was
   * folded from.
   *
   * Separate from `projectsCache` because the two go stale on different events:
   * the scan goes stale when the disk changes, the overlay when the user says
   * "remember that…". Recomputing the overlay on every call would be correct
   * and cheap, but it would hand out a freshly allocated list each time; the
   * stamp keeps object identity stable while nothing has actually changed.
   */
  private aliasedCache: { stamp: string; list: readonly ProjectEntry[] } | null = null;
  /** Config-sourced roots, read once. `null` means "not read yet". */
  private rootsCache: readonly string[] | null = null;
  /**
   * Jarvis' own memory, opened at construction.
   *
   * Not lazy, unlike the project scan: this is one small JSON file, and the
   * first thing a user says after a restart may well be "remember that…". A
   * missing or corrupt file opens as an empty store and logs why — the store
   * never throws on the way in.
   */
  private readonly memory: MemoryStore;
  /**
   * The Phase 16 layers, all opened at construction beside the memory store.
   *
   * Four small JSON files and no timer between them. Lazy construction was the
   * alternative and it is worse here for a specific reason: the vector index is
   * *synced* after every write to either store, so a lazily built one would first
   * appear halfway through a session with an index that had missed everything said
   * before it — and the retrieval it backs is read by the first mission, which may
   * be seconds after boot.
   */
  private readonly episodes: EpisodicStore;
  private readonly profile: ProfileStore;
  private readonly vectors: VectorIndex;
  private readonly learning: LearningQueue;
  /**
   * The world model's queue of things Jarvis would offer to do.
   *
   * A store and nothing else. There is no world *service* and no timer: the graph is
   * assembled when someone asks for it or when a mission finishes, so an idle Jarvis
   * costs exactly what it cost before this phase (§7).
   */
  private readonly proactiveQueue: ProactiveQueue;
  private readonly retriever: Retriever;
  /** The one line saying which embedder was chosen and how. Never a key. */
  private readonly embedderReason: string;
  /**
   * Whether the memory layer is on, when the answer is not the config file's.
   *
   * `null` means "the file decides", which is not the same as `true`: a session that
   * had never touched the switch and one that had switched it back on are different
   * states, and the view says which is in force.
   */
  private memoryEnabledOverride: boolean | null = null;
  /** `.env` + `process.env`, read on first use. See `loadedEnv`. */
  private envCache: Readonly<Record<string, string>> | null = null;
  /**
   * Installed skills, scanned once on first ask.
   *
   * Lazy for the same reason the project registry is: 102 `SKILL.md` files is a
   * real amount of disk work, and nothing about starting up depends on it.
   */
  private skillsCache: readonly Skill[] | null = null;
  /**
   * Jarvis speaking first, and the only thing allowed to.
   *
   * Constructed even when nothing is attached: the level policy and the repeat
   * cooldown are decided here, once, so that a shell connecting halfway through
   * a bad afternoon does not receive a backlog of conditions it never saw start.
   */
  private readonly notifier: Notifier;
  /**
   * Watches Hermes' cron state.
   *
   * Started with the runtime rather than lazily, because the condition it exists
   * to catch — a scheduler that is not running — is true *before* anybody asks a
   * question that would trigger a lazy load. Waiting for the user to ask "what's
   * scheduled?" would mean only ever telling people who already suspected.
   *
   * Public for the same reason `supervisor` is: tests and probes step `poll()`
   * by hand, because a suite that waits out a real 60 s interval is a suite that
   * gets skipped.
   */
  readonly tasks: TaskWatcher;
  private ipc: PipeServer | null = null;
  private token: string | null = null;
  /**
   * Where finished missions are written, and where `get_missions` reads from.
   *
   * Opened at construction like the memory store, and for the same reason: it is
   * one directory and a `readdir`, and the first question after a restart may well
   * be "what did you do last night".
   */
  private readonly missionStore: MissionStore;
  /**
   * The step a mission is currently parked on, and the consent request that asked.
   *
   * One entry rather than a map because a mission runs its steps in series and the
   * runtime runs one mission at a time — so there is never a second step waiting
   * on a second answer. `requestId` is filled by `askForMission` when the engine
   * actually asks, and stays null for a level the engine allowed without asking;
   * `approve_step` refuses in that case rather than resolving something else.
   */
  private missionAsk: { missionId: string; stepId: string; requestId: string | null } | null = null;
  /**
   * An objective that has been offered back and is waiting on a yes or a no.
   *
   * The whole voice-started gesture is this one field. There is never a second
   * offer: any utterance that is not an answer drops it, and no other path in the
   * runtime can start a mission from speech without going through here first.
   *
   * `at` is what makes an offer expire rather than sit there indefinitely — a yes
   * said a minute later belongs to whatever the user is doing now, not to a question
   * they have forgotten. `heard` records which trigger produced it, so the log can
   * tell an objective somebody dictated from one a model read off the screen, and
   * `aloud` remembers which door it came in by, so a typed request gets a typed
   * answer and a spoken one gets a spoken answer.
   */
  private pendingMission: {
    readonly objective: string;
    readonly at: number;
    readonly heard: "objective" | "vision";
    readonly aloud: boolean;
  } | null = null;
  /**
   * The model behind the planner, and the one line that says how it was configured.
   *
   * Held so `get_status` can answer "is there a model" without rebuilding anything.
   * What it never holds is a key: `ProviderHealth.note` names an endpoint or says
   * "not set", and `describeSecret` counts characters — nothing in this field or on
   * the wire is a secret, because the renderer is a different process and the pipe is
   * the boundary a key must not cross.
   */
  private readonly llm: { provider: LLMProvider; reason: string };
  /**
   * The demo workspace as last inspected, or null before anything asked.
   *
   * Cached because it is consulted on two hot paths — `missionRoots` on every mission
   * and `scanProjects` on the first project lookup — and invalidated by the only two
   * things that can change it, `prepare_demo` and `reset_demo`. Nothing else on this
   * machine writes to that directory, so a stale read is not a risk the way a stale
   * project scan is; a judge who prepared the demo from a different window gets it
   * after a rescan, and `prepare_demo` is idempotent anyway.
   */
  private demoCache: DemoWorkspaceState | null = null;
  /** Mission config, read once and held. See `configuredRoots` for the reasoning. */
  private missionConfigCache: {
    roots: readonly string[];
    maxSteps: number | undefined;
    policy: Readonly<Record<string, "auto" | "approval" | "deny">> | undefined;
    webAllow: readonly string[];
    llm: LlmSettings;
    llmPlanner: boolean;
    memoryEnabled: boolean;
  } | null = null;
  /**
   * Per-class policy chosen in Settings, for this session only.
   *
   * Separate from `missionConfigCache` rather than written into it, for the reason
   * that cache exists: the config file is a boot-time read, and a panel that edited
   * the cache would make the runtime disagree with the file on disk with no way for
   * a reader to tell which one they were looking at. This map is consulted *before*
   * the file's value and says on the wire that it is a session override, so the two
   * answers stay distinguishable — and a restart drops this one, which is the
   * behaviour the panel promises.
   *
   * A `"none"` entry is not representable: dropping the override is a delete, so
   * "the file says nothing here" and "I chose to ignore the file" cannot be
   * confused for one another.
   */
  private readonly sessionPolicy = new Map<RiskCategory, "auto" | "approval" | "deny">();
  private startedAt = 0;
  private listening = false;
  private muted = false;
  private stopping = false;
  private quitRequested = false;
  /** True only when this instance published the shared token file. */
  private owningToken = false;
  private readonly voiceEnabled: boolean;
  /** Set while a voice turn is in flight, so replies are spoken not just shown. */
  private speakingTurn = false;

  constructor(private readonly options: RuntimeOptions = {}) {
    super();

    // Before the supervisor, because the supervisor needs the permission
    // handler at construction time — an adapter that starts without one falls
    // back to denying everything, which is safe but useless.
    this.consent = new ConsentBroker({
      send: (req) => {
        if (!this.ipc || this.ipc.clientCount === 0) return false;
        this.broadcast({
          type: "permission_request",
          requestId: req.requestId,
          title: req.title,
          detail: req.detail,
          // Narrowed to what the HUD has buttons for. `deny` always survives.
          options: toIpcOptions(req.options),
          // The classified facts, so the preview can show what is at stake
          // rather than just a sentence. Paths are capped: a call naming 400
          // files must not push a 400-entry list through the pipe, and a user
          // cannot read that list anyway — the count carries the weight.
          risk: {
            level: req.classification.level,
            category: req.classification.category,
            ...(req.classification.paths.length > 0
              ? {
                  paths: req.classification.paths.slice(0, 12),
                  pathCount: req.classification.paths.length,
                }
              : {}),
          },
        });
        return true;
      },
      onLog: (line) => this.log(line),
    });

    this.permissions = new PermissionEngine({
      ask: this.consent.ask,
      ...options.permissions,
      onAudit: (e) => {
        this.onPermissionAudit(e);
        options.permissions?.onAudit?.(e);
      },
    });

    // After the broker, whose `ask` it borrows, and deliberately *not* through
    // the permission engine: that engine can turn repeated approvals into a
    // standing grant, which is right for launching an app and wrong for
    // photographing the desktop. `viaConsentBroker` reuses the HUD dialog while
    // narrowing the answer to two values, so a standing grant has no way in.
    this.screen = new ScreenCapture({
      ask: viaConsentBroker(this.consent.ask),
      capture:
        options.captureScreen ?? windowsCapturePng({ run: nodeRunner, encode: encodePwsh }),
      now: () => Date.now(),
      onLog: (line) => this.log(`screen: ${line}`),
    });

    this.supervisor = new HermesSupervisor({
      cwd: options.cwd,
      hermesPath: options.hermesPath,
      restart: options.restart,
      createAdapter: options.createAdapter,
      onPermissionRequest: (req) => this.decidePermission(req.toolCall),
      onLog: (line) => this.log(line),
    });

    // Aimed only at directories the registry found. `projects()` is read on
    // every call rather than captured, so a project removed from config stops
    // being a valid target immediately instead of at the next restart.
    this.coding = new ClaudeCodeManager({
      allowedRoots: () => this.projects().map((p) => p.dir),
      ...(options.claudePath ? { claudePath: options.claudePath } : {}),
      ...(options.spawnCoding ? { spawnFn: options.spawnCoding } : {}),
      onLog: (line) => this.log(line),
    });
    this.coding.on("started", (job: CodingJob) => this.broadcastJob(job));
    this.coding.on("finished", (job: CodingJob) => {
      // Fire and forget on purpose: the check runs a test suite, which takes
      // minutes. Awaiting it here would block the manager's event loop turn and,
      // through it, the runtime — the exact thing background jobs exist to avoid.
      void this.checkFinishedJob(job);
    });

    this.machine = new AssistantStateMachine();

    // The notifier before the watcher, which pushes through it.
    //
    // The level is read from config unless a caller overrides it, and the sink
    // defaults to the IPC broadcast — so a runtime with no UI attached still
    // *decides* correctly, it just has nowhere to draw. That is deliberate: the
    // cooldown is recorded either way, so attaching a HUD does not replay
    // yesterday's conditions as if they were new.
    this.notifier = new Notifier({
      level:
        options.notifyLevel ??
        parseNotifyLevel(loadConfig(undefined, (m) => this.log(m)).notifyLevel) ??
        "minimal",
      sink:
        options.notifySink ??
        ((n) => this.broadcast({ type: "notification", notification: n })),
      now: () => Date.now(),
    });

    this.tasks = new TaskWatcher({
      notifier: this.notifier,
      ...(options.cronDir === undefined ? {} : { dir: options.cronDir }),
      ...(options.taskPollMs === undefined ? {} : { pollMs: options.taskPollMs }),
      onLog: (line) => this.log(line),
    });

    // Before the local engine, which holds a reference to it. Opening a JSON
    // file is not work worth deferring, and "remember that…" is a plausible
    // first sentence after a restart.
    this.memory = new MemoryStore({
      ...(options.memoryPath === undefined ? {} : { path: options.memoryPath }),
      onError: (m) => this.log(m),
    });

    // The other three stores, and the index over two of them. Same directory, same
    // atomic-write discipline, same "corrupt is empty plus a log line" rule.
    const dir = options.memoryDir ?? memoryDir();
    this.episodes = new EpisodicStore({
      path: joinPath(dir, "episodes.json"),
      onError: (m) => this.log(`memory: ${m}`),
    });
    this.profile = new ProfileStore({
      path: joinPath(dir, "profile.json"),
      onError: (m) => this.log(`memory: ${m}`),
    });
    this.learning = new LearningQueue({
      memory: this.memory,
      profile: this.profile,
      path: joinPath(dir, "proposals.json"),
      onError: (m) => this.log(`memory: ${m}`),
    });
    // An embedder is chosen from the environment, not probed: a boot that waited on a
    // dead port would cost the always-on process its start-up time for a subsystem
    // nothing is waiting on. With nothing configured this is the local lexical one,
    // and the reason line says so in those words.
    const chosenEmbedder = options.embedder
      ? { embedder: options.embedder, reason: `${options.embedder.name} — injected` }
      : createEmbedder({ env: this.loadedEnv() });
    this.embedderReason = chosenEmbedder.reason;
    this.log(`memory: ${chosenEmbedder.reason}`);
    this.vectors = new VectorIndex({
      path: joinPath(dir, "vectors.json"),
      embedder: chosenEmbedder.embedder,
      onError: (m) => this.log(`memory: ${m}`),
    });
    this.proactiveQueue = new ProactiveQueue({
      path: joinPath(options.worldDir ?? worldDir(), "proposals.json"),
      onError: (m) => this.log(`world: ${m}`),
    });

    this.retriever = new Retriever({
      memory: this.memory,
      episodes: this.episodes,
      profile: this.profile,
      vectors: this.vectors,
      // Read at call time, so the switch takes effect on the next retrieval rather
      // than on the next restart.
      enabled: () => this.memoryEnabled(),
      now: () => Date.now(),
    });

    const { enabled, ...voiceOptions } = options.voice ?? {};
    this.voiceEnabled = enabled !== false;
    this.voice = new VoiceSidecar({
      ...voiceOptions,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      onLog: (line) => this.log(line),
    });
    this.wireVoice();

    // After the sidecar, because mic mute is routed to it rather than to a
    // Windows device: muting the OS input would silence every other application
    // on the machine, which is not what "mute the microphone" means to someone
    // talking to Jarvis.
    //
    // Hoisted into a variable rather than written inline because a mission step
    // reaches the same executors: `run_local_intent` needs an `ExecutorDeps`, and
    // building a second one here would be a second set of answers to "what is the
    // microphone" and "where may a screenshot be written".
    const localDeps: EngineDeps = {
      run: nodeRunner,
      launch: nodeLauncher,
      screenshotRoots: defaultScreenshotRoots(),
      now: () => new Date(),
      setMicMuted: (m) => {
        const sent = this.voice.setMuted(m);
        if (sent) this.muted = m;
        return sent;
      },
      isMicMuted: () => this.muted,
      // The one local intent that reaches the internet, and it is allowed to
      // because it degrades to something that works: with no answer, `media.play`
      // opens YouTube's results page and says so. Wired here rather than
      // constructed in the executors so that file keeps its property of touching
      // the world through `run` and `launch` alone.
      findTrack: (query) => findYouTubeVideo(query, { log: (line) => this.log(line) }),
      // One reader for the runtime's lifetime, so its short cache actually
      // spans the two questions a person asks in one breath. It holds no
      // handle and starts no timer, so an idle runtime reads nothing.
      readActiveWindow: () => this.activeWindow.read(),
      // The intent calls this function when it needs the registry, which is
      // when the scan happens — lazy, and fresh on every ask.
      projects: () => this.projects(),
      // So "no projects" can distinguish an empty scan from an unconfigured
      // one. Reads config rather than caching it: the roots are only consulted
      // when a user asks a question that turns on the difference.
      projectRoots: () => this.configuredRoots(),
      // The consent gate, not the camera: an executor reaching this has still
      // not taken a picture, and cannot take one without a human saying yes.
      captureScreen: (req) => this.screen.captureOnce(req),
      // Asked *before* consent, so the user is never talked into being
      // photographed for an agent that would discard the image.
      agentAcceptsImages: () => this.supervisor.acceptsImages,
      // Jarvis' own store. Hermes' files are reachable through the next line
      // and are read-only there — `hermes-memory.ts` has no write path.
      memory: this.memory,
      // Read per ask rather than cached: Hermes writes these during its own
      // turns, so a value captured at boot would be stale the first time the
      // agent learned something.
      hermesMemory: () => readHermesMemory(),
      skills: () => this.skills(),
      // Read per ask, and never from the watcher's cache: half the answer is
      // "how long ago did that happen", which is wrong the moment it is
      // stored. The read is a few hundred bytes of JSON.
      tasks: () => this.taskSnapshot(),
      // Read per ask, like the tasks above and for the same kind of reason:
      // the user may run `hermes mcp add` in a terminal while Jarvis is
      // running, and the next question about it should reflect that rather
      // than the file as it looked at boot.
      mcp: () => this.mcpSnapshot(),
      ...options.localDeps,
    };

    this.localIntents = new LocalIntentEngine(localDeps, {
      // Discovery is lazy inside the engine, so a slow disk cannot delay the
      // runtime becoming reachable.
      catalog: { startMenuRoots: defaultStartMenuRoots(), readDir: readDirSync },
      ...options.localIntents,
      onAudit: (d) => {
        this.auditLocal(d);
        options.localIntents?.onAudit?.(d);
      },
    });

    // After the local engine, whose catalog and executors the tool registry
    // borrows. Nothing here starts a timer or touches the disk beyond opening the
    // mission directory: an idle runtime with no mission running costs what it
    // cost before this phase existed (§7).
    const stack = this.buildMissionStack(localDeps);
    this.missionStore = stack.store;
    this.missionPermissions = stack.permissions;
    this.tools = stack.tools;
    this.missions = stack.orchestrator;
    this.llm = stack.llm;

    this.machine.on("state", (s: string) => {
      this.broadcast({ type: "state", state: s });
      this.emit("state", s);
    });

    this.supervisor.on("state", () => this.broadcastStatus());
    this.supervisor.on("crash", (e: string) => {
      this.log(`hermes crashed: ${e}`);
      this.broadcast({ type: "error", message: `Hermes crashed: ${e}`, fatal: false });
      this.broadcastStatus();
    });
    this.supervisor.on("gave-up", (reason: string) => {
      // A permanent failure is worth saying plainly rather than retrying forever.
      this.broadcast({
        type: "unavailable",
        subsystem: "hermes",
        reason,
      });
      this.broadcastStatus();
    });
    this.supervisor.on("ready", () => this.broadcastStatus());
  }

  // --- missions ------------------------------------------------------------

  /**
   * The mission layer, built in one place.
   *
   * A method rather than fifty more lines of constructor, and it returns its
   * pieces instead of assigning them so that the fields stay `readonly` — a
   * mission stack that can be swapped out at runtime is a mission stack whose
   * permission engine can be swapped out at runtime.
   *
   * What is *not* here is as deliberate as what is. No second consent path: the
   * engine below asks through the same broker the conversation uses, so a mission's
   * questions appear in the same dialog, are subject to the same timeout, and are
   * cancelled by the same `cancelAll` on shutdown.
   *
   * The planner is the model's when there is one and the table's when there is not,
   * and the mission says which on the wire (§32). Both are real planners; neither is
   * a stub for the other.
   */
  private buildMissionStack(localDeps: EngineDeps): {
    store: MissionStore;
    permissions: PermissionEngine;
    tools: ToolRegistry;
    orchestrator: MissionOrchestrator;
    llm: { provider: LLMProvider; reason: string };
  } {
    const store = new MissionStore({
      ...(this.options.missionDir === undefined ? {} : { dir: this.options.missionDir }),
      onError: (m) => this.log(`missions: ${m}`),
    });

    // The ask an injected one wins over, so a test can answer for the user
    // without also having to know how the correlation below works.
    const baseAsk = this.options.permissions?.ask ?? this.consent.ask;
    const permissions = new PermissionEngine({
      ...this.options.permissions,
      // Recorded before delegating: this is the only place the runtime learns
      // which consent request belongs to which step, and it is exact because
      // nothing but a mission step reaches this function.
      ask: (ctx) => {
        if (this.missionAsk) this.missionAsk.requestId = ctx.requestId;
        return baseAsk(ctx);
      },
      // The user's own per-class policy, or nothing at all — in which case the
      // engine's level rule decides, exactly as it does for a conversation.
      // Settings first, config file second: a choice made in this session is the
      // more recent statement of intent, and it is labelled as temporary where it
      // is shown. Read per call rather than captured, so a change takes effect on
      // the next step instead of on the next boot.
      policy: (c) => this.sessionPolicy.get(c.category) ?? this.missionConfig().policy?.[c.category],
      onAudit: (e) => {
        this.onPermissionAudit(e);
        this.options.permissions?.onAudit?.(e);
      },
    });

    const tools = buildToolRegistry({
      localIntents: {
        // The same deps the spoken path uses, plus the catalog map the engine
        // already built from its own entries.
        executorDeps: { ...localDeps, apps: this.localIntents.appMap },
        intentContext: () => this.localIntents.intentContext(),
      },
      projects: () => this.projects(),
      projectRoots: () => this.configuredRoots(),
      memory: this.memory,
      // The Phase 16 layers, each gating its own tool in `default-tools.ts`. The
      // retriever is the one a plan actually reaches for: `get_relevant_context` is a
      // level-0 read, so a mission consults what Jarvis knows without a dialog.
      retriever: this.retriever,
      episodes: this.episodes,
      profile: this.profile,
      // A mission may *propose*. `save_memory_suggestion` writes a question to the
      // queue and nothing to a store; only the user's own window can accept one.
      learning: this.learning,
      run: this.options.runTool ?? nodeProcessRunner,
      // The exceptions to the private-address guard, and nothing else about the
      // network is configurable: a plan cannot add a host, and neither can a model.
      webAllowHosts: () => this.options.webAllowHosts ?? this.missionConfig().webAllow,
      // What makes "open antigravity and tell it to build X" a thing Jarvis can
      // do rather than a thing it apologises about. Two tools: one that names
      // the editors actually installed, one that hands a task to the best of
      // them. `delegate` is a closure over `startCoding` on purpose — the
      // headless route must keep the snapshot, the concurrency cap, the spend
      // ceiling and the after-the-fact work check, and a second entry point
      // into `this.coding` would quietly have none of them.
      codingPlatforms: {
        dataDir: dirname(configFilePath()),
        launch: nodeLauncher,
        delegate: async (task, project) => {
          const job = await this.startCoding(task, project);
          return { id: job.id, detail: `job ${job.id} started in ${job.cwd}` };
        },
      },
      ...(this.options.commsStore ? { commsStore: this.options.commsStore } : {}),
    });

    const configured = this.missionConfig().maxSteps;
    const llm = this.buildProvider();
    const log = (line: string) => this.log(`mission: ${line}`);
    const orchestrator = new MissionOrchestrator({
      registry: tools,
      planner:
        this.missionConfig().llmPlanner && llm.provider.available
          ? new LlmPlanner({
              provider: llm.provider,
              // The registry it will plan against, so the prompt lists the tools that
              // actually exist here and the validator rejects everything else.
              registry: tools,
              fallback: new DeterministicPlanner(),
              log,
            })
          : new DeterministicPlanner(),
      // Diagnosis is not gated on `llmPlanner`: reading a build failure is useful even
      // to someone who wants the table to decide what runs, and the LLM replanner
      // keeps the deterministic one as its floor for every cause but two.
      replanner: llm.provider.available
        ? new LlmReplanner({ provider: llm.provider, fallback: new DeterministicReplanner(), log })
        : new DeterministicReplanner(),
      permissions,
      projects: () => this.projects(),
      // Read per call, so a project cloned after boot is a place a mission may
      // work. Never from a step: the whole point of a root is that the thing
      // being confined does not choose it.
      roots: () => this.missionRoots(),
      // Jarvis' own memory, as facts rather than as instructions — ranked and fused
      // across memories, episodes and the profile (`memory/retrieval.ts`).
      retrieve: (objective) => this.missionMemory(objective),
      now: () => Date.now(),
      log: (line) => this.log(`mission: ${line}`),
      observe: (u) => this.onMissionUpdate(u),
      limits: {
        ...(configured === undefined ? {} : { maxSteps: configured }),
        ...this.options.missionLimits,
      },
    });

    return { store, permissions, tools, orchestrator, llm };
  }

  /**
   * The model, chosen once at boot.
   *
   * `.env` is read from the working directory — which for a packaged Jarvis started
   * from `C:\Windows\system32` means no file and no model, rather than someone else's
   * — and the process environment wins over it, so a key exported in the shell that
   * launched Jarvis is the key used. Only the count of applied settings is logged,
   * never a name and never a value.
   *
   * Hermes is offered as a last resort and guarded twice: it must be ready, and the
   * assistant must not be mid-turn. The session is shared with the conversation, so a
   * plan request sent while Hermes is answering a person would collide with that turn
   * — and a planner that can interrupt a conversation is not worth a planner.
   */
  /**
   * `.env` plus the process environment, read once for the whole process.
   *
   * Once rather than per caller because two readers would log "applied 3 settings"
   * twice for one file, and because the embedder and the completion provider are
   * configured by overlapping keys — reading the file twice leaves room for them to
   * disagree if it changed in between, which is a difference nothing on screen would
   * explain.
   *
   * `loadEnv` reads from the working directory, so a packaged Jarvis started from
   * `C:\Windows\system32` finds no file rather than somebody else's.
   */
  private loadedEnv(): Readonly<Record<string, string>> {
    if (!this.envCache) {
      this.envCache = loadEnv(process.cwd(), (line) => this.log(`env: ${line}`));
    }
    return this.envCache;
  }

  private buildProvider(): { provider: LLMProvider; reason: string } {
    const env = this.loadedEnv();
    const chosen = createProvider({
      settings: this.missionConfig().llm,
      env,
      hermes: {
        ask: async (prompt: string) => {
          let text = "";
          const stopReason = await this.supervisor.streamMessage(prompt, (e) => {
            if (e.kind === "text") text += e.text;
          });
          return { text, stopReason };
        },
        ready: () =>
          this.supervisor.isReady() &&
          (this.machine.state === "idle" || this.machine.state === "conversation"),
      },
      log: (line) => this.log(`llm: ${line}`),
    });
    this.log(`llm: ${chosen.reason}`);
    return chosen;
  }

  /**
   * The tool inventory and the policy over it, in one answer (§42).
   *
   * Every class is listed, including the ones no tool here classifies as, because
   * the policy is applied to what a call *turns out* to be: a step that reaches a
   * system path is a `delete` whatever tool ran it, and a panel that hid the class
   * until something used it would hide it exactly until it mattered.
   *
   * `typicalLevel` is the tool's classification with no arguments and is labelled as
   * typical wherever it is shown. The two numbers at the end come from the engine
   * that will actually decide, not from the constants: an engine constructed with a
   * different ceiling would otherwise be described by a panel reading this one's.
   */
  /**
   * The demo workspace, inspected and held.
   *
   * Read through this everywhere, so the two roots methods and the view all agree
   * within one request rather than each stat'ing the disk at a slightly different
   * moment and disagreeing about whether a fixture exists.
   */
  private demoState(): DemoWorkspaceState {
    if (this.demoCache) return this.demoCache;
    this.demoCache = inspectDemoWorkspace({ log: (m) => this.log(m) });
    return this.demoCache;
  }

  /**
   * The demo root, but only once it has actually been prepared.
   *
   * Gated on the marker file rather than on the directory, and that is the whole
   * point: an unprepared demo widens nothing. A mission on a machine where nobody
   * pressed Prepare can reach exactly what it could reach before this file existed,
   * so the §28 fixtures are a root a user opted into and not a permanent extra
   * corner of the disk that missions may write to.
   */
  private demoRoots(): readonly string[] {
    const state = this.demoState();
    return state.prepared ? [state.root] : [];
  }

  /**
   * The four scenarios, assessed against what this build can really do.
   *
   * Every input is a fact read here and now — the fixtures from disk, the tools from
   * the registry that is actually loaded, the planner from the provider's own health,
   * the busy flag from the orchestrator. None of it is declared by the catalogue,
   * which is why a scenario cannot claim to be runnable on a machine that cannot run
   * it (§43).
   */
  private demoView(): DemoView {
    const state = this.demoState();
    const facts: DemoFacts = {
      fixtures: state.present,
      tools: this.tools.list().map((t) => ({ name: t.name, simulated: t.simulated })),
      llmPlanner: this.missionConfig().llmPlanner && this.llm.provider.health().available,
      missionRunning: this.missions.running().length > 0,
    };
    return {
      root: state.root,
      prepared: state.prepared,
      fixtures: state.fixtures.map((f) => ({
        fixture: f.fixture,
        files: f.files,
        installed: f.installed,
      })),
      scenarios: assessDemos(facts).map((a) => ({
        id: a.scenario.id,
        ordinal: a.scenario.ordinal,
        title: a.scenario.title,
        objective: a.scenario.objective,
        sections: [...a.scenario.sections],
        watch: a.scenario.watch,
        stages: [...a.scenario.stages],
        caveat: a.scenario.caveat ?? null,
        runnable: a.runnable,
        blockers: a.blockers.map((b) => ({ kind: b.kind, detail: b.detail })),
        mocked: [...a.mocked],
        missing: [...a.missing],
      })),
    };
  }

  private toolsView(): ToolsView {
    const configured = this.missionConfig().policy;
    const policy: ToolPolicyEntry[] = RISK_CATEGORIES.map((category) => {
      const session = this.sessionPolicy.get(category);
      const fromFile = configured?.[category] ?? null;
      return {
        category,
        effective: session ?? fromFile ?? "default",
        source: session !== undefined ? "session" : fromFile !== null ? "config" : "default",
        configured: fromFile,
      };
    });
    return {
      tools: this.tools.list().map((t) => ({
        name: t.name,
        summary: t.summary,
        typicalLevel: t.typicalLevel,
        category: t.category,
        simulated: t.simulated,
        // Which faculty owns the tool, from the table in `agents/roles.ts`. Read off
        // the registry that is actually loaded, so a tool a missing dependency left
        // out of the build is absent from its role rather than listed as available.
        role: attributeTool(t).role,
      })),
      policy,
      autoAllowUpTo: this.missionPermissions.autoAllowsUpTo(),
      autoCeiling: NO_ALWAYS_ABOVE,
    };
  }

  /**
   * The three mission keys from the config file, read once and held.
   *
   * Same rule as `configuredRoots`: this is a boot-time decision, and re-reading
   * per step would let a half-saved edit be observed mid-write — which for
   * `missionPolicy` would mean a step deciding its own permission from a file
   * that was momentarily missing a line.
   */
  private missionConfig(): {
    roots: readonly string[];
    maxSteps: number | undefined;
    policy: Readonly<Record<string, "auto" | "approval" | "deny">> | undefined;
    webAllow: readonly string[];
    llm: LlmSettings;
    llmPlanner: boolean;
    memoryEnabled: boolean;
  } {
    if (this.missionConfigCache) return this.missionConfigCache;
    const config = loadConfig(undefined, (m) => this.log(m));
    this.missionConfigCache = {
      roots: this.options.missionRoots ?? config.missionRoots ?? [],
      maxSteps: config.maxMissionSteps,
      policy: config.missionPolicy,
      webAllow: config.webAllowHosts ?? [],
      llm: {
        ...(config.llmProvider === undefined ? {} : { provider: config.llmProvider }),
        ...(config.llmModel === undefined ? {} : { model: config.llmModel }),
        ...(config.llmBaseUrl === undefined ? {} : { baseUrl: config.llmBaseUrl }),
        ...(config.llmVision === undefined ? {} : { vision: config.llmVision }),
        ...(config.llmTimeoutMs === undefined ? {} : { timeoutMs: config.llmTimeoutMs }),
      },
      // Default on: a configured model that is never asked to plan is a model the
      // user paid for and cannot tell is working. Turning it off is one key.
      llmPlanner: config.llmPlanner !== false,
      // Default on as well, and for a plainer reason: an assistant that remembers
      // nothing is the chatbot this project exists not to be. Off is a choice a
      // person makes, in the file or in the window, and it is reported either way.
      memoryEnabled: config.memoryEnabled !== false,
    };
    return this.missionConfigCache;
  }

  /**
   * Whether the memory layer may be used, session override first.
   *
   * The same precedence `set_tool_policy` uses and for the same reason: a choice made
   * in this session is the more recent statement of intent, and the view labels it as
   * temporary where it is shown.
   */
  private memoryEnabled(): boolean {
    return this.memoryEnabledOverride ?? this.missionConfig().memoryEnabled;
  }

  /**
   * Where a mission's steps may act.
   *
   * `missionRoots` when the user wrote them down, and the projects they nominated
   * otherwise — narrower than the project *roots*, which are directories to scan
   * rather than directories to work in. Nothing falls back to the whole disk: a
   * user who has configured nothing has a mission that can read the clock and
   * little else, which is the honest consequence of configuring nothing.
   */
  private missionRoots(): readonly string[] {
    const configured = this.missionConfig().roots;
    const base = configured.length > 0 ? configured : this.projects().map((p) => p.dir);
    // Added to whatever the user configured, never substituted for it, and only while
    // the demo is prepared. It has to be the root itself rather than the fixture
    // directories: two of the three are projects and would arrive through
    // `projects()` anyway, but the inbox has no marker file and is not a project —
    // and scenario 4 is the one that writes and deletes inside it.
    return [...base, ...this.demoRoots()];
  }

  /**
   * What a mission is told before it plans.
   *
   * Phase 13 shipped this as `selectMemories` over the memory store — a keyword match
   * with a recency tiebreak, behind the orchestrator's `retrieve` hook. Phase 16
   * replaces the body and keeps the hook, which is the whole reason the hook exists:
   * the orchestrator is failure-tolerant here by design, so a retrieval layer that
   * throws leaves a mission uninformed rather than broken.
   *
   * What travels is four layers ranked and fused (`memory/retrieval.ts`), each row
   * labelled with the method that found it. Still facts, still fenced as data by
   * `memory-prompt.ts` before a model sees them, and still never an instruction (§52).
   *
   * The index is synced first. A memory saved thirty seconds ago has no vector until
   * something asks for one, and the mission about to plan against it is exactly that
   * ask; `sync` embeds only what changed, so the normal case is a hash comparison over
   * a few hundred short rows.
   */
  private async missionMemory(objective: string): Promise<readonly MissionMemoryRef[]> {
    if (!this.memoryEnabled()) return [];
    try {
      const report = await this.retriever.sync();
      if (report?.degraded) this.log(`memory: index not updated — ${report.reason ?? "embedder failed"}`);
      const result = await this.retriever.retrieve(objective);
      return toMemoryRefs(result.facts);
    } catch (err) {
      // Retrieval is an input to a plan, not a step of one. A mission that plans with
      // nothing remembered is worse than one that plans with everything; a mission
      // that fails to start because a JSON file was unreadable is worse than both.
      this.log(`memory: retrieval failed, planning without it: ${err}`);
      return [];
    }
  }

  /**
   * Bring the vector index back in line with the stores, after a write.
   *
   * Called by every handler that changed an indexable row rather than left to the
   * next retrieval, so that "I saved that" and "similarity search can find it" are
   * the same moment. It never throws: an unreachable embedder is a degraded index
   * and a log line, not a failed save — the row is already on disk, and reporting
   * the write as a failure would be a lie about what happened.
   */
  private async syncVectors(): Promise<void> {
    try {
      const report = await this.retriever.sync();
      if (report?.degraded) {
        this.log(`memory: index not updated — ${report.reason ?? "embedder failed"}`);
      }
    } catch (err) {
      this.log(`memory: index sync failed after a write: ${err}`);
    }
  }

  /**
   * One mission update: recorded, then broadcast.
   *
   * Recorded first on purpose. The store is what survives a crash, and a renderer
   * that received a step the disk never heard about would be showing something no
   * later report could account for.
   *
   * The whole mission goes out with every update rather than a delta, because a
   * window opened halfway through a mission has to be able to draw the graph from
   * the first message it sees.
   */
  private onMissionUpdate(update: MissionUpdate): void {
    this.missionStore.record({
      mission: update.mission,
      at: update.at,
      ...(update.event !== undefined ? { event: update.event } : {}),
      ...(update.step !== undefined ? { step: update.step } : {}),
      ...(update.note !== undefined ? { note: update.note } : {}),
      ...(update.voice !== undefined ? { voice: update.voice } : {}),
    });

    // The step this mission is parked on, so `approve_step` has something to
    // answer. Cleared by the next update whatever it is: the engine has decided
    // by then, and a stale pairing is what would let a click land on the wrong
    // question.
    if (update.event === "need_approval" && update.step) {
      this.missionAsk = {
        missionId: update.mission.id,
        stepId: update.step.id,
        requestId: null,
      };
    } else if (update.event !== undefined && this.missionAsk?.missionId === update.mission.id) {
      this.missionAsk = null;
    }

    this.broadcast({ type: "mission", mission: toMissionView(update.mission) });
    if (update.step) {
      this.broadcast({
        type: "mission_step",
        missionId: update.mission.id,
        step: toMissionStepView(update.step),
      });
    }
    if (update.note !== undefined || update.event !== undefined) {
      this.broadcast({
        type: "mission_event",
        missionId: update.mission.id,
        at: update.at,
        ...(update.event !== undefined ? { transition: update.event } : {}),
        note: update.note ?? update.mission.state,
        ...(update.voice !== undefined ? { voice: update.voice } : {}),
      });
    }
    // The count in `RuntimeStatus` changes on the first and last update of every
    // mission, and the HUD's own line is drawn from it.
    if (update.event === undefined || isTerminal(update.mission.state)) this.broadcastStatus();
  }

  /**
   * Start a mission, and refuse to start a second one.
   *
   * One at a time, for the reason the orchestrator runs its own steps in series:
   * two loops asking for consent at once is two dialogs racing, and the answer a
   * user gives is to whichever one they can see. It also keeps
   * `approve_step` answerable — the pairing above has room for one question —
   * and `missions.running` honest at 0 or 1.
   */
  private async runMission(objective: string): Promise<Mission> {
    const mission = await this.missions.run(objective);
    this.recordMissionEpisode(mission);
    this.broadcastStatus();
    // A mission finishing is the one moment the world demonstrably changed: a
    // project was built, a job was read, something failed. Assembling the graph
    // here — and nowhere on a timer — is what lets Jarvis notice a project it left
    // failing without watching the machine for a living (§7).
    //
    // Fire-and-forget, and deliberately after `return`-worthy work is done: the
    // mission has finished, and failing to have an opinion about it afterwards must
    // not turn a completed mission into a rejected promise.
    void this.assembleWorld()
      .then((world) => this.proposeFromWorld(world, { notify: true }))
      .catch((err) => this.log(`world: could not look for anything to suggest: ${err}`));
    return mission;
  }

  /**
   * The voice-and-vision door to a mission: hear one, offer it, start it if told to.
   *
   * Returns true when the turn is over — an offer made, an answer taken, a refusal
   * spoken — and false when the utterance had nothing to do with missions, which is
   * the overwhelmingly common case and leaves the caller's routing exactly as it was
   * before this existed.
   *
   * Called from both turn paths, and deliberately *after* the local engine has had
   * its refusal. That order is what keeps "look at this and tell me what is wrong" a
   * local read: it costs one capture and one sentence and finishes in the turn it was
   * asked in, and shadowing it with a mission would answer a question nobody asked.
   * The phrases that reach here are the ones asking for the world to be different
   * afterwards.
   *
   * Inside, the gates are in the only order they can be in. A pending offer owns the
   * next yes or no, so it is consulted before any trigger can match — otherwise
   * "yes" would be a fresh utterance every time and no offer could ever be accepted.
   */
  private async tryMission(text: string, aloud: boolean): Promise<boolean> {
    const offer = this.pendingMission;
    if (offer !== null) {
      const answer = readConfirmation(text);
      if (Date.now() - offer.at > MISSION_OFFER_TIMEOUT_MS) {
        this.pendingMission = null;
        this.log("mission: the offer expired unanswered");
        // A yes or a no to a question that has gone stale is worth saying so about,
        // because it is an answer with nothing left to answer. Anything else is a
        // new utterance and routes from scratch.
        if (answer !== null) {
          this.answerWithoutAgent(OFFER_EXPIRED, aloud);
          return true;
        }
      } else if (answer === "yes") {
        this.pendingMission = null;
        return this.startOfferedMission(offer.objective, aloud);
      } else if (answer === "no") {
        this.pendingMission = null;
        this.log("mission: the offer was declined");
        this.answerWithoutAgent(OFFER_DECLINED, aloud);
        return true;
      } else {
        // Neither side named. Dropped rather than re-asked, which is the rule
        // `resolvePending` already follows for a spoken clarification: insisting on
        // an answer to a question the user has moved on from is worse than letting
        // their new request through. Silently, because what they should hear next is
        // the answer to what they just said — and the log keeps the fact that an
        // offer was made and never taken.
        this.pendingMission = null;
        this.log("mission: the offer was dropped, the utterance was not an answer");
      }
    }

    const heard = readMissionRequest(text);
    if (heard === null) {
      if (!isEmptyMissionRequest(text)) return false;
      // A mission was asked for and never named. Said rather than passed on, because
      // an agent handed "start a mission to" would answer a question about missions
      // instead of noticing that one had been requested and had no objective.
      this.answerWithoutAgent(NOTHING_TO_DO, aloud);
      return true;
    }

    if (heard.kind === "objective") {
      this.log(`mission: heard "${heard.trigger}" and offered the objective back`);
      this.offerMission(heard.objective, "objective", aloud, offerSentence(heard.objective));
      return true;
    }

    // "Fix this." Nothing is known yet — not even whether there is anything on the
    // screen worth doing — so this is the one branch that spends a capture before it
    // has anything to offer. `proposeFromScreen` decides whether that is worth doing
    // and refuses first when it is not.
    this.log(`mission: heard "${heard.trigger}", so it needs to look at the screen`);
    const outcome = await this.lookForObjective(heard.ask, "voice");
    if (outcome.kind === "refused") {
      this.log(`mission: no objective from the screen — ${outcome.note}`);
      this.answerWithoutAgent(outcome.speech, aloud);
      return true;
    }
    this.log(
      `mission: ${outcome.model} proposed an objective from the screen in ${outcome.ms}ms`,
    );
    this.offerMission(
      outcome.proposal.objective,
      "vision",
      aloud,
      proposalSentence(outcome.proposal),
    );
    return true;
  }

  /**
   * One look at the screen, for whichever door asked.
   *
   * Both doors go through here so there is one place that spends a capture, one place
   * that pushes the result, and one set of dependencies handed to `proposeFromScreen`
   * — the alternative is two call sites that drift, and the one that drifts silently
   * is the one that forgets to pass `capture` through the consent gate.
   *
   * Every outcome is broadcast, refusals included. A window open beside a spoken "fix
   * this" is the case this exists for: the whole content of a spoken offer is a
   * sentence that gets read out once, and an objective proposed from a screenshot is
   * exactly the kind of thing a user should be able to read before agreeing to it.
   *
   * Nothing is started here and nothing is remembered. The offer the voice path keeps
   * lives in `pendingMission`; a window's proposal is held by the window, and its
   * Start button sends `start_mission` like any other.
   */
  private async lookForObjective(
    ask: string,
    source: "voice" | "window",
  ): Promise<VisionOutcome> {
    const outcome = await proposeFromScreen(ask, {
      reader: this.llm.provider,
      capture: (request) => this.screen.captureOnce(request),
      log: (line) => this.log(line),
    });
    this.broadcast({
      type: "vision_proposal",
      proposal: toVisionProposalView(outcome, source, Date.now()),
    });
    return outcome;
  }

  /**
   * Say an offer, show it, and remember it for exactly one answer.
   *
   * Nothing is running when this returns. The field it sets is the only route from a
   * heard sentence to a started mission, which is the shape `resolve_proposal` gives
   * a proactive suggestion for the same reason: a system that could reach its own
   * accept path is a system that acts on its own conclusions.
   */
  private offerMission(
    objective: string,
    heard: "objective" | "vision",
    aloud: boolean,
    sentence: string,
  ): void {
    this.pendingMission = { objective, at: Date.now(), heard, aloud };
    this.answerWithoutAgent(sentence, aloud);
  }

  /**
   * Start a mission the user has just agreed to out loud.
   *
   * Not awaited, and that is the whole design of this function. A mission is bounded
   * but it is bounded in minutes: holding the turn open for one would leave the
   * microphone dead, the conversation window shut, and a barge-in with nothing to
   * interrupt. So the turn ends on the acknowledgement, and the account arrives when
   * there is something to account for.
   */
  private startOfferedMission(objective: string, aloud: boolean): boolean {
    const busy = this.missions.running()[0];
    if (busy !== undefined) {
      // The same refusal `start_mission` gives, for the same reason: two loops
      // asking for consent at once is two dialogs racing, and the answer lands on
      // whichever one the user can see. A spoken yes is not a privileged way in.
      this.log(`mission: not starting a second one, ${busy} is still running`);
      this.answerWithoutAgent(
        "A mission is already running, so I have not started a second one.",
        aloud,
      );
      return true;
    }
    this.log(`mission: starting "${objective}" from an offer the user accepted`);
    void this.runMission(objective)
      .then((mission) => this.reportMissionAloud(mission, aloud))
      .catch((err) => {
        // The loop catches its own steps, so this is for whatever escaped it — and
        // it is said rather than only logged, because the user is owed an end to a
        // mission they were told had started.
        this.log(`mission: the accepted mission did not run: ${err}`);
        this.tell(MISSION_NOT_STARTED, aloud);
      });
    this.answerWithoutAgent(MISSION_STARTED, aloud);
    return true;
  }

  /**
   * Say how a mission went, minutes after the turn that started it ended.
   *
   * Unsolicited speech, so it goes through `say` rather than through a turn: the
   * state machine has no legal `speak` from IDLE, the transition the daemon drives
   * on playback is rejected and ignored, and that is exactly the path the `say`
   * request already takes. Every sentence comes from `buildReport`, which composes
   * from the mission's own recorded steps — there is no branch here that reads a
   * result and characterises it.
   */
  private reportMissionAloud(mission: Mission, aloud: boolean): void {
    const spoken = spokenReport(buildReport(mission, Date.now()));
    this.tell(spoken, aloud);
  }

  /**
   * Show a sentence to every UI, and speak it when this path has a voice.
   *
   * Broadcast either way: a report a user cannot hear because there is no audio
   * device is still a report they are entitled to read.
   */
  private tell(text: string, aloud: boolean): void {
    this.broadcast({ type: "reply_chunk", text });
    this.broadcast({ type: "reply_done", stopReason: "mission" });
    if (aloud && !this.say(text)) this.log("mission: nothing to speak with, so it was only shown");
  }

  /**
   * End a turn that Jarvis answered itself.
   *
   * `route_local` is the honest label: the runtime handled this without the agent,
   * and it is also the transition that makes `speak` and `done` legal from here —
   * UNDERSTANDING has neither, so a turn that skipped it would wedge. The same three
   * steps `tryLocal` takes, in the same order, so an offer reads on screen exactly
   * like any other local reply.
   */
  private answerWithoutAgent(text: string, aloud: boolean): void {
    this.machine.handle("route_local");
    this.broadcast({ type: "reply_chunk", text });
    this.broadcast({ type: "reply_done", stopReason: "local" });
    this.finishLocal(text, aloud);
  }

  /**
   * Write down that a mission happened, and offer whatever it is entitled to teach.
   *
   * Here rather than in `onMissionUpdate` because this must happen exactly once per
   * mission and `run` resolving is the only event that is exactly once — a terminal
   * state can be broadcast more than once, and two episodes for one mission would
   * make the history double-count what Jarvis has actually done.
   *
   * Two things are written and they are not the same kind of thing. The **episode**
   * is a record of an event: it is not a claim about the user, it is what happened,
   * and it is written without asking because the alternative is an assistant with no
   * memory of its own actions. A **lesson** is a claim, so it is only ever *proposed*
   * — `lessonsFromMission` allows exactly one pattern (a step failed, a corrective
   * step verified, the mission completed) and even that waits for the user to accept
   * it. Nothing here writes a memory.
   *
   * Skipped entirely when memory is off. A switch the user turned off must not keep
   * filling the store it hides; they can turn it back on and find what was there,
   * not what accumulated behind it.
   */
  private recordMissionEpisode(mission: Mission): void {
    if (!this.memoryEnabled()) return;
    try {
      const tools = [...new Set(mission.steps.map((s) => s.tool))];
      const finished = mission.finishedAt ?? Date.now();
      this.episodes.record({
        kind: "mission",
        title: mission.objective,
        outcome: mission.state,
        ...(mission.conclusion !== undefined ? { detail: mission.conclusion } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        missionId: mission.id,
        durationMs: Math.max(0, finished - mission.createdAt),
        at: finished,
      });
      for (const lesson of lessonsFromMission({
        id: mission.id,
        objective: mission.objective,
        state: mission.state,
        steps: mission.steps.map((s) => ({
          title: s.title,
          tool: s.tool,
          status: s.status,
          origin: s.origin,
          ...(s.error !== undefined ? { error: s.error } : {}),
        })),
      })) {
        const offered = this.learning.propose(lesson);
        // A refusal is logged and dropped, not retried. `propose` declines things
        // that are transient, duplicated or already saved, and every one of those
        // is a reason not to ask the user about it.
        this.log(
          offered.ok
            ? `memory: suggesting one thing to remember from mission ${mission.id} — waiting for you`
            : `memory: nothing suggested from mission ${mission.id}: ${offered.reason}`,
        );
      }
      // Only the episode is indexable; a proposal is not in a store yet.
      void this.syncVectors();
    } catch (err) {
      // A mission that finished has finished. Failing to write the history of it
      // must not turn a completed mission into a rejected promise.
      this.log(`memory: could not record mission ${mission.id}: ${err}`);
    }
  }


  // --- the world model -------------------------------------------------------

  /**
   * Whether Jarvis may offer work nobody asked for, and why.
   *
   * The reason is part of the answer rather than a log line: an empty suggestion list
   * because the user configured `proactive: "off"` and an empty one because there is
   * nothing worth saying look identical in a window, and only one of them is a
   * feature working correctly.
   */
  private proactiveSetting(): { enabled: boolean; reason: string } {
    const configured = loadConfig(undefined, () => {}).proactive;
    if (configured === "off") {
      return { enabled: false, reason: "off — config.json sets proactive to off" };
    }
    return {
      enabled: true,
      reason: "on — suggestions wait for you to accept them, and nothing runs by itself",
    };
  }

  /**
   * Join the registries into one graph.
   *
   * Assembled on demand and never cached. Everything in it is already held by
   * something else — the project registry, the app catalog, the foreground window, the
   * cron snapshot, the mission log — so the cost is a directory scan the projects cache
   * usually answers and one PowerShell read the window cache usually answers. A cached
   * graph would be a claim about the machine as it was, which is the one thing a world
   * model must not be.
   *
   * A window that cannot be read is `null`, not an error: "I could not tell what you
   * are looking at" leaves a graph with four kinds of node in it, and failing the whole
   * request over the one input that needs a subprocess would make the feature depend on
   * the least reliable thing in it.
   */
  async assembleWorld(): Promise<World> {
    let window: Awaited<ReturnType<ActiveWindow["read"]>> | null = null;
    try {
      window = await this.activeWindow.read();
    } catch (err) {
      this.log(`world: could not read the foreground window: ${err}`);
    }
    const facts = window && window.ok ? window.window : null;
    return buildWorld({
      at: Date.now(),
      projects: this.projects(),
      apps: this.localIntents.catalog,
      ...(facts ? { window: facts } : {}),
      tasks: this.taskSnapshot().jobs,
      missions: this.missionStore.list(MAX_WORLD_MISSIONS),
    });
  }

  /**
   * Raise whatever the graph supports, and queue it.
   *
   * Two callers, both of them real events: a mission finishing, and a window asking
   * what Jarvis can see. Neither is a timer, which is deliberate — see the field
   * comment on `proactiveQueue`.
   *
   * `notify` is false when a window asked, because the person is already looking at
   * the list. When a mission finishes it is true and the notification is `info`, the
   * one category `minimal` drops: a suggestion is the first thing a user turning the
   * volume down wants gone, and `attention` would put it beside a failing job.
   */
  private async proposeFromWorld(
    world: World,
    opts: { notify: boolean },
  ): Promise<readonly ProactiveProposal[]> {
    if (!this.proactiveSetting().enabled) return [];
    const raised: ProactiveProposal[] = [];
    for (const suggestion of suggest(world)) {
      const offered = this.proactiveQueue.propose(suggestion);
      if (!offered.ok) {
        // Declined-before, already-queued and credential-shaped all land here, and
        // all three are reasons not to ask again rather than errors.
        this.log(`world: not suggesting ${suggestion.fingerprint}: ${offered.reason}`);
        continue;
      }
      raised.push(offered.proposal);
      this.log(
        `world: suggesting "${offered.proposal.objective}" (${offered.proposal.rule}) — waiting for you`,
      );
      this.broadcast({ type: "proactive", proposal: toProposalView(offered.proposal) });
      if (opts.notify) {
        this.notifier.notify({
          key: `proactive:${offered.proposal.fingerprint}`,
          category: "info",
          title: "Jarvis has a suggestion",
          body: offered.proposal.objective,
        });
      }
    }
    return raised;
  }

  /**
   * The graph, the focus, the suggestions and the switch, projected for the wire.
   *
   * Public for `probe:world`, which asserts what crosses this: that an edge never
   * travels without its basis, that a steerable derivation says so, and that a
   * project's `dir` appears only in the two lines that are about a directory — the
   * registry's own detail line and an edge saying where a step ran.
   */
  async worldView(opts: { propose: boolean } = { propose: true }): Promise<WorldView> {
    const world = await this.assembleWorld();
    if (opts.propose) await this.proposeFromWorld(world, { notify: false });
    return toWorldView({
      world,
      proposals: this.proactiveQueue.list(),
      proactive: this.proactiveSetting(),
    });
  }

  // --- voice ---------------------------------------------------------------

  /**
   * Translate daemon events into state-machine transitions and UI events.
   *
   * The state machine is the arbiter, not this method: every branch asks it to
   * move and lets it reject illegal transitions. Voice events arrive from the
   * real world and are inherently racy — a late `final` after a cancel, a
   * duplicate wake — and the machine already knows which of those are legal.
   */
  private wireVoice(): void {
    this.voice.on("state", () => this.broadcastStatus());
    this.voice.on("unavailable", (reason: string) => {
      this.broadcast({ type: "unavailable", subsystem: "voice", reason });
      this.broadcastStatus();
    });
    this.voice.on("crash", (how: string) => {
      this.log(`voice daemon crashed: ${how}`);
      this.broadcastStatus();
    });

    this.voice.on("voice-event", (e: VoiceEvent) => {
      switch (e.type) {
        case "ready":
          this.listening = e.capture;
          // A restarted daemon starts with factory settings. Re-apply the
          // user's mute, or a crash silently un-mutes the microphone — the
          // one state where being wrong is a privacy failure, not a bug.
          if (this.muted) this.voice.setMuted(true);
          this.broadcastStatus();
          break;

        case "wake":
          // The acknowledgement the latency budget is measured against. It
          // goes out before any other work so the orb lights immediately.
          this.machine.handle("wake");
          this.broadcast({ type: "state", state: this.machine.state });
          break;

        case "speech_start":
          this.machine.handle("speech_start");
          break;

        case "speech_end":
          this.machine.handle("speech_end");
          break;

        case "final":
          this.broadcast({ type: "transcript", text: e.text, final: true });
          void this.onUtterance(e.text);
          break;

        case "wake_timeout":
          // Woke, nobody spoke. Back to idle without bothering the agent.
          this.machine.handle("timeout");
          break;

        case "barge_in":
          // The user talking over Jarvis wins immediately: stop the reply and
          // cancel the turn behind it, or the answer to the abandoned question
          // arrives on top of the new one.
          this.supervisor.cancel();
          this.speakingTurn = false;
          this.machine.handle("barge_in");
          break;

        case "speaking_start":
          // The acknowledgement is speech with no turn behind it. WAKE_DETECTED
          // has no legal `speak` transition, so driving the machine from here
          // would be rejected anyway; more to the point the wake timeout has to
          // keep running underneath it, because the user still has not spoken.
          if (e.id === WAKE_ACK_ID) break;
          this.machine.handle("speak");
          break;

        case "speaking_done":
          if (e.id === WAKE_ACK_ID) break;
          // SPEAKING ends when playback ends, not when audio was handed over.
          this.machine.handle("spoken");
          this.openConversationWindow();
          break;

        case "speaking_stopped":
          // Saying "Jarvis" over the ack stops it. That is an interrupted
          // greeting, not an interrupted answer, and cancelling here would drop
          // the machine to IDLE just as the user started their command.
          if (e.id === WAKE_ACK_ID) break;
          if (e.reason !== "superseded") this.machine.handle("cancel");
          break;

        case "level":
          this.broadcast({ type: "level", rms: e.rms });
          break;

        case "muted":
          this.muted = e.muted;
          this.listening = e.capturing;
          this.broadcastStatus();
          break;

        case "listening":
          this.listening = e.listening;
          this.broadcastStatus();
          break;

        case "unavailable":
          this.broadcast({
            type: "unavailable",
            subsystem: e.subsystem,
            reason: e.reason,
          });
          this.broadcastStatus();
          break;

        case "error":
          this.broadcast({ type: "error", message: e.message, fatal: e.fatal });
          break;

        default:
          break;
      }
    });
  }

  /**
   * A finished utterance.
   *
   * Everything here treats the transcript as untrusted input (§52): it is
   * whatever was audible near the microphone, which may include a television,
   * a colleague, or a video deliberately trying to drive the assistant. It is
   * passed to Hermes as *data* and never interpreted as a command by the
   * runtime itself.
   *
   * The local engine gets first refusal, and deliberately gets it *before* the
   * Hermes availability check below. "What time is it" and "lock the computer"
   * are supposed to work with the network down and the agent dead; putting the
   * agent check first would make the whole local layer conditional on the thing
   * it exists to be independent of.
   */
  private async onUtterance(text: string): Promise<void> {
    if (!text) {
      // Heard nothing usable. Say nothing rather than guess at an empty turn.
      this.machine.handle("cancel");
      return;
    }

    const local = await this.tryLocal(text);
    if (local.done) return;

    // A mission heard, offered, accepted or declined. After the local engine and
    // before Hermes, because a mission is Jarvis' own loop: an agent turn is not
    // what a spoken objective asks for, and a spoken yes must never reach one.
    if (await this.tryMission(text, true)) return;

    if (!this.supervisor.isReady()) {
      const detail = `Hermes is not available (${this.supervisor.getStatus().state})`;
      this.broadcast({ type: "error", message: detail, fatal: false });
      this.say("Hermes is not available right now.");
      return;
    }

    this.machine.handle("route_agent");
    this.speakingTurn = true;

    let reply = "";
    try {
      const stopReason = await this.streamGuarded(
        this.withMemories(text),
        (ev) => {
          switch (ev.kind) {
            case "text":
              reply += ev.text;
              this.broadcast({ type: "reply_chunk", text: ev.text });
              break;
            case "thought":
              this.broadcast({ type: "thought", text: ev.text });
              break;
            case "tool_call":
              this.broadcast({
                type: "tool_call",
                id: ev.id,
                title: ev.title,
                status: ev.status,
              });
              break;
            default:
              break;
          }
        },
        local.image,
      );
      this.broadcast({ type: "reply_done", stopReason });
    } catch (err) {
      // Read *before* clearing: if a barge-in already cleared it, this turn is
      // no longer ours to speak for. The banner is silent and still belongs on
      // screen, but announcing the failure out loud would land on top of the
      // question the user interrupted with — the same reasoning as the guard
      // below, which the success path gets by checking before it speaks.
      const stillOurs = this.speakingTurn;
      this.speakingTurn = false;
      this.machine.handle("error");
      const failure = this.reportTurnFailure(err);
      // Say something. A red banner is invisible to a user who asked by voice
      // and is not looking at the screen — which is how this was reported.
      if (stillOurs) this.say(failure.speech);
      return;
    }

    // A barge-in during the turn already moved the machine on; speaking the
    // now-stale answer over the user's new question would be the worst
    // possible behaviour.
    if (!this.speakingTurn) return;
    this.speakingTurn = false;

    if (reply.trim()) this.say(reply.trim());
    else {
      this.machine.handle("done");
      this.openConversationWindow();
    }
  }

  /**
   * Where the user said their projects live.
   *
   * Options win over the config file, which is what tests use. Read once and
   * held: the config file is a boot-time decision, and re-reading it per
   * utterance would mean a half-saved edit could be observed mid-write.
   */
  private configuredRoots(): readonly string[] {
    if (this.rootsCache) return this.rootsCache;
    const roots =
      this.options.projectRoots ?? loadConfig(undefined, (m) => this.log(m)).projectRoots ?? [];
    this.rootsCache = roots;
    return roots;
  }


  /**
   * The user's projects, scanned on first ask.
   *
   * Roots come from the options when a caller supplied them, otherwise from the
   * config file. Neither means no scan: the registry is opt-in by design, and
   * an assistant that goes looking for your source code because nobody told it
   * not to is doing something nobody asked for.
   */
  projects(): readonly ProjectEntry[] {
    return this.withRememberedAliases(this.scanProjects());
  }

  /** The disk scan, cached until `rescanProjects`. Carries config aliases only. */
  private scanProjects(): readonly ProjectEntry[] {
    if (this.projectsCache) return this.projectsCache;

    // The demo root is scanned beside the user's, so `find_project` finds the §28
    // fixtures by name through the ordinary registry rather than through a lookup
    // written for the demo. A scenario that needed its own project resolver would be
    // demonstrating that resolver and not the one every other objective uses.
    const roots = [...this.configuredRoots(), ...this.demoRoots()];
    if (roots.length === 0) {
      this.log(`no project roots configured (set projectRoots in ${configFilePath()})`);
      this.projectsCache = [];
      return this.projectsCache;
    }

    const readDir = this.options.readProjectDir ?? readDirEntries;
    // The user's own names for their projects, from the same config file as the
    // roots. Generated aliases cover what a directory name can imply; this
    // covers what it cannot ("the work one").
    const aliases = loadConfig(undefined, (m) => this.log(m)).projectAliases;
    const found = buildRegistry({ roots, readDir, ...(aliases ? { aliases } : {}) });
    this.log(`project registry: ${found.length} project(s) under ${roots.length} root(s)`);
    this.projectsCache = found;
    return found;
  }

  /**
   * Names the user said out loud, folded in beside the ones from config.
   *
   * §68 in one method. "Remember that my portfolio means this project" is a
   * `memory.remember`, so it lands in `memory.json` — and until this existed,
   * that was the end of it: the fact was recalled correctly when *asked*, but
   * only ever reached a model as prompt text, so "open my portfolio" was a slow
   * agent turn instead of the local action §74 says it should be.
   *
   * Applied over the scanned entries rather than passed into `buildRegistry`,
   * because a memory written *after* boot has to take effect without a rescan —
   * §68 says "remember…" and then "open my portfolio" in the same conversation,
   * and re-reading the disk to absorb one sentence would be an odd price.
   * `aliasesFromMemory` does the interpreting and refuses anything that is not
   * an explicit equivalence; see its notes.
   */
  private withRememberedAliases(found: readonly ProjectEntry[]): readonly ProjectEntry[] {
    const entries = this.memory.entriesList();
    if (entries.length === 0 || found.length === 0) return found;

    // Ids, not text: the stamp exists to detect *change*, and it should not be
    // a copy of the user's private notes held in memory (§53). Ids change on
    // both a write and a `forget`, which is the whole event set.
    const stamp = `${found.length}:${entries.map((e) => e.id).join(",")}`;
    if (this.aliasedCache?.stamp === stamp) return this.aliasedCache.list;

    const learned = aliasesFromMemory(
      entries.map((e) => e.text),
      found,
    );
    const names = Object.keys(learned);
    const list = names.length === 0 ? found : applyAliases(found, learned);
    this.aliasedCache = { stamp, list };

    if (names.length > 0) {
      // The names themselves, not the projects they point at: this line goes to
      // a durable log, and which directory a user calls "the client one" is the
      // kind of thing §53 keeps out of it.
      this.log(`project aliases from memory: ${names.length} (${names.join(", ")})`);
    }
    return list;
  }

  /** Forget the scan, so a newly cloned project is found without a restart. */
  rescanProjects(): readonly ProjectEntry[] {
    this.projectsCache = null;
    this.rootsCache = null;
    this.aliasedCache = null;
    return this.projects();
  }

  /**
   * The installed skills, scanned on first ask.
   *
   * Read straight off disk. No `hermes serve`, no session token, and none of the
   * ~3 s the `hermes skills` CLI costs — which also means "what can you do?"
   * still answers when Hermes is down.
   */
  skills(): readonly Skill[] {
    if (this.skillsCache) return this.skillsCache;
    const roots = this.options.skillRoots;
    const found = roots ? loadSkills(roots[0], roots[1]) : loadSkills();
    this.log(`skill catalog: ${found.length} skill(s)`);
    this.skillsCache = found;
    return found;
  }

  /** What Jarvis has been asked to remember. Read-only view, for the HUD and the probe. */
  memories(): readonly MemoryEntry[] {
    return this.memory.entriesList();
  }

  /**
   * Hermes' scheduled jobs, read fresh from disk.
   *
   * Note what this does *not* offer: a way to create, edit or delete a job.
   * Hermes owns `cron/jobs.json` and writes it under a cross-process lock, and a
   * second writer racing its scheduler could lose the user's jobs. Scheduling
   * something new goes through Hermes itself — where `cron/lifecycle_guard.py`
   * also gets to refuse a job that would restart or kill the gateway, a defence
   * a Jarvis-side writer would bypass.
   */
  taskSnapshot(): TaskSnapshot {
    return readTasks(this.options.cronDir, Date.now());
  }

  /** The same snapshot, projected for the wire. Public so the probe can assert what crosses it. */
  tasksView(): TasksView {
    const snapshot = this.taskSnapshot();
    return {
      tasks: snapshot.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        schedule: j.schedule,
        kind: j.kind,
        nextRunAt: j.nextRunAt,
        lastRunAt: j.lastRunAt,
        lastStatus: j.lastStatus,
        lastError: j.lastError,
      })),
      ticker: snapshot.ticker.state,
      willFire: snapshot.willFire,
      ...(snapshot.warning ? { warning: snapshot.warning } : {}),
    };
  }

  /** One line about what is scheduled, for the spoken path. */
  speakTasks(): string {
    return speakTasks(this.taskSnapshot(), Date.now());
  }

  /**
   * The MCP servers Hermes is configured with, read fresh from its `config.yaml`.
   *
   * Read rather than run: `hermes mcp list` costs 1.655 s of Python startup on
   * this machine and prints a table. Note what has no counterpart here — there
   * is no `addMcpServer`. An MCP entry is a command Hermes will spawn with the
   * user's environment, and Hermes screens entries at save time because exactly
   * that was weaponised in the wild (`hermes_cli/mcp_security.py`). A Jarvis-side
   * writer would be a second door past that screening.
   */
  mcpSnapshot(): McpSnapshot {
    return readMcpServers(this.options.hermesConfigPath);
  }

  /**
   * The same snapshot, projected for the wire. Public so the probe can assert
   * what crosses it — specifically that env *values* never do (§53).
   */
  mcpView(): McpView {
    const snapshot = this.mcpSnapshot();
    return {
      servers: snapshot.servers.map((s) => ({
        name: s.name,
        transport: s.transport,
        ...(s.command ? { command: s.command } : {}),
        ...(s.url ? { url: s.url } : {}),
        envNames: [...s.envNames],
        enabled: s.enabled,
        ...(s.includeTools.length > 0 ? { includeTools: [...s.includeTools] } : {}),
        ...(s.excludeTools.length > 0 ? { excludeTools: [...s.excludeTools] } : {}),
        suspicious: [...s.suspicious],
      })),
      configPresent: snapshot.configPresent,
      unparsed: snapshot.unparsed,
    };
  }

  /** One line about what is connected, for the spoken path. */
  speakMcp(): string {
    return speakMcp(this.mcpSnapshot());
  }

  /**
   * Jarvis' memory and a look at Hermes' separate one, projected for the wire.
   *
   * Hermes' side reports counts and bytes, never entry text. Not because those
   * bytes are secret from the user — they are the user's own notes — but because
   * this is the read-only view of a store Jarvis does not own, and a window that
   * renders its contents is one refactor away from a window that offers to edit
   * them. Sizes answer "is it on, and does it know anything?" without that.
   */
  memoryView(): MemoryView {
    const files = readHermesMemory(this.options.hermesMemoryDir);
    const memory = files.find((f) => f.store === "memory");
    const user = files.find((f) => f.store === "user");
    const entries = this.memories();
    const index = this.vectors.describe();
    return {
      entries: entries.map((e) => ({
        id: e.id,
        text: e.text,
        at: e.at,
        ...(e.editedAt !== undefined ? { editedAt: e.editedAt } : {}),
      })),
      maxEntries: MAX_ENTRIES,
      chars: entries.reduce((sum, e) => sum + e.text.length, 0),
      maxChars: MAX_TOTAL_CHARS,
      enabled: this.memoryEnabled(),
      enabledIsSession: this.memoryEnabledOverride !== null,
      profile: profileKeys().map((f) => {
        const fact = this.profile.get(f.key);
        return {
          key: f.key,
          label: f.label,
          hint: f.hint,
          max: f.max,
          ...(fact ? { value: fact.value, source: fact.source, at: fact.at } : {}),
        };
      }),
      episodes: this.episodes.recent(MEMORY_VIEW_EPISODES).map(toEpisodeView),
      episodeCount: this.episodes.count(),
      proposals: this.learning.list().map((p) => ({
        id: p.id,
        at: p.at,
        kind: p.kind,
        text: p.text,
        ...(p.key !== undefined ? { key: p.key } : {}),
        why: p.why,
        ...(p.missionId !== undefined ? { missionId: p.missionId } : {}),
      })),
      embedder: {
        name: index.embedder,
        dims: index.dims,
        semantic: index.semantic,
        rows: index.rows,
        reason: this.embedderReason,
      },
      hermes: {
        present: (memory?.present ?? false) || (user?.present ?? false),
        memoryEntries: memory?.entries.length ?? 0,
        userEntries: user?.entries.length ?? 0,
        bytes: (memory?.chars ?? 0) + (user?.chars ?? 0),
      },
    };
  }

  /** The installed skills, grouped, projected for the wire. */
  skillsView(): SkillsView {
    const skills = this.skills();
    return {
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        category: s.category,
        source: s.source,
      })),
      categories: summariseSkills(skills).map((c) => ({ ...c })),
    };
  }

  /**
   * Which of the configured MCP servers this utterance is about.
   *
   * A ranking, not a gate, and the distinction is load-bearing. ACP's
   * `mcpServers` parameter is additive only — `create_session`
   * (`acp_adapter/session.py:611-622`) enables every server in Hermes'
   * `config.yaml` before Jarvis's params are read, and
   * `_expand_acp_enabled_toolsets` only appends. So there is no wire-level way
   * for Jarvis to narrow a session's tool surface, and this method does not
   * claim to. It answers "which server is this about?" for the spoken reply and
   * the HUD. The only real off switch is `enabled: false` in Hermes' own file.
   */
  rankMcpServers(utterance: string): readonly McpServer[] {
    return selectServers(this.mcpSnapshot().servers, utterance);
  }

  /**
   * The message that actually goes to Hermes: the utterance, with anything
   * relevant the user has asked Jarvis to remember fenced above it.
   *
   * One function for both the spoken and typed paths, so the fence cannot be
   * present on one and missing on the other — a difference nobody would notice
   * until the day it mattered. See `memory/memory-prompt.ts` for why the block is
   * fenced rather than merged into the sentence.
   */
  private withMemories(text: string): string {
    const entries = this.memory.entriesList();
    if (entries.length === 0) return text;
    const picked = selectMemories(entries, text, (q) => this.memory.recall(q));
    return withMemoryContext(text, fenceMemories(picked));
  }

  // --- delegated coding ------------------------------------------------------

  /**
   * Hand a coding task to Claude Code.
   *
   * Returns as soon as the child exists. The answer arrives later as a
   * `coding_job` event, which is the whole requirement: a build takes minutes
   * and Jarvis has to stay listening through it.
   *
   * The permission mode is `acceptEdits` and not `bypassPermissions`. That is
   * the difference between "may edit files in this project" and "may run any
   * shell command it likes", and the second one is not something to grant on
   * behalf of a user who said a sentence out loud. It also means a task needing
   * `Bash` comes back `refused` rather than silently doing less than asked —
   * visible in the HUD, and spoken.
   */
  async startCoding(task: string, project: ProjectEntry, tools?: readonly string[]): Promise<CodingJob> {
    // Taken before the agent runs. `snapshotWork` also pins the test script from
    // the current package.json, which is what makes the post-task check
    // meaningful — see `work-check.ts` on why it is read this early.
    const before = await snapshotWork(project.dir, this.workDeps());
    const job = await this.coding.start({
      task,
      cwd: project.dir,
      permissionMode: "acceptEdits",
      tools: tools ?? ["Read", "Write", "Edit", "Glob", "Grep"],
    });
    this.codingSnapshots.set(job.id, before);
    return job;
  }

  /** File and process access for the work check. Injectable for tests. */
  private workDeps() {
    return {
      run: (
        file: string,
        args: readonly string[],
        o: { cwd: string; timeoutMs?: number; shell?: boolean },
      ) =>
        // A test suite prints more than a local intent ever does, and
        // `execFile` truncates at the cap without erroring — a too-small buffer
        // would turn a passing run into a silently clipped one. The verdict here
        // comes from the exit code, but the detail line is read by a person.
        (this.options.runCheck ?? nodeRunner)(file, args, { maxBufferBytes: 8 << 20, ...o }),
      readText: (path: string): string | null => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      },
      join: (...parts: string[]) => joinPath(...parts),
    };
  }

  /**
   * Go and look at what the coding agent actually did.
   *
   * Only for jobs that ran to completion. A cancelled or timed-out job left the
   * repository in a half-known state on purpose, and running its test suite
   * would grade an interrupted edit — the answer would be a failing build that
   * says nothing about the work.
   */
  private async checkFinishedJob(job: CodingJob): Promise<void> {
    const before = this.codingSnapshots.get(job.id);
    this.codingSnapshots.delete(job.id);

    if (job.result?.status === "reported" && before) {
      try {
        const check = await checkWork(job.cwd, before, this.workDeps());
        this.codingChecks.set(job.id, check);
        this.log(`coding ${job.id}: ${check.outcome} — ${check.detail}`);
      } catch (err) {
        // checkWork is documented not to throw; if it ever does, the honest
        // answer is still "unchecked" rather than letting the job disappear.
        this.codingChecks.set(job.id, {
          outcome: "unchecked",
          detail: `the check itself failed: ${err instanceof Error ? err.message : String(err)}`,
          changed: [],
          command: null,
        });
      }
    }
    this.broadcastJob(job);
  }

  /**
   * Project a job for the wire.
   *
   * The agent's prose never crosses. It is output from a process that just read
   * a repository, so it is untrusted content (§52); the sentence the UI shows is
   * one Jarvis composed from facts it counted itself.
   */
  private jobView(job: CodingJob): CodingJobView {
    const check = this.codingChecks.get(job.id);
    return {
      id: job.id,
      task: job.task,
      cwd: job.cwd,
      state: job.state,
      startedAt: job.startedAt,
      ...(job.result ? { status: job.result.status, costUsd: job.result.costUsd } : {}),
      ...(check
        ? {
            check: {
              outcome: check.outcome,
              changedCount: check.changed.length,
              command: check.command,
            },
          }
        : {}),
      ...(job.result
        ? {
            detail:
              check && job.result.status === "reported"
                ? speakCheck(check, job.task)
                : speakResult(job.result, job.task),
          }
        : {}),
    };
  }

  private broadcastJob(job: CodingJob): void {
    this.broadcast({ type: "coding_job", job: this.jobView(job) });
  }

  /**
   * Record a local action.
   *
   * Every intent Jarvis carries out itself leaves a line, because the local path
   * bypasses Hermes entirely and would otherwise be the one class of action with
   * no trace of it anywhere. The utterance is *not* recorded — it is audio from
   * the room and may contain anything the user said near the microphone. The
   * intent id, the outcome, and the detail the executor chose to expose are
   * enough to answer "what did it do", which is what an audit log is for.
   */
  private auditLocal(d: LocalDecision): void {
    if (d.route === "agent") return;
    if (d.route === "ask") {
      this.log(`local: ambiguous, asked for clarification`);
      return;
    }
    const verdict = d.outcome?.ok ? "ok" : "failed";
    const detail = d.outcome?.detail ? ` (${d.outcome.detail})` : "";
    this.log(`local: ${d.intent ?? "?"} ${verdict}${detail}`);
  }

  /**
   * Offer the utterance to the local engine.
   *
   * `done` is not "was it local" — it is "is the turn over". A local *failure*
   * still ends the turn: the user asked to mute the speakers, the device
   * refused, and saying so is the honest end of that turn — escalating to an
   * agent that would try the same thing again is not. A capture intent is the
   * opposite case, and the reason this is not a boolean: it is handled locally
   * *and* continues to the agent, carrying the pixels the agent needs.
   */
  private async tryLocal(text: string, aloud = true): Promise<LocalTurn> {
    const decision = await this.localIntents.handle(text);

    if (decision.route === "agent") return { done: false };

    this.machine.handle("route_local");

    if (decision.route === "ask") {
      // Asked out loud, and the answer arrives through the conversation window
      // like any other follow-up.
      const question = decision.question ?? "Which did you mean?";
      this.broadcast({ type: "reply_chunk", text: question });
      this.broadcast({ type: "reply_done", stopReason: "clarify" });
      this.finishLocal(question, aloud);
      return { done: true };
    }

    const outcome = decision.outcome;
    const speech = outcome?.speech ?? "";

    // A local intent that produced something for the agent to look at. The turn
    // is not over: the local layer got consent and took the picture, and the
    // agent still has to answer the question that was asked. So the
    // acknowledgement goes out without a `reply_done`, and the caller continues
    // to Hermes with the payload attached.
    if (outcome?.ok && outcome.handoff) {
      if (speech) this.broadcast({ type: "reply_chunk", text: speech });
      this.machine.handle("route_agent");
      return { done: false, image: outcome.handoff };
    }

    if (outcome && !outcome.ok) {
      // Surface what failed, and keep the detail in the log rather than in the
      // spoken reply — it exists for debugging, not for the user's ears.
      this.broadcast({ type: "error", message: outcome.detail ?? speech, fatal: false });
    }
    this.broadcast({ type: "reply_chunk", text: speech });
    this.broadcast({ type: "reply_done", stopReason: "local" });
    this.finishLocal(speech, aloud);
    return { done: true };
  }

  /**
   * End a locally-handled turn, speaking the reply when there is audio for it.
   *
   * `say` returning false means there is no audio path, so no `speaking_done`
   * will ever arrive to end the turn. Advancing the machine directly is the
   * difference between a silent reply and a turn wedged in SPEAKING.
   */
  private finishLocal(text: string, aloud: boolean): void {
    if (aloud && text && this.say(text)) return;
    this.machine.handle("done");
    this.openConversationWindow();
  }

  /**
   * Speak, if TTS is genuinely available. Returns false when it is not.
   *
   * Every reply is rewritten for the ear on the way through. Hermes answers in
   * markdown, and Piper synthesises whatever it is handed, so without this the
   * assistant says "asteriskasterisk battery asteriskasterisk" and "white heavy
   * check mark" out loud (both measured — see `speakable`). This is the one
   * choke point all four callers pass through, so it is the only correct place
   * for it; the HUD keeps the original markdown, which it renders properly.
   *
   * A reply that is nothing but markup rewrites to "", which is not an
   * utterance — returning false there sends the caller down the same path as a
   * missing TTS engine rather than waiting on a `speaking_done` that the daemon
   * has no reason to send.
   */
  say(text: string): boolean {
    if (!this.voice.isReady()) return false;
    const spoken = speakable(text);
    if (!spoken) return false;
    return this.voice.speak(spoken);
  }

  /**
   * Open the follow-up window (§ conversation mode, 30 s default).
   *
   * The daemon needs telling because it is what decides whether speech alone
   * may start a turn; the state machine's own timer governs the UI side.
   */
  private openConversationWindow(): void {
    if (this.machine.state !== "conversation") return;
    this.voice.setConversation(true);
    const close = (s: string): void => {
      if (s === "conversation") return;
      this.voice.setConversation(false);
      this.machine.off("state", close);
    };
    this.machine.on("state", close);
  }

  get pipeAddress(): string | null {
    return this.ipc?.address ?? null;
  }

  /** Number of attached UIs. Zero is a perfectly normal steady state. */
  get uiCount(): number {
    return this.ipc?.clientCount ?? 0;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();

    // Fresh token per run: a token from a previous run must never work. It is
    // generated in memory and only published after we own the pipe, so a
    // second instance failing the single-instance check cannot clobber the
    // running instance's token and lock its UIs out.
    const token = generateToken();
    const server = new PipeServer({
      pipeName: this.options.pipeName,
      token,
      onRequest: (req) => this.handleRequest(req),
      onLog: (line) => this.log(line),
    });

    try {
      await server.listen();
    } catch (err) {
      // EADDRINUSE means another runtime already owns the pipe. Two runtimes
      // fighting over the microphone and the tray would be worse than one
      // refusing to start.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `could not listen on ${this.options.pipeName ?? "the Jarvis pipe"}: ${msg} ` +
          `(is another Jarvis runtime already running?)`,
      );
    }

    // The pipe is ours; now it is safe to publish credentials for it.
    this.token = token;
    publishToken(token);
    this.ipc = server;
    this.owningToken = true;

    server.on("authenticated", (id: number, name: string) => {
      this.log(`ui attached: ${name} (#${id})`);
      this.broadcastStatus();
    });
    server.on("disconnect", () => {
      // The last UI leaving takes every open question with it. Leaving them
      // pending would mean a window reopened an hour later inherits a stale
      // prompt for an action whose turn is long gone.
      if (server.clientCount === 0) this.consent.cancelAll("no UI attached");
      this.broadcastStatus();
    });

    this.log(`runtime listening on ${server.address}`);
    this.emit("ready");

    if (!this.options.lazyHermes) {
      // Hermes starting slowly must not delay the runtime being reachable, so
      // this is deliberately not awaited. Status reports "starting" meanwhile.
      void this.supervisor.start().catch((err: unknown) => {
        this.log(
          `hermes failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    if (this.voiceEnabled) {
      // Same rule: loading whisper takes seconds, and the runtime must be
      // usable by typed input the whole time.
      void this.voice.start().catch((err: unknown) => {
        this.log(
          `voice failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else {
      this.log("voice disabled by configuration");
    }

    // The task watcher is *not* fire-and-forget like the two above, for the
    // reason it exists: it is the one component whose signal only arrives by
    // waiting. A scheduler that never started is silent, so nothing lazy would
    // ever observe it. Its first poll also feeds the tray's task line.
    this.tasks.start();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.machine.reset();
    // Unblock anything waiting on a human before tearing down the transports;
    // each resolves as unanswered, which the engine reads as a denial.
    this.consent.cancelAll("runtime stopping");
    // Timer first, and synchronously: a poll firing during teardown would try to
    // broadcast through an IPC server that is about to close.
    this.tasks.stop();
    // Voice first: it owns the microphone and two child processes of its own,
    // and releasing hardware promptly matters more than Hermes' session.
    await this.voice.stop();
    await this.supervisor.stop();
    await this.ipc?.close();
    this.ipc = null;
    // Revoke last, and only if we published it — an instance that lost the
    // single-instance race must not delete the winner's credentials.
    if (this.owningToken) {
      revokeToken();
      this.owningToken = false;
    }
    this.token = null;
    this.emit("stopped");
  }

  getStatus(): RuntimeStatus {
    const h = this.supervisor.getStatus();
    const v = this.voice.getStatus();
    return {
      protocolVersion: IPC_PROTOCOL_VERSION,
      state: this.machine.state,
      startedAt: this.startedAt,
      hermes: {
        state: h.state,
        pid: h.hermes?.pid ?? null,
        sessionId: h.sessionId,
        restartCount: h.restartCount,
        gaveUpReason: h.gaveUpReason,
      },
      voice: {
        state: v.state,
        pid: v.pid,
        wakeWord: v.wakeWord,
        device: v.device,
        capturing: v.capturing,
        silentForMs: v.silentForMs,
        restartCount: v.restartCount,
        gaveUpReason: v.gaveUpReason,
      },
      subsystems: {
        wakeWord: this.wakeWordStatus(),
        stt: this.voiceEngineStatus("stt"),
        tts: this.voiceEngineStatus("tts"),
        hermes: this.hermesSubsystemStatus(),
      },
      listening: this.listening,
      muted: this.muted,
      // Counted from the loop and the store rather than from a field kept in
      // step with them: a number the runtime maintains itself is a number that
      // can be wrong, and this one is the HUD's answer to "is it doing
      // something right now".
      missions: {
        running: this.missions.running().length,
        runningIds: [...this.missions.running()],
        awaitingApproval: this.missionAsk === null ? 0 : 1,
        recorded: this.missionStore.count(),
      },
      // Read from the provider on every call rather than cached from boot, because
      // one of them — Hermes — is available exactly when its process is up and idle,
      // and a status that remembered "yes" would be answering about a dead child.
      llm: (() => {
        const health = this.llm.provider.health();
        return {
          provider: health.name,
          model: health.model,
          available: health.available,
          simulated: health.simulated,
          acceptsImages: health.acceptsImages,
          note: health.note,
          planning: this.missionConfig().llmPlanner && health.available,
        };
      })(),
    };
  }

  /**
   * Wake word status.
   *
   * `available` requires audio to actually be flowing: a loaded model with a
   * dead microphone is not a working wake word, and reporting it as one is
   * exactly the kind of lie §4 forbids.
   */
  private wakeWordStatus(): SubsystemStatus {
    if (!this.voiceEnabled) return { state: "unavailable", detail: "voice is disabled" };
    const v = this.voice.getStatus();
    if (v.gaveUpReason) return { state: "unavailable", detail: v.gaveUpReason };
    switch (v.state) {
      case "ready": {
        if (!v.wakeWord) return { state: "unavailable", detail: "no wake-word model loaded" };
        if (!v.capturing) {
          // A capture failure is the one case here a user can fix from the
          // config file, and ffmpeg's own words name the mistake — a device that
          // was renamed, unplugged, or never spelled the way it was typed. Mute
          // also lands here, which is why the hint is attached to the failure
          // and not to the branch.
          if (v.captureFailure) {
            return {
              state: "unavailable",
              detail: `${v.captureFailure} — run "npm run probe:mic" to find one that works`,
            };
          }
          return { state: "unavailable", detail: v.lastError ?? "microphone not capturing" };
        }
        // `capturing` was the whole test until a reboot re-ordered the dshow
        // devices and the daemon opened an input that delivered silence. Every
        // component reported healthy and the wake word could not fire, which is
        // the precise failure §4 exists to forbid. `degraded` rather than
        // `unavailable` because the model is loaded and the device is open —
        // what is missing is a signal, and the fix is a setting, so the detail
        // names both the device and the command that finds a better one.
        if (v.silentForMs !== null && v.silentForMs >= SILENCE_VERDICT_MS) {
          return {
            state: "degraded",
            detail:
              `${v.wakeWord} is loaded, but ${v.device ?? "the default input"} has been ` +
              `silent for ${Math.round(v.silentForMs / 1000)}s — run "npm run probe:mic" ` +
              `and pin a microphone in config.json`,
          };
        }
        return { state: "available", detail: `${v.wakeWord} on ${v.device ?? "default input"}` };
      }
      case "starting":
      case "restarting":
        return { state: "starting", detail: "loading voice models" };
      case "suspended":
        return { state: "unavailable", detail: "suspended (system sleep)" };
      case "failed":
        return { state: "unavailable", detail: v.lastError ?? "voice daemon failed" };
      default:
        return { state: "unavailable", detail: v.lastError ?? "not started" };
    }
  }

  private voiceEngineStatus(which: "stt" | "tts"): SubsystemStatus {
    if (!this.voiceEnabled) return { state: "unavailable", detail: "voice is disabled" };
    const v = this.voice.getStatus();
    if (v.state === "starting" || v.state === "restarting") {
      return { state: "starting", detail: "loading voice models" };
    }
    if (v.state !== "ready") {
      return { state: "unavailable", detail: v.lastError ?? `voice daemon is ${v.state}` };
    }
    const model = which === "stt" ? v.sttModel : v.ttsVoice;
    if (!model) {
      return { state: "unavailable", detail: v.lastError ?? `${which} failed to load` };
    }
    return { state: "available", detail: model };
  }

  private hermesSubsystemStatus(): SubsystemStatus {
    const s = this.supervisor.getStatus();
    if (s.gaveUpReason) {
      return { state: "unavailable", detail: s.gaveUpReason };
    }
    switch (s.state) {
      case "ready":
        return { state: "available" };
      case "starting":
      case "restarting":
        return { state: "starting", detail: s.lastError ?? undefined };
      case "suspended":
        return { state: "unavailable", detail: "suspended (system sleep)" };
      case "failed":
        return { state: "unavailable", detail: s.lastError ?? "failed" };
      default:
        return { state: "unavailable", detail: s.lastError ?? "stopped" };
    }
  }

  /**
   * Send a text prompt through Hermes, streaming the reply to every UI.
   *
   * Typed input gets the same local-first treatment as speech: someone who
   * types "lock the computer" means the same thing as someone who says it, and
   * making the keyboard path depend on Hermes being up would undo the offline
   * guarantee for anyone whose microphone is muted.
   *
   * Resolves when the turn is *over*. In-process callers want that; the IPC
   * handler deliberately does not — see `acceptPrompt`.
   */
  async prompt(text: string): Promise<void> {
    const accepted = await this.acceptPrompt(text);
    if (accepted) await accepted.turn;
  }

  /**
   * Accept a prompt and start its turn, resolving as soon as it is *accepted*.
   *
   * Returns the running agent turn in a wrapper, or `null` when the local fast
   * path already answered and there is no agent turn to wait for. The wrapper is
   * not decoration: a bare `Promise<Promise<void>>` cannot be observed, because
   * `await` unwraps every layer — a caller writing `await acceptPrompt(...)`
   * would silently wait for the whole turn again and restore the exact bug
   * below. Putting the turn inside a non-thenable object makes that impossible
   * to write by accident, and the compiler says so.
   *
   * This split is the fix for a real report: a perfectly healthy turn rendered
   * its streamed reply and then put `ipc request 'prompt' timed out` in red
   * underneath it. `PipeClient` bounds a request at 30 s
   * (`src/ipc/pipe-client.ts`), and the handler used to `await` the whole turn
   * before answering — so that clock was being applied to an agent's thinking
   * time, to every tool call it made, and, worst of all, to a permission prompt
   * that is sitting there waiting for a human to click. No machine deadline is
   * defensible for that last one, and no larger number would have been either.
   *
   * Everything decidable in milliseconds still happens before this resolves:
   * the local engine gets first refusal, and the agent is confirmed reachable.
   * So a caller learns *immediately* that Hermes is down — `probe-resilience`
   * asserts that refusal arrives inside 5 s — and only the open-ended part is
   * left behind the returned promise. That part was already being reported
   * twice: `reply_chunk` / `reply_done` / `error` events carry the turn to every
   * attached UI whether anyone awaits the request or not, which is exactly why
   * the reply was on screen underneath the timeout.
   */
  private async acceptPrompt(
    text: string,
  ): Promise<{ turn: Promise<void> } | null> {
    // `text_input` first: the local branch needs the machine out of idle before
    // it can route, and this is the event that represents a typed turn starting.
    this.machine.handle("text_input");
    // Not aloud: the typed path is silent by design, and the reply is already
    // on its way to every UI as a normal reply_chunk.
    const local = await this.tryLocal(text, false);
    if (local.done) return null;

    // Typed "fix this" means what spoken "fix this" means. Silent here, so the
    // offer and its report arrive as reply events and nothing is synthesised at
    // somebody who is typing.
    if (await this.tryMission(text, false)) return null;

    if (!this.supervisor.isReady()) {
      // Say so rather than silently queueing forever.
      this.machine.handle("cancel");
      throw new Error(
        `Hermes is not available (${this.supervisor.getStatus().state})`,
      );
    }

    this.machine.handle("route_agent");
    return { turn: this.runAgentTurn(text, local.image) };
  }

  /**
   * The open-ended half of a typed turn: stream the agent's reply out as events.
   *
   * Silent by design — no audio on the typed path. Voice replies go through
   * `onUtterance`, which owns speech because it also owns barge-in.
   */
  private async runAgentTurn(text: string, image: TurnImage | undefined): Promise<void> {
    try {
      const stopReason = await this.streamGuarded(
        this.withMemories(text),
        (e) => {
          switch (e.kind) {
            case "text":
              this.broadcast({ type: "reply_chunk", text: e.text });
              break;
            case "thought":
              this.broadcast({ type: "thought", text: e.text });
              break;
            case "tool_call":
              this.broadcast({
                type: "tool_call",
                id: e.id,
                title: e.title,
                status: e.status,
              });
              break;
            default:
              break;
          }
        },
        image,
      );
      this.broadcast({ type: "reply_done", stopReason });
      // No audio on the typed path, so the turn is done here.
      this.machine.handle("done");
    } catch (err) {
      this.machine.handle("error");
      throw err;
    }
  }

  /**
   * `supervisor.streamMessage` with a deadline on *silence*.
   *
   * The one place both turn paths go through, because both had the same defect:
   * a bare `await` with no deadline anywhere beneath it. `HermesAdapter`'s
   * `sessionPrompt` request has no timeout either (deliberately — a turn has no
   * defensible length), so a wedged agent meant an assistant that waited
   * forever, said nothing, and left the orb spinning. Measured at 423 s and
   * still going; see `turn-watchdog.ts` for where the wedge actually lives.
   *
   * What trips it is silence, never duration. Every streamed event resets the
   * clock, so the healthy long turn the previous fix was about — 17 s of
   * thinking, minutes of tool calls — is untouched, and a permission dialog
   * holds the clock entirely (`isPaused`) because a human reading a question is
   * not a symptom of anything.
   *
   * On a trip: cancel the turn at the agent, then reject with `TurnStalledError`
   * so the caller's existing failure path reports it like any other. The race is
   * not decoration — `cancel` is a notification, and an agent wedged badly
   * enough may never answer the prompt request at all, so the rejection cannot
   * be made to depend on it. Cancelling is still worth doing: measured against
   * the live wedge it returned in 1 ms and restored service immediately.
   */
  private async streamGuarded(
    text: string,
    onEvent: (e: HermesStreamEvent) => void,
    image: TurnImage | undefined,
  ): Promise<StopReason> {
    let stalled: TurnStalledError | null = null;
    let tripped: ((err: TurnStalledError) => void) | null = null;

    const watchdog = new TurnWatchdog({
      timeoutMs: this.options.turnStallMs ?? DEFAULT_TURN_STALL_MS,
      noticeMs: this.options.turnNoticeMs ?? DEFAULT_TURN_NOTICE_MS,
      // A question on screen holds the clock. `ConsentBroker` bounds that wait
      // at 110 s of its own, so nothing is unbounded here either.
      isPaused: () => this.consent.pending.length > 0,
      onNotice: (silentMs) => {
        // Not an error yet, and deliberately not a banner: the turn is still
        // live and may well answer. It goes in the log so a user who comes back
        // to a slow turn can see when it went quiet, rather than guessing.
        this.log(
          `agent turn: nothing from the agent for ${Math.round(silentMs / 1000)}s — still waiting`,
        );
      },
      onStall: (silentMs) => {
        stalled = new TurnStalledError(silentMs);
        this.log(
          `agent turn stalled: nothing for ${Math.round(silentMs / 1000)}s — cancelling the turn`,
        );
        this.supervisor.cancel();
        tripped?.(stalled);
      },
    });

    const stream = this.supervisor.streamMessage(
      text,
      (e) => {
        // A stalled turn's late events belong to a turn that already has a
        // verdict. Broadcasting them would put reply text on screen under an
        // error banner saying nothing came back.
        if (stalled) return;
        watchdog.progress();
        onEvent(e);
      },
      image,
    );
    // The loser of the race still settles eventually. Without this handler a
    // cancelled turn's later rejection is an unhandled rejection, which on the
    // runtime process is a crash the user experiences as Jarvis disappearing.
    void stream.catch(() => {});

    try {
      return await Promise.race([
        stream,
        new Promise<never>((_, reject) => {
          tripped = reject;
          // Already tripped between construction and here: impossible today
          // (the watchdog's first tick is a timer away) and cheap to be right
          // about anyway.
          if (stalled) reject(stalled);
        }),
      ]);
    } finally {
      watchdog.stop();
    }
  }

  /**
   * Surface a failed turn on screen and in the log.
   *
   * Shared by the voice and the typed path, because both had the same defect and
   * fixing it in one place is the point. Speech is not here: the typed path is
   * silent by design, and the voice path adds it at its own call site, where it
   * can also check whether the user has already interrupted.
   */
  private reportTurnFailure(err: unknown): AgentFailure {
    // `err.message` alone was the user-visible bug: an RpcError's message is
    // "Internal error" and nothing else, while its code and data — which say
    // what actually happened — were dropped on this line. See
    // `agent-failure.ts` for why the spoken and shown texts differ.
    const failure = describeAgentFailure(err);
    this.log(
      `agent turn failed: ${failure.message}` +
        (failure.redacted ? " (secret-shaped text was removed)" : ""),
    );
    this.broadcast({ type: "error", message: failure.message, fatal: false });
    // Leave the machine somewhere it can be used from. ERROR's only exits are
    // `recover` and `cancel`, and nothing in this runtime has ever sent
    // `recover` — so a failed turn used to park the assistant in ERROR until the
    // user happened to press Cancel. The banner is the record of the failure;
    // the state machine's job now is to be ready for the next question, which is
    // exactly what IDLE means. A failure that has been reported is over.
    if (this.machine.state === "error") this.machine.handle("cancel");
    return failure;
  }

  // --- system power transitions -------------------------------------------

  async onSystemSuspend(): Promise<void> {
    this.log("system suspending");
    this.machine.reset();
    // A question asked before the lid closed has no answer coming. Whoever wakes
    // the machine should not have their first words read as one.
    this.localIntents.reset();
    // Release the microphone before the machine sleeps. A dshow handle held
    // across suspend is a good way to get a device that never comes back.
    await this.voice.suspend();
    await this.supervisor.suspend();
    this.broadcastStatus();
  }

  async onSystemResume(): Promise<void> {
    this.log("system resumed");
    await this.supervisor.resume();
    await this.voice.resume();
    this.broadcastStatus();
  }

  // --- IPC ----------------------------------------------------------------

  private async handleRequest(req: HandledRequest): Promise<void> {
    const { request, respond, fail } = req;
    switch (request.type) {
      case "get_status":
        respond(this.getStatus());
        return;

      case "get_activity": {
        // Bounded on this side as well as in the view. `limit` arrives from a
        // client, so it is clamped rather than trusted: a request for a million
        // rows would serialise the whole log into one pipe frame.
        const asked = typeof request.limit === "number" ? request.limit : DEFAULT_ACTIVITY_ROWS;
        const limit = Number.isFinite(asked)
          ? Math.min(Math.max(Math.floor(asked), 1), MAX_ACTIVITY_ROWS)
          : DEFAULT_ACTIVITY_ROWS;
        // Both engines, merged by time. There are two of them for the reasons
        // given at `missionPermissions`, but there is only one Activity view —
        // and a pane that showed a conversation's decisions while omitting an
        // autonomous loop's would be the most misleading half-truth here.
        const merged = [...this.permissions.audit, ...this.missionPermissions.audit].sort(
          (a, b) => a.at - b.at,
        );
        respond(merged.slice(-limit).map(toActivityEntry));
        return;
      }

      case "get_coding_jobs":
        // Running first, then history: the answer to "what is it doing" matters
        // more than the answer to "what did it do", and a HUD that renders in
        // order gets the useful half without knowing that.
        respond([...this.coding.running(), ...this.coding.recent()].map((j) => this.jobView(j)));
        return;

      case "cancel_coding_job": {
        if (typeof request.jobId !== "string" || request.jobId === "") {
          fail("jobId is required", "bad_request");
          return;
        }
        // False means it was already finished, which is not a failure — the user
        // asked for it stopped and it is stopped.
        respond({ stopped: this.coding.cancel(request.jobId) });
        return;
      }

      case "get_tasks":
        // Re-read rather than serving the watcher's last poll: the caller is a
        // person looking at a window right now, and a minute-old answer to "is
        // my scheduler running?" is exactly the kind of stale truth this feature
        // exists to eliminate. The read is a few hundred bytes of JSON.
        respond(this.tasksView());
        return;

      case "get_mcp":
        // Same re-read rule as `get_tasks`, plus one specific to MCP: `hermes
        // mcp add` is a terminal command the user may have run a second ago, and
        // a cached answer would tell them their new server does not exist.
        respond(this.mcpView());
        return;

      case "get_memory":
        // Jarvis' half is already in hand; Hermes' half is a fresh read for the
        // `get_tasks` reason — `hermes memory setup` may have run since boot, and
        // reporting memory as off when the user just turned it on is the exact
        // kind of confidently stale answer this whole family of handlers avoids.
        respond(this.memoryView());
        return;

      case "get_skills":
        // Served from the cache `skills()` fills on first ask. The others re-read
        // because their files change behind Jarvis' back; a skill directory does
        // not, short of an install the user ran deliberately — and paying a
        // 102-directory walk on every panel open to catch that would be the wrong
        // trade. A restart picks up an install, and so does the first ask after one.
        respond(this.skillsView());
        return;

      case "prompt": {
        if (typeof request.text !== "string" || request.text.trim() === "") {
          fail("prompt text is required", "bad_request");
          return;
        }
        let accepted: { turn: Promise<void> } | null;
        try {
          accepted = await this.acceptPrompt(request.text);
        } catch (err) {
          // Only the fast refusals reach here — an unreachable agent, mainly.
          fail(err instanceof Error ? err.message : String(err), "unavailable");
          return;
        }
        // Answered on acceptance, not on completion. A turn can legitimately run
        // for minutes or block on a permission dialog, and this response used to
        // be what a 30 s client timeout was measuring. See `acceptPrompt`.
        respond();
        // Nothing awaits the turn now, so its failure needs a home: without this
        // an agent error would be an unhandled rejection and the banner the last
        // fix added would never appear on the typed path.
        if (accepted) {
          void accepted.turn.catch((err: unknown) => this.reportTurnFailure(err));
        }
        return;
      }

      case "cancel":
        this.supervisor.cancel();
        this.speakingTurn = false;
        this.voice.stopSpeaking("cancelled");
        this.voice.setConversation(false);
        // Drop any outstanding clarification too. Barge-in deliberately does
        // *not* do this: talking over the question is how people answer one, and
        // clearing it there would discard the answer as it arrived. An explicit
        // cancel is the opposite signal.
        this.localIntents.reset();
        this.machine.handle("cancel");
        respond();
        return;

      case "set_listening": {
        const enabled = Boolean(request.enabled);
        // Ask the daemon; only believe `listening` once it confirms. Reporting
        // the request rather than the result is how a UI ends up showing a
        // microphone that is not actually open.
        const sent = this.voice.setListening(enabled);
        if (!sent) this.listening = false;
        this.broadcastStatus();
        respond({ listening: this.listening, applied: sent });
        return;
      }

      case "set_muted": {
        const muted = Boolean(request.muted);
        this.muted = muted;
        if (muted) this.voice.stopSpeaking("muted");
        const sent = this.voice.setMuted(muted);
        this.broadcastStatus();
        respond({ muted: this.muted, applied: sent });
        return;
      }

      case "push_to_talk": {
        const down = Boolean(request.down);
        if (!this.voice.isReady()) {
          fail(this.voiceUnavailableDetail(), "unavailable");
          return;
        }
        // Holding the key must silence a reply in progress: push-to-talk is
        // the one interrupt that works with no echo cancellation at all.
        if (down) {
          this.supervisor.cancel();
          this.speakingTurn = false;
        }
        this.voice.pushToTalk(down);
        respond({ pushToTalk: down });
        return;
      }

      case "say": {
        if (typeof request.text !== "string" || request.text.trim() === "") {
          fail("text is required", "bad_request");
          return;
        }
        if (!this.say(request.text.trim())) {
          fail(this.voiceUnavailableDetail(), "unavailable");
          return;
        }
        respond();
        return;
      }

      case "restart_hermes":
        try {
          await this.supervisor.restart();
          respond(this.getStatus());
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), "unavailable");
        }
        return;

      case "restart_voice":
        if (!this.voiceEnabled) {
          fail("voice is disabled by configuration", "unavailable");
          return;
        }
        try {
          await this.voice.restart();
          respond(this.getStatus());
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), "unavailable");
        }
        return;

      case "quit":
        // Acknowledge before shutting down, or the caller sees a dropped socket
        // instead of a clean confirmation.
        respond();
        this.quitRequested = true;
        this.emit("quit-requested");
        return;

      case "permission_response": {
        if (typeof request.requestId !== "string" || request.requestId === "") {
          fail("requestId is required", "bad_request");
          return;
        }
        // An answer for a question that is not open is either a stale click or
        // a forged frame. Neither authorises anything, and saying so plainly is
        // better than accepting it silently.
        const delivered = this.consent.resolve(
          request.requestId,
          fromIpcDecision(request.decision),
        );
        if (!delivered) {
          fail("no permission request is open with that id", "bad_request");
          return;
        }
        respond({ requestId: request.requestId });
        return;
      }

      case "hello":
        // Handled during the server handshake; a second hello is meaningless.
        fail("already authenticated", "bad_request");
        return;

      case "start_mission": {
        if (typeof request.objective !== "string" || request.objective.trim() === "") {
          fail("an objective is required", "bad_request");
          return;
        }
        // One at a time. `unavailable` rather than `bad_request` because the
        // request is perfectly well formed and will work in a minute — and the
        // running mission is named, so a UI can offer to show it rather than
        // leaving the user to wonder which one is in the way.
        const running = this.missions.running();
        const busy = running[0];
        if (busy !== undefined) {
          fail(`mission ${busy} is still running`, "unavailable");
          return;
        }
        // Answered when the mission *finishes*, not when it starts: the caller
        // asked for an outcome, and the events it receives in the meantime are
        // what make the wait legible. A mission is bounded by four ceilings, so
        // this cannot wait forever.
        try {
          const mission = await this.runMission(request.objective.trim());
          respond(toMissionDetailView(mission, Date.now()));
        } catch (err) {
          // The loop catches its own steps; this is for anything that escaped it.
          fail(err instanceof Error ? err.message : String(err), "internal");
        }
        return;
      }

      case "propose_from_screen": {
        if (request.ask !== undefined && typeof request.ask !== "string") {
          fail("ask must be a string when it is given", "bad_request");
          return;
        }
        // Refused before a capture, like every other door into the mission loop, and
        // for the plainer reason too: a proposal made while a mission is running is a
        // proposal whose Start button cannot work, so the picture would be taken to
        // offer something that must then be declined.
        const busy = this.missions.running()[0];
        if (busy !== undefined) {
          fail(`mission ${busy} is still running`, "unavailable");
          return;
        }
        // "fix this" is the default because it is what the spoken door says, and a
        // button with an empty box beside it should mean the same thing as the phrase.
        const ask = (request.ask ?? "fix this").trim() || "fix this";
        const outcome = await this.lookForObjective(ask, "window");
        // A refusal answers `ok: true` with a refusal in it, deliberately. It is an
        // answer — the gate said no, or there was nothing on the screen worth doing —
        // and an `error` frame would make a window draw a failed request for a
        // question that was asked and answered (§4).
        respond(toVisionProposalView(outcome, "window", Date.now()));
        return;
      }

      case "get_missions": {
        const asked = typeof request.limit === "number" ? request.limit : DEFAULT_MISSION_ROWS;
        const limit = Number.isFinite(asked)
          ? Math.min(Math.max(Math.floor(asked), 1), MAX_MISSION_ROWS)
          : DEFAULT_MISSION_ROWS;
        const view: MissionsView = {
          missions: this.missionStore.list(limit).map(toMissionView),
          running: [...this.missions.running()],
        };
        respond(view);
        return;
      }

      case "get_mission": {
        if (typeof request.missionId !== "string" || request.missionId === "") {
          fail("missionId is required", "bad_request");
          return;
        }
        const mission = this.missionStore.load(request.missionId);
        if (mission === null) {
          fail("no mission with that id", "bad_request");
          return;
        }
        const view: MissionDetailView = toMissionDetailView(mission, Date.now());
        respond(view);
        return;
      }

      // The Agent Trace. Built from the mission's own append-only log rather than from
      // its snapshot, because a trace is an ordering and a snapshot has none: every step
      // in a finished mission reads `verified` or `failed`, and the sequence that got it
      // there is only in the log. A mission whose log is empty gets `gap` and no entries,
      // which is the honest answer — not an account reconstructed from the final state.
      case "get_trace": {
        if (typeof request.missionId !== "string" || request.missionId === "") {
          fail("missionId is required", "bad_request");
          return;
        }
        const mission = this.missionStore.load(request.missionId);
        if (mission === null) {
          fail("no mission with that id", "bad_request");
          return;
        }
        const lines = this.missionStore.history(request.missionId);
        respond(toTraceView(buildTrace(mission, lines), traceGap(mission, lines)));
        return;
      }

      case "cancel_mission": {
        if (typeof request.missionId !== "string" || request.missionId === "") {
          fail("missionId is required", "bad_request");
          return;
        }
        // False means it was not running, which is not a failure: the caller
        // wanted it stopped and it is not going.
        respond({ stopped: this.missions.cancel(request.missionId) });
        return;
      }

      case "approve_step": {
        if (typeof request.missionId !== "string" || typeof request.stepId !== "string") {
          fail("missionId and stepId are required", "bad_request");
          return;
        }
        const waiting = this.missionAsk;
        // Three ways this can be wrong, and all three are refused rather than
        // approximated. Nothing is waiting; something else is waiting; or the step
        // is waiting but the engine has not asked the user anything — a level it
        // allowed on its own, or a grant that already covered it. Resolving the
        // "nearest" open question in any of those cases would be a click landing
        // on consent the user never read.
        if (
          waiting === null ||
          waiting.missionId !== request.missionId ||
          waiting.stepId !== request.stepId ||
          waiting.requestId === null
        ) {
          fail("that step is not waiting on an answer", "bad_request");
          return;
        }
        const delivered = this.consent.resolve(
          waiting.requestId,
          fromIpcDecision(request.decision),
        );
        if (!delivered) {
          fail("that question is no longer open", "bad_request");
          return;
        }
        respond({ missionId: waiting.missionId, stepId: waiting.stepId });
        return;
      }

      case "get_tools": {
        respond(this.toolsView());
        return;
      }

      case "get_demo": {
        respond(this.demoView());
        return;
      }

      /**
       * Write the §28 fixtures, and let missions reach them.
       *
       * Refused while a mission is running, for the same reason `reset_demo` is:
       * rewriting a project's `package.json` under a step that is building it turns a
       * real result into an unexplainable one, and a demo whose first act is to
       * corrupt the run in progress is worse than a demo that says "not now".
       *
       * The rescan is the part that matters afterwards. `find_project` answers from a
       * cached scan, so without it the fixtures would exist on disk and be invisible
       * to the objective that names them — which would look exactly like a planner bug.
       */
      case "prepare_demo": {
        const busy = this.missions.running()[0];
        if (busy !== undefined) {
          fail("a mission is running, so the demo files are not being rewritten", "unavailable");
          return;
        }
        try {
          prepareDemoWorkspace({ log: (m) => this.log(m) });
        } catch (err) {
          // Reported rather than thrown: a full disk or a locked file is a condition
          // the panel can show beside an unprepared workspace, and the next line of
          // the view will say `prepared: false` because the marker is written last.
          fail(`could not write the demo files: ${sanitiseForDisplay(String(err), 120)}`, "internal");
          return;
        }
        this.demoCache = null;
        this.rescanProjects();
        respond(this.demoView());
        return;
      }

      /**
       * Delete the §28 fixtures.
       *
       * The deletion itself is `resetDemoWorkspace`'s business and it is deliberately
       * narrow — three directories by name, each checked against the demo root, and
       * only when the marker it wrote is present. Nothing about that is negotiable
       * from here, which is why this case passes no path.
       */
      case "reset_demo": {
        const busy = this.missions.running()[0];
        if (busy !== undefined) {
          fail("a mission is running, so the demo files are not being deleted", "unavailable");
          return;
        }
        try {
          resetDemoWorkspace({ log: (m) => this.log(m) });
        } catch (err) {
          fail(`could not remove the demo files: ${sanitiseForDisplay(String(err), 120)}`, "internal");
          return;
        }
        this.demoCache = null;
        this.rescanProjects();
        respond(this.demoView());
        return;
      }

      /**
       * One class, one verdict, this session.
       *
       * Validated against the risk model rather than trusted: a renderer is another
       * process and its message is input. An unrecognised class is refused instead
       * of ignored — a settings panel that silently dropped a choice would show the
       * old value beside a click that appeared to work.
       */
      case "set_tool_policy": {
        if (!isRiskCategory(request.category)) {
          fail(`not a risk class: ${sanitiseForDisplay(String(request.category), 40)}`, "bad_request");
          return;
        }
        const { category, verdict } = request;
        if (verdict === "default") this.sessionPolicy.delete(category);
        else this.sessionPolicy.set(category, verdict);
        // The audit trail for this is the log, not an `activity` entry: that shape
        // describes a decision about a tool call — a name, a level, a verdict — and
        // a policy change is none of those. Forcing it in would put a row in the
        // Activity view for an action nobody took.
        this.log(
          verdict === "default"
            ? `policy: ${category} follows config.json again (${this.missionConfig().policy?.[category] ?? "no entry, so the level rule"})`
            : `policy: ${category} set to ${verdict} for this session`,
        );
        respond(this.toolsView());
        return;
      }

      /**
       * The eight memory writes.
       *
       * Every one of them answers with the whole `memoryView()`, and that is
       * deliberate: a page that patched its own state from a success flag would
       * drift from the store the moment a write was partially refused — a memory
       * saved but a cap reached, a profile field cleared that was not set. One
       * round trip, one truth.
       *
       * A refusal is not a wire error. `screenMemory` declining a token-shaped
       * sentence is the subsystem working, and `fail` would render it in a page's
       * error slot as though the pipe had broken. So refusals come back `ok: true`
       * with `saved: false` and the reason, and only malformed requests `fail`.
       */
      case "remember": {
        if (typeof request.text !== "string" || request.text.trim() === "") {
          fail("text is required", "bad_request");
          return;
        }
        const result = this.memory.remember(request.text);
        if (result.ok) await this.syncVectors();
        respond({ saved: result.ok, speech: result.speech, memory: this.memoryView() });
        return;
      }

      case "edit_memory": {
        if (typeof request.memoryId !== "string" || typeof request.text !== "string") {
          fail("memoryId and text are required", "bad_request");
          return;
        }
        const result = this.memory.revise(request.memoryId, request.text);
        if (result.ok) await this.syncVectors();
        respond({ saved: result.ok, speech: result.speech, memory: this.memoryView() });
        return;
      }

      case "forget_memory": {
        if (typeof request.memoryId !== "string" || request.memoryId === "") {
          fail("memoryId is required", "bad_request");
          return;
        }
        const gone = this.memory.forget(request.memoryId);
        if (gone) await this.syncVectors();
        respond({
          saved: gone !== null,
          speech: gone ? "Forgotten." : "there is no memory with that id",
          memory: this.memoryView(),
        });
        return;
      }

      case "forget_episode": {
        if (typeof request.episodeId !== "string" || request.episodeId === "") {
          fail("episodeId is required", "bad_request");
          return;
        }
        const gone = this.episodes.forget(request.episodeId);
        if (gone) await this.syncVectors();
        respond({
          saved: gone !== null,
          speech: gone ? "Forgotten." : "there is no episode with that id",
          memory: this.memoryView(),
        });
        return;
      }

      case "set_profile": {
        if (typeof request.key !== "string") {
          fail("key is required", "bad_request");
          return;
        }
        if (!isProfileKey(request.key)) {
          fail(
            `not a profile field: ${sanitiseForDisplay(String(request.key), 40)}`,
            "bad_request",
          );
          return;
        }
        // Absent or blank clears it. A field the user emptied is a field they want
        // empty, and storing "" would put a labelled blank into every prompt.
        if (request.value === undefined || request.value.trim() === "") {
          const had = this.profile.forget(request.key);
          respond({
            saved: true,
            speech: had ? "Cleared." : "that was not set",
            memory: this.memoryView(),
          });
          return;
        }
        // `stated`, always: this request came from the user's own keyboard. There
        // is no path here that can write `confirmed`, and none at all for a guess.
        const write = this.profile.set(request.key, request.value, "stated");
        respond({
          saved: write.ok,
          speech: write.ok ? "Saved." : write.reason,
          memory: this.memoryView(),
        });
        return;
      }

      case "resolve_learning": {
        if (typeof request.proposalId !== "string" || request.proposalId === "") {
          fail("proposalId is required", "bad_request");
          return;
        }
        if (request.decision !== "accept" && request.decision !== "reject") {
          fail("decision must be accept or reject", "bad_request");
          return;
        }
        if (request.decision === "reject") {
          const gone = this.learning.reject(request.proposalId);
          respond({
            saved: gone !== null,
            speech: gone ? "Dropped it." : "there is no suggestion with that id",
            memory: this.memoryView(),
          });
          return;
        }
        const accepted = this.learning.accept(request.proposalId);
        if (accepted.ok) {
          await this.syncVectors();
          this.log(`memory: accepted suggestion ${request.proposalId} (${accepted.proposal.kind})`);
        }
        respond({
          saved: accepted.ok,
          speech: accepted.ok ? accepted.speech : accepted.reason,
          memory: this.memoryView(),
        });
        return;
      }

      case "get_world":
        // Assembling is the answer, so there is nothing to invalidate and no
        // `refresh_world`. Suggestions are raised on the way out because the graph
        // is in hand and the person is looking at the page — but never notified
        // for the same reason.
        respond(await this.worldView({ propose: true }));
        return;

      case "resolve_proposal": {
        if (typeof request.proposalId !== "string" || request.proposalId === "") {
          fail("proposalId is required", "bad_request");
          return;
        }
        if (request.decision !== "accept" && request.decision !== "decline") {
          fail("decision must be accept or decline", "bad_request");
          return;
        }
        if (request.decision === "decline") {
          // Declining records the fingerprint, so the rule that raised it stays
          // quiet for a month. Nothing else happens, which is the whole answer:
          // the log now holds a suggestion made and refused.
          const gone = this.proactiveQueue.decline(request.proposalId);
          if (gone.ok) {
            this.log(`world: declined ${gone.proposal.rule} for ${gone.proposal.entityId}`);
          }
          const result: ProposalResult = {
            resolved: gone.ok,
            speech: gone.ok ? "Dropped it. I will not bring that one up again." : gone.reason,
            world: await this.worldView({ propose: false }),
          };
          respond(result);
          return;
        }
        // `take` hands the objective back and removes it. It commits nothing: the
        // record keeps "Jarvis suggested it" and "you ran it" as two events, and
        // between them is a human decision.
        const taken = this.proactiveQueue.take(request.proposalId);
        if (!taken.ok) {
          fail(taken.reason, "bad_request");
          return;
        }
        const accepted = taken.proposal;
        // One at a time, exactly as `start_mission` enforces — an accepted
        // suggestion is not a privileged way in.
        const busy = this.missions.running()[0];
        if (busy !== undefined) {
          fail(`mission ${busy} is still running`, "unavailable");
          return;
        }
        this.log(`world: accepted ${accepted.rule} — running "${accepted.objective}"`);
        try {
          // The same call a typed objective makes. Same planner, same permission
          // prompts, same verification: there is no autonomous path here, only a
          // shorter way to type something the user agreed to.
          const mission = await this.runMission(accepted.objective);
          const result: ProposalResult = {
            resolved: true,
            // The mission's own recorded conclusion, or its state if it wrote
            // none. Never a sentence composed here about how it went.
            speech: mission.conclusion ?? `The mission ended ${mission.state}.`,
            world: await this.worldView({ propose: false }),
            mission: toMissionDetailView(mission, Date.now()),
          };
          respond(result);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), "internal");
        }
        return;
      }

      case "set_memory_enabled": {
        if (typeof request.enabled !== "boolean") {
          fail("enabled is required", "bad_request");
          return;
        }
        this.memoryEnabledOverride = request.enabled;
        this.log(
          `memory: ${request.enabled ? "on" : "off"} for this session (config.json says ${
            this.missionConfig().memoryEnabled ? "on" : "off"
          })`,
        );
        respond({ saved: true, speech: request.enabled ? "On." : "Off.", memory: this.memoryView() });
        return;
      }

      case "forget_everything": {
        if (request.confirm !== FORGET_EVERYTHING) {
          fail(`confirm must be exactly "${FORGET_EVERYTHING}"`, "bad_request");
          return;
        }
        const counts = {
          memories: this.memory.clear(),
          episodes: this.episodes.clear(),
          profile: this.profile.clear(),
          proposals: this.learning.clear(),
        };
        this.vectors.clear();
        // Cached project aliases were derived from memories that no longer exist,
        // so the cache is a copy of deleted text as well as a wrong answer.
        this.aliasedCache = null;
        this.log(
          `memory: forgot everything — ${counts.memories} memories, ${counts.episodes} episodes, ` +
            `${counts.profile} profile fields, ${counts.proposals} suggestions`,
        );
        respond({
          saved: true,
          speech: "All of it is gone.",
          counts,
          memory: this.memoryView(),
        });
        return;
      }

      default: {
        const exhaustive: never = request;
        fail(`unknown request: ${JSON.stringify(exhaustive)}`, "bad_request");
        return;
      }
    }
  }

  // --- permissions ---------------------------------------------------------

  /**
   * Decide one Hermes tool call.
   *
   * The only path from the agent to the machine. It never throws: a bug in
   * classification must produce a denial, not an unhandled rejection that
   * leaves the ACP request unanswered and the turn stalled.
   */
  private async decidePermission(toolCall: unknown): Promise<"allow_once" | "deny"> {
    try {
      const action = toActionDescriptor(toolCall);
      const decision = await this.permissions.evaluate(action);
      return toOutcomeId(decision.verdict);
    } catch (err) {
      this.log(`permission: denying after an internal error: ${String(err)}`);
      return "deny";
    }
  }

  /**
   * Surface an audit entry.
   *
   * Three destinations, because no one of them is enough. The `activity` event
   * is the live push to whatever UI is attached now; `get_activity` serves the
   * same entries to a UI that attaches later, since for an always-on assistant
   * "nobody was watching" is the normal case rather than the exception; and the
   * log line is what survives both, including a crash before either was read.
   */
  private onPermissionAudit(e: AuditEntry): void {
    this.log(
      `permission: ${e.verdict} ${e.tool} (level ${e.level}, ${e.category}) — ${e.reason}`,
    );
    this.broadcast({ type: "activity", entry: toActivityEntry(e) });
    this.emit("permission-audit", e);
  }

  /** A user-facing sentence explaining why voice will not do what was asked. */
  private voiceUnavailableDetail(): string {
    if (!this.voiceEnabled) return "voice is disabled by configuration";
    const v = this.voice.getStatus();
    return (
      v.gaveUpReason ??
      this.voice.unavailableReason() ??
      v.lastError ??
      `voice is ${v.state}`
    );
  }

  get shouldQuit(): boolean {
    return this.quitRequested;
  }

  private broadcast(event: ServerEvent): void {
    this.ipc?.broadcast(event);
    this.emit("broadcast", event);
  }

  private broadcastStatus(): void {
    if (!this.ipc) return;
    this.ipc.broadcast({ type: "status", status: this.getStatus() });
  }

  private log(line: string): void {
    this.options.onLog?.(line);
    this.emit("log", line);
    this.ipc?.broadcast({ type: "log", line });
  }
}
