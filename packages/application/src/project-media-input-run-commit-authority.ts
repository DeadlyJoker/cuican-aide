import { createHash } from "node:crypto";
import {
  assertProjectMediaInputStageToolRequest,
  creativeProjectOpaqueId,
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmission,
  parseProjectMediaInputStageRunAdmission,
  validateToolExecutionReceipt,
  type InstalledPluginPackage,
  type PluginSelection,
  type PluginTaskAdmission,
  type ProjectMediaInputStageRunAdmission,
  type RunState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type { ProjectToolInstallationPin } from "./creative-project-run-commit-authority.ts";
import { parseMediaInputToolCommand } from "@crewon/contracts/project-media-input-tools";
import { parseSaveProjectMediaInputCommand } from "./project-media-input-record.ts";
import type { SaveProjectMediaInputCommand } from "./project-media-input-port.ts";
import {
  projectAssetAuthorityCopy,
  projectAssetAuthorityDenied,
  projectAssetAuthorityFields,
  projectAssetInstallationEvidence,
} from "./project-asset-qualification-data.ts";

/** Independent Worker write authority for the actual dispatched media-input command; it grants no generation. */
export type ProjectMediaInputRunCommitTransactionAuthority = Readonly<{
  version: "crewon.project-media-input-run-commit.v1";
  actor: ActorContext;
  run: RunState;
  receipt: ToolExecutionReceiptState;
  claim: WorkItemClaim;
  commandInput: string;
  operationId: "media_input";
  installation: ProjectToolInstallationPin;
  admission: PluginTaskAdmission;
  mediaInputStageAdmission: ProjectMediaInputStageRunAdmission;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** Real dispatch/profile/PDP only; no nested parent Store borrow. */
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
const sha = Object.freeze({
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
});
export function captureProjectMediaInputRunCommitTransaction(
  input: unknown,
): ProjectMediaInputRunCommitTransactionAuthority {
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
    "mediaInputStageAdmission",
    "selection",
    "package",
    "assertCurrent",
    "assertActive",
  ]);
  if (
    v.version !== "crewon.project-media-input-run-commit.v1" ||
    v.operationId !== "media_input" ||
    typeof v.assertCurrent !== "function" ||
    typeof v.assertActive !== "function" ||
    typeof v.commandInput !== "string" ||
    Buffer.byteLength(v.commandInput, "utf8") > 32 * 1024
  )
    projectAssetAuthorityDenied();
  const evidence = projectAssetInstallationEvidence(v);
  const run = projectAssetAuthorityCopy(v.run) as RunState,
    receipt = projectAssetAuthorityCopy(v.receipt) as ToolExecutionReceiptState;
  const claim = projectAssetAuthorityCopy(v.claim) as WorkItemClaim,
    admission = parsePluginTaskAdmission(
      projectAssetAuthorityCopy(v.admission),
    );
  const stage = parseProjectMediaInputStageRunAdmission(
    projectAssetAuthorityCopy(v.mediaInputStageAdmission),
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
      extensionToolName(evidence.installation.pluginId, "media_input") ||
    receipt.actionIntent.capability !== "project.media-input.write" ||
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
  const current = v.assertCurrent.bind(input),
    assertActive = v.assertActive.bind(input);
  const active = () => {
    const result: unknown = assertActive();
    if (result === undefined) return;
    try {
      void Promise.prototype.then.call(
        result,
        () => undefined,
        () => undefined,
      );
    } catch {
      /* Reject non-void or asynchronous guards without invoking arbitrary thenables. */
    }
    projectAssetAuthorityDenied();
  };
  const transaction: ProjectMediaInputRunCommitTransactionAuthority =
    Object.freeze({
      version: "crewon.project-media-input-run-commit.v1",
      ...evidence,
      run,
      receipt,
      claim,
      admission,
      mediaInputStageAdmission: stage,
      operationId: "media_input",
      commandInput: v.commandInput,
      assertCurrent: async () => {
        active();
        if ((await current()) !== undefined) projectAssetAuthorityDenied();
        active();
      },
      assertActive: active,
    });
  projectMediaInputRunCommand(transaction, sha);
  return transaction;
}
export function deriveProjectMediaInputToolMutationIdempotencyKey(
  q: ProjectMediaInputRunCommitTransactionAuthority,
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
  return `project-media-input-tool:${digest.slice(7)}`;
}
/** Host-derived target and stable Tool receipt key; neither is supplied by the model. */
export function projectMediaInputRunCommand(
  q: ProjectMediaInputRunCommitTransactionAuthority,
  digester: ContentDigester,
): SaveProjectMediaInputCommand {
  const parsed = parseMediaInputToolCommand(JSON.parse(q.commandInput));
  if (parsed.method !== "saveInput") projectAssetAuthorityDenied();
  const { configurationRevision, ...request } = parsed.request;
  assertProjectMediaInputStageToolRequest(
    q.mediaInputStageAdmission,
    q.operationId,
    { method: parsed.method, ...parsed.request },
  );
  return parseSaveProjectMediaInputCommand({
    ...request,
    target: {
      profileId: q.installation.profileId,
      pluginId: q.installation.pluginId,
      configurationRevision,
    },
    idempotencyKey: deriveProjectMediaInputToolMutationIdempotencyKey(
      q,
      digester,
    ),
  });
}
export function assertProjectMediaInputRunCommand(
  q: ProjectMediaInputRunCommitTransactionAuthority | undefined,
  actor: ActorContext,
  command: SaveProjectMediaInputCommand,
): void {
  if (q === undefined) return;
  if (
    extensionCanonicalJson(q.actor) !== extensionCanonicalJson(actor) ||
    extensionCanonicalJson(command) !==
      extensionCanonicalJson(projectMediaInputRunCommand(q, sha))
  )
    projectAssetAuthorityDenied();
}
