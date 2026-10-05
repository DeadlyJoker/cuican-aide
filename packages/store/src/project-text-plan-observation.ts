import { normalizeStoredRunState } from "./stored-run-state.ts";
import type { ProjectTextPlanStore } from "@crewon/application";
import {
  checkpointProjectTextPlanTerminal,
  projectTextRecord,
  projectTextOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  type ProjectTextPlan,
  type ProjectTextPlanStep,
  type ProjectTextPlanRunAdmission,
  type RunState,
} from "@crewon/domain";
import {
  decodePostgresRunState,
  decodePostgresRunEvent,
  type PostgresRunRow,
  type PostgresRunEventRow,
} from "./postgres-run-codec.ts";
import { projectRunSnapshotQuery } from "./creative-project-run-commit-support.ts";
import {
  capturePlanAuthority,
  planAuthorityOption,
  planOwner,
  planEqual,
  planStoreFail,
  planJson,
} from "./project-text-plan-records.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";

export function capturePlanObservation(
  input: Parameters<ProjectTextPlanStore["commitObservation"]>[0],
  options: Parameters<ProjectTextPlanStore["commitObservation"]>[1],
) {
  const v = projectTextRecord(input, [
      "owner",
      "planId",
      "expectedRevision",
      "stepId",
      "expectedStepRevision",
      "run",
      "terminal",
      "at",
    ]),
    owner = planOwner(v.owner),
    q = capturePlanAuthority(planAuthorityOption(options)),
    run = structuredClone(v.run) as RunState;
  normalizeStoredRunState(run, "project_text_plan_observation_invalid");
  const t = projectTextRecord(v.terminal, [
    "eventId",
    "throughSequence",
    "runRevision",
    "status",
  ]);
  if (
    t.status !== "completed" &&
    t.status !== "failed" &&
    t.status !== "canceled"
  )
    planStoreFail();
  const terminal = Object.freeze({
    eventId: projectTextOpaqueId(t.eventId),
    throughSequence: creativeProjectRevision(t.throughSequence),
    runRevision: creativeProjectRevision(t.runRevision),
    status: t.status,
  });
  planEqual(owner.actor, q.actor);
  if (
    run.tenantId !== owner.actor.tenantId ||
    run.spaceId !== owner.actor.spaceId ||
    run.createdByActorId !== owner.actor.actorId
  )
    planStoreFail();
  return Object.freeze({
    owner,
    q,
    planId: projectTextOpaqueId(v.planId),
    expectedRevision: creativeProjectRevision(v.expectedRevision),
    stepId: projectTextOpaqueId(v.stepId),
    expectedStepRevision: creativeProjectRevision(v.expectedStepRevision),
    run,
    terminal,
    at: creativeProjectTimestamp(v.at),
  });
}
export function observationQueries(
  p: ReturnType<typeof capturePlanObservation>,
) {
  return {
    run: {
      sql: projectRunSnapshotQuery("").replaceAll(/\$[12]/gu, "?"),
      values: [p.owner.actor.tenantId, p.run.runId],
    },
    event: {
      sql: "SELECT * FROM run_events WHERE tenant_id=? AND run_id=? AND event_id=?",
      values: [p.owner.actor.tenantId, p.run.runId, p.terminal.eventId],
    },
    binding: {
      sql: "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
      values: [
        p.owner.actor.tenantId,
        p.owner.actor.spaceId,
        p.q.binding.bindingId,
      ],
    },
  };
}
export function checkPlanObservation(
  p: ReturnType<typeof capturePlanObservation>,
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  rows: {
    run: Record<string, unknown> | undefined;
    event: Record<string, unknown> | undefined;
    binding: Record<string, unknown> | undefined;
  },
  admission: ProjectTextPlanRunAdmission | null,
  steps: readonly ProjectTextPlanStep[],
) {
  if (
    rows.run === undefined ||
    rows.event === undefined ||
    admission === null ||
    step.run?.runId !== p.run.runId ||
    step.run.planAdmissionDigest !== admission.contentDigest ||
    plan.planId !== admission.planId ||
    step.stepId !== admission.stepId ||
    plan.threadId !== p.run.threadId
  )
    planStoreFail("project_text_plan_observation_invalid");
  const run = decodePostgresRunState(
      {
        ...rows.run,
        state_json: planJson(rows.run.state_json),
      } as unknown as PostgresRunRow,
      { tenantId: p.run.tenantId, runId: p.run.runId },
    ),
    event = decodePostgresRunEvent(
      {
        ...rows.event,
        event_json: planJson(rows.event.event_json),
      } as unknown as PostgresRunEventRow,
      { tenantId: p.run.tenantId, runId: p.run.runId },
    );
  planEqual(run, p.run, "project_text_plan_observation_invalid");
  if (
    run.status !== p.terminal.status ||
    run.revision !== p.terminal.runRevision ||
    run.lastSequence !== p.terminal.throughSequence ||
    event.type !== `run.${p.terminal.status}` ||
    event.sequence !== p.terminal.throughSequence
  )
    planStoreFail("project_text_plan_observation_invalid");
  planEqual(
    decodeConversation(rows.binding),
    p.q.binding,
    "project_text_plan_binding_changed",
  );
  planEqual({ actor: plan.owner, profileId: plan.profileId }, p.owner);
  planEqual(
    admission.installation,
    p.q.binding.currentInstallation,
    "project_text_plan_installation_changed",
  );
  if (step.terminal !== null) {
    planEqual(
      step.terminal,
      p.terminal,
      "project_text_plan_observation_invalid",
    );
    return Object.freeze({ plan, step });
  }
  if (
    plan.revision !== p.expectedRevision ||
    step.revision !== p.expectedStepRevision
  )
    planStoreFail("project_text_plan_revision_conflict");
  return checkpointProjectTextPlanTerminal(
    plan,
    step,
    p.terminal,
    steps,
    p.at,
    creativeStoreDigester,
  );
}
