import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectTimestamp,
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
import {
  projectAssetId,
  projectAssetKind,
} from "./project-asset-validation.ts";
import type { ProjectAssetKind } from "./project-asset-types.ts";
import type { CreativeProjectActor } from "./creative-project.ts";

/** Independent from the frozen four-stage text conversation protocol. */
export type ProjectAssetStage = Readonly<{
  kind: "assets";
  assetKind: ProjectAssetKind;
  briefRevision: number;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
  }> | null;
}>;
export type ProjectAssetStageSources = Readonly<{
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
    contentDigest: string;
  }> | null;
}>;
export const PROJECT_ASSET_STAGE_OPERATIONS = Object.freeze([
  "asset_context_read",
  "asset_list",
  "asset_read",
  "asset_history",
  "asset_content_read",
  "project_read",
  "outline_read",
  "script_read",
  "content_read",
  "text_history",
  "asset_save",
] as const);
export type ProjectAssetStageOperation =
  (typeof PROJECT_ASSET_STAGE_OPERATIONS)[number];
export type ProjectAssetStageRunAdmission = Readonly<{
  schemaVersion: "crewon.project-asset-stage-run-admission.v1";
  actor: CreativeProjectActor;
  installation: ProjectConversationInstallation;
  runId: string;
  threadId: string;
  projectId: string;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string | null;
  stage: ProjectAssetStage;
  sources: ProjectAssetStageSources;
  allowedOperations: readonly ProjectAssetStageOperation[];
  userContentDigest: string;
  taskInputDigest: string;
  pluginTaskAdmissionDigest: string;
  extensionBindingDigest: string;
  requestDigest: string;
  idempotencyKey: string;
  createdAt: string;
  contentDigest: string;
}>;

export function parseProjectAssetStage(input: unknown): ProjectAssetStage {
  const v = creativeProjectRecord(input, [
    "kind",
    "assetKind",
    "briefRevision",
    "script",
  ]);
  if (v.kind !== "assets") invalid();
  const s =
    v.script === null
      ? null
      : creativeProjectRecord(v.script, [
          "artifactId",
          "episodeId",
          "contentRevision",
        ]);
  return Object.freeze({
    kind: "assets",
    assetKind: projectAssetKind(v.assetKind),
    briefRevision: creativeProjectRevision(v.briefRevision),
    script:
      s === null
        ? null
        : Object.freeze({
            artifactId: projectAssetId(s.artifactId),
            episodeId: projectAssetId(s.episodeId),
            contentRevision: creativeProjectRevision(s.contentRevision),
          }),
  });
}
export function parseProjectAssetStageSources(
  input: unknown,
  stage: ProjectAssetStage,
): ProjectAssetStageSources {
  const v = creativeProjectRecord(input, ["brief", "script"]);
  const b = creativeProjectRecord(v.brief, ["briefRevision", "contentDigest"]);
  const s =
    v.script === null
      ? null
      : creativeProjectRecord(v.script, [
          "artifactId",
          "episodeId",
          "contentRevision",
          "contentDigest",
        ]);
  const brief = Object.freeze({
    briefRevision: creativeProjectRevision(b.briefRevision),
    contentDigest: creativeProjectDigest(b.contentDigest),
  });
  const script =
    s === null
      ? null
      : Object.freeze({
          artifactId: projectAssetId(s.artifactId),
          episodeId: projectAssetId(s.episodeId),
          contentRevision: creativeProjectRevision(s.contentRevision),
          contentDigest: creativeProjectDigest(s.contentDigest),
        });
  if (
    brief.briefRevision !== stage.briefRevision ||
    (stage.script === null
      ? script !== null
      : script === null ||
        (
          Object.keys(stage.script) as (keyof NonNullable<
            ProjectAssetStage["script"]
          >)[]
        ).some((key) => stage.script![key] !== script[key]))
  )
    invalid();
  return Object.freeze({ brief, script });
}
export function parseProjectAssetStageRunAdmission(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectAssetStageRunAdmission {
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
  if (v.schemaVersion !== "crewon.project-asset-stage-run-admission.v1")
    invalid();
  const actor = validateCreativeProjectActor(v.actor),
    installation = parseProjectConversationInstallation(v.installation);
  const stage = parseProjectAssetStage(v.stage),
    sources = parseProjectAssetStageSources(v.sources, stage);
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId ||
    extensionCanonicalJson(v.allowedOperations) !==
      extensionCanonicalJson(PROJECT_ASSET_STAGE_OPERATIONS)
  )
    invalid();
  const body = {
    schemaVersion: "crewon.project-asset-stage-run-admission.v1" as const,
    actor,
    installation,
    runId: creativeProjectOpaqueId(v.runId),
    threadId: projectAssetId(v.threadId),
    projectId: projectAssetId(v.projectId),
    bindingId: projectAssetId(v.bindingId),
    bindingRevision: creativeProjectRevision(v.bindingRevision),
    workspaceId:
      v.workspaceId === null ? null : creativeProjectOpaqueId(v.workspaceId),
    stage,
    sources,
    allowedOperations: PROJECT_ASSET_STAGE_OPERATIONS,
    userContentDigest: creativeProjectDigest(v.userContentDigest),
    taskInputDigest: creativeProjectDigest(v.taskInputDigest),
    pluginTaskAdmissionDigest: creativeProjectDigest(
      v.pluginTaskAdmissionDigest,
    ),
    extensionBindingDigest: creativeProjectDigest(v.extensionBindingDigest),
    requestDigest: creativeProjectDigest(v.requestDigest),
    idempotencyKey: projectAssetId(v.idempotencyKey),
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
export function createProjectAssetStageRunAdmission(
  input: Readonly<{
    actor: CreativeProjectActor;
    binding: ProjectConversationBinding;
    admission: PluginTaskAdmission;
    extensionBinding: ExtensionRunBinding;
    stage: ProjectAssetStage;
    sources: ProjectAssetStageSources;
    at: string;
  }>,
  digester: ExtensionContentDigester,
): ProjectAssetStageRunAdmission {
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
    extension = parseExtensionRunBinding(input.extensionBinding, digester);
  const b = parseProjectConversationBinding(input.binding, digester),
    actor = validateCreativeProjectActor(input.actor);
  const stage = parseProjectAssetStage(input.stage),
    sources = parseProjectAssetStageSources(input.sources, stage);
  if (
    b.state !== "active" ||
    b.threadId !== admission.threadId ||
    extension.source !== null ||
    extension.threadId !== b.threadId ||
    extension.runId !== admission.runId ||
    extension.bindingDigest !== admission.extensionBindingDigest ||
    admission.action !== "project.execute" ||
    extensionCanonicalJson(actor) !== extensionCanonicalJson(b.owner) ||
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
    ).some((key) => admission[key] !== b.currentInstallation[key])
  )
    invalid();
  const body = {
    schemaVersion: "crewon.project-asset-stage-run-admission.v1" as const,
    actor,
    installation: b.currentInstallation,
    runId: admission.runId,
    threadId: admission.threadId,
    projectId: b.projectId,
    bindingId: b.bindingId,
    bindingRevision: b.revision,
    workspaceId: b.workspaceId,
    stage,
    sources,
    allowedOperations: PROJECT_ASSET_STAGE_OPERATIONS,
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
  return parseProjectAssetStageRunAdmission(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}
/** This is a project/stage boundary, not an installed-package or dispatch grant. */
export function assertProjectAssetStageToolRequest(
  scope: ProjectAssetStageRunAdmission,
  operation: string,
  request: Readonly<Record<string, unknown>>,
): void {
  if (operation === "asset_context_read") {
    if (Object.keys(request).length !== 0) invalid();
    return;
  }
  if (
    !scope.allowedOperations.includes(
      operation as ProjectAssetStageOperation,
    ) ||
    request.projectId !== scope.projectId
  )
    invalid();
  if (operation === "asset_list" && request.kind !== scope.stage.assetKind)
    invalid();
  if (
    operation === "asset_save" &&
    (request.kind !== scope.stage.assetKind ||
      request.briefRevision !== scope.sources.brief.briefRevision ||
      extensionCanonicalJson(request.script) !==
        extensionCanonicalJson(
          scope.stage.script === null
            ? null
            : {
                artifactId: scope.stage.script.artifactId,
                contentRevision: scope.stage.script.contentRevision,
              },
        ))
  )
    invalid();
}
function invalid(): never {
  return creativeProjectFailure("project_asset_stage_admission_invalid");
}
