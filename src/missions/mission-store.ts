/**
 * What a mission did, on disk.
 *
 * Two files per mission, because they answer two different questions and one file
 * cannot answer both honestly:
 *
 *  - `<id>.jsonl` is **append-only**. One line per thing that happened, in the
 *    order it happened. Nothing rewrites a line, so the order a mission went
 *    wrong in survives — which is the whole value of a log, and the first thing a
 *    file that gets rewritten loses.
 *  - `<id>.json` is the **latest snapshot**, written through a temp file and
 *    `rename` exactly as `memory/memory-store.ts` does. It is what "show me that
 *    mission" reads, and rename being atomic on one volume is what stops a crash
 *    mid-write from leaving a torn mission where a whole one used to be.
 *
 * Three rules the rest of the file exists to keep:
 *
 *  - **A file is untrusted input.** Everything read back is validated field by
 *    field and sanitised, like `tasks/cron-store.ts` treats Hermes' jobs. A
 *    snapshot with a step this build cannot understand is refused as a whole
 *    rather than loaded in part: a mission missing a step would report counts that
 *    are quietly wrong, and a wrong count is worse than an unreadable record.
 *  - **A credential does not become durable here.** Step arguments are stored,
 *    because they are what the step actually did, but string values go through
 *    `redactSecrets` on the way in. A mission log is a record, not a replay input,
 *    so a redacted argument costs nothing and a stored token costs a great deal.
 *  - **It is bounded.** An always-on process writing an unbounded log is a disk
 *    that fills, so the log has a byte ceiling that says when it stopped, and the
 *    directory keeps the newest `MAX_MISSIONS` missions and no more.
 *
 * Corrupt is never a crash: a bad file yields an empty result and a log line, and
 * the file is left on disk for a person to look at (`loadConfig` and
 * `MemoryStore` set that precedent, for the same reason — this runs at boot).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { redactSecrets } from "../context/window-facts.js";
import { sanitiseForDisplay } from "../permissions/risk-model.js";
import type { ActionOutcome } from "../permissions/verified-action.js";
import type {
  Mission,
  MissionEvent,
  MissionMemoryRef,
  MissionState,
  PlanStep,
  StepStatus,
} from "./mission-model.js";

/**
 * Bumped when a stored mission stops being readable by this code.
 *
 * A snapshot from a future version is refused rather than guessed at — the fields
 * it would be missing are the ones the report counts.
 */
export const SNAPSHOT_VERSION = 1;

/**
 * `%LOCALAPPDATA%\Jarvis\missions` — beside `memory.json`, not inside Hermes'
 * directory. Same resolution as `memoryFilePath()`, so one machine has one Jarvis
 * data directory rather than two that disagree.
 */
export function missionsDir(): string {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "Jarvis", "missions");
}

/** Missions kept. Older ones are deleted, oldest first, when a new one arrives. */
export const MAX_MISSIONS = 50;
/** Per-mission log ceiling. Past it the log says so and stops growing. */
export const MAX_LOG_BYTES = 512_000;
/** Longest stored string inside a step's arguments. A path is far shorter. */
export const MAX_ARG_CHARS = 2_000;

const MAX_OBJECTIVE = 400;
const MAX_TITLE = 200;
const MAX_TEXT = 400;
const MAX_STEPS = 200;
const MAX_MEMORY_REFS = 40;
const MAX_ARG_KEYS = 40;
const MAX_ARG_ITEMS = 40;

/**
 * The line a full log ends with.
 *
 * Load-bearing text: it is how a reopened store recognises a log that is already
 * closed, so it is a constant rather than a sentence written at the call site.
 */
const LOG_FULL_NOTE = "this log reached its size limit, so later events are in the snapshot only";

/**
 * A step as one log line carries it.
 *
 * No `args`: a line is an account of what happened, and the arguments are already
 * in the snapshot. `attempt` and `origin` are here because they are how the report
 * tells a recovery from a first try.
 *
 * `risk` is here for the trace's sake. Reading a level off the *snapshot* instead would
 * mean showing a step's final classification against every line it ever appeared on, and
 * a retry can classify differently from the attempt before it — so a per-step fact would
 * be printed as a per-line one. Absent still means "not classified", as everywhere else.
 */
export interface LoggedStep {
  readonly id: string;
  readonly title: string;
  readonly tool: string;
  readonly status: StepStatus;
  readonly attempt: number;
  readonly origin: "plan" | "replan";
  readonly risk?: { readonly level: number; readonly category: string };
  readonly outcome?: ActionOutcome;
  readonly result?: string;
  readonly error?: string;
  readonly simulated?: boolean;
}

/** One line of `<id>.jsonl`. */
export interface MissionLogLine {
  readonly at: number;
  /** The mission this line belongs to, so a merged read still knows. */
  readonly mission: string;
  readonly state: MissionState;
  readonly event?: MissionEvent;
  readonly step?: LoggedStep;
  readonly note?: string;
  /**
   * Whose words `note` is: absent for a line composed by this repository, `"model"` for
   * a replan diagnosis quoted from a language model.
   *
   * Written down rather than derived, because after the fact there is nothing in a line
   * to derive it from — and a trace that showed a model's sentence in the same voice as a
   * counted one would be making the claim §43 forbids. Declared as the literal rather
   * than imported from `replanner.ts`, for the reason `MissionRecordInput` is: the store
   * does not depend on the loop.
   */
  readonly voice?: "model";
}

/**
 * What `record` takes.
 *
 * Structurally the orchestrator's `MissionUpdate`, declared here rather than
 * imported so the store does not depend on the loop that drives it — a probe or a
 * test can record a mission without constructing an orchestrator.
 */
export interface MissionRecordInput {
  readonly mission: Mission;
  readonly at: number;
  readonly event?: MissionEvent;
  readonly step?: PlanStep;
  readonly note?: string;
  readonly voice?: "model";
}

export interface MissionStoreOptions {
  dir?: string;
  onError?(msg: string): void;
  maxMissions?: number;
  /** Per-mission log ceiling in bytes. Lowered by tests; never raised in the runtime. */
  maxLogBytes?: number;
}

// --- what this build recognises ---------------------------------------------

/**
 * The known names, as `Record<Union, true>` rather than a `Set` of strings.
 *
 * Written this way so adding a state or an event to `mission-model.ts` and not
 * teaching this file about it is a compile error, not a mission that silently
 * fails to load after the next restart.
 */
const STATES: Record<MissionState, true> = {
  planning: true,
  retrieving: true,
  executing: true,
  verifying: true,
  replanning: true,
  waiting_approval: true,
  completed: true,
  failed: true,
  blocked: true,
  cancelled: true,
};

const STATUSES: Record<StepStatus, true> = {
  pending: true,
  awaiting_approval: true,
  running: true,
  done: true,
  unverified: true,
  failed: true,
  skipped: true,
  cancelled: true,
};

const EVENTS: Record<MissionEvent, true> = {
  planned: true,
  plan_empty: true,
  retrieved: true,
  verify: true,
  step_ok: true,
  step_bad: true,
  need_approval: true,
  approved: true,
  denied: true,
  replanned: true,
  replan_exhausted: true,
  ask_user: true,
  finish: true,
  give_up: true,
  cancel: true,
  error: true,
};

const OUTCOMES: Record<ActionOutcome, true> = {
  verified: true,
  unconfirmed: true,
  failed: true,
  unchecked: true,
};

const SOURCES: Record<MissionMemoryRef["source"], true> = {
  memory: true,
  project: true,
  skill: true,
  window: true,
  task: true,
  profile: true,
  episode: true,
};

function known<T extends string>(table: Record<T, true>, raw: unknown): T | null {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(table, raw)
    ? (raw as T)
    : null;
}

// --- names, values, and what is safe to keep --------------------------------

/**
 * A mission id that can be a filename, or nothing.
 *
 * Ids come from the orchestrator, but a caller may supply one (`run(objective,
 * {id})`), and an id is about to be pasted into a path. A traversal here would
 * write outside the missions directory, so the shape is an allow-list and
 * anything else is refused rather than repaired — a repaired id would be a
 * different mission's file.
 */
export function safeMissionId(raw: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw) ? raw : null;
}

/** Sanitised text, or null when there was none to keep. */
function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const out = sanitiseForDisplay(raw, max);
  return out === "" ? null : out;
}

function finite(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * One argument value, on the way to disk and on the way back.
 *
 * Strings are redacted, everything is capped, and anything that is not JSON —
 * a function, a symbol, `undefined` — is dropped rather than serialised as
 * `null`, which would turn "we did not store this" into "the step was called
 * with null".
 */
function safeValue(raw: unknown, depth = 0): unknown {
  if (typeof raw === "string") return redactSecrets(raw.slice(0, MAX_ARG_CHARS)).text;
  if (typeof raw === "boolean" || raw === null) return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (depth >= 3) return null;
  if (Array.isArray(raw)) {
    return raw.slice(0, MAX_ARG_ITEMS).map((item) => safeValue(item, depth + 1));
  }
  if (typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw).slice(0, MAX_ARG_KEYS)) {
      const kept = safeValue(value, depth + 1);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return undefined;
}

function safeArgs(raw: unknown): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const kept = safeValue(raw);
  return typeof kept === "object" && kept !== null && !Array.isArray(kept)
    ? (kept as Record<string, unknown>)
    : {};
}

// --- on the way out ---------------------------------------------------------

/** The mission as it is stored: itself, with its arguments made safe to keep. */
function toStored(mission: Mission): Mission {
  return {
    ...mission,
    steps: mission.steps.map((s) => ({ ...s, args: safeArgs(s.args) })),
  };
}

function toLoggedStep(step: PlanStep): LoggedStep {
  return {
    id: step.id,
    title: step.title,
    tool: step.tool,
    status: step.status,
    attempt: step.attempt,
    origin: step.origin,
    ...(step.risk !== undefined
      ? { risk: { level: step.risk.level, category: step.risk.category } }
      : {}),
    ...(step.outcome !== undefined ? { outcome: step.outcome } : {}),
    ...(step.result !== undefined ? { result: sanitiseForDisplay(step.result, MAX_TEXT) } : {}),
    ...(step.error !== undefined ? { error: sanitiseForDisplay(step.error, MAX_TEXT) } : {}),
    ...(step.simulated ? { simulated: true } : {}),
  };
}

function toLine(input: MissionRecordInput): MissionLogLine {
  return {
    at: input.at,
    mission: input.mission.id,
    state: input.mission.state,
    ...(input.event !== undefined ? { event: input.event } : {}),
    ...(input.step !== undefined ? { step: toLoggedStep(input.step) } : {}),
    ...(input.note !== undefined ? { note: sanitiseForDisplay(input.note, MAX_TEXT) } : {}),
    ...(input.voice === "model" ? { voice: "model" as const } : {}),
  };
}

// --- on the way back --------------------------------------------------------

function readStep(raw: unknown): PlanStep | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = text(o.id, 80);
  const tool = text(o.tool, 80);
  const status = known(STATUSES, o.status);
  const attempt = finite(o.attempt);
  const priority = finite(o.priority);
  // A step missing any of these cannot be counted, displayed or explained, and a
  // mission whose counts are wrong is the failure this store exists to avoid.
  if (id === null || tool === null || status === null || attempt === null || priority === null) {
    return null;
  }
  const dependsOn = Array.isArray(o.dependsOn)
    ? o.dependsOn.slice(0, MAX_STEPS).flatMap((d) => text(d, 80) ?? [])
    : [];
  const outcome = known(OUTCOMES, o.outcome);
  const result = text(o.result, MAX_TEXT);
  const error = text(o.error, MAX_TEXT);
  const startedAt = finite(o.startedAt);
  const finishedAt = finite(o.finishedAt);
  return {
    id,
    title: text(o.title, MAX_TITLE) ?? id,
    tool,
    args: safeArgs(o.args),
    dependsOn,
    priority,
    optional: o.optional === true,
    origin: o.origin === "replan" ? "replan" : "plan",
    status,
    attempt,
    ...(startedAt !== null ? { startedAt } : {}),
    ...(finishedAt !== null ? { finishedAt } : {}),
    ...(outcome !== null ? { outcome } : {}),
    ...(result !== null ? { result } : {}),
    ...(error !== null ? { error } : {}),
    ...(o.simulated === true ? { simulated: true } : {}),
    ...(readRisk(o.risk) ?? {}),
  };
}

/**
 * A stored classification, when the file holds a whole one.
 *
 * Both halves or neither: a level with no category, or a category with no level,
 * is a number a reader would have to interpret without knowing what it is about.
 * The level is range-checked because it is drawn as a severity — a file claiming
 * level 9 would render as something worse than the model has words for. An
 * unreadable classification drops the field rather than the step; the step is
 * still an honest record of what ran, and `risk` being absent already means "not
 * classified" everywhere it is read.
 */
function readRisk(raw: unknown): { risk: { level: number; category: string } } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const level = finite(o.level);
  const category = text(o.category, 40);
  if (level === null || category === null) return null;
  if (level < 0 || level > 4) return null;
  return { risk: { level: Math.round(level), category } };
}

const METHODS: Record<string, true> = {
  keyword: true,
  vector: true,
  both: true,
  profile: true,
  recent: true,
};

function readMemoryRef(raw: unknown): MissionMemoryRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const source = known(SOURCES, o.source);
  const summary = text(o.summary, MAX_TEXT);
  if (source === null || summary === null) return null;
  // An unrecognised method is dropped rather than kept: `method` is a claim about
  // how a row was found, and a word this build does not know is a claim it cannot
  // stand behind.
  const method = known(METHODS, o.method);
  return { source, summary, ...(method === null ? {} : { method }) };
}

/**
 * A stored mission, or nothing.
 *
 * Strict about the fields that decide what a mission *was* — its id, its state,
 * every step — and forgiving about the rest, which is the same line
 * `tasks/cron-store.ts` draws. A missing `conclusion` reads as "it did not say";
 * a step this build cannot understand means the record is not this mission any
 * more, and the honest answer is that it could not be read.
 */
export function readStoredMission(raw: unknown): Mission | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? safeMissionId(o.id) : null;
  const state = known(STATES, o.state);
  const createdAt = finite(o.createdAt);
  if (id === null || state === null || createdAt === null) return null;
  if (!Array.isArray(o.steps) || o.steps.length > MAX_STEPS) return null;

  const steps: PlanStep[] = [];
  for (const rawStep of o.steps) {
    const step = readStep(rawStep);
    if (step === null) return null;
    steps.push(step);
  }

  const memory = Array.isArray(o.memory)
    ? o.memory.slice(0, MAX_MEMORY_REFS).flatMap((m) => readMemoryRef(m) ?? [])
    : [];
  const finishedAt = finite(o.finishedAt);
  const conclusion = text(o.conclusion, MAX_TEXT);
  return {
    id,
    objective: text(o.objective, MAX_OBJECTIVE) ?? "",
    createdAt,
    state,
    steps,
    memory,
    planner: o.planner === "llm" ? "llm" : "deterministic",
    replans: finite(o.replans) ?? 0,
    ...(finishedAt !== null ? { finishedAt } : {}),
    ...(conclusion !== null ? { conclusion } : {}),
  };
}

function readLine(raw: unknown): MissionLogLine | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const at = finite(o.at);
  const mission = typeof o.mission === "string" ? safeMissionId(o.mission) : null;
  const state = known(STATES, o.state);
  if (at === null || mission === null || state === null) return null;
  const step = readLoggedStep(o.step);
  const event = known(EVENTS, o.event);
  const note = text(o.note, MAX_TEXT);
  return {
    at,
    mission,
    state,
    ...(event !== null ? { event } : {}),
    ...(step !== null ? { step } : {}),
    ...(note !== null ? { note } : {}),
    // Only the one word this build writes. Anything else off disk is dropped, so a
    // hand-edited file cannot invent a provenance and cannot un-mark one either: an
    // unrecognised value reads as "composed here", which is the claim that has to be
    // earned, so the drop is in the direction that costs a mark rather than adds one.
    ...(o.voice === "model" ? { voice: "model" as const } : {}),
  };
}

/**
 * A logged step, which is deliberately not a `PlanStep`.
 *
 * A line carries no `args`, `priority` or `dependsOn`, so reading one through
 * `readStep` would reject every line that has a step on it — the shapes are
 * different because the questions are.
 */
function readLoggedStep(raw: unknown): LoggedStep | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = text(o.id, 80);
  const tool = text(o.tool, 80);
  const status = known(STATUSES, o.status);
  if (id === null || tool === null || status === null) return null;
  const outcome = known(OUTCOMES, o.outcome);
  const result = text(o.result, MAX_TEXT);
  const error = text(o.error, MAX_TEXT);
  return {
    id,
    title: text(o.title, MAX_TITLE) ?? id,
    tool,
    status,
    attempt: finite(o.attempt) ?? 1,
    origin: o.origin === "replan" ? "replan" : "plan",
    ...(readRisk(o.risk) ?? {}),
    ...(outcome !== null ? { outcome } : {}),
    ...(result !== null ? { result } : {}),
    ...(error !== null ? { error } : {}),
    ...(o.simulated === true ? { simulated: true } : {}),
  };
}

// --- the store --------------------------------------------------------------

/**
 * Missions on disk.
 *
 * Single-writer by construction, like `MemoryStore`: one runtime drives missions,
 * and the orchestrator runs them serially. No lock is taken, because claiming one
 * across a boundary nothing else writes to would be theatre.
 *
 * Every public method is total. `record` swallows a disk error into `onError`
 * rather than throwing, because it is called from an observer inside the mission
 * loop — a full disk must not be the thing that fails a mission that otherwise
 * succeeded, and it certainly must not do it by throwing through the loop.
 */
export class MissionStore {
  private readonly dir: string;
  private readonly onError: (msg: string) => void;
  private readonly maxMissions: number;
  private readonly maxLogBytes: number;
  /** Bytes appended per mission, so the ceiling holds without stat-ing every line. */
  private readonly logged = new Map<string, number>();

  constructor(opts: MissionStoreOptions = {}) {
    this.dir = opts.dir ?? missionsDir();
    this.onError = opts.onError ?? (() => {});
    this.maxMissions = Math.max(1, opts.maxMissions ?? MAX_MISSIONS);
    this.maxLogBytes = Math.max(1_000, opts.maxLogBytes ?? MAX_LOG_BYTES);
  }

  /** Where this store keeps its files. Reported, so a probe can name it. */
  directory(): string {
    return this.dir;
  }

  /**
   * Append one line and rewrite the snapshot.
   *
   * Both, every time, and in that order: the log is the sequence and the snapshot
   * is the current truth, and a snapshot written before its line would leave a
   * mission that reached a state no line accounts for.
   */
  record(input: MissionRecordInput): void {
    const id = safeMissionId(input.mission.id);
    if (id === null) {
      this.onError(
        `refusing to store a mission whose id is not a safe name: ${sanitiseForDisplay(input.mission.id, 80)}`,
      );
      return;
    }
    try {
      const fresh = !existsSync(this.snapshotPath(id));
      this.ensureDir();
      this.append(id, toLine(input));
      this.writeSnapshot(id, input.mission, input.at);
      // Only when the count can actually have grown. Pruning on every line would
      // read the directory sixteen times for one mission and change nothing.
      if (fresh) this.prune();
    } catch (err) {
      this.onError(
        `could not record mission ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** One mission, or null when there is no such record or it cannot be read. */
  load(rawId: string): Mission | null {
    const id = safeMissionId(rawId);
    if (id === null) return null;
    const path = this.snapshotPath(id);
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("expected an object");
      const o = parsed as Record<string, unknown>;
      const version = finite(o.version);
      if (version !== SNAPSHOT_VERSION) {
        throw new Error(`snapshot version ${String(o.version)} is not ${SNAPSHOT_VERSION}`);
      }
      const mission = readStoredMission(o.mission);
      if (mission === null) throw new Error("the mission in it could not be read");
      // A file renamed by hand would otherwise answer to two different ids.
      if (mission.id !== id) throw new Error(`it holds mission ${mission.id}, not ${id}`);
      return mission;
    } catch (err) {
      this.onError(
        `ignoring unreadable mission at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Missions, newest first.
   *
   * Unreadable records are skipped and reported, not counted — a history page
   * showing four of five missions and saying so beats one that refuses to open
   * because of a file somebody edited.
   */
  list(limit = this.maxMissions): readonly Mission[] {
    return this.ids()
      .flatMap((id) => this.load(id) ?? [])
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit));
  }

  /**
   * How many missions are on disk.
   *
   * A directory read and no parsing, because the one caller is the status
   * snapshot: `RuntimeStatus` is broadcast on every voice and agent transition,
   * and answering "how many" by loading fifty JSON files would put that work in
   * front of a wake word. A file that turns out to be unreadable is still counted
   * here — the number is "records kept", and `list()` is where a bad one is
   * dropped and reported.
   */
  count(): number {
    return this.ids().length;
  }

  /**
   * Every line of one mission's log, in the order it was written.
   *
   * A single bad line is dropped rather than ending the read: the log is
   * append-only, so a torn last line is what a crash mid-append looks like, and
   * the lines before it are still exactly what happened.
   */
  history(rawId: string): readonly MissionLogLine[] {
    const id = safeMissionId(rawId);
    if (id === null) return [];
    const path = this.logPath(id);
    if (!existsSync(path)) return [];
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch (err) {
      this.onError(`could not read the log at ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const lines: MissionLogLine[] = [];
    let dropped = 0;
    for (const raw of body.split("\n")) {
      if (raw.trim() === "") continue;
      let line: MissionLogLine | null = null;
      try {
        line = readLine(JSON.parse(raw));
      } catch {
        line = null;
      }
      if (line === null) dropped += 1;
      else lines.push(line);
    }
    if (dropped > 0) {
      this.onError(`skipped ${dropped} unreadable line${dropped === 1 ? "" : "s"} in ${path}`);
    }
    return lines;
  }

  // --- files ----------------------------------------------------------------

  private snapshotPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private logPath(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /** Mission ids present on disk, from the snapshots rather than an index file. */
  private ids(): readonly string[] {
    if (!existsSync(this.dir)) return [];
    try {
      return readdirSync(this.dir).flatMap((name) => {
        if (!name.endsWith(".json")) return [];
        return safeMissionId(name.slice(0, -".json".length)) ?? [];
      });
    } catch (err) {
      this.onError(`could not list ${this.dir}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Append one line, or say once that the log is full.
   *
   * The ceiling is on the log, not on the mission: past it the snapshot is still
   * written, so "what happened in the end" survives a mission that produced an
   * unreasonable number of events. The truncation line is written *into* the log
   * because a log that stops without saying why is indistinguishable from a
   * runtime that died.
   */
  private append(id: string, line: MissionLogLine): void {
    const path = this.logPath(id);
    const used = this.budget(id, path);
    if (used >= this.maxLogBytes) return;
    const body = `${JSON.stringify(line)}\n`;
    if (used + body.length > this.maxLogBytes) {
      const cut: MissionLogLine = {
        at: line.at,
        mission: id,
        state: line.state,
        note: LOG_FULL_NOTE,
      };
      appendFileSync(path, `${JSON.stringify(cut)}\n`, "utf8");
      this.logged.set(id, this.maxLogBytes);
      return;
    }
    appendFileSync(path, body, "utf8");
    this.logged.set(id, used + body.length);
  }

  /**
   * How much of this log's budget is gone.
   *
   * The counter is per process, so a reopened store has to ask the file. Size
   * alone is not the answer: a log closed by the ceiling is *smaller* than the
   * ceiling by however much the last rejected line was, so a new process would
   * see room and write a second "this log is full" line every time it started.
   * The marker on disk is what closes a log, and it survives a restart.
   */
  private budget(id: string, path: string): number {
    const counted = this.logged.get(id);
    if (counted !== undefined) return counted;
    const size = this.sizeOf(path);
    const used = size > 0 && this.endsClosed(path) ? this.maxLogBytes : size;
    this.logged.set(id, used);
    return used;
  }

  private endsClosed(path: string): boolean {
    try {
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      return (lines[lines.length - 1] ?? "").includes(LOG_FULL_NOTE);
    } catch {
      return false;
    }
  }

  private sizeOf(path: string): number {
    try {
      return existsSync(path) ? statSync(path).size : 0;
    } catch {
      return 0;
    }
  }

  /** Temp file plus `rename`: a crash mid-write leaves the previous snapshot whole. */
  private writeSnapshot(id: string, mission: Mission, at: number): void {
    const body = JSON.stringify(
      { version: SNAPSHOT_VERSION, savedAt: at, mission: toStored(mission) },
      null,
      2,
    );
    const path = this.snapshotPath(id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
  }

  /**
   * Keep the newest `maxMissions`, delete the rest.
   *
   * Ordered by `createdAt` from inside the record rather than by file mtime: mtime
   * moves every time a mission is recorded, so the oldest *mission* and the
   * least-recently-written *file* are not the same thing, and a long mission
   * running across a boot would be the one thrown away.
   */
  private prune(): void {
    const dated = this.ids().map((id) => ({ id, at: this.load(id)?.createdAt ?? 0 }));
    if (dated.length <= this.maxMissions) return;
    const doomed = dated
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
      .slice(this.maxMissions);
    for (const { id } of doomed) {
      try {
        rmSync(this.snapshotPath(id), { force: true });
        rmSync(this.logPath(id), { force: true });
        this.logged.delete(id);
      } catch (err) {
        this.onError(`could not remove old mission ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
