import {
  createProjectMediaInputStageRunAdmission,
  extensionCanonicalJson,
  parseProjectMediaInputStage,
  parseProjectMediaInputStageSources,
  parseProjectConversationBinding,
  type ProjectMediaInputStage,
  type ProjectMediaInputStageRunAdmission,
  type ProjectMediaInputStageSources,
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
import type { ProjectMediaInputStageStore } from "./project-media-input-stage-store-port.ts";
import {
  captureProjectMediaInputStageAuthority,
  type ProjectMediaInputStageCommitAuthority,
} from "./project-media-input-stage-authority.ts";
import { projectAssetAuthorityFields } from "./project-asset-qualification-data.ts";

export type ProjectMediaInputConversationTask = Readonly<{
  binding: ProjectConversationBinding;
  stage: ProjectMediaInputStage;
  sources: ProjectMediaInputStageSources;
  content: string;
  authority: ProjectMediaInputStageCommitAuthority;
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  stages: Pick<
    ProjectMediaInputStageStore,
    "loadMediaInputStageAdmission" | "readRequiredMediaInputStageDigest"
  >;
}>;
export type ProjectMediaInputConversationTaskPreparation = Omit<
  ProjectMediaInputConversationTask,
  "sources"
> &
  Readonly<{ prepareSources(): Promise<ProjectMediaInputStageSources> }>;
export function captureProjectMediaInputConversationTask(
  input: ProjectMediaInputConversationTask,
  digester: ContentDigester,
): ProjectMediaInputConversationTask {
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
    authority = captureProjectMediaInputStageAuthority(v.authority);
  const stage = parseProjectMediaInputStage(v.stage),
    sources = parseProjectMediaInputStageSources(v.sources, stage),
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
      loadMediaInputStageAdmission: method(
        input.stages,
        "loadMediaInputStageAdmission",
      ),
      readRequiredMediaInputStageDigest: method(
        input.stages,
        "readRequiredMediaInputStageDigest",
      ),
    }),
  });
}
export function projectMediaInputConversationTaskReceipt(
  base: ExtensionMutationReceipt,
  task: ProjectMediaInputConversationTask,
  digester: ContentDigester,
): ExtensionMutationReceipt {
  return Object.freeze({
    ...base,
    requestDigest: digester.sha256(
      extensionCanonicalJson({
        version: "crewon.project-media-input-stage-task-command.v1",
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
export function projectMediaInputConversationTaskAdmission(
  task: ProjectMediaInputConversationTask,
  admission: PluginTaskAdmission,
  binding: ExtensionRunBinding,
  at: string,
  digester: ContentDigester,
) {
  // A user can submit a previously displayed configuration; fail as a refreshable conflict before any Run is committed.
  if (task.stage.configurationRevision !== binding.configurationRevision)
    throw new ApplicationError(
      "conflict",
      "project_media_input_stage_configuration_changed",
    );
  return createProjectMediaInputStageRunAdmission(
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
export async function assertCurrentProjectMediaInputConversationBinding(
  task: Pick<
    ProjectMediaInputConversationTask,
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
export async function assertSavedProjectMediaInputConversationTask(
  task: ProjectMediaInputConversationTask,
  admission: PluginTaskAdmission,
  binding: ExtensionRunBinding,
  digester: ContentDigester,
  checkCurrent = true,
): Promise<ProjectMediaInputStageRunAdmission> {
  const locator = {
    tenantId: admission.tenantId,
    spaceId: admission.spaceId,
    runId: admission.runId,
  };
  const required = await task.stages.readRequiredMediaInputStageDigest(locator),
    saved = await task.stages.loadMediaInputStageAdmission(locator);
  if (
    saved === null ||
    required !== saved.contentDigest ||
    extensionCanonicalJson(saved) !==
      extensionCanonicalJson(
        projectMediaInputConversationTaskAdmission(
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
    await assertCurrentProjectMediaInputConversationBinding(task);
    await task.authority.assertCurrent();
    task.authority.assertActive();
  }
  return saved;
}
export async function prepareProjectMediaInputConversationTask(
  input:
    | ProjectMediaInputConversationTask
    | ProjectMediaInputConversationTaskPreparation,
  command: CreateExtensionTaskCommand,
  extensions: ExtensionStore,
  digester: ContentDigester,
): Promise<ProjectMediaInputConversationTask> {
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
    authority = captureProjectMediaInputStageAuthority(v.authority),
    stage = parseProjectMediaInputStage(v.stage);
  const conversations = Object.freeze({
    loadBinding: method(input.conversations, "loadBinding"),
  });
  const stages = Object.freeze({
    loadMediaInputStageAdmission: method(
      input.stages,
      "loadMediaInputStageAdmission",
    ),
    readRequiredMediaInputStageDigest: method(
      input.stages,
      "readRequiredMediaInputStageDigest",
    ),
  });
  await authority.assertCurrent();
  authority.assertActive();
  await assertCurrentProjectMediaInputConversationBinding({
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
    locator === null
      ? null
      : await stages.loadMediaInputStageAdmission(locator);
  if (
    admission !== null &&
    (saved === null ||
      (await stages.readRequiredMediaInputStageDigest(locator!)) !==
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
          v.prepareSources as () => Promise<ProjectMediaInputStageSources>
        ).call(input)
      : v.sources);
  return captureProjectMediaInputConversationTask(
    {
      binding,
      authority,
      stage,
      sources: parseProjectMediaInputStageSources(sources, stage),
      content: v.content as string,
      conversations,
      stages,
    },
    digester,
  );
}
export async function createProjectMediaInputStageTurnFromHost(
  input: Readonly<{
    actor: ActorContext;
    command: CreateExtensionTaskCommand;
    task:
      | ProjectMediaInputConversationTask
      | ProjectMediaInputConversationTaskPreparation;
    extensions: ExtensionStore;
    digester: ContentDigester;
    create(
      task: ProjectMediaInputConversationTask,
      onStage: (stage: ProjectMediaInputStageRunAdmission) => void,
    ): Promise<CommitExtensionTurnResult>;
  }>,
): Promise<
  Readonly<{
    result: CommitExtensionTurnResult;
    mediaInputStageAdmission: ProjectMediaInputStageRunAdmission;
  }>
> {
  const task = await prepareProjectMediaInputConversationTask(
    input.task,
    input.command,
    input.extensions,
    input.digester,
  );
  if (
    input.extensions.projectMediaInputStageAdmissionVersion !==
      "crewon.project-media-input-stage-run-admission.v1" ||
    extensionCanonicalJson(input.actor) !==
      extensionCanonicalJson(task.authority.actor) ||
    input.command.intent.kind !== "generate" ||
    extensionCanonicalJson(input.command.intent.input) !==
      extensionCanonicalJson({ prompt: task.content }) ||
    input.command.threadId !== task.binding.threadId
  )
    fail();
  let captured: ProjectMediaInputStageRunAdmission | undefined;
  const result = await input.create(task, (stage) => {
    captured = stage;
  });
  if (captured === undefined || captured.runId !== result.binding.runId) fail();
  return Object.freeze({ result, mediaInputStageAdmission: captured });
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
    "project_media_input_stage_admission_invalid",
  );
}
