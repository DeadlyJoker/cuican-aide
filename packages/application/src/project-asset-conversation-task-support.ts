import {
  createProjectAssetStageRunAdmission,
  extensionCanonicalJson,
  parseProjectAssetStage,
  parseProjectAssetStageSources,
  parseProjectConversationBinding,
  type ProjectAssetStage,
  type ProjectAssetStageRunAdmission,
  type ProjectAssetStageSources,
  type ProjectConversationBinding,
  type PluginTaskAdmission,
  type ExtensionRunBinding,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  ExtensionMutationReceipt,
  ExtensionStore,
  CommitExtensionTurnResult,
} from "./extension-store-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import { pluginTaskReceipt } from "./extension-plugin-task-support.ts";
import type { ProjectConversationStore } from "./project-conversation-store-port.ts";
import type { ProjectAssetStageStore } from "./project-asset-stage-store-port.ts";
import {
  captureProjectAssetStageAuthority,
  type ProjectAssetStageCommitAuthority,
} from "./project-asset-stage-authority.ts";
import { projectAssetAuthorityFields } from "./project-asset-qualification-data.ts";

export type ProjectAssetConversationTask = Readonly<{
  binding: ProjectConversationBinding;
  stage: ProjectAssetStage;
  sources: ProjectAssetStageSources;
  content: string;
  authority: ProjectAssetStageCommitAuthority;
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  stages: Pick<
    ProjectAssetStageStore,
    "loadAssetStageAdmission" | "readRequiredAssetStageDigest"
  >;
}>;
export type ProjectAssetConversationTaskPreparation = Omit<
  ProjectAssetConversationTask,
  "sources"
> &
  Readonly<{ prepareSources(): Promise<ProjectAssetStageSources> }>;
export function captureProjectAssetConversationTask(
  input: ProjectAssetConversationTask,
  digester: ContentDigester,
): ProjectAssetConversationTask {
  const v = projectAssetAuthorityFields(input, [
    "binding",
    "stage",
    "sources",
    "content",
    "authority",
    "conversations",
    "stages",
  ]);
  const binding = parseProjectConversationBinding(v.binding, digester),
    authority = captureProjectAssetStageAuthority(v.authority);
  const stage = parseProjectAssetStage(v.stage),
    sources = parseProjectAssetStageSources(v.sources, stage),
    content = v.content;
  if (
    binding.state !== "active" ||
    typeof content !== "string" ||
    !content.trim() ||
    Buffer.byteLength(content, "utf8") > 16384 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content) ||
    [...content].some((point) => {
      const code = point.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    }) ||
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
    conversations: Object.freeze({
      loadBinding: method(input.conversations, "loadBinding"),
    }),
    stages: Object.freeze({
      loadAssetStageAdmission: method(input.stages, "loadAssetStageAdmission"),
      readRequiredAssetStageDigest: method(
        input.stages,
        "readRequiredAssetStageDigest",
      ),
    }),
  });
}
export function projectAssetConversationTaskReceipt(
  base: ExtensionMutationReceipt,
  task: ProjectAssetConversationTask,
  digester: ContentDigester,
): ExtensionMutationReceipt {
  return Object.freeze({
    ...base,
    requestDigest: digester.sha256(
      extensionCanonicalJson({
        version: "crewon.project-asset-stage-task-command.v1",
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
export function projectAssetConversationTaskAdmission(
  task: ProjectAssetConversationTask,
  admission: PluginTaskAdmission,
  binding: ExtensionRunBinding,
  at: string,
  digester: ContentDigester,
) {
  return createProjectAssetStageRunAdmission(
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
export async function assertCurrentProjectAssetConversationBinding(
  task: Pick<
    ProjectAssetConversationTask,
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
export async function assertSavedProjectAssetConversationTask(
  task: ProjectAssetConversationTask,
  admission: PluginTaskAdmission,
  binding: ExtensionRunBinding,
  digester: ContentDigester,
  checkCurrent = true,
): Promise<ProjectAssetStageRunAdmission> {
  const locator = {
    tenantId: admission.tenantId,
    spaceId: admission.spaceId,
    runId: admission.runId,
  };
  const required = await task.stages.readRequiredAssetStageDigest(locator),
    saved = await task.stages.loadAssetStageAdmission(locator);
  if (
    saved === null ||
    required !== saved.contentDigest ||
    extensionCanonicalJson(saved) !==
      extensionCanonicalJson(
        projectAssetConversationTaskAdmission(
          task,
          admission,
          binding,
          saved.createdAt,
          digester,
        ),
      )
  )
    fail();
  if (checkCurrent) {
    await assertCurrentProjectAssetConversationBinding(task);
    await task.authority.assertCurrent();
    task.authority.assertActive();
  }
  return saved;
}
export async function prepareProjectAssetConversationTask(
  input: ProjectAssetConversationTask | ProjectAssetConversationTaskPreparation,
  command: CreateExtensionTaskCommand,
  extensions: ExtensionStore,
  digester: ContentDigester,
): Promise<ProjectAssetConversationTask> {
  const preparing = Object.hasOwn(input, "prepareSources");
  const v = projectAssetAuthorityFields(input, [
    "binding",
    "stage",
    preparing ? "prepareSources" : "sources",
    "content",
    "authority",
    "conversations",
    "stages",
  ]);
  const binding = parseProjectConversationBinding(v.binding, digester),
    authority = captureProjectAssetStageAuthority(v.authority),
    stage = parseProjectAssetStage(v.stage);
  const conversations = Object.freeze({
    loadBinding: method(input.conversations, "loadBinding"),
  });
  const stages = Object.freeze({
    loadAssetStageAdmission: method(input.stages, "loadAssetStageAdmission"),
    readRequiredAssetStageDigest: method(
      input.stages,
      "readRequiredAssetStageDigest",
    ),
  });
  await authority.assertCurrent();
  authority.assertActive();
  await assertCurrentProjectAssetConversationBinding({
    binding,
    authority,
    conversations,
  });
  const base = pluginTaskReceipt(
      authority.actor,
      command,
      authority.pin,
      digester,
    ),
    lookup = extensions.loadPluginTaskAdmissionByReceipt;
  if (lookup === undefined) fail();
  const pin = authority.pin,
    admission = await lookup.call(extensions, {
      tenantId: pin.tenantId,
      spaceId: pin.spaceId,
      profileId: pin.profileId,
      pluginId: pin.pluginId,
      principalId: pin.principalId,
      actorId: pin.actorId,
      idempotencyKey: base.idempotencyKey,
    });
  const locator =
    admission === null
      ? null
      : {
          tenantId: pin.tenantId,
          spaceId: pin.spaceId,
          runId: admission.runId,
        };
  const saved =
    locator === null ? null : await stages.loadAssetStageAdmission(locator);
  if (
    admission !== null &&
    (saved === null ||
      (await stages.readRequiredAssetStageDigest(locator!)) !==
        saved.contentDigest ||
      saved.bindingId !== binding.bindingId ||
      saved.bindingRevision !== binding.revision ||
      saved.projectId !== binding.projectId ||
      saved.threadId !== command.threadId ||
      extensionCanonicalJson(saved.actor) !==
        extensionCanonicalJson(authority.actor) ||
      extensionCanonicalJson(saved.installation) !==
        extensionCanonicalJson(authority.installation) ||
      extensionCanonicalJson(saved.stage) !== extensionCanonicalJson(stage) ||
      typeof v.content !== "string" ||
      saved.userContentDigest !== digester.sha256(v.content))
  )
    fail();
  if (preparing && typeof v.prepareSources !== "function") fail();
  // A confirmed original receipt freezes its sources. Later selected-source changes never mint a second Run.
  const sources =
    saved?.sources ??
    (preparing
      ? await (
          v.prepareSources as () => Promise<ProjectAssetStageSources>
        ).call(input)
      : v.sources);
  return captureProjectAssetConversationTask(
    {
      binding,
      authority,
      stage,
      sources: parseProjectAssetStageSources(sources, stage),
      content: v.content as string,
      conversations,
      stages,
    },
    digester,
  );
}
export async function createProjectAssetStageTurnFromHost(
  input: Readonly<{
    actor: ActorContext;
    command: CreateExtensionTaskCommand;
    task:
      | ProjectAssetConversationTask
      | ProjectAssetConversationTaskPreparation;
    extensions: ExtensionStore;
    digester: ContentDigester;
    create(
      task: ProjectAssetConversationTask,
      onStage: (stage: ProjectAssetStageRunAdmission) => void,
    ): Promise<CommitExtensionTurnResult>;
  }>,
): Promise<
  Readonly<{
    result: CommitExtensionTurnResult;
    assetStageAdmission: ProjectAssetStageRunAdmission;
  }>
> {
  const task = await prepareProjectAssetConversationTask(
    input.task,
    input.command,
    input.extensions,
    input.digester,
  );
  if (
    input.extensions.projectAssetStageAdmissionVersion !==
      "crewon.project-asset-stage-run-admission.v1" ||
    extensionCanonicalJson(input.actor) !==
      extensionCanonicalJson(task.authority.actor) ||
    input.command.intent.kind !== "generate" ||
    extensionCanonicalJson(input.command.intent.input) !==
      extensionCanonicalJson({ prompt: task.content }) ||
    input.command.threadId !== task.binding.threadId
  )
    fail();
  let captured: ProjectAssetStageRunAdmission | undefined;
  const result = await input.create(task, (stage) => {
    captured = stage;
  });
  if (captured === undefined || captured.runId !== result.binding.runId) fail();
  return Object.freeze({ result, assetStageAdmission: captured });
}
function method<T extends object, K extends keyof T>(input: T, key: K): T[K] {
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
function fail(): never {
  throw new ApplicationError(
    "conflict",
    "project_asset_stage_admission_invalid",
  );
}
