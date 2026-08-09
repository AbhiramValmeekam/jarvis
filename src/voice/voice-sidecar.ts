/**
 * Supervisor for the Python voice daemon.
 *
 * Same contract as `HermesSupervisor`: own a child process, keep it alive
 * within bounds, and never pretend it is working when it is not. Voice is the
 * subsystem most likely to be genuinely unavailable on a given machine — no
 * microphone, no Python environment, a driver that vanished on resume — so the
 * failure paths here matter more than the happy one.
 *
 * The rule from §4 applies throughout: when voice does not work, say so and
 * say why. Typed input keeps working regardless, which is why nothing in the
 * runtime is allowed to block on this class being ready.
 */
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { RestartPolicy, type RestartPolicyOptions } from "../system/restart-policy.js";
import {
  LineBuffer,
  encodeCommand,
  parseVoiceEvent,
  type VoiceCommand,
  type VoiceEvent,
} from "./voice-protocol.js";

export type VoiceState =
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "suspended"
  | "failed";

export interface VoiceSidecarOptions {
  /** Project root; the daemon path and venv are resolved relative to it. */
  cwd?: string;
  /** Explicit interpreter. Defaults to the project venv, then `python`. */
  pythonPath?: string;
  /** Explicit daemon script. Defaults to `<cwd>/voice/daemon.py`. */
  daemonPath?: string;
  /** ffmpeg dshow device name. Defaults to the first audio input found. */
  device?: string;
  wakeWord?: string;
  sttModel?: string;
  piperVoice?: string;
  restart?: RestartPolicyOptions;
  /** Extra argv passed to the daemon, for measurement hooks. */
  extraArgs?: string[];
  /** Injected by tests so no Python is required. */
  spawnProcess?: (cmd: string, args: string[], cwd: string) => ChildProcess;
  onLog?: (line: string) => void;
}

export interface VoiceStatus {
  state: VoiceState;
  pid: number | null;
  wakeWord: string | null;
  device: string | null;
  sttModel: string | null;
  ttsVoice: string | null;
  /** True only when audio is genuinely being captured right now. */
  capturing: boolean;
  restartCount: number;
  gaveUpReason: string | null;
  lastError: string | null;
}

/** How long to wait for the daemon to load its models before calling it dead. */
const READY_TIMEOUT_MS = 90_000;

export class VoiceSidecar extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: VoiceState = "stopped";
  private policy: RestartPolicy;
  private restartTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private suspended = false;

  private wakeWord: string | null = null;
  private device: string | null = null;
  private sttModel: string | null = null;
  private ttsVoice: string | null = null;
  private capturing = false;
  private lastError: string | null = null;
  private restartCount = 0;

  private readonly cwd: string;

  constructor(private readonly options: VoiceSidecarOptions = {}) {
    super();
    this.cwd = resolvePath(options.cwd ?? process.cwd());
    this.policy = new RestartPolicy(options.restart);
  }

  getStatus(): VoiceStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      wakeWord: this.wakeWord,
      device: this.device,
      sttModel: this.sttModel,
      ttsVoice: this.ttsVoice,
      capturing: this.capturing,
      restartCount: this.restartCount,
      gaveUpReason: this.policy.reason,
      lastError: this.lastError,
    };
  }

  isReady(): boolean {
    return this.state === "ready" && this.child !== null;
  }

  /**
   * Locate the Python interpreter.
   *
   * The project venv is preferred because it is the one with the models
   * installed. Falling back to a bare `python` is deliberate but rarely right;
   * when it fails the error message says exactly what to run.
   */
  resolvePython(): { path: string; source: string } | null {
    if (this.options.pythonPath) {
      return { path: this.options.pythonPath, source: "configured" };
    }
    const venv = join(this.cwd, ".venv", "Scripts", "python.exe");
    if (existsSync(venv)) return { path: venv, source: "project venv" };
    const posixVenv = join(this.cwd, ".venv", "bin", "python");
    if (existsSync(posixVenv)) return { path: posixVenv, source: "project venv" };
    return null;
  }

  daemonScript(): string {
    return this.options.daemonPath ?? join(this.cwd, "voice", "daemon.py");
  }

  /**
   * Why voice cannot start, in words the user can act on — or null if it can.
   *
   * §61 requires that anything needing manual setup be explained exactly, so
   * this returns the literal command to run rather than "dependency missing".
   */
  unavailableReason(): string | null {
    const script = this.daemonScript();
    if (!existsSync(script)) {
      return `voice daemon not found at ${script}`;
    }
    if (!this.resolvePython()) {
      return (
        "no Python environment found. Set one up with:  " +
        "uv venv .venv --python 3.11  &&  " +
        "uv pip install --python .venv openwakeword faster-whisper piper-tts"
      );
    }
    return null;
  }

  async start(): Promise<void> {
    if (this.child || this.stopping) return;

    const reason = this.unavailableReason();
    if (reason) {
      this.setState("failed");
      this.lastError = reason;
      this.emit("unavailable", reason);
      return;
    }

    const python = this.resolvePython();
    /* c8 ignore next */
    if (!python) return; // unreachable: unavailableReason() covers it

    const args = [
      this.daemonScript(),
      "--stt-model", this.options.sttModel ?? "base.en",
      "--wake-word", this.options.wakeWord ?? "hey_jarvis",
    ];
    if (this.options.device) args.push("--device", this.options.device);
    if (this.options.piperVoice) args.push("--piper-voice", this.options.piperVoice);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);

    this.setState("starting");
    this.log(`starting voice daemon (${python.source}: ${python.path})`);

    const child = this.options.spawnProcess
      ? this.options.spawnProcess(python.path, args, this.cwd)
      : spawn(python.path, args, {
          cwd: this.cwd,
          // No shell: arguments must never be re-parsed by cmd.exe, which is
          // how a device name with a quote in it becomes command injection.
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
        });

    this.child = child;
    this.wireChild(child);

    // Model loading takes seconds (measured: ~6 s warm, longer on first run).
    // If `ready` never arrives, treat it as a crash rather than hanging.
    this.readyTimer = setTimeout(() => {
      if (this.state === "starting") {
        this.lastError = `voice daemon did not become ready within ${READY_TIMEOUT_MS / 1000}s`;
        this.log(this.lastError);
        this.killChild();
      }
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  private wireChild(child: ChildProcess): void {
    const out = new LineBuffer();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of out.push(chunk)) this.onLine(line);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) this.log(line.trim());
      }
    });

    child.on("error", (err: Error) => {
      this.lastError = err.message;
      this.log(`voice daemon error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      for (const line of out.flush()) this.onLine(line);
      this.onExit(code, signal);
    });
  }

  private onLine(line: string): void {
    const event = parseVoiceEvent(line);
    if (!event) {
      // Unparseable output is dropped, but not silently — a daemon emitting
      // garbage is a bug worth seeing.
      if (line.trim()) this.log(`ignored unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    switch (event.type) {
      case "ready":
        this.clearReadyTimer();
        this.wakeWord = event.wakeWord;
        this.device = event.device;
        this.sttModel = event.sttModel;
        this.ttsVoice = event.ttsVoice;
        this.capturing = event.capture;
        this.setState("ready");
        this.policy.reset();
        this.log(
          `voice ready — wake=${event.wakeWord ?? "none"} stt=${event.sttModel ?? "none"} ` +
            `tts=${event.ttsVoice ?? "none"} device=${event.device ?? "none"}`,
        );
        break;
      case "muted":
        this.capturing = event.capturing;
        break;
      case "unavailable":
        this.lastError = `${event.subsystem}: ${event.reason}`;
        break;
      case "error":
        this.lastError = event.message;
        break;
      case "log":
        this.log(event.line);
        return; // logs are not part of the event stream the runtime consumes
      default:
        break;
    }

    this.emit("voice-event", event);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearReadyTimer();
    this.child = null;
    this.capturing = false;

    if (this.stopping || this.suspended) {
      this.setState(this.suspended ? "suspended" : "stopped");
      return;
    }

    const how = signal ? `signal ${signal}` : `code ${code}`;
    this.log(`voice daemon exited (${how})`);
    this.emit("crash", how);

    const decision = this.policy.recordCrash();
    if (!decision.restart) {
      this.setState("failed");
      this.lastError = decision.reason;
      this.emit("gave-up", decision.reason);
      this.emit("unavailable", `voice stopped working and ${decision.reason}`);
      return;
    }

    this.restartCount = decision.attempt;
    this.setState("restarting");
    this.log(`restarting voice daemon in ${decision.delayMs}ms (attempt ${decision.attempt})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, decision.delayMs);
    this.restartTimer.unref?.();
  }

  // --- commands ------------------------------------------------------------

  /** Returns false when the daemon is not there to receive it. */
  send(cmd: VoiceCommand): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !this.isReady()) return false;
    try {
      stdin.write(encodeCommand(cmd));
      return true;
    } catch {
      return false;
    }
  }

  speak(text: string, id?: string): boolean {
    return this.send(id === undefined ? { type: "speak", text } : { type: "speak", text, id });
  }

  stopSpeaking(reason = "stopped"): boolean {
    return this.send({ type: "stop_speaking", reason });
  }

  setMuted(muted: boolean): boolean {
    return this.send({ type: "set_muted", muted });
  }

  setListening(enabled: boolean): boolean {
    return this.send({ type: "set_listening", enabled });
  }

  setConversation(open: boolean): boolean {
    return this.send({ type: "set_conversation", open });
  }

  pushToTalk(down: boolean): boolean {
    return this.send({ type: "ptt", down });
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Release the microphone for sleep.
   *
   * The daemon is stopped rather than paused: holding a dshow handle across a
   * suspend is how you get a device that never comes back, and audio hardware
   * is routinely re-enumerated on resume.
   */
  async suspend(): Promise<void> {
    if (this.suspended) return;
    this.suspended = true;
    this.cancelRestart();
    await this.stopChild();
    this.setState("suspended");
  }

  async resume(): Promise<void> {
    if (!this.suspended) return;
    this.suspended = false;
    this.policy.reset();
    this.restartCount = 0;
    await this.start();
  }

  async restart(): Promise<void> {
    this.cancelRestart();
    this.policy.reset();
    this.restartCount = 0;
    await this.stopChild();
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelRestart();
    await this.stopChild();
    this.setState("stopped");
    this.stopping = false;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Ask first: a clean shutdown releases the microphone and stops ffmpeg and
    // ffplay, which are separate processes the daemon owns. Killing outright
    // can orphan them.
    this.send({ type: "shutdown" });
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }

    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.killChild();
        done();
      }, 3_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    this.child = null;
  }

  private killChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearReadyTimer();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private setState(s: VoiceState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  private log(line: string): void {
    this.options.onLog?.(`[voice] ${line}`);
    this.emit("log", line);
  }
}
