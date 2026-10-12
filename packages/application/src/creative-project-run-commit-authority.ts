import { canonicalActionIntent } from "@crewon/contracts";
import { createHash } from "node:crypto";
import {
  creativeProjectOpaqueId,
  extensionToolName,
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmission,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
  pluginInstallationRevision,
  pluginInstallationVersion,
  validateCreativeProjectActor,
  validateToolExecutionReceipt,
  type InstalledPluginPackage,
  type PluginSelection,
  type PluginTaskAdmission,
  type RunState,
  type ToolExecutionReceiptState,
  type ProjectStageRunAdmission,
  type ProjectTextPlanRunAdmission,
  parseProjectStageRunAdmission,
  parseProjectTextPlanRunAdmission,
  assertProjectStageToolRequest,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";

/** Fixed host digest for original Run/Tool qualification. It performs no I/O and grants no authority. */
export function projectToolAuthorityContentDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Complete actual installation identity, without UI invocation provenance. */
export type ProjectToolInstallationPin = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
}>;
export type ProjectToolMutationOperation =
  | "project_create"
  | "brief_append"
  | "outline_save"
  | "script_save"
  | "text_select"
  | "text_lock";

export function parseProjectToolInstallationPin(
  input: unknown,
): ProjectToolInstallationPin {
  const fields = ownFields(input, [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "selectionRevision",
  ]);
  return Object.freeze({
    tenantId: pluginInstallationOpaqueId(fields.tenantId),
    spaceId: pluginInstallationOpaqueId(fields.spaceId),
    profileId: pluginInstallationOpaqueId(fields.profileId),
    pluginId: pluginInstallationNamespaceId(fields.pluginId),
    publisherId: pluginInstallationNamespaceId(fields.publisherId),
    version: pluginInstallationVersion(fields.version),
    packageDigest: pluginInstallationDigest(fields.packageDigest),
    selectionRevision: pluginInstallationRevision(fields.selectionRevision),
  });
}

/** Worker-issued authority for the actual dispatched command; never a plugin/public DTO. */
export type CreativeProjectRunCommitTransactionAuthority = Readonly<{
  version: "crewon.creative-project-run-commit.v1";
  actor: ActorContext;
  run: RunState;
  receipt: ToolExecutionReceiptState;
  claim: WorkItemClaim;
  /** Exact original command.input, whose digest is persisted in the Tool receipt. */
  commandInput: string;
  operationId: ProjectToolMutationOperation;
  installation: ProjectToolInstallationPin;
  /** Original genuine persisted task admission, never synthesized from installation trust. */
  admission: PluginTaskAdmission;
  /** Immutable host stage record, if this Run was admitted through a project conversation. */
  projectStageAdmission?: ProjectStageRunAdmission;
  /** Required whenever the original task-admission plan marker is non-null. */
  projectTextPlanAdmission?: ProjectTextPlanRunAdmission;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** Live Worker dispatch/actor/PDP fence. Must not borrow the committing Store's pool. */
  assertCurrent(): Promise<void>;
}>;

/** Capture data without executing getters, toJSON, or caller-controlled thenables. */
export type CreativeProjectRunReadAuthority = Omit<
  CreativeProjectRunCommitTransactionAuthority,
  "version" | "operationId"
> &
  Readonly<{
    version: "crewon.creative-project-run-read.v1";
    operationId:
      | "project_read"
      | "content_read"
      | "outline_read"
      | "script_read"
      | "text_history";
  }>;
export function captureCreativeProjectRunReadAuthority(
  input: unknown,
): CreativeProjectRunReadAuthority {
  return captureRunAuthority(input, "read") as CreativeProjectRunReadAuthority;
}
export function captureCreativeProjectRunCommitTransaction(
  input: unknown,
): CreativeProjectRunCommitTransactionAuthority {
  return captureRunAuthority(
    input,
    "mutation",
  ) as CreativeProjectRunCommitTransactionAuthority;
}
function captureRunAuthority(
  input: unknown,
  purpose: "read" | "mutation",
):
  | CreativeProjectRunReadAuthority
  | CreativeProjectRunCommitTransactionAuthority {
  const fields = ownFields(input, [
    "version",
    "actor",
    "run",
    "receipt",
    "claim",
    "commandInput",
    "operationId",
    "installation",
    "admission",
    "selection",
    "package",
    "assertCurrent",
    ...(input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "projectStageAdmission")
      ? ["projectStageAdmission"]
      : []),
    ...(input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "projectTextPlanAdmission")
      ? ["projectTextPlanAdmission"]
      : []),
  ]);
  if (
    fields.version !==
      (purpose === "read"
        ? "crewon.creative-project-run-read.v1"
        : "crewon.creative-project-run-commit.v1") ||
    typeof fields.assertCurrent !== "function" ||
    typeof fields.commandInput !== "string" ||
    Buffer.byteLength(fields.commandInput, "utf8") > 131072
  )
    denied();
  const actor = validateCreativeProjectActor(copy(fields.actor));
  const run = copy(fields.run) as RunState;
  const receipt = copy(fields.receipt) as ToolExecutionReceiptState;
  const claim = copy(fields.claim) as WorkItemClaim;
  const admission = parsePluginTaskAdmission(copy(fields.admission));
  const stage =
    fields.projectStageAdmission === undefined
      ? undefined
      : parseProjectStageRunAdmission(copy(fields.projectStageAdmission), {
          sha256: projectToolAuthorityContentDigest,
        });
  const pin = parseProjectToolInstallationPin(fields.installation);
  const plan =
    fields.projectTextPlanAdmission === undefined
      ? undefined
      : parseProjectTextPlanRunAdmission(
          copy(fields.projectTextPlanAdmission),
          {
            sha256: projectToolAuthorityContentDigest,
          },
        );
  const operations =
    purpose === "read"
      ? [
          "project_read",
          "content_read",
          "outline_read",
          "script_read",
          "text_history",
        ]
      : [
          "project_create",
          "brief_append",
          "outline_save",
          "script_save",
          "text_select",
          "text_lock",
        ];
  if (
    typeof fields.operationId !== "string" ||
    !operations.includes(fields.operationId)
  )
    denied();
  const selection = parsePluginSelection(copy(fields.selection));
  const pkg = parseInstalledPluginPackage(copy(fields.package));
  try {
    validateToolExecutionReceipt(receipt);
  } catch {
    denied();
  }
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
    run.tenantId !== actor.tenantId ||
    run.spaceId !== actor.spaceId ||
    run.createdByActorId !== actor.actorId ||
    receipt.tenantId !== actor.tenantId ||
    receipt.runId !== run.runId ||
    (receipt.status !== "dispatched" && receipt.status !== "unknownOutcome") ||
    receipt.effect !== (purpose === "read" ? "readOnly" : "mutation") ||
    receipt.recovery !== (purpose === "read" ? "replaySafe" : "reconcilable") ||
    receipt.actionIntent === null ||
    receipt.actionIntent.policySnapshotId !== run.policySnapshotId ||
    receipt.actionIntent.workspaceBindingId !== run.workspaceBindingId ||
    claim.workItem.tenantId !== actor.tenantId ||
    claim.workItem.runId !== run.runId ||
    claim.workItem.workItemId !== receipt.workItemId ||
    !Number.isSafeInteger(claim.lease.epoch) ||
    claim.lease.epoch < 1 ||
    !Number.isFinite(Date.parse(claim.lease.expiresAt)) ||
    selection.state !== "enabled" ||
    selection.revision !== pin.selectionRevision ||
    selection.selectedPackageDigest !== pin.packageDigest ||
    pkg.packageDigest !== pin.packageDigest ||
    pkg.version !== pin.version ||
    admission.runId !== run.runId ||
    admission.threadId !== run.threadId ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) => admission[key] !== actor[key],
    ) ||
    (
      [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
      ] as const
    ).some((key) => admission[key] !== pin[key]) ||
    (
      ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
    ).some((key) => selection[key] !== pin[key] || pkg[key] !== pin[key])
  )
    denied();
  if (
    purpose === "read" &&
    (stage === undefined ||
      receipt.actionIntent?.capability !== "project.read" ||
      receipt.actionIntent.effect !== "readOnly" ||
      receipt.call.name !==
        extensionToolName(pin.pluginId, fields.operationId as string) ||
      receipt.call.inputDigest !==
        projectToolAuthorityContentDigest(fields.commandInput) ||
      receipt.actionDigest !==
        projectToolAuthorityContentDigest(
          canonicalActionIntent(receipt.actionIntent),
        ))
  )
    denied();
  creativeProjectOpaqueId(claim.lease.ownerId);
  creativeProjectOpaqueId(claim.lease.leaseId);
  const current = fields.assertCurrent.bind(input);
  if (
    plan !== undefined &&
    (stage === undefined ||
      plan.runId !== run.runId ||
      plan.threadId !== run.threadId ||
      plan.stageAdmissionDigest !== stage.contentDigest ||
      plan.extensionBindingDigest !== stage.extensionBindingDigest ||
      plan.projectId !== stage.projectId ||
      extensionCanonicalJson(plan.actor) !== extensionCanonicalJson(actor) ||
      extensionCanonicalJson(plan.installation) !== extensionCanonicalJson(pin))
  )
    denied();
  if (stage !== undefined) {
    if (
      stage.runId !== run.runId ||
      stage.threadId !== run.threadId ||
      extensionCanonicalJson(stage.actor) !== extensionCanonicalJson(actor) ||
      extensionCanonicalJson(stage.installation) !==
        extensionCanonicalJson(pin) ||
      stage.pluginTaskAdmissionDigest !==
        projectToolAuthorityContentDigest(extensionCanonicalJson(admission))
    )
      denied();
    assertProjectStageToolRequest(
      stage,
      fields.operationId as string,
      fields.operationId === "script_save"
        ? { outline: null, ...JSON.parse(fields.commandInput) }
        : JSON.parse(fields.commandInput),
    );
  }
  return Object.freeze({
    version:
      purpose === "read"
        ? "crewon.creative-project-run-read.v1"
        : "crewon.creative-project-run-commit.v1",
    actor,
    run,
    receipt,
    claim,
    commandInput: fields.commandInput,
    operationId: fields.operationId as ProjectToolMutationOperation,
    installation: pin,
    admission,
    ...(stage === undefined ? {} : { projectStageAdmission: stage }),
    ...(plan === undefined ? {} : { projectTextPlanAdmission: plan }),
    selection,
    package: pkg,
    assertCurrent: async () => {
      const result: unknown = await current();
      if (result !== undefined) denied();
    },
  }) as
    | CreativeProjectRunReadAuthority
    | CreativeProjectRunCommitTransactionAuthority;
}

function ownFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    denied();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      denied();
    result[key] = descriptor.value;
  }
  if (Object.keys(result).length !== keys.length) denied();
  return result;
}

function copy(input: unknown): unknown {
  // Domain canonical JSON rejects non-data objects/accessors before serialization.
  const json = extensionCanonicalJson(input);
  if (Buffer.byteLength(json, "utf8") > 262144) denied();
  return freeze(JSON.parse(json));
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function denied(): never {
  throw new Error("creative_project_run_commit_authority_invalid");
}
