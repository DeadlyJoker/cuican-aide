import { validateCreativeProjectActor } from "./creative-project-validation.ts";
import { parseProjectConversationInstallation } from "./project-conversation-binding.ts";
import {
  parseExtensionExecutionTarget,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import type {
  ProjectTextPlan,
  ProjectTextPlanRevision,
} from "./project-text-plan-types.ts";
import {
  planRecord,
  planId,
  planRevision,
  planEnum,
  planNullable,
  planTimes,
  planChecked,
  planCreated,
  planFailure,
  planStage,
  planEpisodeIds,
  planInstruction,
  planDigest,
  parseProjectTextPlanDelegation,
  planSources,
  planArray,
  parseProjectTextPlanBaseline,
  planTime,
} from "./project-text-plan-validation.ts";

export function parseProjectTextPlan(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectTextPlan {
  const v = planRecord(input, [
    "schemaVersion",
    "planId",
    "owner",
    "profileId",
    "projectId",
    "threadId",
    "bindingId",
    "workspaceId",
    "revision",
    "currentPlanRevision",
    "state",
    "activeStepId",
    "pauseReason",
    "wakeRevision",
    "createdAt",
    "updatedAt",
    "contentDigest",
  ]);
  if (v.schemaVersion !== "crewon.project-text-plan.v1") planFailure();
  const state = planEnum(v.state, [
      "ready",
      "running",
      "waitingSelection",
      "paused",
      "completed",
      "revoked",
    ]),
    pauseReason = planNullable(v.pauseReason, (x) =>
      planEnum(x, [
        "source_changed",
        "selection_changed",
        "locked",
        "binding_changed",
        "installation_changed",
        "authorization_unavailable",
        "run_failed",
        "run_canceled",
        "result_missing",
        "result_invalid",
        "user_paused",
      ]),
    ),
    activeStepId = planNullable(v.activeStepId, planId);
  if (
    (state === "paused") !== (pauseReason !== null) ||
    (["running", "waitingSelection"].includes(state) &&
      activeStepId === null) ||
    (state === "completed" && activeStepId !== null)
  )
    planFailure();
  return planChecked(
    {
      schemaVersion: v.schemaVersion,
      planId: planId(v.planId),
      owner: validateCreativeProjectActor(v.owner),
      profileId: planId(v.profileId),
      projectId: planId(v.projectId),
      threadId: planId(v.threadId),
      bindingId: planId(v.bindingId),
      workspaceId: planNullable(v.workspaceId, planId),
      revision: planRevision(v.revision),
      currentPlanRevision: planRevision(v.currentPlanRevision),
      state,
      activeStepId,
      pauseReason,
      wakeRevision: planRevision(v.wakeRevision, { minimum: 0 }),
      ...planTimes(v.createdAt, v.updatedAt),
    },
    v.contentDigest,
    digester,
  );
}
export function createProjectTextPlan(
  input: Omit<ProjectTextPlan, "schemaVersion" | "contentDigest">,
  digester: ExtensionContentDigester,
): ProjectTextPlan {
  return parseProjectTextPlan(
    planCreated(
      { schemaVersion: "crewon.project-text-plan.v1", ...input },
      digester,
    ),
    digester,
  );
}
export function parseProjectTextPlanRevision(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectTextPlanRevision {
  const v = planRecord(input, [
    "schemaVersion",
    "planId",
    "planRevision",
    "actor",
    "installation",
    "projectId",
    "threadId",
    "bindingId",
    "bindingRevision",
    "workspaceId",
    "configurationRevision",
    "configurationDigest",
    "target",
    "start",
    "targetStage",
    "episodeMode",
    "episodeIds",
    "adoption",
    "concurrency",
    "maximumResultsPerStep",
    "instruction",
    "instructionDigest",
    "delegation",
    "sources",
    "baselines",
    "createdAt",
    "contentDigest",
  ]);
  if (
    v.schemaVersion !== "crewon.project-text-plan-revision.v1" ||
    v.concurrency !== 1 ||
    v.maximumResultsPerStep !== 1
  )
    planFailure();
  const actor = validateCreativeProjectActor(v.actor),
    installation = parseProjectConversationInstallation(v.installation),
    start = planStage(v.start),
    targetStage = planStage(v.targetStage),
    episodeIds = planEpisodeIds(v.episodeIds),
    instruction = planInstruction(v.instruction),
    instructionDigest = planDigest(v.instructionDigest),
    baselines = planArray(v.baselines, 17, parseProjectTextPlanBaseline),
    sources = planSources(v.sources);
  const order = ["brief", "outline", "script"],
    episodeMode = planEnum(v.episodeMode, [
      "none",
      "newOutline",
      "selectedOutline",
      "independentScripts",
    ]);
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId ||
    order.indexOf(start) > order.indexOf(targetStage) ||
    (targetStage !== "brief" && episodeIds.length === 0) ||
    (targetStage === "brief" && episodeIds.length !== 0) ||
    digester.sha256(instruction) !== instructionDigest ||
    new Set(baselines.map((x) => `${x.kind}:${x.episodeId ?? ""}`)).size !==
      baselines.length ||
    (start !== "brief" && sources.brief === null) ||
    (episodeMode === "none"
      ? targetStage !== "brief"
      : targetStage === "brief") ||
    (episodeMode === "newOutline" && start === "script") ||
    (["selectedOutline", "independentScripts"].includes(episodeMode) &&
      (start !== "script" || targetStage !== "script")) ||
    (episodeMode === "selectedOutline" && sources.outline === null) ||
    (episodeMode === "independentScripts" && sources.outline !== null)
  )
    planFailure();
  return planChecked(
    {
      schemaVersion: v.schemaVersion,
      planId: planId(v.planId),
      planRevision: planRevision(v.planRevision),
      actor,
      installation,
      projectId: planId(v.projectId),
      threadId: planId(v.threadId),
      bindingId: planId(v.bindingId),
      bindingRevision: planRevision(v.bindingRevision),
      workspaceId: planNullable(v.workspaceId, planId),
      configurationRevision: planRevision(v.configurationRevision),
      configurationDigest: planDigest(v.configurationDigest),
      target: parseExtensionExecutionTarget(v.target),
      start,
      targetStage,
      episodeMode,
      episodeIds,
      adoption: planEnum(v.adoption, ["manual", "whenUnchanged"]),
      concurrency: 1,
      maximumResultsPerStep: 1,
      instruction,
      instructionDigest,
      delegation: parseProjectTextPlanDelegation(v.delegation),
      sources,
      baselines,
      createdAt: planTime(v.createdAt),
    },
    v.contentDigest,
    digester,
  );
}
export function createProjectTextPlanRevision(
  input: Omit<ProjectTextPlanRevision, "schemaVersion" | "contentDigest">,
  digester: ExtensionContentDigester,
): ProjectTextPlanRevision {
  return parseProjectTextPlanRevision(
    planCreated(
      { schemaVersion: "crewon.project-text-plan-revision.v1", ...input },
      digester,
    ),
    digester,
  );
}
export function assertProjectTextPlanChange(
  previous: ProjectTextPlan,
  next: ProjectTextPlan,
): void {
  if (
    next.revision !== previous.revision + 1 ||
    next.currentPlanRevision < previous.currentPlanRevision ||
    next.currentPlanRevision > previous.currentPlanRevision + 1 ||
    next.wakeRevision < previous.wakeRevision ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
    previous.state === "revoked"
  )
    planFailure("project_text_plan_transition_invalid");
  for (const key of [
    "planId",
    "profileId",
    "projectId",
    "threadId",
    "bindingId",
    "workspaceId",
    "createdAt",
  ] as const)
    if (next[key] !== previous[key])
      planFailure("project_text_plan_identity_changed");
  if (JSON.stringify(next.owner) !== JSON.stringify(previous.owner))
    planFailure("project_text_plan_identity_changed");
}
