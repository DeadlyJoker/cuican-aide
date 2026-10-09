import { canonicalActionIntent } from "@crewon/contracts";
import {
  assertProjectStageToolRequest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmission,
  parseProjectStageRunAdmission,
  validateToolExecutionReceipt,
  type InstalledPluginPackage,
  type PluginSelection,
  type PluginTaskAdmission,
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
import {
  parseProjectStructuredOutlineCommand,
  type SaveProjectStructuredOutlineCommand,
  type ProjectStructuredOutlineCommand,
  type ProjectStructuredOutlineMutationKind,
} from "./project-structured-outline-commands.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import {
  projectAssetAuthorityCopy as copy,
  projectAssetAuthorityFields as fields,
  projectAssetInstallationEvidence as installationEvidence,
} from "./project-asset-qualification-data.ts";

/** Independent live Worker qualification. A legacy Tool or an installation pin alone cannot authorize this operation. */
export type ProjectOutlineRunCommitTransactionAuthority = Readonly<{
  version: "crewon.project-outline-run-commit.v2";
  actor: ActorContext;
  run: RunState;
  receipt: ToolExecutionReceiptState;
  claim: WorkItemClaim;
  commandInput: string;
  operationId: "outline_change";
  installation: ProjectToolInstallationPin;
  admission: PluginTaskAdmission;
  projectStageAdmission: ProjectStageRunAdmission;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** External dispatch/profile/policy only. Never borrow the committing Store's connection. */
  assertCurrent(): Promise<void>;
}>;
const sha = Object.freeze({
  sha256: projectToolAuthorityContentDigest,
});

export function captureProjectOutlineRunCommitTransaction(
  input: unknown,
): ProjectOutlineRunCommitTransactionAuthority {
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
      "selection",
      "package",
      "assertCurrent",
    ]);
    if (
      v.version !== "crewon.project-outline-run-commit.v2" ||
      v.operationId !== "outline_change" ||
      typeof v.assertCurrent !== "function" ||
      typeof v.commandInput !== "string" ||
      Buffer.byteLength(v.commandInput, "utf8") > 60 * 1024
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
        receipt.status !== "unknownOutcome") ||
      receipt.effect !== "mutation" ||
      receipt.recovery !== "reconcilable" ||
      receipt.actionIntent === null ||
      receipt.call.name !==
        extensionToolName(evidence.installation.pluginId, "outline_change") ||
      receipt.actionIntent.capability !== "project.write" ||
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
      stage.stage.kind !== "outline" ||
      stage.runId !== run.runId ||
      stage.threadId !== run.threadId ||
      [stage].some(
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
    const result: ProjectOutlineRunCommitTransactionAuthority = Object.freeze({
      version: "crewon.project-outline-run-commit.v2",
      ...evidence,
      run,
      receipt,
      claim,
      admission,
      projectStageAdmission: stage,
      operationId: "outline_change",
      commandInput: v.commandInput,
      assertCurrent: async () => {
        if ((await current()) !== undefined) denied();
      },
    });
    projectOutlineRunMutationCommand(result, sha);
    return result;
  } catch (cause) {
    throw new Error("project_outline_run_commit_authority_invalid", {
      cause,
    });
  }
}

/** Retry identity belongs to the exact original Tool receipt; plugins cannot choose it. */
export function deriveProjectOutlineToolMutationIdempotencyKey(
  q: ProjectOutlineRunCommitTransactionAuthority,
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
  return `project-outline-tool:${digest.slice(7)}`;
}

export function projectOutlineRunMutationCommand(
  q: ProjectOutlineRunCommitTransactionAuthority,
  digester: ContentDigester,
): SaveProjectStructuredOutlineCommand {
  return projectOutlineRunMutation(q, digester).command;
}

/** Pin the Agent's observed Foundation without changing the manual UI command protocol. */
export function projectOutlineRunMutation(
  q: ProjectOutlineRunCommitTransactionAuthority,
  digester: ContentDigester,
) {
  const input: unknown = JSON.parse(q.commandInput);
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.hasOwn(input, "idempotencyKey")
  )
    denied();
  const { expectedFoundationRevision, ...mutation } = input as Record<
    string,
    unknown
  >;
  const foundationRevision = creativeProjectRevision(
    expectedFoundationRevision,
  );
  // The stage supplies project/brief scope only. A legacy outline_save receipt
  // cannot qualify this independently captured outline_change transaction.
  assertProjectStageToolRequest(
    q.projectStageAdmission,
    "outline_save",
    mutation,
  );
  const command = parseProjectStructuredOutlineCommand("save-outline", {
    ...mutation,
    idempotencyKey: deriveProjectOutlineToolMutationIdempotencyKey(q, digester),
  });
  return Object.freeze({
    command,
    expectedFoundationRevision: foundationRevision,
  });
}

/** The Run may append its exact candidate only; selection and locking remain user actions. */
export function qualifyProjectOutlineRunCommand(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectStructuredOutlineMutationKind,
  command: ProjectStructuredOutlineCommand,
  digester: ContentDigester,
): void {
  const q = authority?.outlineRunTransaction;
  if (q === undefined) return;
  const captured = captureProjectOutlineRunCommitTransaction(q);
  if (
    authority?.transaction !== undefined ||
    authority?.runTransaction !== undefined ||
    authority?.textUiTransaction !== undefined ||
    authority?.planTransaction !== undefined ||
    authority?.outlineUiTransaction !== undefined ||
    kind !== "save-outline" ||
    extensionCanonicalJson(actor) !== extensionCanonicalJson(captured.actor) ||
    extensionCanonicalJson(command) !==
      extensionCanonicalJson(
        projectOutlineRunMutationCommand(captured, digester),
      )
  )
    denied();
}
function denied(): never {
  throw new Error("project_outline_run_commit_authority_invalid");
}
