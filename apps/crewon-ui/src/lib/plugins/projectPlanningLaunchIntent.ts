import {
  parseProjectPlanningProposal,
  type ProjectPlanningProposal,
} from "@crewon/contracts/project-planning";
import { parseProjectTextId } from "@crewon/contracts";
import {
  parseProjectConversationAssociationRequest,
  PROJECT_CONVERSATION_ASSOCIATION_ACTIONS,
  type ProjectConversationAssociationAttachInput,
} from "@crewon/contracts/project-conversation-association";
import {
  parseProjectTextPlansActionRequest,
  PROJECT_TEXT_PLANS_METHOD_ACTIONS,
  type ProjectTextPlansRequests,
} from "@crewon/contracts/project-text-plans";

export type ProjectPlanningLaunchMode = "create" | "execute";
export type ProjectPlanningLaunchIntent = Readonly<{
  version: "crewon.project-planning-launch-intent.v1";
  proposal: ProjectPlanningProposal;
  selectionRevision: number;
  mode: ProjectPlanningLaunchMode;
  adoption: "manual" | "whenUnchanged";
  key: string;
  threadRevision: number;
  workspaceId: string | null;
  dispatched: "create" | "attach" | "start" | null;
  projectId: string | null;
  briefRevision: number | null;
  attach: ProjectConversationAssociationAttachInput | null;
  start: ProjectTextPlansRequests["start"] | null;
  associated: boolean;
  planId: string | null;
}>;
export type ProjectPlanningLaunchStorage = Pick<Storage, "getItem" | "setItem">;
export const proposalLaunchIdentity = (
  proposal: ProjectPlanningProposal,
): string => JSON.stringify(parseProjectPlanningProposal(proposal));
const MAX_INTENTS = 16,
  MAX_BYTES = 256 * 1024;
function invalid(): never {
  throw new Error("project_planning_launch_intent_invalid");
}
const keys = [
  "version",
  "proposal",
  "selectionRevision",
  "mode",
  "adoption",
  "key",
  "threadRevision",
  "workspaceId",
  "dispatched",
  "projectId",
  "briefRevision",
  "attach",
  "start",
  "associated",
  "planId",
];
const positive = (x: unknown): x is number =>
  Number.isSafeInteger(x) && (x as number) > 0;
const id = (x: unknown): x is string => {
  try {
    parseProjectTextId(x);
    return true;
  } catch {
    return false;
  }
};

/** Local frozen commands are recovery hints only; every operation still uses the authenticated host. */
export function parseProjectPlanningLaunchIntent(
  input: unknown,
): ProjectPlanningLaunchIntent {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k)) ||
    v.version !== "crewon.project-planning-launch-intent.v1" ||
    !positive(v.selectionRevision) ||
    !positive(v.threadRevision) ||
    (v.mode !== "create" && v.mode !== "execute") ||
    (v.adoption !== "manual" && v.adoption !== "whenUnchanged") ||
    typeof v.key !== "string" ||
    !/^[a-f0-9]{64}$/u.test(v.key) ||
    (v.workspaceId !== null && !id(v.workspaceId)) ||
    ![null, "create", "attach", "start"].includes(v.dispatched as never) ||
    typeof v.associated !== "boolean" ||
    (v.projectId !== null && !id(v.projectId)) ||
    (v.briefRevision !== null && !positive(v.briefRevision)) ||
    (v.planId !== null && !id(v.planId))
  )
    invalid();
  const proposal = parseProjectPlanningProposal(v.proposal);
  if ((v.projectId === null) !== (v.briefRevision === null)) invalid();
  const attach =
    v.attach === null
      ? null
      : (parseProjectConversationAssociationRequest({
          action: PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.attach,
          input: v.attach,
        }).input as ProjectConversationAssociationAttachInput);
  if (
    attach &&
    (attach.projectId !== v.projectId ||
      attach.threadId !== proposal.origin.threadId ||
      attach.expectedThreadRevision !== v.threadRevision ||
      attach.workspaceId !== v.workspaceId ||
      attach.idempotencyKey !== `planning-attach:${v.key}`)
  )
    invalid();
  const start =
    v.start === null
      ? null
      : (parseProjectTextPlansActionRequest({
          action: PROJECT_TEXT_PLANS_METHOD_ACTIONS.start,
          input: v.start,
        }).input as ProjectTextPlansRequests["start"]);
  if (
    start &&
    (v.mode !== "execute" ||
      !v.associated ||
      start.projectId !== v.projectId ||
      start.threadId !== proposal.origin.threadId ||
      start.expectedBriefRevision !== v.briefRevision ||
      start.idempotencyKey !== `planning-start:${v.key}` ||
      start.instruction !== proposal.input.instruction ||
      start.start !== proposal.input.start ||
      start.target !== proposal.input.target ||
      start.adoption !== v.adoption ||
      JSON.stringify(start.episodes) !==
        JSON.stringify(
          proposal.input.episodeCount === null
            ? null
            : { kind: "newOutline", episodeCount: proposal.input.episodeCount },
        ))
  )
    invalid();
  if (
    (v.associated && !attach) ||
    (v.planId !== null && !start) ||
    (v.dispatched === "attach" && !attach) ||
    (v.dispatched === "start" && !start)
  )
    invalid();
  return Object.freeze({
    ...v,
    proposal,
    attach,
    start,
  }) as ProjectPlanningLaunchIntent;
}

/** Bounded account/endpoint-local cache. Reading or restoring never dispatches a command. */
export function createProjectPlanningLaunchIntentStore(
  storage: ProjectPlanningLaunchStorage,
  ownerKey: string,
) {
  const storageKey = `crewon.project-planning-launch.v1:${ownerKey}`;
  function load(): ProjectPlanningLaunchIntent[] {
    const raw = storage.getItem(storageKey);
    if (raw === null) return [];
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) invalid();
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > MAX_INTENTS) invalid();
    const entries = values.map(parseProjectPlanningLaunchIntent);
    if (
      new Set(entries.map((e) => proposalLaunchIdentity(e.proposal))).size !==
      entries.length
    )
      invalid();
    return entries;
  }
  load();
  return {
    get(proposal: ProjectPlanningProposal) {
      return (
        load().find(
          (e) =>
            proposalLaunchIdentity(e.proposal) ===
            proposalLaunchIdentity(proposal),
        ) ?? null
      );
    },
    save(value: ProjectPlanningLaunchIntent) {
      const checked = parseProjectPlanningLaunchIntent(value),
        identity = proposalLaunchIdentity(checked.proposal);
      const entries = load(),
        previous = entries.find(
          (e) => proposalLaunchIdentity(e.proposal) === identity,
        );
      if (previous) {
        for (const field of [
          "selectionRevision",
          "mode",
          "adoption",
          "key",
          "threadRevision",
          "workspaceId",
        ] as const)
          if (checked[field] !== previous[field])
            throw new Error("project_planning_launch_intent_changed");
        for (const field of [
          "projectId",
          "briefRevision",
          "attach",
          "start",
          "planId",
        ] as const)
          if (
            previous[field] !== null &&
            JSON.stringify(previous[field]) !== JSON.stringify(checked[field])
          )
            throw new Error("project_planning_launch_intent_changed");
        if (previous.associated && !checked.associated)
          throw new Error("project_planning_launch_intent_changed");
      }
      const next = entries.filter(
        (e) => proposalLaunchIdentity(e.proposal) !== identity,
      );
      next.push(checked);
      // Unknown commands cannot be evicted to make room for a new project.
      if (next.length > MAX_INTENTS) {
        const completed = next.findIndex(
          (e) =>
            e !== checked &&
            e.dispatched === null &&
            (e.planId !== null || (e.mode === "create" && e.associated)),
        );
        if (completed === -1)
          throw new Error("project_planning_launch_intent_limit");
        next.splice(completed, 1);
      }
      const encoded = JSON.stringify(next);
      if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) invalid();
      storage.setItem(storageKey, encoded);
    },
  };
}
export type ProjectPlanningLaunchIntentStore = ReturnType<
  typeof createProjectPlanningLaunchIntentStore
>;
