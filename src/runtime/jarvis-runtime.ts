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
import { join as joinPath } from "node:path";
import { HermesSupervisor, type SupervisorOptions } from "../system/hermes-supervisor.js";
import { AssistantStateMachine } from "./state-machine.js";
import { VoiceSidecar, type VoiceSidecarOptions } from "../voice/voice-sidecar.js";
import type { VoiceEvent } from "../voice/voice-protocol.js";
import { PipeServer, type HandledRequest } from "../ipc/pipe-server.js";
import { generateToken, publishToken, revokeToken } from "../ipc/token.js";
import type {
  ActivityEntry,
  CodingJobView,
  RuntimeStatus,
  ServerEvent,
  SubsystemStatus,
  TasksView,
} from "../ipc/contract.js";
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
  buildRegistry,
  type DirEntry,
  type ProjectEntry,
} from "../context/project-registry.js";
import { loadConfig, configFilePath } from "../context/config.js";
import { MemoryStore, type MemoryEntry } from "../memory/memory-store.js";
import { readHermesMemory } from "../memory/hermes-memory.js";
import { loadSkills, type Skill } from "../memory/skill-catalog.js";
import { fenceMemories, selectMemories, withMemoryContext } from "../memory/memory-prompt.js";
import { Notifier, parseNotifyLevel, type NotifyLevel } from "../notifications/notifier.js";
import { TaskWatcher } from "../tasks/task-watcher.js";
import { speakTasks } from "../tasks/speak-tasks.js";
import { readTasks, type TaskSnapshot } from "../tasks/cron-store.js";
import {
  PermissionEngine,
  type AuditEntry,
  type EngineOptions as PermissionOptions,
} from "../permissions/permission-engine.js";
import { ConsentBroker } from "../permissions/consent-broker.js";
import {
  toActionDescriptor,
  toOutcomeId,
  fromIpcDecision,
  toIpcOptions,
} from "../permissions/action-bridge.js";

export interface RuntimeOptions {
  cwd?: string;
  pipeName?: string;
  hermesPath?: string;
  restart?: SupervisorOptions["restart"];
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
  | { done: false; image?: { kind: "image"; data: Uint8Array; mimeType: string } };

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
  readonly consent: ConsentBroker;
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
    this.localIntents = new LocalIntentEngine(
      {
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
        ...options.localDeps,
      },
      {
        // Discovery is lazy inside the engine, so a slow disk cannot delay the
        // runtime becoming reachable.
        catalog: { startMenuRoots: defaultStartMenuRoots(), readDir: readDirSync },
        ...options.localIntents,
        onAudit: (d) => {
          this.auditLocal(d);
          options.localIntents?.onAudit?.(d);
        },
      },
    );

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
          this.machine.handle("speak");
          break;

        case "speaking_done":
          // SPEAKING ends when playback ends, not when audio was handed over.
          this.machine.handle("spoken");
          this.openConversationWindow();
          break;

        case "speaking_stopped":
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
      const stopReason = await this.supervisor.streamMessage(
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
      this.speakingTurn = false;
      this.machine.handle("error");
      const message = err instanceof Error ? err.message : String(err);
      this.broadcast({ type: "error", message, fatal: false });
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
    if (this.projectsCache) return this.projectsCache;

    const roots = this.configuredRoots();
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

  /** Forget the scan, so a newly cloned project is found without a restart. */
  rescanProjects(): readonly ProjectEntry[] {
    this.projectsCache = null;
    this.rootsCache = null;
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

  /** Speak, if TTS is genuinely available. Returns false when it is not. */
  say(text: string): boolean {
    if (!this.voice.isReady()) return false;
    return this.voice.speak(text);
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
      protocolVersion: 1,
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
      case "ready":
        if (!v.wakeWord) return { state: "unavailable", detail: "no wake-word model loaded" };
        if (!v.capturing) {
          return { state: "unavailable", detail: v.lastError ?? "microphone not capturing" };
        }
        return { state: "available", detail: `${v.wakeWord} on ${v.device ?? "default input"}` };
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
   */
  async prompt(text: string): Promise<void> {
    // `text_input` first: the local branch needs the machine out of idle before
    // it can route, and this is the event that represents a typed turn starting.
    this.machine.handle("text_input");
    // Not aloud: the typed path is silent by design, and the reply is already
    // on its way to every UI as a normal reply_chunk.
    const local = await this.tryLocal(text, false);
    if (local.done) return;

    if (!this.supervisor.isReady()) {
      // Say so rather than silently queueing forever.
      this.machine.handle("cancel");
      throw new Error(
        `Hermes is not available (${this.supervisor.getStatus().state})`,
      );
    }

    this.machine.handle("route_agent");
    try {
      const stopReason = await this.supervisor.streamMessage(
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
        local.image,
      );
      this.broadcast({ type: "reply_done", stopReason });
      // No audio on the typed path, so the turn is done here. Voice replies
      // go through speak/spoken instead, owned by the audio consumer.
      this.machine.handle("done");
    } catch (err) {
      this.machine.handle("error");
      throw err;
    }
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
        respond(this.permissions.audit.slice(-limit).map(toActivityEntry));
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

      case "prompt": {
        if (typeof request.text !== "string" || request.text.trim() === "") {
          fail("prompt text is required", "bad_request");
          return;
        }
        try {
          await this.prompt(request.text);
          respond();
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), "unavailable");
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
