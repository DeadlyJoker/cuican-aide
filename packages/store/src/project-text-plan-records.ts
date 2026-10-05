import { captureProjectTextPlanCommitAuthority } from "@crewon/application";
import type {
  ProjectTextPlanStore,
  ProjectTextPlanCommitAuthority,
  ProjectTextPlanOwner,
  ProjectTextPlanReceipt,
  ProjectTextPlanMutation,
} from "@crewon/application";
import {
  projectTextRecord,
  projectTextPlanEnvelopeRecord,
  projectTextOpaqueId,
  creativeProjectRevision,
  creativeProjectDigest,
  validateCreativeProjectActor,
  parseProjectTextPlan,
  parseProjectTextPlanRevision,
  parseProjectTextPlanStep,
  parseProjectTextPlanRunAdmission,
  parseProjectTextPlanDelegation,
  parseProjectConversationBinding,
  parsePluginSelection,
  parseInstalledPluginPackage,
  extensionCanonicalJson,
  type ProjectTextPlan,
  type ProjectTextPlanRevision,
  type ProjectTextPlanStep,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";

export function planStoreFail(
  code = "project_text_plan_store_result_invalid",
): never {
  throw new Error(code);
}
export const planJson = (v: unknown): unknown =>
  typeof v === "string" ? JSON.parse(v) : v;
export function planEqual(
  a: unknown,
  b: unknown,
  code = "project_text_plan_store_result_invalid",
): void {
  if (extensionCanonicalJson(a) !== extensionCanonicalJson(b))
    planStoreFail(code);
}
export function planOwner(input: unknown): ProjectTextPlanOwner {
  const v = projectTextRecord(input, ["actor", "profileId"]);
  return Object.freeze({
    actor: validateCreativeProjectActor(v.actor),
    profileId: projectTextOpaqueId(v.profileId),
  });
}
export const planOwnerValues = (o: ProjectTextPlanOwner) =>
  [
    o.actor.tenantId,
    o.actor.spaceId,
    o.actor.principalId,
    o.actor.actorId,
    o.profileId,
  ] as const;
export const planOwnerWhere =
  "tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND profile_id=?";
export const planScope = (p: ProjectTextPlan) =>
  [p.owner.tenantId, p.owner.spaceId, p.planId] as const;
export const planColumns =
  "tenant_id,space_id,principal_id,actor_id,profile_id,plan_id,project_id,thread_id,binding_id,revision,current_plan_revision,state,active_step_id,wake_revision,record_json";
export const planValues = (p: ProjectTextPlan) =>
  [
    ...planOwnerValues({ actor: p.owner, profileId: p.profileId }),
    p.planId,
    p.projectId,
    p.threadId,
    p.bindingId,
    p.revision,
    p.currentPlanRevision,
    p.state,
    p.activeStepId,
    p.wakeRevision,
    JSON.stringify(p),
  ] as const;
export const planStepColumns =
  "tenant_id,space_id,plan_id,plan_revision,step_id,ordinal,kind,episode_id,attempt,revision,state,record_json";
export const planStepValues = (p: ProjectTextPlan, s: ProjectTextPlanStep) =>
  [
    ...planScope(p),
    s.planRevision,
    s.stepId,
    s.ordinal,
    s.kind,
    s.episodeId,
    s.attempt,
    s.revision,
    s.state,
    JSON.stringify(s),
  ] as const;
export function decodePlan(
  row: Record<string, unknown> | undefined | null,
  owner?: ProjectTextPlanOwner,
): ProjectTextPlan | null {
  if (row == null) return null;
  const p = parseProjectTextPlan(
      planJson(row.record_json),
      creativeStoreDigester,
    ),
    values = planValues(p);
  if (
    planColumns
      .split(",")
      .slice(0, -1)
      .some((k, i) =>
        row[k] === null
          ? values[i] !== null
          : String(row[k]) !== String(values[i]),
      )
  )
    planStoreFail();
  if (owner) planEqual({ actor: p.owner, profileId: p.profileId }, owner);
  return p;
}
export function decodePlanRevision(
  row: Record<string, unknown> | undefined | null,
): ProjectTextPlanRevision | null {
  if (row == null) return null;
  const p = parseProjectTextPlanRevision(
    planJson(row.record_json),
    creativeStoreDigester,
  );
  if (
    row.tenant_id !== p.actor.tenantId ||
    row.space_id !== p.actor.spaceId ||
    row.plan_id !== p.planId ||
    String(row.plan_revision) !== String(p.planRevision)
  )
    planStoreFail();
  return p;
}
export function decodePlanStep(
  row: Record<string, unknown> | undefined | null,
  p: ProjectTextPlan,
): ProjectTextPlanStep | null {
  if (row == null) return null;
  const s = parseProjectTextPlanStep(
      planJson(row.record_json),
      creativeStoreDigester,
    ),
    v = planStepValues(p, s);
  if (
    planStepColumns
      .split(",")
      .slice(0, -1)
      .some((k, i) =>
        row[k] === null ? v[i] !== null : String(row[k]) !== String(v[i]),
      )
  )
    planStoreFail();
  return s;
}
export function decodePlanAdmission(
  row: Record<string, unknown> | undefined | null,
) {
  if (row == null) return null;
  const s = parseProjectTextPlanRunAdmission(
    planJson(row.record_json),
    creativeStoreDigester,
  );
  if (
    row.tenant_id !== s.actor.tenantId ||
    row.space_id !== s.actor.spaceId ||
    row.run_id !== s.runId ||
    row.plan_id !== s.planId ||
    String(row.plan_revision) !== String(s.planRevision) ||
    row.step_id !== s.stepId
  )
    planStoreFail();
  return s;
}
export function planReceipt(input: unknown): ProjectTextPlanReceipt {
  const v = projectTextRecord(input, [
    "actor",
    "idempotencyKey",
    "requestDigest",
  ]);
  return Object.freeze({
    actor: validateCreativeProjectActor(v.actor),
    idempotencyKey: projectTextOpaqueId(v.idempotencyKey),
    requestDigest: creativeProjectDigest(v.requestDigest),
  });
}
export function decodePlanReceipt(
  row: Record<string, unknown> | undefined | null,
  o: ProjectTextPlanOwner,
  r: ProjectTextPlanReceipt,
): ProjectTextPlanMutation | null {
  if (row == null) return null;
  if (row.request_digest !== r.requestDigest)
    planStoreFail("project_text_plan_idempotency_conflict");
  const v = projectTextPlanEnvelopeRecord(planJson(row.result_json), [
      "kind",
      "disposition",
      "plan",
      "planRevision",
      "steps",
    ]),
    plan = parseProjectTextPlan(v.plan, creativeStoreDigester),
    revision = parseProjectTextPlanRevision(
      v.planRevision,
      creativeStoreDigester,
    );
  if (
    ![
      "start",
      "pause",
      "revoke",
      "resume",
      "reviseRemaining",
      "continue",
    ].includes(String(v.kind)) ||
    v.kind !== row.kind ||
    v.disposition !== "committed" ||
    !Array.isArray(v.steps) ||
    v.steps.length > 18 ||
    row.plan_id !== plan.planId ||
    row.idempotency_key !== r.idempotencyKey
  )
    planStoreFail();
  planEqual({ actor: plan.owner, profileId: plan.profileId }, o);
  if (
    planOwnerValues(o).some(
      (x, i) => row[planOwnerWhere.split(" AND ")[i]!.split("=")[0]!] !== x,
    )
  )
    planStoreFail();
  const steps = Object.freeze(
    v.steps.map((s) => parseProjectTextPlanStep(s, creativeStoreDigester)),
  );
  checkPlanStructure(plan, revision, steps);
  return Object.freeze({
    kind: v.kind as ProjectTextPlanMutation["kind"],
    disposition: "replayed",
    plan,
    planRevision: revision,
    steps,
  });
}
export const capturePlanAuthority = captureProjectTextPlanCommitAuthority;
export function planAuthorityOption(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    planStoreFail();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== 1 ||
    !("authority" in descriptors) ||
    !("value" in descriptors.authority!) ||
    descriptors.authority!.enumerable !== true ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    planStoreFail();
  return descriptors.authority!.value;
}
export function capturePlanControl(
  input: Parameters<ProjectTextPlanStore["commitControl"]>[0],
  options: Parameters<ProjectTextPlanStore["commitControl"]>[1],
) {
  const v = projectTextPlanEnvelopeRecord(input, [
      "kind",
      "plan",
      "expectedRevision",
      "planRevision",
      "steps",
      "receipt",
    ]),
    q = capturePlanAuthority(planAuthorityOption(options)),
    plan = parseProjectTextPlan(v.plan, creativeStoreDigester),
    revision = parseProjectTextPlanRevision(
      v.planRevision,
      creativeStoreDigester,
    ),
    expected = creativeProjectRevision(v.expectedRevision, { minimum: 0 }),
    receipt = planReceipt(v.receipt);
  if (
    ![
      "start",
      "pause",
      "revoke",
      "resume",
      "reviseRemaining",
      "continue",
    ].includes(String(v.kind)) ||
    !Array.isArray(v.steps) ||
    v.steps.length > 18 ||
    plan.revision !== expected + 1
  )
    planStoreFail();
  const steps = Object.freeze(
    v.steps.map((s) => parseProjectTextPlanStep(s, creativeStoreDigester)),
  );
  checkPlanStructure(plan, revision, steps);
  planEqual(plan.owner, q.actor);
  planEqual(receipt.actor, q.actor);
  planEqual(revision.installation, q.binding.currentInstallation);
  if (
    plan.projectId !== q.binding.projectId ||
    plan.threadId !== q.binding.threadId ||
    plan.bindingId !== q.binding.bindingId ||
    plan.profileId !== q.binding.profileId ||
    plan.workspaceId !== q.binding.workspaceId ||
    revision.bindingRevision !== q.binding.revision
  )
    planStoreFail("project_text_plan_binding_changed");
  if (
    v.kind === "start" ||
    v.kind === "resume" ||
    v.kind === "reviseRemaining"
  ) {
    if (q.delegation === null)
      planStoreFail("project_text_plan_delegation_required");
    planEqual(q.delegation, revision.delegation);
  } else if (q.delegation !== null) planStoreFail();
  return Object.freeze({
    kind: v.kind as ProjectTextPlanMutation["kind"],
    plan,
    revision,
    steps,
    expected,
    receipt,
    q,
  });
}
export function checkPlanStructure(
  p: ProjectTextPlan,
  r: ProjectTextPlanRevision,
  steps: readonly ProjectTextPlanStep[],
): void {
  planEqual(p.owner, r.actor);
  if (
    p.planId !== r.planId ||
    p.currentPlanRevision !== r.planRevision ||
    p.profileId !== r.installation.profileId ||
    p.projectId !== r.projectId ||
    p.threadId !== r.threadId ||
    p.bindingId !== r.bindingId ||
    p.workspaceId !== r.workspaceId ||
    steps.length === 0 ||
    steps.length > 18 ||
    new Set(steps.map((s) => s.stepId)).size !== steps.length ||
    steps.some(
      (s, i) =>
        s.planId !== p.planId ||
        s.planRevision !== r.planRevision ||
        s.ordinal !== i + 1,
    ) ||
    (p.activeStepId !== null && !steps.some((s) => s.stepId === p.activeStepId))
  )
    planStoreFail();
}
export function planRead(input: unknown, fields: readonly string[]) {
  const v = projectTextRecord(input, fields),
    o = planOwner({ actor: v.actor, profileId: v.profileId });
  return { v, o };
}
