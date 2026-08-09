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
import { readdirSync } from "node:fs";
import { HermesSupervisor, type SupervisorOptions } from "../system/hermes-supervisor.js";
import { AssistantStateMachine } from "./state-machine.js";
import { VoiceSidecar, type VoiceSidecarOptions } from "../voice/voice-sidecar.js";
import type { VoiceEvent } from "../voice/voice-protocol.js";
import { PipeServer, type HandledRequest } from "../ipc/pipe-server.js";
import { generateToken, publishToken, revokeToken } from "../ipc/token.js";
import type { RuntimeStatus, ServerEvent, SubsystemStatus } from "../ipc/contract.js";
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
} from "../local-intents/executors.js";
import { defaultStartMenuRoots } from "../system/app-catalog.js";

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
  /** Machine-facing overrides for local actions. Injected by tests. */
  localDeps?: Partial<EngineDeps>;
  onLog?: (line: string) => void;
}

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

export class JarvisRuntime extends EventEmitter {
  readonly supervisor: HermesSupervisor;
  readonly machine: AssistantStateMachine;
  readonly voice: VoiceSidecar;
  readonly localIntents: LocalIntentEngine;
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

    this.supervisor = new HermesSupervisor({
      cwd: options.cwd,
      hermesPath: options.hermesPath,
      restart: options.restart,
      createAdapter: options.createAdapter,
      onLog: (line) => this.log(line),
    });

    this.machine = new AssistantStateMachine();

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

    if (await this.tryLocal(text)) return;

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
      const stopReason = await this.supervisor.streamMessage(text, (ev) => {
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
      });
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
   * Returns true when the turn is finished locally and Hermes should not see it.
   * A local *failure* still counts as handled: the user asked to mute the
   * speakers, the device refused, and saying so is the honest end of that turn —
   * escalating to an agent that would try the same thing again is not.
   */
  private async tryLocal(text: string, aloud = true): Promise<boolean> {
    const decision = await this.localIntents.handle(text);

    if (decision.route === "agent") return false;

    this.machine.handle("route_local");

    if (decision.route === "ask") {
      // Asked out loud, and the answer arrives through the conversation window
      // like any other follow-up.
      const question = decision.question ?? "Which did you mean?";
      this.broadcast({ type: "reply_chunk", text: question });
      this.broadcast({ type: "reply_done", stopReason: "clarify" });
      this.finishLocal(question, aloud);
      return true;
    }

    const outcome = decision.outcome;
    const speech = outcome?.speech ?? "";

    if (outcome && !outcome.ok) {
      // Surface what failed, and keep the detail in the log rather than in the
      // spoken reply — it exists for debugging, not for the user's ears.
      this.broadcast({ type: "error", message: outcome.detail ?? speech, fatal: false });
    }
    this.broadcast({ type: "reply_chunk", text: speech });
    this.broadcast({ type: "reply_done", stopReason: "local" });
    this.finishLocal(speech, aloud);
    return true;
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
    server.on("disconnect", () => this.broadcastStatus());

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
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.machine.reset();
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
    if (await this.tryLocal(text, false)) return;

    if (!this.supervisor.isReady()) {
      // Say so rather than silently queueing forever.
      this.machine.handle("cancel");
      throw new Error(
        `Hermes is not available (${this.supervisor.getStatus().state})`,
      );
    }

    this.machine.handle("route_agent");
    try {
      const stopReason = await this.supervisor.streamMessage(text, (e) => {
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
      });
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

      case "permission_response":
        // The permission engine arrives in Phase 5; refusing is the honest
        // answer until it does.
        fail("permission engine not implemented yet (Phase 5)", "unavailable");
        return;

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
