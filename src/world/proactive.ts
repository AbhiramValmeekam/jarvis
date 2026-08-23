/**
 * Suggesting work, which is not the same as doing it.
 *
 * The graph next door knows things the user has not asked about: that the last
 * mission on a project failed and nothing has been run since, that a scheduled job
 * has been failing, that the editor is open on a project Jarvis has never looked at.
 * An assistant that noticed those and acted would be an assistant that runs commands
 * nobody asked for. An assistant that noticed and said nothing would be wasting the
 * only real advantage of keeping a world model at all.
 *
 * So this produces *suggestions*: an objective, and the facts that led to it. Nothing
 * here starts anything, and nothing here can — a suggestion is a value, the queue it
 * goes into (`proposal-store.ts`) only stores it, and the single path from a queued
 * suggestion to a running mission is a request the user's own window sent. That is
 * the same door learning goes through (`src/memory/learning.ts`), for the same
 * reason: the user's confirmation is not a formality to be optimised away.
 *
 * Three properties are load-bearing, and each one is a rule this file enforces
 * rather than a convention it hopes for:
 *
 *  1. **Every suggestion cites records.** `because` is a list of sentences naming
 *     missions, jobs and times. A suggestion whose reasoning cannot be checked is one
 *     the user can only accept on faith, and faith is not consent.
 *
 *  2. **Nothing the user already refused comes back.** A mission that ended
 *     `blocked` was refused at a permission prompt and a `cancelled` one was stopped
 *     by hand. Re-proposing either would be nagging with extra steps, so there is
 *     deliberately no rule that reads those states — and a test that says so.
 *
 *  3. **Untrusted text may agree, never decide.** A window title or a scheduled
 *     job's name can name any project (§52). Those edges arrive flagged `steerable`,
 *     and a steerable edge can only support a target that a non-steerable record
 *     already reached. A web page cannot make Jarvis offer to work on something.
 */
import { entityOf, missionsOn, type World } from "./world-model.js";

export type RuleName = "left-failing" | "job-failing" | "focused-untouched";

export interface Suggestion {
  /**
   * Stable for the same situation, so the queue can refuse a duplicate and a decline
   * can stick. Built from the rule and the entity, never from the wording — a rule
   * that rephrased its objective would otherwise slip past a decline.
   */
  readonly fingerprint: string;
  readonly rule: RuleName;
  /** What the user would be agreeing to run. Worded from the registry, not from a title. */
  readonly objective: string;
  /** One checkable sentence per line. Never a model's account of its own reasoning. */
  readonly because: readonly string[];
  /** The project this is about. */
  readonly entityId: string;
}

/**
 * How long a project has to have been quiet before "you are working in this and I
 * have never looked at it" is worth saying.
 *
 * Six hours rather than minutes: the interesting case is opening a project in the
 * morning that nothing has been run against, not glancing at one between two steps
 * of a mission that is already running.
 */
export const QUIET_MS = 6 * 60 * 60 * 1000;

/** At most this many at once. A list nobody reads to the bottom of is a list nobody reads. */
export const MAX_SUGGESTIONS = 4;

/** Rule order, worst-first: a broken build outranks a project nobody has checked. */
const WEIGHT: Record<RuleName, number> = {
  "left-failing": 0,
  "job-failing": 1,
  "focused-untouched": 2,
};

export interface SuggestOptions {
  readonly now?: number;
  readonly limit?: number;
}

/** "3 hours ago", "just now" — relative so it needs no locale and no timezone. */
export function ageLabel(ms: number): string {
  if (ms < 60_000) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Whether a non-steerable record also connects these two.
 *
 * This is the enforcement point for rule 3 above. A scheduled job's name saying
 * "portal" is enough to draw an edge and not enough to choose a target, so the rule
 * that wants to act on the job asks here whether anything the user actually did —
 * a mission — reached the same project. Agreement is allowed; authority is not.
 */
function corroborated(world: World, projectId: string): boolean {
  return world.edges.some((e) => e.to === projectId && e.steerable !== true);
}

/**
 * What Jarvis would offer to do, given what it can see.
 *
 * Pure, and deliberately so: the same world produces the same suggestions, which is
 * what makes a decline meaningful — a rule whose output drifted would come back
 * under a new fingerprint and the user would decline it again forever.
 */
export function suggest(world: World, opts: SuggestOptions = {}): readonly Suggestion[] {
  const now = opts.now ?? world.at;
  const limit = Math.max(0, opts.limit ?? MAX_SUGGESTIONS);
  const out: Suggestion[] = [];
  const claimed = new Set<string>();

  const projects = world.entities.filter((e) => e.kind === "project");

  // --- rule 1: something was left failing ----------------------------------
  for (const project of projects) {
    const missions = missionsOn(world, project.id);
    const newest = missions[0];
    if (!newest) continue;
    // `blocked` and `cancelled` are absent on purpose — see the header, property 2.
    if (newest.status !== "failed") continue;
    const why = newest.note ?? "";
    out.push({
      fingerprint: `left-failing:${project.id}`,
      rule: "left-failing",
      objective: `check whether ${project.label} still builds and its tests pass`,
      because: [
        `mission ${newest.key} ("${newest.label}") ended failed ` +
          `${ageLabel(Math.max(0, now - (newest.at ?? now)))}`,
        ...(why ? [`it stopped because ${why}`] : []),
        `nothing has run against ${project.label} since`,
      ],
      entityId: project.id,
    });
    claimed.add(project.id);
  }

  // --- rule 2: a scheduled job keeps failing -------------------------------
  //
  // The job's own name is what links it to a project, and a job's name was written by
  // an agent turn — so the link arrives `steerable` and `corroborated` decides whether
  // it may be acted on. In practice that means: a job about a project Jarvis has
  // actually worked on can raise a suggestion, and a job named after a project nobody
  // here has ever touched cannot.
  for (const edge of world.edges) {
    if (edge.kind !== "scheduled_in") continue;
    if (claimed.has(edge.to)) continue;
    const task = entityOf(world, edge.from);
    const project = entityOf(world, edge.to);
    if (!task || !project) continue;
    if (task.status !== "error") continue;
    if (!corroborated(world, project.id)) continue;
    out.push({
      fingerprint: `job-failing:${task.id}`,
      rule: "job-failing",
      objective: `check whether ${project.label} still builds and its tests pass`,
      because: [
        `the scheduled job "${task.label}" reports its last run as error` +
          (task.at ? ` ${ageLabel(Math.max(0, now - task.at))}` : ""),
        ...(task.note ? [`Hermes gave the reason as ${task.note}`] : []),
        `its name names ${project.label}, and missions here have worked on that project`,
      ],
      entityId: project.id,
    });
    claimed.add(project.id);
  }

  // --- rule 3: the user is in a project nothing has looked at ---------------
  //
  // `focus.steerable` is why this reads the focus rather than the `focused` edges: a
  // browser tab titled after a project sets the same edge, and the graph already
  // worked out that such an answer was chosen by whatever the page loaded.
  const focus = world.focus;
  if (focus && focus.projectId && !focus.steerable && !claimed.has(focus.projectId)) {
    const project = entityOf(world, focus.projectId);
    const window = entityOf(world, focus.windowId);
    if (project && window) {
      const missions = missionsOn(world, project.id);
      const newest = missions[0];
      const quiet = newest === null || newest === undefined || (now - (newest.at ?? 0)) > QUIET_MS;
      if (quiet) {
        out.push({
          fingerprint: `focused-untouched:${project.id}`,
          rule: "focused-untouched",
          objective: `show what has changed in ${project.label}`,
          because: [
            `${window.label} is in the foreground and its title names ${project.label}`,
            newest
              ? `the last mission on it was ${ageLabel(Math.max(0, now - (newest.at ?? now)))}`
              : `no mission has ever looked at ${project.label}`,
          ],
          entityId: project.id,
        });
        claimed.add(project.id);
      }
    }
  }

  return out
    .slice()
    .sort((a, b) => WEIGHT[a.rule] - WEIGHT[b.rule] || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, limit);
}
