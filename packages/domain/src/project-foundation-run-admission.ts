import type { CreativeProjectActor } from "./creative-project.ts";
import {
  creativeProjectBriefText,
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectTimestamp,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "./extension-run-binding.ts";
import {
  parsePluginTaskAdmission,
  type PluginTaskAdmission,
} from "./plugin-task-admission.ts";
import {
  parseProjectConversationBinding,
  parseProjectConversationInstallation,
  type ProjectConversationBinding,
  type ProjectConversationInstallation,
} from "./project-conversation-binding.ts";
import type {
  ProjectFoundation,
  ProjectRevisionDigestPointer,
} from "./project-foundation-types.ts";
import {
  projectPointersEqual,
  validateProjectFoundation,
  validateProjectRevisionDigestPointer,
} from "./project-foundation-validation.ts";
import {
  validateProjectProposal,
  type ProjectProposal,
} from "./project-proposal.ts";
import {
  createProjectStageRunAdmission,
  parseProjectStageRunAdmission,
  type ProjectStageRunAdmission,
} from "./project-stage-run-admission.ts";

export const PROJECT_FOUNDATION_RUN_OPERATIONS = Object.freeze([
  "foundation_scope",
  "foundation_read",
  "foundation_source",
  "foundation_source_page",
  "foundation_chapters",
  "foundation_proposal",
  "foundation_proposals",
  "foundation_proposal_save",
] as const);
export type ProjectFoundationRunOperation =
  (typeof PROJECT_FOUNDATION_RUN_OPERATIONS)[number];

/**
 * Immutable attached facts for the original discussion Run. Neither this record nor its
 * public projection supplies execution permission: the host independently authorizes the
 * installed service and qualifies the actual Tool receipt. The v1 stage/Run shapes stay exact.
 */
export type ProjectFoundationRunAdmission = Readonly<{
  schemaVersion: "crewon.project-foundation-run-admission.v1";
  actor: CreativeProjectActor;
  installation: ProjectConversationInstallation;
  runId: string;
  threadId: string;
  projectId: string;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string | null;
  projectStageAdmissionDigest: string;
  foundationRevision: number;
  parametersRevision: number;
  parametersDigest: string;
  source: ProjectRevisionDigestPointer | null;
  confirmedProposal: ProjectRevisionDigestPointer | null;
  /** Context hint only. Saving a candidate must not revoke this Run's read qualification. */
  latestProposal: ProjectRevisionDigestPointer | null;
  allowedOperations: readonly ProjectFoundationRunOperation[];
  userContentDigest: string;
  /** The original stage's task input digest; attaching these facts does not rewrite input. */
  taskInputDigest: string;
  pluginTaskAdmissionDigest: string;
  extensionBindingDigest: string;
  requestDigest: string;
  idempotencyKey: string;
  createdAt: string;
  contentDigest: string;
}>;

export type CreateProjectFoundationRunAdmissionInput = Readonly<{
  actor: CreativeProjectActor;
  binding: ProjectConversationBinding;
  admission: PluginTaskAdmission;
  extensionBinding: ExtensionRunBinding;
  stageAdmission: ProjectStageRunAdmission;
  foundation: ProjectFoundation;
  latestProposal: ProjectProposal | null;
  at: string;
}>;

const admissionFields = [
  "schemaVersion",
  "actor",
  "installation",
  "runId",
  "threadId",
  "projectId",
  "bindingId",
  "bindingRevision",
  "workspaceId",
  "projectStageAdmissionDigest",
  "foundationRevision",
  "parametersRevision",
  "parametersDigest",
  "source",
  "confirmedProposal",
  "latestProposal",
  "allowedOperations",
  "userContentDigest",
  "taskInputDigest",
  "pluginTaskAdmissionDigest",
  "extensionBindingDigest",
  "requestDigest",
  "idempotencyKey",
  "createdAt",
  "contentDigest",
] as const;

export function parseProjectFoundationRunAdmission(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectFoundationRunAdmission {
  const v = creativeProjectRecord(input, admissionFields);
  if (v.schemaVersion !== "crewon.project-foundation-run-admission.v1")
    invalid();
  const actor = validateCreativeProjectActor(v.actor);
  const installation = parseProjectConversationInstallation(v.installation);
  const foundationRevision = creativeProjectRevision(v.foundationRevision);
  const parametersRevision = creativeProjectRevision(v.parametersRevision);
  const confirmedProposal = validateProjectRevisionDigestPointer(
    v.confirmedProposal,
  );
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId ||
    parametersRevision > foundationRevision ||
    (confirmedProposal !== null &&
      (foundationRevision < 2 || parametersRevision >= foundationRevision)) ||
    !same(v.allowedOperations, PROJECT_FOUNDATION_RUN_OPERATIONS)
  )
    invalid();
  const body = {
    schemaVersion: "crewon.project-foundation-run-admission.v1" as const,
    actor,
    installation,
    runId: creativeProjectOpaqueId(v.runId),
    threadId: creativeProjectOpaqueId(v.threadId),
    projectId: creativeProjectOpaqueId(v.projectId),
    bindingId: creativeProjectOpaqueId(v.bindingId),
    bindingRevision: creativeProjectRevision(v.bindingRevision),
    workspaceId:
      v.workspaceId === null ? null : creativeProjectOpaqueId(v.workspaceId),
    projectStageAdmissionDigest: creativeProjectDigest(
      v.projectStageAdmissionDigest,
    ),
    foundationRevision,
    parametersRevision,
    parametersDigest: creativeProjectDigest(v.parametersDigest),
    source: validateProjectRevisionDigestPointer(v.source),
    confirmedProposal,
    latestProposal: validateProjectRevisionDigestPointer(v.latestProposal),
    allowedOperations: PROJECT_FOUNDATION_RUN_OPERATIONS,
    userContentDigest: creativeProjectDigest(v.userContentDigest),
    taskInputDigest: creativeProjectDigest(v.taskInputDigest),
    pluginTaskAdmissionDigest: creativeProjectDigest(
      v.pluginTaskAdmissionDigest,
    ),
    extensionBindingDigest: creativeProjectDigest(v.extensionBindingDigest),
    requestDigest: creativeProjectDigest(v.requestDigest),
    idempotencyKey: creativeProjectOpaqueId(v.idempotencyKey),
    createdAt: creativeProjectTimestamp(v.createdAt),
  };
  const contentDigest = creativeProjectDigest(v.contentDigest);
  if (digester.sha256(extensionCanonicalJson(body)) !== contentDigest)
    invalid();
  return Object.freeze({ ...body, contentDigest });
}

/** Called by the host using the same transaction's original binding/stage/Foundation facts. */
export function createProjectFoundationRunAdmission(
  input: CreateProjectFoundationRunAdmissionInput,
  digester: ExtensionContentDigester,
): ProjectFoundationRunAdmission {
  const v = creativeProjectRecord(input, [
    "actor",
    "binding",
    "admission",
    "extensionBinding",
    "stageAdmission",
    "foundation",
    "latestProposal",
    "at",
  ]);
  const actor = validateCreativeProjectActor(v.actor);
  const binding = parseProjectConversationBinding(v.binding, digester);
  const admission = parsePluginTaskAdmission(v.admission);
  const extensionBinding = parseExtensionRunBinding(
    v.extensionBinding,
    digester,
  );
  const stage = parseProjectStageRunAdmission(v.stageAdmission, digester);
  const foundation = validateProjectFoundation(v.foundation);
  const expectedStage = createProjectStageRunAdmission(
    {
      actor,
      binding,
      admission,
      extensionBinding,
      stage: stage.stage,
      sources: stage.sources,
      at: stage.createdAt,
    },
    digester,
  );
  if (
    stage.stage.kind !== "discussion" ||
    !same(stage, expectedStage) ||
    foundation.projectId !== binding.projectId ||
    foundation.tenantId !== actor.tenantId ||
    foundation.spaceId !== actor.spaceId ||
    foundation.ownerPrincipalId !== actor.principalId ||
    extensionBinding.tenantId !== actor.tenantId ||
    extensionBinding.spaceId !== actor.spaceId ||
    extensionBinding.actorId !== actor.actorId ||
    extensionBinding.pluginId !== admission.pluginId ||
    stage.userContentDigest !== extensionBinding.inputDigest
  )
    invalid();
  const latest =
    v.latestProposal === null
      ? null
      : validateProjectProposal(v.latestProposal);
  if (latest !== null) {
    const { contentDigest, ...body } = latest;
    if (
      latest.tenantId !== foundation.tenantId ||
      latest.spaceId !== foundation.spaceId ||
      latest.projectId !== foundation.projectId ||
      latest.ownerPrincipalId !== foundation.ownerPrincipalId ||
      latest.foundationRevision > foundation.revision ||
      latest.parametersRevision > foundation.parametersRevision ||
      latest.kind !==
        (foundation.origin === "novel"
          ? "novel-adaptation"
          : "creative-plan") ||
      digester.sha256(extensionCanonicalJson(body)) !== contentDigest
    )
      invalid();
  }
  const body = {
    schemaVersion: "crewon.project-foundation-run-admission.v1" as const,
    actor,
    installation: stage.installation,
    runId: stage.runId,
    threadId: stage.threadId,
    projectId: stage.projectId,
    bindingId: stage.bindingId,
    bindingRevision: stage.bindingRevision,
    workspaceId: stage.workspaceId,
    projectStageAdmissionDigest: stage.contentDigest,
    foundationRevision: foundation.revision,
    parametersRevision: foundation.parametersRevision,
    parametersDigest: digester.sha256(
      extensionCanonicalJson(foundation.parameters),
    ),
    source: foundation.source,
    confirmedProposal: foundation.confirmedProposal,
    latestProposal:
      latest === null
        ? null
        : Object.freeze({
            revision: latest.revision,
            digest: latest.contentDigest,
          }),
    allowedOperations: PROJECT_FOUNDATION_RUN_OPERATIONS,
    userContentDigest: stage.userContentDigest,
    taskInputDigest: stage.taskInputDigest,
    pluginTaskAdmissionDigest: stage.pluginTaskAdmissionDigest,
    extensionBindingDigest: stage.extensionBindingDigest,
    requestDigest: stage.requestDigest,
    idempotencyKey: stage.idempotencyKey,
    createdAt: creativeProjectTimestamp(v.at),
  };
  return parseProjectFoundationRunAdmission(
    {
      ...body,
      contentDigest: digester.sha256(extensionCanonicalJson(body)),
    },
    digester,
  );
}

/** Latest proposal is deliberately absent: candidate append does not advance Foundation. */
export function assertProjectFoundationRunFoundation(
  scope: ProjectFoundationRunAdmission,
  input: ProjectFoundation,
  digester: ExtensionContentDigester,
): void {
  const s = parseProjectFoundationRunAdmission(scope, digester);
  const foundation = validateProjectFoundation(input);
  if (
    foundation.tenantId !== s.actor.tenantId ||
    foundation.spaceId !== s.actor.spaceId ||
    foundation.ownerPrincipalId !== s.actor.principalId ||
    foundation.projectId !== s.projectId ||
    foundation.revision !== s.foundationRevision ||
    foundation.parametersRevision !== s.parametersRevision ||
    digester.sha256(extensionCanonicalJson(foundation.parameters)) !==
      s.parametersDigest ||
    !projectPointersEqual(foundation.source, s.source) ||
    !projectPointersEqual(foundation.confirmedProposal, s.confirmedProposal)
  )
    creativeProjectFailure("project_foundation_run_inputs_stale");
}

/** Request matching is data qualification only, not installed service/PDP permission. */
export function assertProjectFoundationToolRequest(
  scope: ProjectFoundationRunAdmission,
  operation: string,
  input: Readonly<Record<string, unknown>>,
): void {
  const fields = requestFields[operation as ProjectFoundationRunOperation];
  if (
    !fields ||
    !scope.allowedOperations.includes(
      operation as ProjectFoundationRunOperation,
    )
  )
    invalid();
  const r = creativeProjectRecord(input, [
    ...(operation === "foundation_chapters" &&
    !Object.hasOwn(input, "afterStartOffset")
      ? fields.filter((field) => field !== "afterStartOffset")
      : fields),
    ...(operation === "foundation_read"
      ? ["parametersStartOffset", "parametersLimit"].filter((field) =>
          Object.hasOwn(input, field),
        )
      : []),
  ]);
  if (operation === "foundation_scope") return;
  if (r.projectId !== scope.projectId) invalid();
  if (operation === "foundation_read") {
    if (Object.hasOwn(r, "parametersStartOffset"))
      bounded(r.parametersStartOffset, 0, 8192);
    if (Object.hasOwn(r, "parametersLimit"))
      bounded(r.parametersLimit, 1, 1024);
  }
  if (
    [
      "foundation_source",
      "foundation_source_page",
      "foundation_chapters",
    ].includes(operation)
  ) {
    if (
      scope.source === null ||
      r.sourceRevision !== scope.source.revision ||
      r.sourceDigest !== scope.source.digest
    )
      invalid();
  }
  if (
    operation === "foundation_source_page" ||
    operation === "foundation_proposal"
  ) {
    bounded(r.startOffset, 0, 20_000_000);
    bounded(r.limit, 1, 1024);
  }
  if (operation === "foundation_chapters") {
    if (Object.hasOwn(r, "afterStartOffset"))
      bounded(r.afterStartOffset, 0, 20_000_000);
    bounded(r.limit, 1, 16);
  }
  if (operation === "foundation_proposal") {
    creativeProjectRevision(r.proposalRevision);
    creativeProjectDigest(r.proposalDigest);
  }
  if (operation === "foundation_proposals") {
    creativeProjectRevision(r.afterProposalRevision, { minimum: 0 });
    bounded(r.limit, 1, 4);
  }
  if (operation === "foundation_proposal_save") {
    if (
      r.expectedFoundationRevision !== scope.foundationRevision ||
      !["creative-plan", "novel-adaptation"].includes(r.kind as string)
    )
      invalid();
    creativeProjectRevision(r.expectedProposalRevision, { minimum: 0 });
    creativeProjectBriefText(r.text);
  }
}

const requestFields: Readonly<
  Record<ProjectFoundationRunOperation, readonly string[]>
> = Object.freeze({
  foundation_scope: [],
  foundation_read: ["projectId"],
  foundation_source: ["projectId", "sourceRevision", "sourceDigest"],
  foundation_source_page: [
    "projectId",
    "sourceRevision",
    "sourceDigest",
    "startOffset",
    "limit",
  ],
  foundation_chapters: [
    "projectId",
    "sourceRevision",
    "sourceDigest",
    "afterStartOffset",
    "limit",
  ],
  foundation_proposal: [
    "projectId",
    "proposalRevision",
    "proposalDigest",
    "startOffset",
    "limit",
  ],
  foundation_proposals: ["projectId", "afterProposalRevision", "limit"],
  foundation_proposal_save: [
    "projectId",
    "expectedFoundationRevision",
    "expectedProposalRevision",
    "kind",
    "text",
  ],
});
function bounded(input: unknown, minimum: number, maximum: number): void {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    invalid();
}
function same(a: unknown, b: unknown): boolean {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function invalid(): never {
  return creativeProjectFailure("project_foundation_run_admission_invalid");
}
