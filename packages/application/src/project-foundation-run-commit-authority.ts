import { canonicalActionIntent } from "@crewon/contracts";
import {
  assertProjectFoundationToolRequest,
  PROJECT_FOUNDATION_RUN_OPERATIONS,
  type ProjectFoundationRunOperation,
  creativeProjectOpaqueId,
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmission,
  parseProjectFoundationRunAdmission,
  parseProjectStageRunAdmission,
  validateToolExecutionReceipt,
  type InstalledPluginPackage,
  type PluginSelection,
  type PluginTaskAdmission,
  type ProjectFoundationRunAdmission,
  type ProjectStageRunAdmission,
  type RunState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import {
  projectToolAuthorityContentDigest,
  type ProjectToolInstallationPin,
} from "./creative-project-run-commit-authority.ts";
import type { SaveProjectProposalCommand } from "./project-foundation-commands.ts";
import type { ProjectFoundationMutationCommand } from "./project-foundation-commands.ts";
import type {
  ProjectFoundationCommitAuthority,
  ProjectFoundationMutationKind,
} from "./project-foundation-store-port.ts";
import { foundationCommand } from "./project-foundation-application-support.ts";
import {
  projectAssetAuthorityCopy as copy,
  projectAssetAuthorityFields as fields,
  projectAssetInstallationEvidence as installationEvidence,
} from "./project-asset-qualification-data.ts";

/** Independent live Worker qualification. The old stage and UI pin cannot authorize this operation. */
export type ProjectFoundationRunCommitTransactionAuthority = Readonly<{
  version: "crewon.project-foundation-run-commit.v1";
  actor: ActorContext;
  run: RunState;
  receipt: ToolExecutionReceiptState;
  claim: WorkItemClaim;
  commandInput: string;
  operationId: "foundation_proposal_save";
  installation: ProjectToolInstallationPin;
  admission: PluginTaskAdmission;
  projectStageAdmission: ProjectStageRunAdmission;
  foundationAdmission: ProjectFoundationRunAdmission;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** External dispatch/profile/policy only. Never borrow the committing Store's connection. */
  assertCurrent(): Promise<void>;
}>;
/** Independent read evidence; never accepted by the proposal commit protocol. */
export type ProjectFoundationRunReadAuthority = Readonly<
  Omit<
    ProjectFoundationRunCommitTransactionAuthority,
    "version" | "operationId"
  > & {
    version: "crewon.project-foundation-run-read.v1";
    operationId: Exclude<
      ProjectFoundationRunOperation,
      "foundation_proposal_save"
    >;
  }
>;
const sha = Object.freeze({
  sha256: projectToolAuthorityContentDigest,
});

export function captureProjectFoundationRunCommitTransaction(
  input: unknown,
): ProjectFoundationRunCommitTransactionAuthority {
  return captureFoundationRunAuthority(
    input,
    "mutation",
  ) as ProjectFoundationRunCommitTransactionAuthority;
}
export function captureProjectFoundationRunReadAuthority(
  input: unknown,
): ProjectFoundationRunReadAuthority {
  return captureFoundationRunAuthority(
    input,
    "read",
  ) as ProjectFoundationRunReadAuthority;
}
function captureFoundationRunAuthority(
  input: unknown,
  purpose: "mutation" | "read",
):
  | ProjectFoundationRunCommitTransactionAuthority
  | ProjectFoundationRunReadAuthority {
  const mutation = purpose === "mutation";
  const version = mutation
    ? "crewon.project-foundation-run-commit.v1"
    : "crewon.project-foundation-run-read.v1";
  try {
    const v = fields(input, [
      "version",
      "actor",
      "run",
      "receipt",
      "claim",
      "commandInput",
      "operationId",
      "installation",
      "admission",
      "projectStageAdmission",
      "foundationAdmission",
      "selection",
      "package",
      "assertCurrent",
    ]);
    if (
      v.version !== version ||
      (mutation
        ? v.operationId !== "foundation_proposal_save"
        : !PROJECT_FOUNDATION_RUN_OPERATIONS.includes(
            v.operationId as ProjectFoundationRunOperation,
          ) || v.operationId === "foundation_proposal_save") ||
      typeof v.assertCurrent !== "function" ||
      typeof v.commandInput !== "string" ||
      Buffer.byteLength(v.commandInput, "utf8") > 24 * 1024
    )
      denied();
    const evidence = installationEvidence(v);
    const run = copy(v.run) as RunState;
    const receipt = copy(v.receipt) as ToolExecutionReceiptState;
    const claim = copy(v.claim) as WorkItemClaim;
    const admission = parsePluginTaskAdmission(copy(v.admission));
    const stage = parseProjectStageRunAdmission(
      copy(v.projectStageAdmission),
      sha,
    );
    const foundation = parseProjectFoundationRunAdmission(
      copy(v.foundationAdmission),
      sha,
    );
    validateToolExecutionReceipt(receipt);
    if (
      run === null ||
      typeof run !== "object" ||
      Array.isArray(run) ||
      claim === null ||
      typeof claim !== "object" ||
      Array.isArray(claim) ||
      claim.workItem === null ||
      typeof claim.workItem !== "object" ||
      claim.lease === null ||
      typeof claim.lease !== "object"
    )
      denied();
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
          mutation &&
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
      (receipt.status !== "dispatched" &&
        !(mutation && receipt.status === "unknownOutcome")) ||
      receipt.effect !== (mutation ? "mutation" : "readOnly") ||
      receipt.recovery !== (mutation ? "reconcilable" : "replaySafe") ||
      receipt.actionIntent === null ||
      receipt.call.name !==
        extensionToolName(
          evidence.installation.pluginId,
          v.operationId as ProjectFoundationRunOperation,
        ) ||
      receipt.actionIntent.capability !==
        (mutation ? "project.write" : "project.read") ||
      (!mutation &&
        (receipt.actionIntent.effect !== "readOnly" ||
          receipt.actionIntent.recovery !== "replaySafe")) ||
      receipt.actionIntent.executionTarget.kind !== "control" ||
      receipt.actionIntent.policySnapshotId !== run.policySnapshotId ||
      receipt.actionIntent.workspaceBindingId !== run.workspaceBindingId ||
      receipt.call.inputDigest !== sha.sha256(v.commandInput) ||
      receipt.actionDigest !==
        sha.sha256(canonicalActionIntent(receipt.actionIntent)) ||
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
        Object.keys(
          evidence.installation,
        ) as (keyof ProjectToolInstallationPin)[]
      ).some((key) => admission[key] !== evidence.installation[key]) ||
      stage.stage.kind !== "discussion" ||
      stage.runId !== run.runId ||
      stage.threadId !== run.threadId ||
      foundation.runId !== run.runId ||
      foundation.threadId !== run.threadId ||
      foundation.projectId !== stage.projectId ||
      foundation.bindingId !== stage.bindingId ||
      foundation.bindingRevision !== stage.bindingRevision ||
      foundation.workspaceId !== stage.workspaceId ||
      foundation.projectStageAdmissionDigest !== stage.contentDigest ||
      foundation.taskInputDigest !== stage.taskInputDigest ||
      foundation.userContentDigest !== stage.userContentDigest ||
      [stage, foundation].some(
        (record) =>
          extensionCanonicalJson(record.actor) !==
            extensionCanonicalJson(evidence.actor) ||
          extensionCanonicalJson(record.installation) !==
            extensionCanonicalJson(evidence.installation) ||
          record.pluginTaskAdmissionDigest !==
            sha.sha256(extensionCanonicalJson(admission)) ||
          record.extensionBindingDigest !== admission.extensionBindingDigest ||
          record.requestDigest !== admission.requestDigest ||
          record.idempotencyKey !== admission.idempotencyKey,
      )
    )
      denied();
    creativeProjectOpaqueId(claim.lease.ownerId);
    creativeProjectOpaqueId(claim.lease.leaseId);
    const current = v.assertCurrent.bind(input);
    const result = Object.freeze({
      version,
      ...evidence,
      run,
      receipt,
      claim,
      admission,
      projectStageAdmission: stage,
      foundationAdmission: foundation,
      operationId: v.operationId,
      commandInput: v.commandInput,
      assertCurrent: async () => {
        if ((await current()) !== undefined) denied();
      },
    });
    if (mutation)
      projectFoundationRunMutationCommand(
        result as ProjectFoundationRunCommitTransactionAuthority,
        sha,
      );
    else {
      const request: unknown = JSON.parse(result.commandInput);
      const copied = copy(request);
      if (
        copied === null ||
        typeof copied !== "object" ||
        Array.isArray(copied)
      )
        denied();
      assertProjectFoundationToolRequest(
        foundation,
        result.operationId as ProjectFoundationRunOperation,
        copied as Readonly<Record<string, unknown>>,
      );
    }
    return result as
      | ProjectFoundationRunCommitTransactionAuthority
      | ProjectFoundationRunReadAuthority;
  } catch (cause) {
    throw new Error(
      mutation
        ? "project_foundation_run_commit_authority_invalid"
        : "project_foundation_run_read_authority_invalid",
      {
        cause,
      },
    );
  }
}

/** Retry identity belongs to the exact original Tool receipt; plugins cannot choose it. */
export function deriveProjectFoundationToolMutationIdempotencyKey(
  q: ProjectFoundationRunCommitTransactionAuthority,
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
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) denied();
  return `project-foundation-tool:${digest.slice(7)}`;
}

export function projectFoundationRunMutationCommand(
  q: ProjectFoundationRunCommitTransactionAuthority,
  digester: ContentDigester,
): SaveProjectProposalCommand {
  const input: unknown = JSON.parse(q.commandInput);
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.hasOwn(input, "idempotencyKey")
  )
    denied();
  assertProjectFoundationToolRequest(
    q.foundationAdmission,
    q.operationId,
    input as Readonly<Record<string, unknown>>,
  );
  const command = foundationCommand("save-proposal", {
    ...input,
    idempotencyKey: deriveProjectFoundationToolMutationIdempotencyKey(
      q,
      digester,
    ),
  }) as SaveProjectProposalCommand;
  if (
    command.expectedFoundationRevision !==
    q.foundationAdmission.foundationRevision
  )
    denied();
  return command;
}

/** The Run may append its exact Tool proposal only; it cannot inherit the manual UI actions. */
export function qualifyProjectFoundationRunCommand(
  authority: ProjectFoundationCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectFoundationMutationKind,
  command: ProjectFoundationMutationCommand,
  digester: ContentDigester,
): void {
  const q = authority?.runTransaction;
  if (q === undefined) return;
  const captured = captureProjectFoundationRunCommitTransaction(q);
  if (
    authority?.transaction !== undefined ||
    kind !== "save-proposal" ||
    extensionCanonicalJson(actor) !== extensionCanonicalJson(captured.actor) ||
    extensionCanonicalJson(command) !==
      extensionCanonicalJson(
        projectFoundationRunMutationCommand(captured, digester),
      )
  )
    denied();
}
function denied(): never {
  throw new Error("project_foundation_run_commit_authority_invalid");
}
