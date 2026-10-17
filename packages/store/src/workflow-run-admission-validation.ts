import { createHash } from "node:crypto";
import {
  RunStoreError,
  canonicalJson as stableJson,
  validateWorkflowRunInput,
  type CommitWorkflowRunStartInput,
  type WorkflowRunAdmissionAuthority,
  type WorkflowRunInputAuthority,
  type WorkItem,
} from "@crewon/application";
import {
  parseCompiledWorkflowVersion,
  validateWorkflowSchemaValue,
  type CompiledWorkflowVersion,
} from "@crewon/domain";
import { validateWorkItems } from "./store-invariants.ts";

export const workflowAdmissionDigest = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

export function validateWorkflowAdmissionInput(
  input: CommitWorkflowRunStartInput,
): void {
  for (const value of [
    input.tenantId,
    input.spaceId,
    input.threadId,
    input.workflowVersionId,
    input.idempotency?.key,
  ])
    boundedIdentity(value);
  for (const [value, maximum] of [
    [input.idempotency?.scope, 4_096],
    [input.idempotency?.requestFingerprint, 131_072],
  ] as const)
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > maximum
    )
      throw new RunStoreError("workflow_run_admission_input_invalid");
  if (typeof input.prepare !== "function")
    throw new RunStoreError("workflow_run_admission_input_invalid");
  validateWorkflowRunInput(input.workflowInput);
}

export function validateWorkflowAdmissionAuthority(
  input: Pick<
    CommitWorkflowRunStartInput,
    "tenantId" | "workflowVersionId" | "workflowInput"
  >,
  authority: WorkflowRunAdmissionAuthority,
): CompiledWorkflowVersion {
  const asset = authority.workflowVersion;
  const workflow = parseCompiledWorkflowVersion(
    asset.definitionJson,
    workflowAdmissionDigest,
  );
  if (
    asset.schemaVersion !== "crewon.workflow-version-asset.v0" ||
    asset.tenantId !== input.tenantId ||
    asset.workflowVersionId !== input.workflowVersionId ||
    asset.workflowVersionId !== workflow.workflowVersionId ||
    asset.workflowId !== workflow.workflowId ||
    asset.contentDigest !== workflow.contentDigest ||
    !Number.isFinite(Date.parse(asset.createdAt))
  )
    throw new RunStoreError("workflow_run_authority_invalid");
  validateWorkflowSchemaValue(input.workflowInput, workflow.inputSchema);
  const route = authority.route;
  if (
    Object.keys(route).sort().join(",") !==
    "agentVersionId,authorityId,policySnapshotId,runtimeGeneration,workspaceBindingId"
  )
    throw new RunStoreError("workflow_run_authority_invalid");
  for (const value of [
    route.authorityId,
    route.agentVersionId,
    route.runtimeGeneration,
    route.policySnapshotId,
  ])
    boundedIdentity(value);
  if (route.workspaceBindingId !== null)
    boundedIdentity(route.workspaceBindingId);
  return workflow;
}

export function validateWorkflowAdmissionPreparation(
  input: CommitWorkflowRunStartInput,
  authority: WorkflowRunAdmissionAuthority,
  prepared: ReturnType<CommitWorkflowRunStartInput["prepare"]>,
): void {
  const { commit, workflowInputValue } = prepared;
  const event = commit.events[0];
  const binding = {
    workflowId: authority.workflowVersion.workflowId,
    workflowVersionId: authority.workflowVersion.workflowVersionId,
    contentDigest: authority.workflowVersion.contentDigest,
  };
  if (
    commit.tenantId !== input.tenantId ||
    commit.expectedRevision !== 0 ||
    commit.threadAdmission !== undefined ||
    stableJson(commit.idempotency) !== stableJson(input.idempotency) ||
    commit.events.length !== 1 ||
    event?.type !== "run.created" ||
    event.sequence !== 1 ||
    event.data.tenantId !== input.tenantId ||
    event.data.spaceId !== input.spaceId ||
    event.data.threadId !== input.threadId ||
    event.data.purpose !== "workflow" ||
    event.data.goalBinding !== null ||
    event.data.collaborationMode !== "default" ||
    stableJson(event.data.workflowVersionBinding) !== stableJson(binding) ||
    Object.entries(authority.route).some(
      ([key, value]) =>
        (event.data as unknown as Record<string, unknown>)[key] !== value,
    ) ||
    commit.workItems.length !== 1 ||
    commit.outbox.length !== 1
  )
    throw new RunStoreError("workflow_run_preparation_invalid");
  validateWorkflowInputAuthority(workflowInputValue);
  if (stableJson(workflowInputValue.value) !== stableJson(input.workflowInput))
    throw new RunStoreError("workflow_run_input_mismatch");
  const work = commit.workItems[0]!;
  const notification = commit.outbox[0]!;
  if (
    stableJson(work.payload.binding) !== stableJson(binding) ||
    stableJson(work.payload.workflowInput) !==
      stableJson({
        valueId: workflowInputValue.valueId,
        valueDigest: workflowInputValue.valueDigest,
      }) ||
    work.createdAt !== event.occurredAt ||
    notification.createdAt !== event.occurredAt ||
    notification.topic !== "run.updated" ||
    stableJson(notification.payload) !==
      stableJson({
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: 1,
      })
  )
    throw new RunStoreError("workflow_run_preparation_invalid");
  validateWorkflowSchedulerWorkItems(
    commit.workItems,
    event.identity.runId,
    input.tenantId,
    () => false,
  );
}

/** Separate from ordinary admission: untrusted commitRun callers cannot select this payload. */
export function validateWorkflowSchedulerWorkItems(
  items: readonly WorkItem[],
  runId: string,
  tenantId: string,
  exists: (id: string) => boolean,
): void {
  for (const item of items) {
    const payload = item.payload;
    const withReview =
      payload.schemaVersion === "crewon.workflow-scheduler-work-item.v2";
    if (
      Object.keys(payload).sort().join(",") !==
        (withReview
          ? "binding,reviewContext,schedulerOperationId,schemaVersion,trigger,workflowInput"
          : "binding,schedulerOperationId,schemaVersion,trigger,workflowInput") ||
      (!withReview &&
        payload.schemaVersion !== "crewon.workflow-scheduler-work-item.v1") ||
      payload.trigger !== "workflowScheduler"
    )
      throw new RunStoreError("workflow_scheduler_payload_invalid");
    if (withReview) {
      const review = payload.reviewContext as Record<string, unknown> | null;
      if (
        !review ||
        Array.isArray(review) ||
        Object.keys(review).sort().join() !==
          "gateRequestId,nodeId,receiptFingerprint" ||
        typeof review.receiptFingerprint !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(review.receiptFingerprint)
      )
        throw new RunStoreError("workflow_scheduler_payload_invalid");
      boundedIdentity(review.nodeId);
      boundedIdentity(review.gateRequestId);
    }
    boundedIdentity(payload.schedulerOperationId);
    const binding = payload.binding as Record<string, unknown> | null;
    const ref = payload.workflowInput as Record<string, unknown> | null;
    if (
      !binding ||
      Object.keys(binding).sort().join(",") !==
        "contentDigest,workflowId,workflowVersionId" ||
      !ref ||
      Object.keys(ref).sort().join(",") !== "valueDigest,valueId"
    )
      throw new RunStoreError("workflow_scheduler_payload_invalid");
    boundedIdentity(binding.workflowId);
    boundedIdentity(binding.workflowVersionId);
    boundedIdentity(ref.valueId);
    for (const digest of [binding.contentDigest, ref.valueDigest])
      if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest))
        throw new RunStoreError("workflow_scheduler_payload_invalid");
  }
  // Preserve the shared identity, uniqueness, timestamp and size validation.
  validateWorkItems(
    items.map((item) => ({ ...item, payload: { throughSequence: 1 } })),
    runId,
    tenantId,
    1,
    exists,
  );
  if (items.some((item) => Buffer.byteLength(stableJson(item)) > 65_536))
    throw new RunStoreError("work_item_too_large");
}

export function validateWorkflowInputAuthority(
  value: WorkflowRunInputAuthority,
): void {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "schemaVersion,value,valueDigest,valueId" ||
    value.schemaVersion !== "crewon.workflow-execution-value.v0"
  )
    throw new RunStoreError("workflow_run_input_invalid");
  boundedIdentity(value.valueId);
  validateWorkflowRunInput(value.value);
  if (
    workflowAdmissionDigest.sha256(stableJson(value.value)) !==
    value.valueDigest
  )
    throw new RunStoreError("workflow_run_input_digest_mismatch");
}

function boundedIdentity(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 512
  )
    throw new RunStoreError("workflow_run_admission_identity_invalid");
}
