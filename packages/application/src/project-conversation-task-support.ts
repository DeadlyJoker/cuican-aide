import { pluginTaskModelId } from "./plugin-task-model-selection.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import {
  extensionCanonicalJson,
  parseProjectConversationBinding,
  parseProjectConversationStage,
  parseProjectStageSources,
  createProjectStageRunAdmission,
  type ProjectConversationBinding,
  type ProjectConversationStage,
  type ProjectStageSources,
  type PluginTaskAdmission,
  type ExtensionRunBinding,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { captureProjectConversationAuthority } from "./project-conversation-authority.ts";
import type {
  ProjectConversationCommitAuthority,
  ProjectConversationStore,
} from "./project-conversation-store-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ExtensionMutationReceipt } from "./extension-store-port.ts";
import { ApplicationError } from "./application-error.ts";
export type ProjectConversationTask = Readonly<{
  binding: ProjectConversationBinding;
  stage: ProjectConversationStage;
  sources: ProjectStageSources;
  content: string;
  modelId?: string;
  authority: ProjectConversationCommitAuthority;
  conversations: Pick<
    ProjectConversationStore,
    "loadStageAdmission" | "loadBinding"
  >;
}>;
export function captureProjectConversationTask(
  input: ProjectConversationTask,
  digester: ContentDigester,
): ProjectConversationTask {
  input = uiRecord(input, [
    "binding",
    "stage",
    "sources",
    "content",
    "authority",
    "conversations",
    ...(Object.hasOwn(input, "modelId") ? ["modelId"] : []),
  ]) as unknown as ProjectConversationTask;
  const binding = parseProjectConversationBinding(input.binding, digester),
    authority = captureProjectConversationAuthority(input.authority),
    stage = parseProjectConversationStage(input.stage),
    sources = parseProjectStageSources(input.sources, stage),
    content = input.content;
  if (
    typeof content !== "string" ||
    !content.trim() ||
    new TextEncoder().encode(content).length > 16384 ||
    binding.state !== "active" ||
    extensionCanonicalJson(binding.owner) !==
      extensionCanonicalJson(authority.actor) ||
    extensionCanonicalJson(binding.currentInstallation) !==
      extensionCanonicalJson(authority.installation)
  )
    fail();
  return Object.freeze({
    binding,
    authority,
    stage,
    sources,
    content,
    conversations: captureConversationReads(input.conversations),
    ...(Object.hasOwn(input, "modelId")
      ? { modelId: pluginTaskModelId(input.modelId) }
      : {}),
  });
}
export function projectConversationTaskReceipt(
  base: ExtensionMutationReceipt,
  task: ProjectConversationTask,
  digester: ContentDigester,
): ExtensionMutationReceipt {
  return Object.freeze({
    ...base,
    requestDigest: digester.sha256(
      extensionCanonicalJson({
        version:
          task.modelId === undefined
            ? "crewon.project-stage-task-command.v1"
            : "crewon.project-stage-task-command.v2",
        ...(task.modelId === undefined ? {} : { modelId: task.modelId }),
        baseRequestDigest: base.requestDigest,
        bindingId: task.binding.bindingId,
        bindingRevision: task.binding.revision,
        projectId: task.binding.projectId,
        stage: task.stage,
        sources: task.sources,
        userContentDigest: digester.sha256(task.content),
      }),
    ),
  });
}
export function projectConversationTaskAdmission(
  task: ProjectConversationTask,
  admission: PluginTaskAdmission,
  binding: ExtensionRunBinding,
  at: string,
  digester: ContentDigester,
) {
  return createProjectStageRunAdmission(
    {
      actor: task.authority.actor,
      binding: task.binding,
      admission,
      extensionBinding: binding,
      stage: task.stage,
      sources: task.sources,
      at,
    },
    digester,
  );
}
export async function assertSavedProjectConversationTask(
  task: ProjectConversationTask,
  admission: PluginTaskAdmission,
  binding: ExtensionRunBinding,
  digester: ContentDigester,
  checkCurrent = true,
): Promise<ProjectStageRunAdmission> {
  const saved = await task.conversations.loadStageAdmission({
    tenantId: admission.tenantId,
    spaceId: admission.spaceId,
    runId: admission.runId,
  });
  if (saved === null) fail();
  const expected = projectConversationTaskAdmission(
    task,
    admission,
    binding,
    saved.createdAt,
    digester,
  );
  if (extensionCanonicalJson(saved) !== extensionCanonicalJson(expected))
    fail();
  if (checkCurrent) {
    await assertCurrentConversationBinding(task);
    await task.authority.assertCurrent();
    task.authority.assertActive();
  }
  return saved;
}
function fail(): never {
  throw new ApplicationError("conflict", "project_stage_admission_invalid");
}

export async function restoreProjectConversationTask(
  task: ProjectConversationTask,
  command: import("./extension-task-application-service.ts").CreateExtensionTaskCommand,
  extensions: import("./extension-store-port.ts").ExtensionStore,
  digester: ContentDigester,
): Promise<ProjectConversationTask> {
  const lookup = extensions.loadPluginTaskAdmissionByReceipt;
  if (lookup === undefined) return task;
  const { pluginTaskReceipt } = await import(
    "./extension-plugin-task-support.ts"
  );
  const pin = task.authority.pin,
    receipt = pluginTaskReceipt(task.authority.actor, command, pin, digester);
  const admission = await lookup.call(extensions, {
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    profileId: pin.profileId,
    pluginId: pin.pluginId,
    principalId: pin.principalId,
    actorId: pin.actorId,
    idempotencyKey: receipt.idempotencyKey,
  });
  if (admission === null) return task;
  const saved = await task.conversations.loadStageAdmission({
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    runId: admission.runId,
  });
  if (
    saved === null ||
    saved.bindingId !== task.binding.bindingId ||
    saved.bindingRevision !== task.binding.revision ||
    extensionCanonicalJson(saved.stage) !== extensionCanonicalJson(task.stage)
  )
    fail();
  return task.stage.kind === "discussion"
    ? captureProjectConversationTask(
        { ...task, sources: saved.sources },
        digester,
      )
    : task;
}

export type ProjectConversationTaskPreparation = Omit<
  ProjectConversationTask,
  "sources"
> &
  Readonly<{ prepareSources(): Promise<ProjectStageSources> }>;
export async function prepareProjectConversationTask(
  input: ProjectConversationTask | ProjectConversationTaskPreparation,
  command: import("./extension-task-application-service.ts").CreateExtensionTaskCommand,
  extensions: import("./extension-store-port.ts").ExtensionStore,
  digester: ContentDigester,
): Promise<ProjectConversationTask> {
  if (!Object.hasOwn(input, "prepareSources"))
    return restoreProjectConversationTask(
      captureProjectConversationTask(
        input as ProjectConversationTask,
        digester,
      ),
      command,
      extensions,
      digester,
    );
  const task = uiRecord(input, [
      "binding",
      "stage",
      "prepareSources",
      "content",
      "authority",
      "conversations",
      ...(Object.hasOwn(input, "modelId") ? ["modelId"] : []),
    ]) as unknown as ProjectConversationTaskPreparation,
    binding = parseProjectConversationBinding(task.binding, digester),
    authority = captureProjectConversationAuthority(task.authority),
    stage = parseProjectConversationStage(task.stage);
  await authority.assertCurrent();
  authority.assertActive();
  await assertCurrentConversationBinding({
    binding,
    authority,
    conversations: captureConversationReads(task.conversations),
  });
  const { pluginTaskReceipt } = await import(
      "./extension-plugin-task-support.ts"
    ),
    pin = authority.pin,
    base = pluginTaskReceipt(authority.actor, command, pin, digester),
    lookup = extensions.loadPluginTaskAdmissionByReceipt;
  const admission =
    lookup === undefined
      ? null
      : await lookup.call(extensions, {
          tenantId: pin.tenantId,
          spaceId: pin.spaceId,
          profileId: pin.profileId,
          pluginId: pin.pluginId,
          principalId: pin.principalId,
          actorId: pin.actorId,
          idempotencyKey: base.idempotencyKey,
        });
  const saved =
    admission === null
      ? null
      : await task.conversations.loadStageAdmission({
          tenantId: pin.tenantId,
          spaceId: pin.spaceId,
          runId: admission.runId,
        });
  if (
    admission !== null &&
    (saved === null ||
      saved.bindingId !== binding.bindingId ||
      saved.bindingRevision !== binding.revision ||
      saved.projectId !== binding.projectId ||
      saved.threadId !== command.threadId ||
      extensionCanonicalJson(saved.actor) !==
        extensionCanonicalJson(authority.actor) ||
      extensionCanonicalJson(saved.installation) !==
        extensionCanonicalJson(authority.installation) ||
      extensionCanonicalJson(saved.stage) !== extensionCanonicalJson(stage) ||
      saved.userContentDigest !== digester.sha256(task.content))
  )
    fail();
  const prepare = Object.getOwnPropertyDescriptor(task, "prepareSources");
  if (
    !prepare?.enumerable ||
    !("value" in prepare) ||
    typeof prepare.value !== "function"
  )
    fail();
  const sources = saved?.sources ?? (await prepare.value.call(task));
  return captureProjectConversationTask(
    {
      binding,
      authority,
      stage,
      sources,
      content: task.content,
      conversations: task.conversations,
      ...(Object.hasOwn(task, "modelId")
        ? { modelId: pluginTaskModelId(task.modelId) }
        : {}),
    },
    digester,
  );
}

function captureConversationReads(
  input: ProjectConversationTask["conversations"],
): ProjectConversationTask["conversations"] {
  return Object.freeze({
    loadBinding: captureMethod(input, "loadBinding"),
    loadStageAdmission: captureMethod(input, "loadStageAdmission"),
  });
}
function captureMethod<T extends object, K extends keyof T>(
  input: T,
  key: K,
): T[K] {
  if (input === null || typeof input !== "object") fail();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (d === undefined) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function") fail();
    return d.value.bind(input) as T[K];
  }
  return fail();
}
async function assertCurrentConversationBinding(
  task: Pick<
    ProjectConversationTask,
    "binding" | "authority" | "conversations"
  >,
): Promise<void> {
  const current = await task.conversations.loadBinding({
    actor: task.authority.actor,
    profileId: task.authority.installation.profileId,
    threadId: task.binding.threadId,
  });
  if (
    current === null ||
    extensionCanonicalJson(current) !== extensionCanonicalJson(task.binding)
  )
    throw new ApplicationError(
      "conflict",
      "project_conversation_revision_conflict",
    );
}

export async function createProjectConversationTurnFromHost(input: {
  actor: import("./authorization-port.ts").ActorContext;
  command: import("./extension-task-application-service.ts").CreateExtensionTaskCommand;
  task: ProjectConversationTask | ProjectConversationTaskPreparation;
  extensions: import("./extension-store-port.ts").ExtensionStore;
  digester: ContentDigester;
  create: (
    task: ProjectConversationTask,
    onStage: (stage: ProjectStageRunAdmission) => void,
  ) => Promise<import("./extension-store-port.ts").CommitExtensionTurnResult>;
}) {
  const captured = await prepareProjectConversationTask(
    input.task,
    input.command,
    input.extensions,
    input.digester,
  );
  if (
    input.extensions.projectStageAdmissionVersion !==
      "crewon.project-stage-run-admission.v1" ||
    input.command.threadId !== captured.binding.threadId ||
    input.command.intent.kind !== "generate" ||
    extensionCanonicalJson(input.command.intent.input) !==
      extensionCanonicalJson({ prompt: captured.content })
  )
    throw new ApplicationError(
      "conflict",
      "project_stage_admission_unavailable",
    );
  let stageAdmission: ProjectStageRunAdmission | undefined;
  const result = await input.create(captured, (stage) => {
    stageAdmission = stage;
  });
  if (stageAdmission === undefined)
    throw new ApplicationError("internal", "project_stage_admission_missing");
  return { result, stageAdmission };
}
