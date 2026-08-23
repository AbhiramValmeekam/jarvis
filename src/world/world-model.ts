/**
 * The world model: what exists around this machine, and what connects to what.
 *
 * Everything above this file has been *episodic* — a mission runs, a memory is
 * kept, a window has a title right now. None of it answers the question a plan
 * actually needs answered first: what is here, and which of it bears on the thing
 * the user just asked for. "Get my project ready for tomorrow" is unanswerable
 * without knowing which projects exist, which one the user is looking at, what has
 * already been run against it and what failed.
 *
 * So this assembles a graph out of registries that already exist. It discovers
 * nothing on its own and it opens no files: the project registry scanned the disk,
 * the app catalog read the Start Menu, the window facts came from the foreground
 * window, the cron snapshot came from Hermes, the missions came from the mission
 * store. This is the join, and only the join — which is why it is pure and why
 * `buildWorld` is a function rather than a service.
 *
 * Two rules give the graph its shape, and both are about honesty rather than tidiness.
 *
 * **Every edge carries a `basis`**: one sentence, in plain words, naming the record
 * it was derived from. An entity graph whose edges cannot be checked is a set of
 * assertions about the user's life that the user cannot audit, and a plan built on
 * one of those would be confidently wrong in a way nobody could trace. So there is
 * no inference here without a sentence saying what it was inferred from.
 *
 * **A window title is data, not authority** (§52). Titles are chosen by whatever the
 * app loaded, so a page can name any project it likes. A title that names a project
 * therefore produces a `focused` edge — that much is a fact about the title — and
 * that edge is flagged `steerable` when `origin` is `web`. Nothing downstream is
 * allowed to pick a target from a steerable edge; see `src/world/proactive.ts`.
 */
import { redactSecrets } from "../context/window-facts.js";
import { defuseMarkers, sanitiseForDisplay } from "../permissions/risk-model.js";

export type EntityKind = "project" | "app" | "window" | "task" | "mission";

/**
 * One thing in the world.
 *
 * `at` is "the most recent moment a source places this at", and `null` is a real
 * answer rather than a missing one: a project in the registry has no timestamp
 * until something happens to it, and filling that in with the clock would date every
 * project to whenever the graph was built.
 */
export interface Entity {
  /** `kind:key`. Unique within a graph. */
  readonly id: string;
  readonly kind: EntityKind;
  readonly key: string;
  /** Display-safe, and short. */
  readonly label: string;
  /** One display-safe line. Never raw text from a file or a program. */
  readonly detail?: string;
  /**
   * The source's own word for the state this is in — a mission's `failed`, a job's
   * `error`, `disabled`, `never-run`.
   *
   * Separate from `detail` because `detail` is prose for a person and this is read by
   * the rules in `proactive.ts`. A rule that had to parse a display string would break
   * the first time the wording improved, and it would break silently.
   */
  readonly status?: string;
  /** The source's own explanation, when it gave one. Display-safe, never a model's. */
  readonly note?: string;
  readonly at: number | null;
  /** Which registry said this exists. Shown, so the graph can be checked. */
  readonly source: string;
}

export type EdgeKind =
  /** A mission acted on a project. */
  | "worked_on"
  /** The foreground window names a project. */
  | "focused"
  /** The foreground window belongs to a catalogued app. */
  | "window_of"
  /** A scheduled job's name names a project. */
  | "scheduled_in";

export interface Edge {
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  readonly at: number | null;
  /** Why this edge exists, in words a person can check against a record. */
  readonly basis: string;
  /**
   * True when the text this edge was derived from is chosen by something other than
   * the user or this machine — a web page, a chat peer, a document from elsewhere.
   *
   * It travels on the edge rather than being re-derived later because the taint
   * belongs to the *derivation*, not to the entity: the project is real, the
   * registry says so, and it is only the claim that the user is looking at it that
   * a stranger got to influence.
   */
  readonly steerable?: boolean;
}

export interface World {
  readonly at: number;
  readonly entities: readonly Entity[];
  readonly edges: readonly Edge[];
  /** What the user appears to be on right now, when the window said enough to tell. */
  readonly focus: Focus | null;
  /** True when a cap was hit, so a view can say "and more" rather than imply "all". */
  readonly truncated: boolean;
}

export interface Focus {
  readonly windowId: string;
  readonly appId?: string;
  readonly projectId?: string;
  /** True when the project was read out of a title a stranger may have chosen. */
  readonly steerable: boolean;
}

// --- what goes in ----------------------------------------------------------

/**
 * The inputs, described structurally rather than imported.
 *
 * `ProjectEntry`, `CatalogEntry`, `WindowFacts`, `CronJob` and `Mission` are all
 * assignable to these, so the runtime hands over its real registries untouched.
 * Narrow types are used anyway for two reasons: this module stays free of every
 * subsystem it joins, and a test can build a world out of six literals instead of
 * five real stores.
 */
export interface ProjectFact {
  readonly key: string;
  readonly name: string;
  readonly dir: string;
  readonly kind: string;
  readonly aliases?: readonly string[];
}

export interface AppFact {
  readonly key: string;
  readonly name: string;
  readonly launch?: { readonly kind: string; readonly file?: string; readonly uri?: string };
}

export interface WindowFact {
  readonly title: string;
  readonly process: string;
  readonly pid?: number;
  readonly kind: string;
  readonly hasTitle: boolean;
  readonly redacted?: boolean;
  readonly origin: string;
}

export interface TaskFact {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
}

export interface StepFact {
  readonly tool: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly status?: string;
  readonly outcome?: string;
}

export interface MissionFact {
  readonly id: string;
  readonly objective: string;
  readonly state: string;
  readonly createdAt: number;
  readonly finishedAt?: number;
  readonly conclusion?: string;
  readonly steps: readonly StepFact[];
}

export interface WorldInput {
  readonly at: number;
  readonly projects?: readonly ProjectFact[];
  readonly apps?: readonly AppFact[];
  /** The foreground window, when one could be read. */
  readonly window?: WindowFact | null;
  readonly tasks?: readonly TaskFact[];
  /** Newest first, as `MissionStore.list()` returns them. */
  readonly missions?: readonly MissionFact[];
}

// --- caps ------------------------------------------------------------------

/**
 * Bounds, and what binds first.
 *
 * The mission cap is the one that matters: the mission store keeps fifty, and a
 * graph that joined all fifty against every project would be mostly history. Twenty
 * is roughly a fortnight of real use, and the store is still there for the rest.
 *
 * Apps are capped differently — by *relevance* rather than by count. A catalogued
 * app nobody has touched is not part of anyone's world, so an app entity exists only
 * when an edge points at it. That keeps a three-hundred-entry Start Menu out of the
 * graph without pretending those apps are not installed.
 */
export const MAX_WORLD_MISSIONS = 20;
export const MAX_ENTITIES = 200;
export const MAX_EDGES = 400;
const MAX_LABEL = 80;
const MAX_DETAIL = 120;
const MAX_BASIS = 160;

// --- text, treated as text -------------------------------------------------

/**
 * Every string that leaves this file, treated as what it is: text somebody else wrote.
 *
 * Three passes, and the order is the whole point.
 *
 *  1. **Redact.** Most of what is cleaned here is program output: a mission's
 *     conclusion is a build's stderr, a job's note is Hermes reporting an error. A
 *     build that printed a deploy key would otherwise put it into a graph that reaches
 *     the renderer, the suggestion cards and the wire. `toWindowFacts` already does
 *     this to titles, for the same reason and in the same order.
 *  2. **Sanitise**, which flattens and truncates. After redacting, because it is what
 *     removes a zero-width character splitting a key into two halves no pattern
 *     matches — doing it first would reassemble the secret and then miss it.
 *  3. **Defuse**, which collapses the `---` fence the memory prompt quotes data
 *     inside. Last, because it erases the run of hyphens a PEM header is recognised
 *     by, and screening afterwards looks for a signature this step already removed.
 *     `world/proposal-store.ts` states the same rule from the other end.
 */
function clean(text: string, max: number): string {
  return defuseMarkers(sanitiseForDisplay(redactSecrets(text).text, max));
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The words that count as naming a project.
 *
 * Anything under three characters is dropped. A two-letter alias matches inside
 * half the words in English, and an edge that fires on "go" in "going" is worse than
 * a missing edge: it is a wrong fact with a basis sentence attached.
 */
function namesOf(project: ProjectFact): readonly string[] {
  const words = [project.name, project.key, ...(project.aliases ?? [])]
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 3);
  return [...new Set(words)];
}

/**
 * Which of the project's names a piece of text uses, if any.
 *
 * Returns the matched word rather than a boolean so the basis sentence can quote it:
 * "the objective said `portal`" is checkable, "the objective mentioned the project"
 * is a claim the reader has to take on trust.
 */
export function nameUsedIn(text: string, project: ProjectFact): string | null {
  const hay = text.toLowerCase();
  for (const word of namesOf(project)) {
    if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(word)}(?:[^a-z0-9]|$)`).test(hay)) return word;
  }
  return null;
}

/** Windows path comparison: separators normalised, case ignored, prefix on a boundary. */
export function isUnder(path: string, dir: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
  const a = norm(path);
  const b = norm(dir);
  return a === b || a.startsWith(`${b}\\`);
}

/** Every string in a step's arguments, one level deep plus arrays of strings. */
function argStrings(args: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") out.push(item);
    }
  }
  return out;
}

// --- the join ---------------------------------------------------------------

/**
 * Assemble the graph.
 *
 * Order is deliberate. Projects, tasks and missions become entities first, because
 * they exist whether or not anything connects them. Edges are derived second. Apps
 * come last, and only the ones an edge reached. Then project timestamps are filled
 * in from the newest edge that touched them — a project's `at` is the last time
 * something *happened* to it, which is a fact about the world, where "when the
 * registry was scanned" would be a fact about this function.
 */
export function buildWorld(input: WorldInput): World {
  const entities = new Map<string, Entity>();
  const edges: Edge[] = [];
  let truncated = false;

  const projects = input.projects ?? [];
  for (const p of projects) {
    const id = `project:${p.key}`;
    entities.set(id, {
      id,
      kind: "project",
      key: p.key,
      label: clean(p.name, MAX_LABEL),
      detail: clean(`${p.kind} project in ${p.dir}`, MAX_DETAIL),
      at: null,
      source: "project registry",
    });
  }

  for (const t of input.tasks ?? []) {
    const id = `task:${t.id}`;
    const state = t.enabled ? (t.lastStatus ?? "never-run") : "disabled";
    entities.set(id, {
      id,
      kind: "task",
      key: t.id,
      label: clean(t.name, MAX_LABEL),
      detail: clean(`${t.schedule} — ${state}`, MAX_DETAIL),
      status: state,
      ...(t.lastError ? { note: clean(t.lastError, MAX_DETAIL) } : {}),
      at: t.lastRunAt,
      source: "Hermes scheduler",
    });
  }

  const missions = (input.missions ?? []).slice(0, MAX_WORLD_MISSIONS);
  if ((input.missions ?? []).length > missions.length) truncated = true;
  for (const m of missions) {
    const id = `mission:${m.id}`;
    entities.set(id, {
      id,
      kind: "mission",
      key: m.id,
      label: clean(m.objective, MAX_LABEL),
      detail: clean(m.conclusion ? `${m.state} — ${m.conclusion}` : m.state, MAX_DETAIL),
      status: clean(m.state, 40),
      ...(m.conclusion ? { note: clean(m.conclusion, MAX_DETAIL) } : {}),
      at: m.finishedAt ?? m.createdAt,
      source: "mission log",
    });
  }

  // The foreground window. One entity, keyed by process rather than by pid, because
  // the graph is read by a person watching their own screen and "Code" is the thing
  // they recognise; the pid is in the detail for anyone who needs it.
  let windowId: string | null = null;
  const win = input.window ?? null;
  if (win && win.process) {
    windowId = `window:${win.process.toLowerCase()}`;
    const titled = win.hasTitle && win.title ? clean(win.title, MAX_LABEL) : "(no title)";
    entities.set(windowId, {
      id: windowId,
      kind: "window",
      key: win.process.toLowerCase(),
      label: titled,
      detail: clean(
        `${win.kind}, title set ${win.origin === "web" ? "by what it loaded" : "locally"}` +
          (win.redacted ? ", partly redacted" : ""),
        MAX_DETAIL,
      ),
      at: input.at,
      source: "foreground window",
    });
  }

  // --- mission → project ---------------------------------------------------
  //
  // Two bases, and the stronger one wins. A step whose arguments name a path inside
  // the project directory *ran there*; an objective that used the project's name only
  // says the user was talking about it. Both are edges worth having, and conflating
  // them would let "have a look at the portal" claim the same standing as a build
  // that actually executed in the portal's directory.
  //
  // A name in an objective is the user's own word, so unlike a window title it is
  // allowed to decide — but only when it decides *one* project. `aliasesForProject`
  // deliberately adds a project's leading word, so `jarvis-runtime` and `jarvis-hud`
  // both answer to "jarvis"; the registry can afford that because `findProject`
  // returns `ambiguous` and Jarvis asks. A graph has nobody to ask. Left as generous
  // as the registry, one objective saying "probe-world-a" drew a confident
  // `worked_on` edge to all three probe fixtures, and the proactive rules then read
  // those edges and offered work on two projects no mission had been near.
  //
  // So: the longest match wins, and a tie decides nothing. An objective that named
  // one project exactly and two others by a shared prefix named the first one; an
  // objective that named two equally well named neither, and the mission simply
  // stands in the graph untied to a project — which is the truth about it.
  for (const m of missions) {
    const from = `mission:${m.id}`;
    const ranIn = new Set<string>();
    const named: { to: string; word: string }[] = [];
    for (const p of projects) {
      const to = `project:${p.key}`;
      if (m.steps.some((s) => argStrings(s.args).some((v) => isUnder(v, p.dir)))) {
        ranIn.add(to);
        edges.push({
          kind: "worked_on",
          from,
          to,
          at: m.finishedAt ?? m.createdAt,
          basis: clean(`a step of this mission ran in ${p.dir}`, MAX_BASIS),
        });
      }
      // Gathered for every project, including one that already earned a stronger
      // edge: whether a word was ambiguous is a fact about the sentence, and
      // leaving that project out would let a shared prefix become decisive just
      // because the project it really meant was recognised some other way.
      const word = nameUsedIn(m.objective, p);
      if (word !== null) named.push({ to, word });
    }
    const longest = named.reduce((n, c) => Math.max(n, c.word.length), 0);
    const winners = named.filter((c) => c.word.length === longest);
    const only = winners.length === 1 ? winners[0] : undefined;
    if (only && !ranIn.has(only.to)) {
      edges.push({
        kind: "worked_on",
        from,
        to: only.to,
        at: m.finishedAt ?? m.createdAt,
        basis: clean(`the objective said "${only.word}"`, MAX_BASIS),
      });
    }
  }

  // --- window → app, window → project --------------------------------------
  if (win && windowId) {
    const proc = win.process.toLowerCase().replace(/\.exe$/, "");
    const app = (input.apps ?? []).find((a) => {
      const file = a.launch?.file ?? "";
      const base = file.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
      return base !== "" && base === proc;
    });
    if (app) {
      const appId = `app:${app.key}`;
      entities.set(appId, {
        id: appId,
        kind: "app",
        key: app.key,
        label: clean(app.name, MAX_LABEL),
        at: input.at,
        source: "app catalog",
      });
      edges.push({
        kind: "window_of",
        from: windowId,
        to: appId,
        at: input.at,
        basis: clean(`the foreground process is ${win.process}`, MAX_BASIS),
      });
    }

    // The one edge in this graph a stranger can influence, and the reason `steerable`
    // exists. A page titled "portfolio-site" makes this fire; that is a true fact
    // about the title and a false one about the user, so it is recorded and flagged.
    if (win.hasTitle && win.title) {
      const steerable = win.origin === "web";
      for (const p of projects) {
        const word = nameUsedIn(win.title, p);
        if (word === null) continue;
        edges.push({
          kind: "focused",
          from: windowId,
          to: `project:${p.key}`,
          at: input.at,
          basis: clean(`the window title says "${word}"`, MAX_BASIS),
          ...(steerable ? { steerable: true } : {}),
        });
      }
    }
  }

  // --- task → project ------------------------------------------------------
  for (const t of input.tasks ?? []) {
    for (const p of projects) {
      const word = nameUsedIn(t.name, p);
      if (word === null) continue;
      edges.push({
        kind: "scheduled_in",
        from: `task:${t.id}`,
        to: `project:${p.key}`,
        at: t.lastRunAt,
        // A job name is written by an agent turn, so it is untrusted in exactly the
        // way a window title is — and for jobs there is no `local` case at all.
        basis: clean(`the job's name says "${word}"`, MAX_BASIS),
        steerable: true,
      });
    }
  }

  // --- caps, then the timestamps the edges imply ---------------------------
  //
  // Trimming happens before `focus` is computed and before project times are filled
  // in, so a trimmed graph is internally consistent rather than a full graph with
  // holes in it: no edge here can point at an entity that is not in `entities`.
  let kept = [...entities.values()];
  if (kept.length > MAX_ENTITIES) {
    truncated = true;
    // Order of loss: the oldest mission goes before the newest, and nothing that is
    // part of *now* — the window, its app, the projects, the schedule — goes at all.
    const rank = (e: Entity): number => (e.kind === "mission" ? 1 : 0);
    kept = kept
      .slice()
      .sort((a, b) => rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0))
      .slice(0, MAX_ENTITIES);
  }
  const live = new Map(kept.map((e) => [e.id, e]));

  let live_edges = edges.filter((e) => live.has(e.from) && live.has(e.to));
  if (live_edges.length > MAX_EDGES) {
    truncated = true;
    live_edges = live_edges.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_EDGES);
  }

  for (const [id, entity] of live) {
    if (entity.kind !== "project") continue;
    let newest: number | null = null;
    for (const e of live_edges) {
      if (e.to !== id && e.from !== id) continue;
      if (e.at !== null && (newest === null || e.at > newest)) newest = e.at;
    }
    if (newest !== null) live.set(id, { ...entity, at: newest });
  }

  // `focus` is the graph's answer to "what is the user on", and it is deliberately
  // allowed to be a steerable answer rather than no answer: a UI that showed nothing
  // when a browser tab happens to name a project would be hiding a real observation.
  // What it may not do is let that answer choose work, which is enforced elsewhere.
  let focus: Focus | null = null;
  if (windowId && live.has(windowId)) {
    const appEdge = live_edges.find((e) => e.from === windowId && e.kind === "window_of");
    const projectEdges = live_edges.filter((e) => e.from === windowId && e.kind === "focused");
    const trusted = projectEdges.find((e) => e.steerable !== true);
    const chosen = trusted ?? projectEdges[0];
    focus = {
      windowId,
      ...(appEdge ? { appId: appEdge.to } : {}),
      ...(chosen ? { projectId: chosen.to } : {}),
      steerable: chosen !== undefined && chosen.steerable === true,
    };
  }

  return {
    at: input.at,
    entities: [...live.values()],
    edges: live_edges,
    focus,
    truncated,
  };
}

// --- reading it -------------------------------------------------------------

export function entityOf(world: World, id: string): Entity | null {
  return world.entities.find((e) => e.id === id) ?? null;
}

/** Every edge with this entity at either end, newest first. */
export function edgesOf(world: World, id: string): readonly Edge[] {
  return world.edges
    .filter((e) => e.from === id || e.to === id)
    .slice()
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** The entities this one is connected to, newest edge first, de-duplicated. */
export function neighboursOf(world: World, id: string): readonly Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>([id]);
  for (const edge of edgesOf(world, id)) {
    const other = edge.from === id ? edge.to : edge.from;
    if (seen.has(other)) continue;
    seen.add(other);
    const entity = entityOf(world, other);
    if (entity) out.push(entity);
  }
  return out;
}

/**
 * The missions that touched a project, newest first.
 *
 * `worked_on` only: a window that happened to name the project did not touch it, and
 * a rule that treated the two the same would decide there was "recent activity" on a
 * project because a tab was open.
 */
export function missionsOn(world: World, projectId: string): readonly Entity[] {
  return world.edges
    .filter((e) => e.kind === "worked_on" && e.to === projectId)
    .slice()
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .flatMap((e) => {
      const entity = entityOf(world, e.from);
      return entity ? [entity] : [];
    });
}

/** One line of counts, for a log or a status field. Never a claim about meaning. */
export function describeWorld(world: World): string {
  const by = (kind: EntityKind): number => world.entities.filter((e) => e.kind === kind).length;
  return (
    `${by("project")} project(s), ${by("app")} app(s), ${by("task")} task(s), ` +
    `${by("mission")} mission(s), ${world.edges.length} connection(s)` +
    (world.truncated ? " (trimmed)" : "")
  );
}
