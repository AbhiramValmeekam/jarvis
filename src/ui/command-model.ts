/**
 * Presentation rules for the Command Center, separate from React so they can be
 * tested without a DOM — the same split as `hud-model`, `permission-model` and
 * `activity-model`.
 *
 * The Command Center answers the questions an always-on assistant owes its user:
 * what are you scheduled to do without me, what is plugged into you, what do you
 * remember about me, and what can you actually do. Phases 8, 9 and 10 built every
 * one of those answers and shipped them over the wire; until this file none of
 * them had a screen.
 *
 * Three rules shape all of it, and each exists because the honest answer and the
 * flattering answer differ.
 *
 * **"I could not read it" is not "there is none."** A missing config, a YAML
 * shape the reader does not handle, and a genuinely empty list are three
 * different facts. Rendering them the same way turns every failed read into a
 * clean bill of health — which is the one thing a security-relevant inventory
 * must never do.
 *
 * **A schedule that will not fire is not a schedule.** Hermes' cron ticker lives
 * inside its gateway, so a perfectly configured job list can be inert. A row
 * reading "next in 12 minutes" over a dead ticker is a promise nothing will keep,
 * so the time is phrased as conditional and the row carries the warning tone.
 *
 * **A flagged MCP server is an alert, not a row.** An entry Hermes will refuse to
 * spawn is evidence something wrote to `config.yaml`, and it sorts to the top
 * rather than sitting eleventh in an alphabetical list.
 */
import { sanitiseForDisplay } from "../permissions/risk-model";
import type { McpView, MemoryView, SkillsView, TasksView } from "../ipc/contract";

export type CommandTabId = "activity" | "tasks" | "mcp" | "memory" | "skills";

/**
 * One section's data, or an honest account of why it is absent.
 *
 * Three states rather than "data or null", because `null` cannot tell a panel
 * that has not finished loading apart from one whose read failed — and those want
 * opposite words on screen. A spinner over a failure reads as "nearly there"
 * forever.
 */
export type Section<T> =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "ready"; data: T };

export interface CommandData {
  tasks: Section<TasksView>;
  mcp: Section<McpView>;
  memory: Section<MemoryView>;
  skills: Section<SkillsView>;
}

/** Every section loading — the state a freshly opened panel starts in. */
export function loadingData(): CommandData {
  return {
    tasks: { status: "loading" },
    mcp: { status: "loading" },
    memory: { status: "loading" },
    skills: { status: "loading" },
  };
}

/**
 * A duration in words.
 *
 * Deliberately not `describeAge` from `tasks/cron-store.ts`, which is the same
 * three lines: that module opens files, and importing it here would pull
 * `node:fs` into the renderer bundle — the one process in this app with no Node
 * access by design. Copying three lines is the cheaper of the two prices.
 */
export function describeSpan(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

/** A wall-clock date for a memory. Local, because that is how people place things. */
export function describeWhen(at: number, now: number, locale?: string): string {
  if (!Number.isFinite(at)) return "unknown";
  const delta = now - at;
  if (delta < 60_000) return "just now";
  if (delta < 86_400_000) return `${describeSpan(delta)} ago`;
  return new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** What a section says instead of a list, when it has no list to show. */
export function sectionMessage<T>(s: Section<T>, connected: boolean): string | null {
  if (s.status === "loading") return connected ? "Reading…" : "Not connected.";
  if (s.status === "failed") return `Couldn't read this: ${sanitiseForDisplay(s.error, 160)}`;
  return null;
}

// --- tasks -----------------------------------------------------------------

export interface TaskRow {
  key: string;
  name: string;
  schedule: string;
  /** When it next runs — or what makes that a fiction. Never a bare countdown. */
  timing: string;
  /** How the last run went, phrased so "never run" cannot read as "fine". */
  history: string;
  tone: "ordinary" | "warning" | "failed";
}

/**
 * Rows for the scheduled-task list.
 *
 * `willFire` reaches every row rather than living only in the banner. A user
 * scanning a list does not read the header first, and "next in 12 minutes" is a
 * claim — one that is false whenever Hermes' gateway is not running. When it will
 * not fire, the timing column says what *would* happen instead of what will.
 */
export function toTaskRows(view: TasksView, now: number): TaskRow[] {
  return view.tasks.map((t, i) => {
    const failed = t.lastStatus === "error";
    const when =
      t.nextRunAt === null
        ? "no next run scheduled"
        : t.nextRunAt >= now
          ? `in ${describeSpan(t.nextRunAt - now)}`
          : `overdue by ${describeSpan(now - t.nextRunAt)}`;
    return {
      key: `${t.id}-${i}`,
      // Sanitised here rather than trusted from the wire, for the same reason
      // `activity-model` re-sanitises: a job name is a string that arrived in a
      // file this process does not own, and the last stop before the DOM is this
      // one. A previous process having cleaned it is not a reason to assume so.
      name: sanitiseForDisplay(t.name || t.id, 60),
      schedule: sanitiseForDisplay(t.schedule, 40),
      timing: view.willFire ? when : `would be ${when} — but nothing is running it`,
      history:
        t.lastRunAt === null
          ? "never run"
          : failed
            ? `last run failed${t.lastError ? `: ${sanitiseForDisplay(t.lastError, 100)}` : ""}`
            : `last ran ${describeSpan(now - t.lastRunAt)} ago`,
      tone: failed ? "failed" : view.willFire ? "ordinary" : "warning",
    };
  });
}

/**
 * The one line above the task list.
 *
 * Returns the runtime's warning when there is one, unchanged — it was written to
 * name the exact command that fixes it (§61), and paraphrasing it here would
 * strip the only actionable thing on the screen.
 */
export function tasksBanner(view: TasksView): { text: string; tone: "warning" | "ok" } | null {
  if (view.warning) return { text: sanitiseForDisplay(view.warning, 400), tone: "warning" };
  if (view.tasks.length === 0) return null;
  return { text: `Hermes' scheduler is ${view.ticker}.`, tone: "ok" };
}

/** What the tasks panel says with nothing to list. */
export function tasksEmpty(view: TasksView): string {
  return view.ticker === "never-run"
    ? "Nothing is scheduled, and Hermes' scheduler has never run on this machine."
    : "Nothing is scheduled.";
}

// --- mcp -------------------------------------------------------------------

export interface McpRow {
  key: string;
  name: string;
  /** Where it comes from: the command, or the origin. Never a full URL. */
  origin: string;
  /** Environment variable *names*, joined. Values never reach this process. */
  needs: string;
  /** Tool filters, when `config.yaml` sets them. */
  filters: string;
  enabled: boolean;
  /** Why Hermes will refuse to spawn it, if it will. Empty for nearly all. */
  warnings: string[];
  tone: "flagged" | "disabled" | "ordinary";
}

/**
 * Rows for the MCP inventory, flagged entries first.
 *
 * The ordering is the security feature. `suspicious` mirrors
 * `hermes_cli/mcp_security.py`, which exists because the June 2026 campaign wrote
 * `command: bash` entries into people's configs; an entry carrying one of those
 * verdicts is evidence something edited that file, and it must not sort
 * alphabetically into eleventh place where nobody scrolls.
 *
 * Disabled servers sort last and stay visible. Hiding them would answer "what is
 * plugged in?" with a list that omits a backdoor somebody left switched off —
 * still one `enabled: true` away from spawning.
 */
export function toMcpRows(view: McpView): McpRow[] {
  const rows = view.servers.map((s, i) => ({
    key: `${s.name}-${i}`,
    name: sanitiseForDisplay(s.name, 60),
    origin: sanitiseForDisplay(s.command || s.url || "unknown", 80),
    needs: s.envNames.map((n) => sanitiseForDisplay(n, 40)).join(", "),
    filters: [
      s.includeTools?.length ? `only ${s.includeTools.length} tool(s)` : "",
      s.excludeTools?.length ? `${s.excludeTools.length} blocked` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    enabled: s.enabled,
    warnings: s.suspicious.map((w) => sanitiseForDisplay(w, 240)),
    tone: (s.suspicious.length > 0
      ? "flagged"
      : s.enabled
        ? "ordinary"
        : "disabled") as McpRow["tone"],
  }));
  const rank = (r: McpRow): number => (r.tone === "flagged" ? 0 : r.enabled ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/**
 * What the MCP panel says when it lists nothing.
 *
 * Three different sentences for three different facts, and this is the function
 * the whole "absence is not zero" rule exists for. `unparsed` in particular must
 * never render as "none": the `mcp_servers` block is *there*, this reader could
 * not handle its YAML, and telling someone they have no MCP servers when the
 * truthful answer is "I could not tell" is exactly the false all-clear §4
 * forbids.
 */
export function mcpEmpty(view: McpView): string {
  if (!view.configPresent) {
    return "Hermes has no config file here, so nothing is configured yet.";
  }
  if (view.unparsed) {
    return (
      "Hermes' config has an `mcp_servers` block written in a YAML shape this reader " +
      "doesn't handle, so this list is not the answer. Run `hermes mcp list` in a terminal."
    );
  }
  return "No MCP servers are configured.";
}

/**
 * The banner above the list. Present when something is wrong, absent otherwise.
 *
 * A zero-flagged banner is deliberately not offered. "0 problems found" is a
 * reassurance the reader cannot back — it screened for the shapes Hermes screens
 * for, not for every bad server that exists.
 */
export function mcpBanner(view: McpView): string | null {
  const flagged = view.servers.filter((s) => s.suspicious.length > 0).length;
  if (flagged === 0) return null;
  return (
    `${flagged} configured server${flagged === 1 ? "" : "s"} ` +
    `${flagged === 1 ? "matches a shape" : "match shapes"} Hermes refuses to spawn. ` +
    "Jarvis doesn't edit this file — remove them with `hermes mcp remove`."
  );
}

// --- memory ----------------------------------------------------------------

export interface MemoryRow {
  key: string;
  text: string;
  when: string;
}

export function toMemoryRows(view: MemoryView, now: number, locale?: string): MemoryRow[] {
  return view.entries
    .map((e, i) => ({
      key: `${e.id}-${i}`,
      // The full text, capped only against a pathological entry. This is the
      // user's own dictated note, and truncating it in the one view that lists
      // them would leave them unable to check what Jarvis actually recorded.
      text: sanitiseForDisplay(e.text, 600),
      when: describeWhen(e.at, now, locale),
    }))
    .reverse();
}

/**
 * The line about Hermes' separate store.
 *
 * Said plainly because the two stores are genuinely different and a user who
 * thinks they are one will be surprised twice: once when Hermes does not know
 * something they told Jarvis, and once when Jarvis does not know something they
 * told Hermes.
 */
export function hermesMemoryLine(view: MemoryView): string {
  const { present, memoryEntries, userEntries } = view.hermes;
  if (!present) return "Hermes keeps its own memory separately. It's off, or empty.";
  const total = memoryEntries + userEntries;
  return (
    `Hermes keeps its own memory separately: ${total} entr${total === 1 ? "y" : "ies"}. ` +
    "Only Hermes writes those — ask it to remember something and it will."
  );
}

/** Headroom, so a store near its cap says so before it starts evicting. */
export function memoryHeadroom(view: MemoryView): string {
  return `${view.entries.length} of ${view.maxEntries}`;
}

// --- skills ----------------------------------------------------------------

export interface SkillRow {
  key: string;
  name: string;
  description: string;
  category: string;
  source: "user" | "bundled";
}

/**
 * Skills matching a query, or all of them.
 *
 * A plain substring match over name, description and category. No ranking and no
 * fuzzy matching: this is a filter box over a list the user can already see, and
 * a clever matcher that silently drops an exact-substring hit would be worse than
 * none.
 */
export function filterSkills(view: SkillsView, query: string): SkillRow[] {
  const q = query.trim().toLowerCase();
  return view.skills
    .filter(
      (s) =>
        q === "" ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    )
    .map((s, i) => ({
      key: `${s.category}/${s.name}-${i}`,
      name: sanitiseForDisplay(s.name, 60),
      // Untrusted (§52): a skill description is file content that `hermes skills
      // install` can add to from a public hub, and it lands in the DOM.
      description: sanitiseForDisplay(s.description, 200),
      category: sanitiseForDisplay(s.category || "general", 40),
      source: s.source,
    }));
}

/** The summary line: how many, and how many the user installed themselves. */
export function skillsSummary(view: SkillsView): string {
  const n = view.skills.length;
  if (n === 0) return "No skills are installed.";
  const user = view.skills.filter((s) => s.source === "user").length;
  const head = `${n} skill${n === 1 ? "" : "s"} across ${view.categories.length} categor${
    view.categories.length === 1 ? "y" : "ies"
  }`;
  return user > 0 ? `${head} · ${user} installed by you` : head;
}

/** The count on the Command Center button: things that want attention, not a total. */
export function attentionCount(data: CommandData): number {
  const flagged =
    data.mcp.status === "ready"
      ? data.mcp.data.servers.filter((s) => s.suspicious.length > 0).length
      : 0;
  // A scheduler that will not fire counts once, not once per job: the user has
  // one problem to fix, and a badge reading "14" for fourteen inert jobs would
  // overstate it into noise.
  const scheduler = data.tasks.status === "ready" && data.tasks.data.warning ? 1 : 0;
  return flagged + scheduler;
}
