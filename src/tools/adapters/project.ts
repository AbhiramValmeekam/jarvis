/**
 * The project registry, as facts a plan can bind to.
 *
 * A mission says "get my portfolio ready" and every step after that needs the same
 * thing: which directory is that, and what kind of project is it. `list_projects`
 * and `find_project` answer exactly that, and nothing else — no scanning a path a
 * step nominated, no reading files, no running a build. The registry itself is
 * built from roots the user configured (`context/project-registry.ts`), which is
 * what makes the directory a fact rather than an argument.
 *
 * Paths do cross this boundary, unlike `describeProject`, which deliberately keeps
 * them out of *spoken* replies (§53). A step that is going to typecheck a project
 * needs its directory, and the caller is the orchestrator, not the speaker. They go
 * in `data`, where the next step reads them, and the summary stays speakable.
 */
import {
  describeProject,
  findProject,
  type ProjectEntry,
} from "../../context/project-registry.js";
import {
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

export interface ProjectDeps {
  /**
   * The registry, read at call time.
   *
   * A function for the reason `ExecutorDeps.projects` is one: a project cloned
   * after boot should be found by the next step, not the next restart.
   */
  readonly projects: () => readonly ProjectEntry[];
  /** The roots the user nominated, so "none found" and "none configured" differ. */
  readonly projectRoots?: () => readonly string[];
}

/** How a project travels to the next step. Everything here is registry-derived. */
function facts(p: ProjectEntry): ToolArgs {
  return { key: p.key, name: p.name, dir: p.dir, kind: p.kind, root: p.root };
}

function listProjects(deps: ProjectDeps): Tool {
  return {
    name: "list_projects",
    summary: "List the projects Jarvis knows about",
    schema: {},
    async run(_args: ToolArgs, _ctx: ToolContext): Promise<ToolRun> {
      const entries = deps.projects();
      if (entries.length === 0) {
        const roots = deps.projectRoots?.() ?? [];
        // Two different problems with two different fixes. A single "no projects"
        // would send the second user hunting through a folder that was never the
        // issue — the same distinction `ExecutorDeps.projectRoots` exists for.
        return {
          outcome: "verified",
          summary:
            roots.length === 0
              ? "no project folders are configured"
              : `nothing that looks like a project under ${roots.length} configured folder${roots.length === 1 ? "" : "s"}`,
          data: { projects: [], configuredRoots: roots.length },
        };
      }
      return {
        outcome: "verified",
        summary: `${entries.length} project${entries.length === 1 ? "" : "s"}`,
        detail: entries.map(describeProject).join(" · "),
        data: { projects: entries.map(facts) },
      };
    },
  };
}

function findProjectTool(deps: ProjectDeps): Tool {
  return {
    // `find_` matches the read family, which is what this is: a lookup in a
    // registry that was built from the user's own configuration.
    name: "find_project",
    summary: "Resolve a project name to its directory and kind",
    schema: { name: { kind: "string", required: true, max: 120 } },
    async run(args: ToolArgs, _ctx: ToolContext): Promise<ToolRun> {
      const spoken = readString(args, "name");
      const lookup = findProject(spoken, deps.projects());
      if (lookup.kind === "none") {
        return {
          outcome: "failed",
          summary: `no project answers to that name`,
          error: `nothing in the registry matches "${spoken}"`,
        };
      }
      if (lookup.kind === "ambiguous") {
        // Two projects answering to one word is a real state, and guessing which
        // one to build would be the wrong kind of confident.
        return {
          outcome: "failed",
          summary: "more than one project answers to that name",
          detail: lookup.candidates.map(describeProject).join(" · "),
          error: `${lookup.candidates.length} projects match "${spoken}"`,
          data: { candidates: lookup.candidates.map(facts) },
        };
      }
      return {
        outcome: "verified",
        summary: describeProject(lookup.project),
        detail: lookup.project.dir,
        data: facts(lookup.project),
      };
    },
  };
}

export function projectTools(deps: ProjectDeps): readonly Tool[] {
  return [listProjects(deps), findProjectTool(deps)];
}
