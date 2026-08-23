/**
 * The world, projected onto the wire.
 *
 * A file of its own for the same reason `missions/mission-view.ts` is one: what a
 * projection *omits* is a security property, and a property is worth being able to test
 * without a pipe.
 *
 * What it omits, and what it insists on:
 *
 *  - **A project's `dir` travels only where a directory is the point.** Two places: the
 *    detail line the registry already shows, and an edge whose basis is "a step of this
 *    mission ran in ..." — which is the reason for that edge and cannot be stated
 *    without it. Nothing else carries one: no label, no status, no suggestion's
 *    evidence. A view with an absolute path per node would put the shape of the
 *    user's disk into every window that ever attaches, for nothing.
 *  - **An edge never travels without its `basis`.** The type makes it required and this
 *    function has no branch that can drop it. An edge with no stated reason is an
 *    assertion about the user's life that the user cannot check.
 *  - **`steerable` travels whenever it is true.** It is the difference between "you are
 *    working on this" and "a web page said this" (§52), and dropping it in the
 *    projection would erase the distinction exactly where a person would act on it.
 *  - **Nothing is added.** No derived importance, no "probably relevant", no score. The
 *    graph is a join over records, and the records are all there is (§43).
 */
import type {
  ProactiveProposalView,
  WorldEdgeView,
  WorldEntityView,
  WorldView,
} from "../ipc/contract.js";
import { sanitiseForDisplay } from "../permissions/risk-model.js";
import { describeWorld, type Entity, type Edge, type World } from "./world-model.js";
import type { ProactiveProposal } from "./proposal-store.js";

/** One line, in a panel that is not a log viewer. Same ceiling the mission view uses. */
const MAX_LINE = 200;

const line = (text: string): string => sanitiseForDisplay(text, MAX_LINE);

export function toEntityView(entity: Entity): WorldEntityView {
  return {
    id: entity.id,
    kind: entity.kind,
    key: entity.key,
    label: line(entity.label),
    ...(entity.detail === undefined ? {} : { detail: line(entity.detail) }),
    ...(entity.status === undefined ? {} : { status: line(entity.status) }),
    at: entity.at,
    source: entity.source,
  };
}

export function toEdgeView(edge: Edge): WorldEdgeView {
  return {
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    at: edge.at,
    basis: line(edge.basis),
    ...(edge.steerable === true ? { steerable: true } : {}),
  };
}

/**
 * A suggestion, as the user is asked about it.
 *
 * `because` travels whole — up to the queue's own five lines — because it is the
 * evidence, and a suggestion shown with half its evidence is one the user answers
 * without the part that mattered. It is already display-safe: the rules compose it from
 * registry strings and from a mission's recorded conclusion, and the queue cleaned and
 * screened it before storing it. It goes through the sanitiser again anyway, because
 * "already safe" is an argument about other code and this is the last function before
 * the pipe.
 */
export function toProposalView(proposal: ProactiveProposal): ProactiveProposalView {
  return {
    id: proposal.id,
    at: proposal.at,
    rule: proposal.rule,
    objective: line(proposal.objective),
    because: proposal.because.map((b) => line(b)),
    entityId: proposal.entityId,
  };
}

export interface WorldViewInput {
  readonly world: World;
  readonly proposals: readonly ProactiveProposal[];
  /** Whether suggestions may be produced at all, and the sentence that says why. */
  readonly proactive: { readonly enabled: boolean; readonly reason: string };
}

export function toWorldView(input: WorldViewInput): WorldView {
  const { world } = input;
  return {
    at: world.at,
    entities: world.entities.map(toEntityView),
    edges: world.edges.map(toEdgeView),
    focus: world.focus
      ? {
          windowId: world.focus.windowId,
          ...(world.focus.appId === undefined ? {} : { appId: world.focus.appId }),
          ...(world.focus.projectId === undefined ? {} : { projectId: world.focus.projectId }),
          steerable: world.focus.steerable,
        }
      : null,
    truncated: world.truncated,
    proposals: input.proposals.map(toProposalView),
    proactive: { enabled: input.proactive.enabled, reason: line(input.proactive.reason) },
    summary: describeWorld(world),
  };
}
