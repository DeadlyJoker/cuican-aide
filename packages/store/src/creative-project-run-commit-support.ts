import {
  projectToolRunMutationCommand,
  type ActorContext,
  type CreativeProjectCommitAuthority,
  type CreativeProjectMutationKind,
  type CreativeProjectMutationReceipt,
  type CreativeProjectRunCommitTransactionAuthority,
  type ProjectTextMutationKind,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  extensionCanonicalJson,
  extensionToolName,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type RunAttemptState,
  type RunState,
  type RunStepState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import { extensionStoreDigester } from "./extension-store-records.ts";

export type ProjectRunQualification =
  CreativeProjectRunCommitTransactionAuthority;
export function projectRunCommitQualification(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: CreativeProjectMutationKind | ProjectTextMutationKind,
  receipt: CreativeProjectMutationReceipt,
): ProjectRunQualification | undefined {
  const q = authority?.runTransaction;
  if (q === undefined) return undefined;
  const command = projectToolRunMutationCommand(q, extensionStoreDigester);
  if (
    extensionCanonicalJson(actor) !== extensionCanonicalJson(q.actor) ||
    kind !== command.kind ||
    receipt.idempotencyKey !== command.receipt.idempotencyKey ||
    receipt.requestDigest !== command.receipt.requestDigest ||
    extensionStoreDigester.sha256(q.commandInput) !==
      q.receipt.call.inputDigest ||
    q.receipt.call.name !==
      extensionToolName(q.installation.pluginId, q.operationId) ||
    q.receipt.actionIntent?.capability !== "project.write" ||
    q.receipt.actionDigest !==
      extensionStoreDigester.sha256(
        canonicalActionIntent(q.receipt.actionIntent),
      )
  )
    denied();
  return q;
}

const fixedRun = [
  "runId",
  "threadId",
  "tenantId",
  "spaceId",
  "createdByActorId",
  "authorityId",
  "runtimeGeneration",
  "agentVersionId",
  "policySnapshotId",
  "workspaceBindingId",
] as const;
const fixedReceipt = [
  "schemaVersion",
  "receiptId",
  "tenantId",
  "runId",
  "stepId",
  "attemptId",
  "workItemId",
  "executionId",
  "idempotencyKey",
  "actionDigest",
  "actionIntent",
  "call",
  "effect",
  "recovery",
  "preparedAt",
] as const;

/** All records below have been decoded from the caller's actual transaction connection. */
export function assertProjectRunExecution(
  q: ProjectRunQualification,
  facts: Readonly<{
    run: RunState | null;
    receipt: ToolExecutionReceiptState | null;
    step: RunStepState | null;
    originalAttempt: RunAttemptState | null;
    currentAttempt: RunAttemptState | null;
    admission: PluginTaskAdmission | null;
    binding: unknown;
    configuration: unknown;
  }>,
): void {
  const { run, receipt, step, originalAttempt, currentAttempt, admission } =
    facts;
  if (
    run === null ||
    receipt === null ||
    step === null ||
    originalAttempt === null ||
    currentAttempt === null ||
    admission === null ||
    fixedRun.some((key) => run[key] !== q.run[key]) ||
    run.cancelRequested ||
    (run.status !== "running" &&
      !(
        run.status === "reconciling" &&
        run.reconciliationReceiptId === receipt.receiptId &&
        receipt.status === "unknownOutcome"
      )) ||
    fixedReceipt.some(
      (key) =>
        extensionCanonicalJson(receipt[key]) !==
        extensionCanonicalJson(q.receipt[key]),
    ) ||
    (receipt.status !== "dispatched" && receipt.status !== "unknownOutcome") ||
    step.kind !== "tool" ||
    step.status !== "running" ||
    step.currentAttemptId !== currentAttempt.attemptId ||
    [originalAttempt, currentAttempt].some(
      (attempt) =>
        attempt.tenantId !== q.actor.tenantId ||
        attempt.runId !== run.runId ||
        attempt.stepId !== receipt.stepId ||
        attempt.workItemId !== receipt.workItemId,
    ) ||
    originalAttempt.attemptId !== receipt.attemptId ||
    currentAttempt.status !== "running" ||
    currentAttempt.leaseEpoch !== q.claim.lease.epoch ||
    extensionCanonicalJson(admission) !== extensionCanonicalJson(q.admission)
  )
    denied();
  const binding = parseExtensionRunBinding(
    facts.binding,
    extensionStoreDigester,
  );
  const config = parseExtensionConfiguration(
    facts.configuration,
    extensionStoreDigester,
  );
  if (
    binding.bindingDigest !== admission.extensionBindingDigest ||
    binding.runId !== run.runId ||
    binding.threadId !== run.threadId ||
    binding.actorId !== run.createdByActorId ||
    binding.tenantId !== run.tenantId ||
    binding.spaceId !== run.spaceId ||
    binding.pluginId !== q.installation.pluginId ||
    binding.target.authorityId !== run.authorityId ||
    binding.target.runtimeGeneration !== run.runtimeGeneration ||
    binding.target.agentVersionId !== run.agentVersionId ||
    binding.target.policySnapshotId !== run.policySnapshotId ||
    binding.target.workspaceBindingId !== run.workspaceBindingId ||
    config.tenantId !== binding.tenantId ||
    config.spaceId !== binding.spaceId ||
    config.pluginId !== binding.pluginId ||
    config.pluginVersion !== admission.version ||
    config.revision !== binding.configurationRevision ||
    config.contentDigest !== binding.configurationDigest
  )
    denied();
}

/** A scheduling lease is necessary but never replaces the actor, Tool or installation checks. */
export function assertProjectRunQueue(
  q: ProjectRunQualification,
  row: Record<string, unknown> | undefined,
  now: number,
): void {
  if (row === undefined) denied();
  const expires =
    row.lease_expires_at_ms === undefined
      ? row.lease_expires_at instanceof Date
        ? row.lease_expires_at.getTime()
        : Date.parse(String(row.lease_expires_at))
      : Number(row.lease_expires_at_ms);
  const work: unknown =
    typeof row.work_item_json === "string"
      ? JSON.parse(row.work_item_json)
      : row.work_item_json;
  if (work === null || typeof work !== "object" || Array.isArray(work))
    denied();
  const item = work as Record<string, unknown>;
  if (
    row.tenant_id !== q.actor.tenantId ||
    row.run_id !== q.run.runId ||
    row.work_item_id !== q.receipt.workItemId ||
    row.kind !== "run.execute" ||
    row.status !== "leased" ||
    row.lease_owner_id !== q.claim.lease.ownerId ||
    row.lease_id !== q.claim.lease.leaseId ||
    Number(row.lease_epoch) !== q.claim.lease.epoch ||
    !Number.isFinite(expires) ||
    !Number.isFinite(now) ||
    expires <= now ||
    expires < Date.parse(q.claim.lease.expiresAt) ||
    item.workItemId !== row.work_item_id ||
    item.tenantId !== row.tenant_id ||
    item.runId !== row.run_id ||
    item.kind !== row.kind ||
    extensionCanonicalJson(item) !== extensionCanonicalJson(q.claim.workItem)
  )
    denied();
}

export function projectRunReceiptLocator(q: ProjectRunQualification) {
  const {
    tenantId,
    spaceId,
    profileId,
    pluginId,
    principalId,
    actorId,
    idempotencyKey,
  } = q.admission;
  return {
    tenantId,
    spaceId,
    profileId,
    pluginId,
    principalId,
    actorId,
    idempotencyKey,
  };
}
export const projectRunBindingQuery = (
  prefix: string,
) => `SELECT b.binding_json,c.configuration_json
  FROM ${prefix}extension_run_bindings b JOIN ${prefix}extension_configurations c
  ON c.tenant_id=b.tenant_id AND c.space_id=b.space_id AND c.plugin_id=b.plugin_id AND c.revision=b.configuration_revision
  WHERE b.tenant_id=$1 AND b.run_id=$2`;
export const projectRunSnapshotQuery = (
  prefix: string,
) => `SELECT s.*,b.thread_id FROM ${prefix}run_snapshots s
  LEFT JOIN ${prefix}run_thread_bindings b ON b.tenant_id=s.tenant_id AND b.run_id=s.run_id
  WHERE s.tenant_id=$1 AND s.run_id=$2`;
export function projectRunJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
export function denied(): never {
  throw new Error("creative_project_run_commit_not_current");
}
