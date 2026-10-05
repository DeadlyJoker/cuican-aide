import { projectTextOpaqueId } from "./project-text-content.ts";
import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  creativeProjectRecord,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  creativeProjectDigest,
  creativeProjectFailure,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import {
  parseProjectConversationBinding,
  parseProjectConversationInstallation,
  type ProjectConversationBinding,
  type ProjectConversationInstallation,
} from "./project-conversation-binding.ts";
import {
  parsePluginTaskAdmission,
  type PluginTaskAdmission,
} from "./plugin-task-admission.ts";
import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "./extension-run-binding.ts";
import type { CreativeProjectActor } from "./creative-project.ts";

export type ProjectConversationStage =
  | Readonly<{ kind: "discussion" }>
  | Readonly<{ kind: "brief" | "outline"; briefRevision: number }>
  | Readonly<{
      kind: "script";
      episodeId: string;
      briefRevision: number;
      outline: Readonly<{ artifactId: string; contentRevision: number }> | null;
    }>;
export type ProjectStageSources = Readonly<{
  brief: Readonly<{ briefRevision: number; contentDigest: string }> | null;
  outline: Readonly<{
    artifactId: string;
    contentRevision: number;
    contentDigest: string;
  }> | null;
}>;
export const PROJECT_STAGE_READ_OPERATIONS = [
  "project_context_read",
  "project_read",
  "outline_read",
  "script_read",
  "content_read",
  "text_history",
] as const;
export type ProjectStageOperation =
  | (typeof PROJECT_STAGE_READ_OPERATIONS)[number]
  | "brief_append"
  | "outline_save"
  | "script_save";
export type ProjectStageRunAdmission = Readonly<{
  schemaVersion: "crewon.project-stage-run-admission.v1";
  actor: CreativeProjectActor;
  installation: ProjectConversationInstallation;
  runId: string;
  threadId: string;
  projectId: string;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string | null;
  stage: ProjectConversationStage;
  sources: ProjectStageSources;
  allowedOperations: readonly ProjectStageOperation[];
  userContentDigest: string;
  taskInputDigest: string;
  pluginTaskAdmissionDigest: string;
  extensionBindingDigest: string;
  requestDigest: string;
  idempotencyKey: string;
  createdAt: string;
  contentDigest: string;
}>;
export function parseProjectConversationStage(
  input: unknown,
): ProjectConversationStage {
  const kind = creativeProjectRecord(
    input,
    Object.keys(Object.getOwnPropertyDescriptors(input ?? {})),
  ).kind;
  if (kind === "discussion") {
    creativeProjectRecord(input, ["kind"]);
    return Object.freeze({ kind });
  }
  if (kind === "brief" || kind === "outline") {
    const v = creativeProjectRecord(input, ["kind", "briefRevision"]);
    return Object.freeze({
      kind,
      briefRevision: creativeProjectRevision(v.briefRevision),
    });
  }
  if (kind === "script") {
    const v = creativeProjectRecord(input, [
      "kind",
      "episodeId",
      "briefRevision",
      "outline",
    ]);
    const outline =
      v.outline === null
        ? null
        : creativeProjectRecord(v.outline, ["artifactId", "contentRevision"]);
    return Object.freeze({
      kind,
      episodeId: projectTextOpaqueId(v.episodeId),
      briefRevision: creativeProjectRevision(v.briefRevision),
      outline:
        outline === null
          ? null
          : Object.freeze({
              artifactId: projectTextOpaqueId(outline.artifactId),
              contentRevision: creativeProjectRevision(outline.contentRevision),
            }),
    });
  }
  return invalid();
}
export function projectStageOperations(
  stage: ProjectConversationStage,
): readonly ProjectStageOperation[] {
  return Object.freeze([
    ...PROJECT_STAGE_READ_OPERATIONS,
    ...(stage.kind === "discussion"
      ? []
      : ([
          stage.kind === "brief"
            ? "brief_append"
            : stage.kind === "outline"
              ? "outline_save"
              : "script_save",
        ] as ProjectStageOperation[])),
  ]);
}
export function parseProjectStageSources(
  input: unknown,
  stage: ProjectConversationStage,
): ProjectStageSources {
  const v = creativeProjectRecord(input, ["brief", "outline"]),
    b =
      v.brief === null
        ? null
        : creativeProjectRecord(v.brief, ["briefRevision", "contentDigest"]),
    o =
      v.outline === null
        ? null
        : creativeProjectRecord(v.outline, [
            "artifactId",
            "contentRevision",
            "contentDigest",
          ]);
  const brief =
      b === null
        ? null
        : Object.freeze({
            briefRevision: creativeProjectRevision(b.briefRevision),
            contentDigest: creativeProjectDigest(b.contentDigest),
          }),
    outline =
      o === null
        ? null
        : Object.freeze({
            artifactId: projectTextOpaqueId(o.artifactId),
            contentRevision: creativeProjectRevision(o.contentRevision),
            contentDigest: creativeProjectDigest(o.contentDigest),
          });
  if (
    stage.kind !== "discussion" &&
    (brief === null || brief.briefRevision !== stage.briefRevision)
  )
    invalid();
  if (
    stage.kind === "script"
      ? stage.outline === null
        ? outline !== null
        : outline === null ||
          outline.artifactId !== stage.outline.artifactId ||
          outline.contentRevision !== stage.outline.contentRevision
      : outline !== null
  )
    invalid();
  return Object.freeze({ brief, outline });
}
export function parseProjectStageRunAdmission(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectStageRunAdmission {
  const v = creativeProjectRecord(input, [
    "schemaVersion",
    "actor",
    "installation",
    "runId",
    "threadId",
    "projectId",
    "bindingId",
    "bindingRevision",
    "workspaceId",
    "stage",
    "sources",
    "allowedOperations",
    "userContentDigest",
    "taskInputDigest",
    "pluginTaskAdmissionDigest",
    "extensionBindingDigest",
    "requestDigest",
    "idempotencyKey",
    "createdAt",
    "contentDigest",
  ]);
  if (v.schemaVersion !== "crewon.project-stage-run-admission.v1") invalid();
  const actor = validateCreativeProjectActor(v.actor),
    installation = parseProjectConversationInstallation(v.installation),
    stage = parseProjectConversationStage(v.stage),
    sources = parseProjectStageSources(v.sources, stage),
    allowedOperations = projectStageOperations(stage);
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId ||
    extensionCanonicalJson(v.allowedOperations) !==
      extensionCanonicalJson(allowedOperations)
  )
    invalid();
  const body = {
    schemaVersion: "crewon.project-stage-run-admission.v1" as const,
    actor,
    installation,
    runId: creativeProjectOpaqueId(v.runId),
    threadId: projectTextOpaqueId(v.threadId),
    projectId: projectTextOpaqueId(v.projectId),
    bindingId: projectTextOpaqueId(v.bindingId),
    bindingRevision: creativeProjectRevision(v.bindingRevision),
    workspaceId:
      v.workspaceId === null ? null : creativeProjectOpaqueId(v.workspaceId),
    stage,
    sources,
    allowedOperations,
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
  if (
    digester.sha256(
      extensionCanonicalJson({
        stage,
        sources,
        userContentDigest: body.userContentDigest,
      }),
    ) !== body.taskInputDigest ||
    digester.sha256(extensionCanonicalJson(body)) !==
      creativeProjectDigest(v.contentDigest)
  )
    invalid();
  return Object.freeze({ ...body, contentDigest: v.contentDigest as string });
}
export function createProjectStageRunAdmission(
  input: Readonly<{
    actor: CreativeProjectActor;
    binding: ProjectConversationBinding;
    admission: PluginTaskAdmission;
    extensionBinding: ExtensionRunBinding;
    stage: ProjectConversationStage;
    sources: ProjectStageSources;
    at: string;
  }>,
  digester: ExtensionContentDigester,
): ProjectStageRunAdmission {
  input = creativeProjectRecord(input, [
    "actor",
    "binding",
    "admission",
    "extensionBinding",
    "stage",
    "sources",
    "at",
  ]) as unknown as typeof input;
  const admission = parsePluginTaskAdmission(input.admission),
    extension = parseExtensionRunBinding(input.extensionBinding, digester),
    b = parseProjectConversationBinding(input.binding, digester),
    stage = parseProjectConversationStage(input.stage),
    sources = parseProjectStageSources(input.sources, stage);
  if (
    b.state !== "active" ||
    b.threadId !== admission.threadId ||
    extension.source !== null ||
    extension.threadId !== b.threadId ||
    extension.runId !== admission.runId ||
    extension.bindingDigest !== admission.extensionBindingDigest ||
    admission.action !== "project.execute" ||
    admission.principalId !== b.owner.principalId ||
    admission.actorId !== b.owner.actorId ||
    extensionCanonicalJson(input.actor) !== extensionCanonicalJson(b.owner) ||
    [
      "tenantId",
      "spaceId",
      "profileId",
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "selectionRevision",
    ].some(
      (k) =>
        admission[k as keyof PluginTaskAdmission] !==
        b.currentInstallation[k as keyof ProjectConversationInstallation],
    )
  )
    invalid();
  const body = {
    schemaVersion: "crewon.project-stage-run-admission.v1" as const,
    actor: input.actor,
    installation: b.currentInstallation,
    runId: admission.runId,
    threadId: admission.threadId,
    projectId: b.projectId,
    bindingId: b.bindingId,
    bindingRevision: b.revision,
    workspaceId: b.workspaceId,
    stage,
    sources,
    allowedOperations: projectStageOperations(stage),
    userContentDigest: extension.inputDigest,
    taskInputDigest: digester.sha256(
      extensionCanonicalJson({
        stage,
        sources,
        userContentDigest: extension.inputDigest,
      }),
    ),
    pluginTaskAdmissionDigest: digester.sha256(
      extensionCanonicalJson(admission),
    ),
    extensionBindingDigest: extension.bindingDigest,
    requestDigest: admission.requestDigest,
    idempotencyKey: admission.idempotencyKey,
    createdAt: input.at,
  };
  return parseProjectStageRunAdmission(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}
export function assertProjectStageToolRequest(
  scope: ProjectStageRunAdmission,
  operation: string,
  request: Readonly<Record<string, unknown>>,
): void {
  if (operation === "project_context_read") {
    if (Object.keys(request).length !== 0) invalid();
    return;
  }
  if (
    !scope.allowedOperations.includes(operation as ProjectStageOperation) ||
    request.projectId !== scope.projectId
  )
    invalid();
  if (
    scope.stage.kind === "script" &&
    (operation === "script_save" || operation === "script_read") &&
    request.episodeId !== scope.stage.episodeId
  )
    invalid();
  if (operation === "outline_save" || operation === "script_save") {
    if (
      scope.sources.brief === null ||
      request.briefRevision !== scope.sources.brief.briefRevision
    )
      invalid();
    if (
      operation === "script_save" &&
      extensionCanonicalJson(request.outline) !==
        extensionCanonicalJson(
          scope.stage.kind === "script" ? scope.stage.outline : null,
        )
    )
      invalid();
  }
}
function invalid(): never {
  return creativeProjectFailure("project_stage_admission_invalid");
}
