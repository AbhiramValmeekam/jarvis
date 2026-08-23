/**
 * Preload bridge.
 *
 * The renderer is the least-trusted part of the desktop app: it renders model
 * output and, later, web content. It therefore gets no Node access at all
 * (`contextIsolation: true`, `nodeIntegration: false`) and can only reach the
 * runtime through the narrow, explicitly enumerated surface below.
 *
 * Note what is NOT here: no arbitrary `invoke`, no channel name taken from the
 * renderer, no filesystem, no shell. A prompt-injection payload rendered in the
 * HUD can only do what this file allows, and this file allows nothing that
 * isn't already a user-initiated assistant action.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  ActivityEntry,
  DemoView,
  McpView,
  MemoryView,
  MemoryWriteResult,
  MissionDetailView,
  MissionsView,
  RuntimeStatus,
  ServerEvent,
  SkillsView,
  TasksView,
  ToolsView,
  TraceView,
  ProposalResult,
  VisionProposalView,
  WorldView,
} from "../ipc/contract.js";

export type UiBridge = {
  getStatus(): Promise<RuntimeStatus | null>;
  /** The decision backlog, for a HUD that attached after the fact. */
  getActivity(): Promise<readonly ActivityEntry[]>;
  /**
   * Hermes' scheduled jobs, and whether its scheduler is actually alive.
   *
   * Read-only, and there is no counterpart that creates or deletes one. Hermes
   * owns that file and writes it under a lock; scheduling something new goes
   * through the agent, which is also where the gateway-lifecycle guard lives.
   */
  getTasks(): Promise<TasksView | null>;
  /**
   * The MCP servers Hermes is configured with.
   *
   * Read-only, with no `addMcpServer` beside it, and that is the security
   * boundary rather than an omission. An MCP entry is a command Hermes spawns
   * with the user's environment; Hermes screens those on save because entries of
   * exactly that shape were planted in the wild. A write here would be a path to
   * the same effect that skips the screening — from the *renderer*, the one
   * process in this app that renders model output.
   */
  getMcp(): Promise<McpView | null>;
  /** What Jarvis remembers, and whether Hermes' separate store is on. */
  getMemory(): Promise<MemoryView | null>;
  /**
   * The memory writes.
   *
   * These exist on the bridge and the read-only rule this file states elsewhere is
   * not being bent: what a renderer may write here is the user's own notes about
   * their own life, into the same store methods behind the same screens that
   * dictation goes through. No path here can write an *inferred* value, accept a
   * suggestion the runtime did not put in the queue, or widen a permission.
   *
   * Every one of them resolves with the whole `MemoryView` after the write, and a
   * refusal comes back as `saved: false` with the reason — not a rejected promise.
   */
  remember(text: string): Promise<MemoryWriteResult | null>;
  editMemory(memoryId: string, text: string): Promise<MemoryWriteResult | null>;
  forgetMemory(memoryId: string): Promise<MemoryWriteResult | null>;
  forgetEpisode(episodeId: string): Promise<MemoryWriteResult | null>;
  /** `value` omitted clears the field. The key must be one of the eight. */
  setProfile(key: string, value?: string): Promise<MemoryWriteResult | null>;
  /**
   * Accept or decline one thing Jarvis offered to remember.
   *
   * The only way anything Jarvis proposed becomes something it knows, and it is a
   * click in the user's own window. Nothing a mission does can reach this.
   */
  resolveLearning(
    proposalId: string,
    decision: "accept" | "reject",
  ): Promise<MemoryWriteResult | null>;
  /** Switch the layer off, or on. Nothing is deleted either way. */
  setMemoryEnabled(enabled: boolean): Promise<MemoryWriteResult | null>;
  /**
   * Delete all four layers.
   *
   * `confirm` must be exactly `FORGET_EVERYTHING`, typed by the user rather than
   * supplied by the page. The runtime refuses anything else, so a mis-wired button
   * cannot erase a memory store.
   */
  forgetEverything(confirm: string): Promise<MemoryWriteResult | null>;
  /** The installed skills — what Jarvis can actually do. */
  getSkills(): Promise<SkillsView | null>;
  /**
   * What Jarvis can see: projects, apps, the foreground window, jobs, missions, and
   * the edges between them with the reason for each.
   *
   * Read-only, and asking is what assembles it — there is no `refreshWorld` and
   * nothing on a timer. Suggestions come back inside the same view.
   */
  getWorld(): Promise<WorldView | null>;
  /**
   * Answer one thing Jarvis offered to do.
   *
   * The only door from a suggestion to a mission, and it is a click in the user's
   * own window. `accept` runs the objective through exactly the path `startMission`
   * takes — same planner, same permission prompts, same verification — and resolves
   * when that mission is over. `decline` starts nothing and keeps that rule quiet.
   */
  resolveProposal(
    proposalId: string,
    decision: "accept" | "decline",
  ): Promise<ProposalResult | null>;
  /**
   * Give Jarvis an objective, and get the finished mission back.
   *
   * The one write on this bridge that starts an autonomous loop, and it takes an
   * outcome rather than a plan — there is no way from here to hand the runtime a
   * step, a tool name or an argument. Everything the mission then does is chosen,
   * classified and permitted on the runtime's side of the pipe.
   *
   * It resolves when the mission is over, which can be minutes. The page does not
   * wait on this promise to draw: the plan, every step and every line arrive as
   * `mission*` events while it runs, and this resolution is the report.
   */
  startMission(objective: string): Promise<MissionDetailView | null>;
  /**
   * Ask Jarvis to look at the screen and propose an objective.
   *
   * The window's "fix this": one screenshot, one model call, and a proposal — the
   * objective it would take on, and what it says it saw, so the two can be checked
   * against each other. Nothing starts. A Start button calls `startMission` with the
   * objective it was shown, which is the same path a typed one takes, and that is why
   * there is no `acceptProposal` here: a screenshot must not have a door into the
   * mission loop that a person's click does not open.
   *
   * `ask` is optional and defaults to the phrase the spoken door uses. Resolves with a
   * refusal — not a rejection — when there is no vision model, when the capture gate
   * said no, or when there was nothing on screen worth doing; each of those is an
   * answer, and the page shows the sentence.
   */
  proposeFromScreen(ask?: string): Promise<VisionProposalView | null>;
  /** Missions this runtime knows about, newest first. Finished ones included. */
  getMissions(): Promise<MissionsView | null>;
  /** One mission and the report built from its own record. */
  getMission(missionId: string): Promise<MissionDetailView | null>;
  /**
   * The Agent Trace: every line the mission logged, attributed to a role.
   *
   * Separate from `getMission` because it is a different and much larger thing: the
   * detail view is the mission as it stands now, and this is the order it happened in.
   * Fetched on demand rather than pushed, so a page that never opens the trace never
   * carries one across the pipe.
   */
  getTrace(missionId: string): Promise<TraceView | null>;
  /** Stop a mission where it is. Cancelling is an outcome, not an error. */
  cancelMission(missionId: string): Promise<void>;
  /**
   * Answer the consent question a mission step is parked on.
   *
   * Separate from `respondToPermission` because they answer different questions,
   * and because this one is addressed by mission and step rather than by a request
   * id the renderer would have to have been told. The runtime refuses anything
   * that does not name the step actually waiting.
   */
  approveStep(
    missionId: string,
    stepId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ): Promise<void>;
  /**
   * The tools a mission may choose from, and the per-class policy over them.
   *
   * Read-only, and deliberately with no `invokeTool` beside it: a renderer able to
   * call a tool would reach the filesystem and the shell without passing the
   * mission loop, the classification or the permission engine.
   */
  getTools(): Promise<ToolsView | null>;
  /**
   * Set one risk class's policy for this session, and get the new view back.
   *
   * The only write on this bridge that changes what a mission is allowed to do, and
   * it is a class and a verdict from fixed sets — never a tool name, never a path.
   * It cannot loosen a `forbidden` classification and `auto` still asks at the top
   * level; both rules live in the engine, where a renderer cannot reach them.
   *
   * It does not touch `config.json`. The change lasts until the runtime restarts,
   * which is what the panel says on its face.
   */
  setToolPolicy(
    category: string,
    verdict: "auto" | "approval" | "deny" | "default",
  ): Promise<ToolsView | null>;
  /**
   * The demo scenarios and an honest verdict on which of them will run here (§28).
   *
   * Read-only, and there is no `runDemo` beside it. Each scenario carries the exact
   * objective it stands for, and the Run button calls `startMission` with that
   * string — so a demonstration takes the same path, the same classification and the
   * same consent prompts as anything typed into the objective box.
   */
  getDemo(): Promise<DemoView | null>;
  /**
   * Write the demo fixtures, and answer with the new view.
   *
   * No argument, deliberately: the directory is computed in the runtime from one
   * environment variable, so this bridge cannot nominate somewhere for Jarvis to
   * write. Safe to call twice — and worth calling twice, since it is what puts the
   * deliberate break back after a mission has repaired it.
   */
  prepareDemo(): Promise<DemoView | null>;
  /** Remove the demo fixtures — the three it created, by name. Answers with the view. */
  resetDemo(): Promise<DemoView | null>;
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  setListening(enabled: boolean): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  restartHermes(): Promise<void>;
  restartVoice(): Promise<void>;
  /** Hold-to-talk. `down` is the key state, not a toggle. */
  pushToTalk(down: boolean): Promise<void>;
  say(text: string): Promise<void>;
  /**
   * Answer an outstanding permission request.
   *
   * The decision is a fixed enum, not a free string, and the runtime rejects a
   * requestId it did not issue — so the worst a compromised renderer can do is
   * answer a question the user was already being asked, which it could do by
   * drawing a fake button anyway. It cannot invent a grant for anything else.
   */
  respondToPermission(
    requestId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ): Promise<void>;
  hideWindow(): void;
  /** Open Mission Control. Takes nothing, so it can only ever open that window. */
  openMissionWindow(): void;
  /** Open the Memory page. Same rule: no argument, so no other window. */
  openMemoryWindow(): void;
  /** Subscribe to runtime events. Returns an unsubscribe function. */
  onEvent(handler: (event: ServerEvent) => void): () => void;
  /** Connection state of the UI↔runtime link. */
  onLink(handler: (linked: boolean) => void): () => void;
};

const bridge: UiBridge = {
  getStatus: () => ipcRenderer.invoke("jarvis:get-status"),
  getActivity: () => ipcRenderer.invoke("jarvis:get-activity"),
  getTasks: () => ipcRenderer.invoke("jarvis:get-tasks"),
  getMcp: () => ipcRenderer.invoke("jarvis:get-mcp"),
  getMemory: () => ipcRenderer.invoke("jarvis:get-memory"),
  remember: (text: string) => ipcRenderer.invoke("jarvis:remember", String(text)),
  editMemory: (memoryId: string, text: string) =>
    ipcRenderer.invoke("jarvis:edit-memory", String(memoryId), String(text)),
  forgetMemory: (memoryId: string) =>
    ipcRenderer.invoke("jarvis:forget-memory", String(memoryId)),
  forgetEpisode: (episodeId: string) =>
    ipcRenderer.invoke("jarvis:forget-episode", String(episodeId)),
  setProfile: (key: string, value?: string) =>
    // `undefined` stays `undefined` across the bridge rather than becoming "undefined":
    // absent means clear, and a field cleared by a string is a field set to garbage.
    ipcRenderer.invoke(
      "jarvis:set-profile",
      String(key),
      value === undefined ? undefined : String(value),
    ),
  resolveLearning: (proposalId: string, decision: string) =>
    ipcRenderer.invoke("jarvis:resolve-learning", String(proposalId), String(decision)),
  setMemoryEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("jarvis:set-memory-enabled", Boolean(enabled)),
  forgetEverything: (confirm: string) =>
    // Passed through as typed. Main compares it against the one accepted phrase and
    // so does the runtime; neither of them will accept a phrase this page invented.
    ipcRenderer.invoke("jarvis:forget-everything", String(confirm)),
  getSkills: () => ipcRenderer.invoke("jarvis:get-skills"),
  getWorld: () => ipcRenderer.invoke("jarvis:get-world"),
  resolveProposal: (proposalId: string, decision: string) =>
    // Coerced here and checked against the literal pair in main: `accept` starts a
    // mission, so this is one of the calls that acts on the machine.
    ipcRenderer.invoke("jarvis:resolve-proposal", String(proposalId), String(decision)),
  startMission: (objective: string) =>
    ipcRenderer.invoke("jarvis:start-mission", String(objective)),
  proposeFromScreen: (ask?: string) =>
    // Passed only when there is something to pass: main reads an absent `ask` as
    // "fix this", and coercing `undefined` here would send the word "undefined" to
    // a vision model as the user's question.
    ipcRenderer.invoke("jarvis:propose-from-screen", ask === undefined ? undefined : String(ask)),
  getMissions: () => ipcRenderer.invoke("jarvis:get-missions"),
  getMission: (missionId: string) =>
    ipcRenderer.invoke("jarvis:get-mission", String(missionId)),
  getTrace: (missionId: string) => ipcRenderer.invoke("jarvis:get-trace", String(missionId)),
  cancelMission: (missionId: string) =>
    ipcRenderer.invoke("jarvis:cancel-mission", String(missionId)),
  approveStep: (missionId, stepId, decision) =>
    // Coerced here and validated again in main, for the same reason
    // `respondToPermission` is: this call authorises an action on the machine.
    ipcRenderer.invoke(
      "jarvis:approve-step",
      String(missionId),
      String(stepId),
      String(decision),
    ),
  getTools: () => ipcRenderer.invoke("jarvis:get-tools"),
  getDemo: () => ipcRenderer.invoke("jarvis:get-demo"),
  prepareDemo: () => ipcRenderer.invoke("jarvis:prepare-demo"),
  resetDemo: () => ipcRenderer.invoke("jarvis:reset-demo"),
  setToolPolicy: (category: string, verdict: string) =>
    // Coerced here and validated again in main and in the runtime. Three checks for
    // two strings looks like too many until one remembers that this is the one
    // renderer-driven message that changes what a mission may do.
    ipcRenderer.invoke("jarvis:set-tool-policy", String(category), String(verdict)),
  prompt: (text: string) => ipcRenderer.invoke("jarvis:prompt", String(text)),
  cancel: () => ipcRenderer.invoke("jarvis:cancel"),
  setListening: (enabled: boolean) =>
    ipcRenderer.invoke("jarvis:set-listening", Boolean(enabled)),
  setMuted: (muted: boolean) => ipcRenderer.invoke("jarvis:set-muted", Boolean(muted)),
  restartHermes: () => ipcRenderer.invoke("jarvis:restart-hermes"),
  restartVoice: () => ipcRenderer.invoke("jarvis:restart-voice"),
  pushToTalk: (down: boolean) => ipcRenderer.invoke("jarvis:push-to-talk", Boolean(down)),
  say: (text: string) => ipcRenderer.invoke("jarvis:say", String(text)),
  respondToPermission: (requestId, decision) =>
    // Coerced here as well as validated in main: the renderer is the untrusted
    // side, so nothing but a string and one of three literals crosses over.
    ipcRenderer.invoke("jarvis:permission-response", String(requestId), String(decision)),
  hideWindow: () => ipcRenderer.send("jarvis:hide-window"),
  openMissionWindow: () => ipcRenderer.send("jarvis:open-mission"),
  openMemoryWindow: () => ipcRenderer.send("jarvis:open-memory"),

  onEvent(handler) {
    const listener = (_e: unknown, payload: ServerEvent) => handler(payload);
    ipcRenderer.on("jarvis:event", listener);
    return () => ipcRenderer.off("jarvis:event", listener);
  },

  onLink(handler) {
    const listener = (_e: unknown, linked: boolean) => handler(linked);
    ipcRenderer.on("jarvis:link", listener);
    return () => ipcRenderer.off("jarvis:link", listener);
  },
};

contextBridge.exposeInMainWorld("jarvis", bridge);
