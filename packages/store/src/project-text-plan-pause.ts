import type { ProjectTextPlanStore } from "@crewon/application";
import {
  projectTextRecord,
  projectTextOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  checkpointProjectTextPlanSystemPause,
  type ProjectTextPlan,
  type ProjectTextPlanStep,
} from "@crewon/domain";
import {
  capturePlanAuthority,
  planAuthorityOption,
  planOwner,
  planEqual,
  planStoreFail,
} from "./project-text-plan-records.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  decodeCreativeProject,
  creativeStoreDigester,
} from "./creative-project-store-records.ts";

const reasons = [
  "authorization_unavailable",
  "source_changed",
  "selection_changed",
  "run_failed",
  "run_canceled",
  "result_missing",
  "locked",
  "binding_changed",
  "installation_changed",
  "result_invalid",
] as const;
export function capturePlanPause(
  input: Parameters<ProjectTextPlanStore["commitSystemPause"]>[0],
  options: Parameters<ProjectTextPlanStore["commitSystemPause"]>[1],
) {
  const v = projectTextRecord(input, [
      "owner",
      "planId",
      "expectedRevision",
      "stepId",
      "expectedStepRevision",
      "reason",
      "at",
    ]),
    q = capturePlanAuthority(planAuthorityOption(options)),
    owner = planOwner(v.owner);
  planEqual(owner.actor, q.actor);
  if (
    owner.profileId !== q.binding.profileId ||
    typeof v.reason !== "string" ||
    !reasons.includes(v.reason as (typeof reasons)[number])
  )
    planStoreFail("project_text_plan_pause_invalid");
  return {
    owner,
    q,
    planId: projectTextOpaqueId(v.planId),
    stepId: projectTextOpaqueId(v.stepId),
    expectedRevision: creativeProjectRevision(v.expectedRevision),
    expectedStepRevision: creativeProjectRevision(v.expectedStepRevision),
    reason: v.reason as Parameters<
      typeof checkpointProjectTextPlanSystemPause
    >[2],
    at: creativeProjectTimestamp(v.at),
  };
}
export function checkedPlanPause(
  p: ReturnType<typeof capturePlanPause>,
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  rows: {
    binding: Record<string, unknown> | undefined;
    project: Record<string, unknown> | undefined;
  },
) {
  planEqual(
    decodeConversation(rows.binding),
    p.q.binding,
    "project_text_plan_binding_changed",
  );
  const project = decodeCreativeProject(
    rows.project,
    p.owner.actor,
    plan.projectId,
  );
  if (
    project === null ||
    project.state !== "active" ||
    plan.bindingId !== p.q.binding.bindingId ||
    plan.projectId !== p.q.binding.projectId ||
    plan.threadId !== p.q.binding.threadId
  )
    planStoreFail("project_text_plan_binding_changed");
  if (
    plan.revision !== p.expectedRevision ||
    step.revision !== p.expectedStepRevision
  )
    planStoreFail("project_text_plan_revision_conflict");
  return checkpointProjectTextPlanSystemPause(
    plan,
    step,
    p.reason,
    p.at,
    creativeStoreDigester,
  );
}
