import { createHash } from "node:crypto";
import {
  assertProjectAssetStageToolRequest,
  creativeProjectOpaqueId,
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmission,
  parseProjectAssetStageRunAdmission,
  validateToolExecutionReceipt,
  type InstalledPluginPackage,
  type PluginSelection,
  type PluginTaskAdmission,
  type ProjectAssetStageRunAdmission,
  type RunState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type { ProjectToolInstallationPin } from "./creative-project-run-commit-authority.ts";
import type { ProjectAssetCommitAuthority } from "./project-asset-commit-authority.ts";
import {
  parseProjectAssetMutationCommand,
  type ProjectAssetMutationCommand,
  type ProjectAssetMutationKind,
  type SaveProjectAssetCandidateCommand,
} from "./project-asset-commands.ts";
import {
  projectAssetAuthorityCopy,
  projectAssetAuthorityDenied,
  projectAssetAuthorityFields,
  projectAssetInstallationEvidence,
} from "./project-asset-qualification-data.ts";

/** Separate from all text/plan/UI qualifications. Only the actual dispatched candidate command can write. */
export type ProjectAssetRunCommitTransactionAuthority = Readonly<{
  version: "crewon.project-asset-run-commit.v1";
  actor: ActorContext;
  run: RunState;
  receipt: ToolExecutionReceiptState;
  claim: WorkItemClaim;
  commandInput: string;
  operationId: "asset_save";
  installation: ProjectToolInstallationPin;
  admission: PluginTaskAdmission;
  assetStageAdmission: ProjectAssetStageRunAdmission;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** Real dispatch/profile/PDP only; no nested parent Store borrow. */
  assertCurrent(): Promise<void>;
}>;
const sha = Object.freeze({
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
});
export function captureProjectAssetRunCommitTransaction(
  input: unknown,
): ProjectAssetRunCommitTransactionAuthority {
  const v = projectAssetAuthorityFields(input, [
    "version",
    "actor",
    "run",
    "receipt",
    "claim",
    "commandInput",
    "operationId",
    "installation",
    "admission",
    "assetStageAdmission",
    "selection",
    "package",
    "assertCurrent",
  ]);
  if (
    v.version !== "crewon.project-asset-run-commit.v1" ||
    v.operationId !== "asset_save" ||
    typeof v.assertCurrent !== "function" ||
    typeof v.commandInput !== "string" ||
    Buffer.byteLength(v.commandInput, "utf8") > 24 * 1024
  )
    projectAssetAuthorityDenied();
  const evidence = projectAssetInstallationEvidence(v);
  const run = projectAssetAuthorityCopy(v.run) as RunState,
    receipt = projectAssetAuthorityCopy(v.receipt) as ToolExecutionReceiptState;
  const claim = projectAssetAuthorityCopy(v.claim) as WorkItemClaim,
    admission = parsePluginTaskAdmission(
      projectAssetAuthorityCopy(v.admission),
    );
  const stage = parseProjectAssetStageRunAdmission(
    projectAssetAuthorityCopy(v.assetStageAdmission),
    sha,
  );
  validateToolExecutionReceipt(receipt);
  if (
    run === null ||
    typeof run !== "object" ||
    Array.isArray(run) ||
    claim === null ||
    typeof claim !== "object" ||
    claim.workItem === null ||
    typeof claim.workItem !== "object" ||
    claim.lease === null ||
    typeof claim.lease !== "object"
  )
    projectAssetAuthorityDenied();
  for (const key of [
    "runId",
    "threadId",
    "authorityId",
    "runtimeGeneration",
    "agentVersionId",
    "policySnapshotId",
    "createdByActorId",
  ] as const)
    creativeProjectOpaqueId(run[key]);
  if (run.workspaceBindingId !== null)
    creativeProjectOpaqueId(run.workspaceBindingId);
  if (
    (run.status !== "running" &&
      !(
        run.status === "reconciling" &&
        run.reconciliationReceiptId === receipt.receiptId &&
        receipt.status === "unknownOutcome"
      )) ||
    run.cancelRequested !== false ||
    run.tenantId !== evidence.actor.tenantId ||
    run.spaceId !== evidence.actor.spaceId ||
    run.createdByActorId !== evidence.actor.actorId ||
    receipt.tenantId !== run.tenantId ||
    receipt.runId !== run.runId ||
    (receipt.status !== "dispatched" && receipt.status !== "unknownOutcome") ||
    receipt.effect !== "mutation" ||
    receipt.recovery !== "reconcilable" ||
    receipt.actionIntent === null ||
    receipt.call.name !==
      extensionToolName(evidence.installation.pluginId, "asset_save") ||
    receipt.actionIntent.capability !== "project.asset.write" ||
    receipt.actionIntent.executionTarget.kind !== "control" ||
    receipt.actionIntent.policySnapshotId !== run.policySnapshotId ||
    receipt.actionIntent.workspaceBindingId !== run.workspaceBindingId ||
    receipt.call.inputDigest !== sha.sha256(v.commandInput) ||
    claim.workItem.tenantId !== run.tenantId ||
    claim.workItem.runId !== run.runId ||
    claim.workItem.workItemId !== receipt.workItemId ||
    !Number.isSafeInteger(claim.lease.epoch) ||
    claim.lease.epoch < 1 ||
    !Number.isFinite(Date.parse(claim.lease.expiresAt)) ||
    admission.action !== "project.execute" ||
    admission.runId !== run.runId ||
    admission.threadId !== run.threadId ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) => admission[key] !== evidence.actor[key],
    ) ||
    (
      Object.keys(evidence.installation) as (keyof ProjectToolInstallationPin)[]
    ).some((key) => admission[key] !== evidence.installation[key]) ||
    stage.runId !== run.runId ||
    stage.threadId !== run.threadId ||
    extensionCanonicalJson(stage.actor) !==
      extensionCanonicalJson(evidence.actor) ||
    extensionCanonicalJson(stage.installation) !==
      extensionCanonicalJson(evidence.installation) ||
    stage.pluginTaskAdmissionDigest !==
      sha.sha256(extensionCanonicalJson(admission)) ||
    stage.extensionBindingDigest !== admission.extensionBindingDigest ||
    stage.requestDigest !== admission.requestDigest ||
    stage.idempotencyKey !== admission.idempotencyKey
  )
    projectAssetAuthorityDenied();
  creativeProjectOpaqueId(claim.lease.ownerId);
  creativeProjectOpaqueId(claim.lease.leaseId);
  const current = v.assertCurrent.bind(input);
  const transaction: ProjectAssetRunCommitTransactionAuthority = Object.freeze({
    version: "crewon.project-asset-run-commit.v1",
    ...evidence,
    run,
    receipt,
    claim,
    admission,
    assetStageAdmission: stage,
    operationId: "asset_save",
    commandInput: v.commandInput,
    assertCurrent: async () => {
      if ((await current()) !== undefined) projectAssetAuthorityDenied();
    },
  });
  projectAssetRunMutationCommand(transaction, sha);
  return transaction;
}
export function deriveProjectAssetToolMutationIdempotencyKey(
  q: ProjectAssetRunCommitTransactionAuthority,
  digester: ContentDigester,
): string {
  const digest = digester.sha256(
    extensionCanonicalJson({
      version: q.version,
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
      receiptId: q.receipt.receiptId,
      executionId: q.receipt.executionId,
      actionDigest: q.receipt.actionDigest,
      operationId: q.operationId,
    }),
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) projectAssetAuthorityDenied();
  return `project-asset-tool:${digest.slice(7)}`;
}
/** Only optional null fields are normalized; identity and actual raw input are never replaced. */
export function projectAssetRunMutationCommand(
  q: ProjectAssetRunCommitTransactionAuthority,
  digester: ContentDigester,
): SaveProjectAssetCandidateCommand {
  const raw: unknown = JSON.parse(q.commandInput);
  const v = projectAssetAuthorityFields(raw, [
    "projectId",
    "kind",
    "expectedAssetRevision",
    "briefRevision",
    "content",
    ...(raw !== null && typeof raw === "object" && Object.hasOwn(raw, "assetId")
      ? ["assetId"]
      : []),
    ...(raw !== null && typeof raw === "object" && Object.hasOwn(raw, "script")
      ? ["script"]
      : []),
  ]);
  const command = parseProjectAssetMutationCommand("save-content", {
    ...v,
    assetId: v.assetId ?? null,
    script: v.script ?? null,
    idempotencyKey: deriveProjectAssetToolMutationIdempotencyKey(q, digester),
  }) as SaveProjectAssetCandidateCommand;
  assertProjectAssetStageToolRequest(
    q.assetStageAdmission,
    q.operationId,
    command,
  );
  return command;
}
export function assertProjectAssetRunMutationCommand(
  authority: ProjectAssetCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectAssetMutationKind,
  command: ProjectAssetMutationCommand,
  digester: ContentDigester,
): void {
  const q = authority?.runTransaction;
  if (q === undefined) return;
  const expected = projectAssetRunMutationCommand(q, digester);
  if (
    kind !== "save-content" ||
    extensionCanonicalJson(actor) !== extensionCanonicalJson(q.actor) ||
    extensionCanonicalJson(command) !== extensionCanonicalJson(expected)
  )
    projectAssetAuthorityDenied();
}
