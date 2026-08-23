/**
 * Agent roles: which faculty of Jarvis did a thing, and what it was able to reach.
 *
 * The master prompt asks for planner, research, memory, computer, coding, verify and
 * security "agents". This file is the whole of that, and it is deliberately not seven
 * processes, seven prompts or seven message queues. Three decisions are worth stating
 * because each of them is a thing this file refuses to do.
 *
 *  1. **A role is a partition of the tool registry, not a participant.** `research` is
 *     the name for the six network tools; `coding` is the name for the project and git
 *     tools. Nothing here runs, asks, decides or holds state. Seven processes would have
 *     bought a diagram and cost seven more places for a permission decision to be made,
 *     and the one property this build sells is that there is exactly one such place
 *     (`permissions/permission-engine.ts`).
 *  2. **Roles are derived from the record, never predicted from the objective.** There is
 *     no function here that reads an objective and guesses which roles it will need.
 *     Narrowing the planner's tool list from the words in a sentence would duplicate
 *     `plan-builder.ts`'s own keyword matching, could silently cost the planner a
 *     capability the objective actually needed, and would print a guess in the one place
 *     that must hold a record (§43). `attributeLine` runs *after* the fact, over the
 *     mission's own log.
 *  3. **A role can only subtract.** `roleCapabilities` reports what the registry already
 *     offered, split up. There is no ceiling, no per-role allowance and no path from here
 *     to the risk model or the permission engine — measured, the research and computer
 *     tools already classify at level 3, so any per-role ceiling below that would refuse
 *     every web call and every command, and one at 3 would newly refuse the two level-4
 *     cases Phase 13 documents as reaching the user for a decision. A second gate that
 *     could only be wrong is not a security improvement.
 *
 * It has no imports, on purpose: every input is a plain shape, so the same table answers
 * for the runtime, for a probe and for a unit test without any of the three starting a
 * process to find out what Jarvis can do.
 */

/** The seven. Fixed order — this is display order as well as the canonical list. */
export type AgentRole =
  | "planner"
  | "research"
  | "memory"
  | "computer"
  | "coding"
  | "verify"
  | "security";

export const ROLE_ORDER: readonly AgentRole[] = [
  "planner",
  "research",
  "memory",
  "computer",
  "coding",
  "verify",
  "security",
];

export interface RoleDescription {
  readonly role: AgentRole;
  /** How the role is named to a person. One or two words. */
  readonly label: string;
  /**
   * What the role is for, in a sentence a user can hold Jarvis to.
   *
   * Written as a claim about what the role *does*, not about how well it does it, so
   * a trace that shows the role acting can be checked against this line.
   */
  readonly purpose: string;
}

const DESCRIPTIONS: Readonly<Record<AgentRole, RoleDescription>> = {
  planner: {
    role: "planner",
    label: "Planner",
    purpose: "Turns an objective into steps, and decides what to do instead when one fails.",
  },
  research: {
    role: "research",
    label: "Research",
    purpose: "Reads the web and named hosts, and carries the sources back with the answer.",
  },
  memory: {
    role: "memory",
    label: "Memory",
    purpose: "Retrieves what Jarvis already knew, and writes down only what was confirmed.",
  },
  computer: {
    role: "computer",
    label: "Computer",
    purpose: "Acts on this machine — files, commands, and the mocked outbox and calendar.",
  },
  coding: {
    role: "coding",
    label: "Coding",
    purpose: "Finds projects and reads their git state. It writes nothing by itself.",
  },
  verify: {
    role: "verify",
    label: "Verify",
    purpose: "Checks whether a step changed what it claimed, and refuses to round it up.",
  },
  security: {
    role: "security",
    label: "Security",
    purpose: "Puts a risky step in front of you, and records the answer you gave.",
  },
};

export function describeRole(role: AgentRole): RoleDescription {
  return DESCRIPTIONS[role];
}

/**
 * Which role owns which tool, by name.
 *
 * A table rather than a rule over categories, because the categories are about *risk*
 * and the roles are about *what kind of work it is*: `read_file` and `git_status` are
 * both level-0 reads and they belong to different faculties. The table is checked
 * against the live registry by a test, so a tool added without a line here is a test
 * failure and not a silent reclassification.
 *
 * `planner`, `verify` and `security` own nothing. That is the honest shape of them: the
 * planner is `plan-builder.ts` and `llm-planner.ts`, verification is `runVerified()`,
 * and the gate is the permission engine. None of the three is reachable as a tool a plan
 * could name, and listing one here to fill the column would be exactly the fake
 * symmetry §43 is about.
 */
const OWNED: Readonly<Record<AgentRole, readonly string[]>> = {
  planner: [],
  research: [
    "web_search",
    "fetch_web_page",
    "http_request",
    "browse_open",
    "browse_links",
    "browse_follow",
  ],
  memory: [
    "search_memory",
    "list_memories",
    "write_memory",
    "delete_memory",
    "save_memory_suggestion",
    "get_relevant_context",
    "read_profile",
    "list_episodes",
  ],
  computer: [
    "run_command",
    "run_local_intent",
    "list_directory",
    "read_file",
    "write_file",
    "delete_file",
    "send_email",
    "list_calendar_events",
    "create_calendar_event",
  ],
  coding: ["find_project", "list_projects", "git_status", "git_list_commits", "git_list_branches"],
  verify: [],
  security: [],
};

const BY_NAME: ReadonlyMap<string, AgentRole> = (() => {
  const map = new Map<string, AgentRole>();
  for (const role of ROLE_ORDER) {
    for (const name of OWNED[role]) map.set(name, role);
  }
  return map;
})();

/**
 * Where a tool the table does not name ends up.
 *
 * Not a substitute for the table — a fallback is a guess, and `attributeTool` says which
 * of the two answered so a trace never presents one as the other. It exists so that no
 * tool is ever *unowned*: a registry entry with no role would vanish from the tool pane's
 * role column and from every engagement count, which is a worse failure than a coarse
 * answer nobody was told to trust.
 */
const BY_CATEGORY: Readonly<Record<string, AgentRole>> = {
  read: "computer",
  write: "computer",
  move: "computer",
  delete: "computer",
  execute: "computer",
  network: "research",
  credential: "security",
  "security-control": "security",
  unknown: "computer",
};

/** The least a role table needs to know about a tool. Structurally a `ToolInfo`. */
export interface ToolFact {
  readonly name: string;
  readonly category: string;
  readonly typicalLevel?: number;
  readonly simulated?: boolean;
}

export interface ToolAttribution {
  readonly name: string;
  readonly role: AgentRole;
  /** `table` is a decision this file made on purpose; `category` is a fallback. */
  readonly attributed: "table" | "category";
}

export function attributeTool(tool: ToolFact): ToolAttribution {
  const named = BY_NAME.get(tool.name);
  if (named !== undefined) return { name: tool.name, role: named, attributed: "table" };
  return {
    name: tool.name,
    role: BY_CATEGORY[tool.category] ?? "computer",
    attributed: "category",
  };
}

export interface RoleCapability {
  readonly role: AgentRole;
  readonly label: string;
  readonly purpose: string;
  /** The tools this role owns *in the registry it was asked about*, in that order. */
  readonly tools: readonly string[];
  /**
   * The highest level any of them classifies at with no arguments, or `null` when the
   * role owns nothing here.
   *
   * Computed from the registry rather than declared, because a declared ceiling is a
   * claim that can drift out of step with what the tools actually do — and the number
   * a user reads next to "Research" has to be the number the engine will see.
   */
  readonly highestLevel: number | null;
  /** How many of them are mocked. Shown, never hidden (§43). */
  readonly simulated: number;
  /** Tools the table did not name, so a coarse answer is visible as one. */
  readonly byCategory: readonly string[];
}

/**
 * Split a registry into roles.
 *
 * Every role comes back, including the ones that own nothing in this registry: a role
 * missing from the list would read as a faculty Jarvis does not have, when the truth is
 * usually a dependency that was not wired.
 */
export function roleCapabilities(tools: readonly ToolFact[]): readonly RoleCapability[] {
  const owned = new Map<AgentRole, ToolFact[]>(ROLE_ORDER.map((r) => [r, []]));
  const coarse = new Map<AgentRole, string[]>(ROLE_ORDER.map((r) => [r, []]));
  for (const tool of tools) {
    const attribution = attributeTool(tool);
    owned.get(attribution.role)?.push(tool);
    if (attribution.attributed === "category") coarse.get(attribution.role)?.push(tool.name);
  }
  return ROLE_ORDER.map((role) => {
    const mine = owned.get(role) ?? [];
    const levels = mine
      .map((t) => t.typicalLevel)
      .filter((l): l is number => typeof l === "number");
    return {
      ...DESCRIPTIONS[role],
      tools: mine.map((t) => t.name),
      highestLevel: levels.length > 0 ? Math.max(...levels) : null,
      simulated: mine.filter((t) => t.simulated === true).length,
      byCategory: coarse.get(role) ?? [],
    };
  });
}

/**
 * Which role a recorded mission event belongs to.
 *
 * Grouped by who the event is *about* rather than by where in the loop it is emitted:
 *
 *  - The planner owns every event that changes what the mission is going to do, which
 *    includes `give_up` and `error`. Stopping is a planning decision, because the only
 *    alternative to stopping is another plan.
 *  - Verify owns the whole of the truth-telling: `verify`, both its verdicts, and
 *    `finish`, since finishing is the claim that every required step verified.
 *  - Security owns the events that came from outside the loop — a consent question, its
 *    two answers, and a cancel, which is consent withdrawn from the mission as a whole.
 *
 * Returns `null` for a word that is not an event this build emits, so a hand-edited log
 * line cannot become a role's action.
 */
const EVENT_ROLE: Readonly<Record<string, AgentRole>> = {
  planned: "planner",
  plan_empty: "planner",
  replanned: "planner",
  replan_exhausted: "planner",
  ask_user: "planner",
  give_up: "planner",
  error: "planner",
  retrieved: "memory",
  verify: "verify",
  step_ok: "verify",
  step_bad: "verify",
  finish: "verify",
  need_approval: "security",
  approved: "security",
  denied: "security",
  cancel: "security",
};

export function roleOfEvent(event: string): AgentRole | null {
  return EVENT_ROLE[event] ?? null;
}

/** What one recorded line is attributed to, and on what basis. */
export interface LineAttribution {
  readonly role: AgentRole;
  /**
   * Which of the three rules answered.
   *
   * `event` — the line named a mission event. `tool` — it named no event, so it is a
   * step starting, and the role is whoever owns that step's tool. `default` — neither,
   * which is the mission's own opening line and its bookkeeping notes.
   */
  readonly basis: "event" | "tool" | "default";
}

/**
 * Attribute one log line to exactly one role.
 *
 * An event outranks a tool: `step_ok` carries the step it is about, and the fact worth
 * recording there is that something *checked* it, not that a command was involved.
 * A line with no event and a step is the only line the orchestrator writes when a step
 * begins, and it is the one that shows research, computer and coding doing the work.
 */
export function attributeLine(line: {
  readonly event?: string;
  readonly step?: { readonly tool?: string };
}): LineAttribution {
  if (line.event !== undefined) {
    const byEvent = roleOfEvent(line.event);
    if (byEvent !== null) return { role: byEvent, basis: "event" };
  }
  const tool = line.step?.tool;
  if (tool !== undefined && tool !== "") {
    return { role: attributeTool({ name: tool, category: "unknown" }).role, basis: "tool" };
  }
  return { role: "planner", basis: "default" };
}

export interface RoleEngagement {
  readonly role: AgentRole;
  readonly label: string;
  readonly purpose: string;
  /** How many recorded lines this role accounted for. Counted, never estimated. */
  readonly actions: number;
  readonly engaged: boolean;
}

/**
 * Which roles this mission actually engaged, counted from its own log.
 *
 * Every role is returned, with a count that may be zero — the list is "the seven, and
 * what each of them did here", which is a stronger statement than a list of the ones
 * that happened to appear. A zero is a role that did nothing, and saying so is the
 * point of the page.
 */
export function roleEngagement(
  lines: readonly { readonly event?: string; readonly step?: { readonly tool?: string } }[],
): readonly RoleEngagement[] {
  const counts = new Map<AgentRole, number>(ROLE_ORDER.map((r) => [r, 0]));
  for (const line of lines) {
    const { role } = attributeLine(line);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return ROLE_ORDER.map((role) => {
    const actions = counts.get(role) ?? 0;
    return { ...DESCRIPTIONS[role], actions, engaged: actions > 0 };
  });
}
