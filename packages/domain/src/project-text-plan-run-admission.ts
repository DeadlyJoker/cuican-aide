import { validateCreativeProjectActor } from "./creative-project-validation.ts";
import { parseProjectConversationInstallation } from "./project-conversation-binding.ts";
import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import type { ProjectStageRunAdmission } from "./project-stage-run-admission.ts";
import type {
  ProjectTextPlanRunAdmission,
  ProjectTextPlanRevision,
  ProjectTextPlanStep,
} from "./project-text-plan-types.ts";
import {
  planRecord,
  planId,
  planRevision,
  planChecked,
  planCreated,
  planTime,
  planDigest,
  planStage,
  planNullable,
  planEpisodeIds,
  planSources,
  parseProjectTextPlanBaseline,
  planFailure,
} from "./project-text-plan-validation.ts";

export function parseProjectTextPlanRunAdmission(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectTextPlanRunAdmission {
  const v = planRecord(input, [
    "schemaVersion",
    "planId",
    "planRevision",
    "planRevisionDigest",
    "stepId",
    "stepRevision",
    "attempt",
    "actor",
    "installation",
    "projectId",
    "threadId",
    "bindingId",
    "bindingRevision",
    "workspaceId",
    "configurationRevision",
    "configurationDigest",
    "runId",
    "stageAdmissionDigest",
    "extensionBindingDigest",
    "delegationDigest",
    "inputDigest",
    "idempotencyKey",
    "taskIdempotencyKey",
    "kind",
    "episodeId",
    "expectedEpisodeIds",
    "sources",
    "baseline",
    "createdAt",
    "contentDigest",
  ]);
  if (v.schemaVersion !== "crewon.project-text-plan-run-admission.v1")
    planFailure();
  const actor = validateCreativeProjectActor(v.actor),
    installation = parseProjectConversationInstallation(v.installation),
    kind = planStage(v.kind),
    episodeId = planNullable(v.episodeId, planId),
    expectedEpisodeIds = planEpisodeIds(v.expectedEpisodeIds),
    sources = planSources(v.sources),
    baseline = planNullable(v.baseline, parseProjectTextPlanBaseline);
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId ||
    (kind === "script") !== (episodeId !== null) ||
    (kind === "outline"
      ? expectedEpisodeIds.length === 0
      : expectedEpisodeIds.length !== 0) ||
    (kind !== "brief" && sources.brief === null) ||
    (baseline !== null &&
      (baseline.kind !== kind || baseline.episodeId !== episodeId))
  )
    planFailure();
  return planChecked(
    {
      schemaVersion: v.schemaVersion,
      planId: planId(v.planId),
      planRevision: planRevision(v.planRevision),
      planRevisionDigest: planDigest(v.planRevisionDigest),
      stepId: planId(v.stepId),
      stepRevision: planRevision(v.stepRevision),
      attempt: planRevision(v.attempt),
      actor,
      installation,
      projectId: planId(v.projectId),
      threadId: planId(v.threadId),
      bindingId: planId(v.bindingId),
      bindingRevision: planRevision(v.bindingRevision),
      workspaceId: planNullable(v.workspaceId, planId),
      configurationRevision: planRevision(v.configurationRevision),
      configurationDigest: planDigest(v.configurationDigest),
      runId: planId(v.runId),
      stageAdmissionDigest: planDigest(v.stageAdmissionDigest),
      extensionBindingDigest: planDigest(v.extensionBindingDigest),
      delegationDigest: planDigest(v.delegationDigest),
      inputDigest: planDigest(v.inputDigest),
      idempotencyKey: planId(v.idempotencyKey),
      taskIdempotencyKey: planId(v.taskIdempotencyKey),
      kind,
      episodeId,
      expectedEpisodeIds,
      sources,
      baseline,
      createdAt: planTime(v.createdAt),
    },
    v.contentDigest,
    digester,
  );
}
export function createProjectTextPlanRunAdmission(
  input: Omit<ProjectTextPlanRunAdmission, "schemaVersion" | "contentDigest">,
  digester: ExtensionContentDigester,
): ProjectTextPlanRunAdmission {
  return parseProjectTextPlanRunAdmission(
    planCreated(
      { schemaVersion: "crewon.project-text-plan-run-admission.v1", ...input },
      digester,
    ),
    digester,
  );
}
export function assertProjectTextPlanRunSources(
  plan: ProjectTextPlanRevision,
  step: ProjectTextPlanStep,
  admission: ProjectTextPlanRunAdmission,
  stage: ProjectStageRunAdmission,
  digester: ExtensionContentDigester,
): void {
  if (
    plan.planId !== step.planId ||
    plan.planRevision !== step.planRevision ||
    admission.planId !== plan.planId ||
    admission.planRevision !== plan.planRevision ||
    admission.planRevisionDigest !== plan.contentDigest ||
    admission.stepId !== step.stepId ||
    admission.stepRevision !== step.revision ||
    admission.attempt !== step.attempt ||
    admission.kind !== step.kind ||
    admission.episodeId !== step.episodeId ||
    admission.stageAdmissionDigest !== stage.contentDigest ||
    admission.runId !== stage.runId ||
    admission.inputDigest !== stage.userContentDigest ||
    admission.idempotencyKey !== stage.idempotencyKey ||
    admission.extensionBindingDigest !== stage.extensionBindingDigest ||
    admission.delegationDigest !==
      digester.sha256(extensionCanonicalJson(plan.delegation))
  )
    planFailure("project_text_plan_run_scope_invalid");
  for (const key of [
    "projectId",
    "threadId",
    "bindingId",
    "bindingRevision",
    "workspaceId",
  ] as const)
    if (admission[key] !== stage[key] || admission[key] !== plan[key])
      planFailure("project_text_plan_run_scope_invalid");
  for (const key of ["actor", "installation"] as const)
    if (
      extensionCanonicalJson(admission[key]) !==
        extensionCanonicalJson(stage[key]) ||
      extensionCanonicalJson(admission[key]) !==
        extensionCanonicalJson(plan[key])
    )
      planFailure("project_text_plan_run_scope_invalid");
  if (
    stage.stage.kind !== step.kind ||
    (stage.stage.kind === "script" &&
      stage.stage.episodeId !== step.episodeId) ||
    extensionCanonicalJson(admission.sources) !==
      extensionCanonicalJson(stage.sources) ||
    extensionCanonicalJson(admission.baseline) !==
      extensionCanonicalJson(
        step.baseline ??
          plan.baselines.find(
            (x) => x.kind === step.kind && x.episodeId === step.episodeId,
          ) ??
          null,
      ) ||
    (step.kind === "outline" &&
      extensionCanonicalJson(admission.expectedEpisodeIds) !==
        extensionCanonicalJson(plan.episodeIds))
  )
    planFailure("project_text_plan_run_scope_invalid");
}
