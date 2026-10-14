import { canonicalActionIntent } from "@crewon/contracts";
import { parseProjectOutlineToolContextRequest } from "@crewon/contracts/project-outline-tools";
import {
  creativeProjectOpaqueId,
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
import type { WorkItemClaim } from "./durable-queue-port.ts";
import {
  projectToolAuthorityContentDigest,
  type ProjectToolInstallationPin,
} from "./creative-project-run-commit-authority.ts";
import {
  projectAssetAuthorityCopy as copy,
  projectAssetAuthorityFields as fields,
  projectAssetInstallationEvidence as installationEvidence,
} from "./project-asset-qualification-data.ts";

/** Independent genuine outline_context read receipt. It never authorizes a mutation or legacy outline_read. */
export type ProjectOutlineRunReadAuthority = Readonly<{
  version: "crewon.project-outline-run-read.v1";
  actor: ActorContext;
  run: RunState;
  receipt: ToolExecutionReceiptState;
  claim: WorkItemClaim;
  commandInput: string;
  operationId: "outline_context";
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

export function captureProjectOutlineRunReadAuthority(
  input: unknown,
): ProjectOutlineRunReadAuthority {
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
      v.version !== "crewon.project-outline-run-read.v1" ||
      v.operationId !== "outline_context" ||
      typeof v.assertCurrent !== "function" ||
      typeof v.commandInput !== "string" ||
      Buffer.byteLength(v.commandInput, "utf8") > 8 * 1024
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
      run.status !== "running" ||
      run.cancelRequested !== false ||
      run.tenantId !== evidence.actor.tenantId ||
      run.spaceId !== evidence.actor.spaceId ||
      run.createdByActorId !== evidence.actor.actorId ||
      receipt.tenantId !== run.tenantId ||
      receipt.runId !== run.runId ||
      receipt.status !== "dispatched" ||
      receipt.effect !== "readOnly" ||
      receipt.recovery !== "replaySafe" ||
      receipt.actionIntent === null ||
      receipt.call.name !==
        extensionToolName(evidence.installation.pluginId, "outline_context") ||
      receipt.actionIntent.capability !== "project.read" ||
      receipt.actionIntent.effect !== "readOnly" ||
      receipt.actionIntent.recovery !== "replaySafe" ||
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
    const result: ProjectOutlineRunReadAuthority = Object.freeze({
      version: "crewon.project-outline-run-read.v1",
      ...evidence,
      run,
      receipt,
      claim,
      admission,
      projectStageAdmission: stage,
      operationId: "outline_context",
      commandInput: v.commandInput,
      assertCurrent: async () => {
        if ((await current()) !== undefined) denied();
      },
    });
    const request = parseProjectOutlineToolContextRequest(
      JSON.parse(result.commandInput),
    );
    if (request.projectId !== stage.projectId) denied();
    return result;
  } catch (cause) {
    throw new Error("project_outline_run_read_authority_invalid", {
      cause,
    });
  }
}

function denied(): never {
  throw new Error("project_outline_run_read_authority_invalid");
}
