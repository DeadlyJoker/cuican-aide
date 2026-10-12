import { projectConversationStageSources } from "./project-conversation-stage-sources.ts";
import { conversationStageProjectReader } from "./project-conversation-stage-project-reader.ts";
import { resolvePluginProjectWorkspaceTarget } from "./plugin-project-workspace-target.ts";
import { projectConversationCall } from "./project-conversation-call.ts";
import { captureProjectConversationDependencies } from "./project-conversation-dependencies.ts";
import {
  PROJECT_CONVERSATION_ASSOCIATION_ACTIONS as associationActions,
  parseProjectConversationAssociationRequest,
  parseProjectConversationAssociationResponse,
  type ProjectConversationAssociationRequest,
} from "@crewon/contracts/project-conversation-association";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
  type ProjectConversationsRequests,
  type ProjectConversationsResponses,
  type ProjectConversationsUiMethod,
  type PublicProjectConversationBinding,
} from "@crewon/contracts/project-conversations";
import {
  createProjectConversationBinding,
  extensionCanonicalJson,
  parseProjectConversationBinding,
  parseProjectStageRunAdmission,
  type ProjectConversationBinding,
} from "@crewon/domain";
import type {
  ProjectConversationCommitAuthority,
  ProjectConversationStore,
  ProjectConversationMutation,
} from "./project-conversation-store-port.ts";
import type { ThreadApplicationService } from "./thread-application-service.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import type {
  CreativeProjectStore,
  PluginProjectReadStoreBinding,
} from "./creative-project-store-port.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { projectConversationReceipt } from "./project-conversation-receipt.ts";
import type { PluginProjectReadScope } from "./plugin-project-read-scope.ts";
import { projectConversationPublicBinding } from "./project-conversation-projection.ts";
import { ownedConversationProjectWriteAuthority } from "./project-conversation-project-authority.ts";
import {
  readConversationProject,
  authorizeConversationProject,
} from "./project-conversation-project-reader.ts";
import { changeProjectConversationBinding } from "./project-conversation-binding-change.ts";
import { preparePluginProjectWorkspace } from "./plugin-project-workspace-preparation.ts";
import { prepareNativeWorkspaceConversation } from "./project-conversation-native-workspace.ts";
import type { PluginProjectWorkspaceNativeObservation } from "./plugin-project-workspace-native-observation.ts";
import type { PluginProjectWorkspaceNativeRegistrationStore } from "./plugin-project-workspace-store-port.ts";
import { conversationUiProjectReader } from "./project-conversation-ui-project-reader.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import type { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  captureProjectConversationAuthority,
  assertProjectConversationActor,
} from "./project-conversation-authority.ts";
import { ApplicationError } from "./application-error.ts";
import { readProjectConversationBinding } from "./project-conversation-binding-reader.ts";
import { creativeOwner } from "./creative-project-application-support.ts";
export type ProjectConversationApplicationDependencies = Readonly<{
  conversations: ProjectConversationStore;
  threads: Pick<ThreadApplicationService, "prepareCreateThread">;
  threadStore: Pick<ThreadStore, "loadThreadInSpace">;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief"> &
    Partial<PluginProjectReadStoreBinding>;
  texts: Pick<
    ProjectTextStore,
    "loadOutline" | "loadRevision" | "loadOutlineSourceRevision"
  >;
  tasks: Pick<
    ExtensionTaskApplicationService,
    "createProjectConversationTurnFromHost"
  >;
  authorization: CreativeProjectAuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;
export type ProjectConversationRequests = ProjectConversationsRequests;
export type ProjectConversationCallAuthority =
  ProjectConversationCommitAuthority;

/** Authenticated project operations; creating/opening a binding alone never issues a Run grant. */
export class ProjectConversationApplicationService {
  readonly #d: ProjectConversationApplicationDependencies;
  constructor(d: ProjectConversationApplicationDependencies) {
    this.#d = captureProjectConversationDependencies(d);
  }
  /** Read-only target discovery on the original qualified project store. */
  resolveWorkspaceTargetFromPluginUi(
    context: PluginUiActionContext,
    authority: ProjectConversationCommitAuthority,
  ) {
    return projectConversationCall(() =>
      resolvePluginProjectWorkspaceTarget({
        context,
        authority,
        projects: this.#d.projects,
        authorization: this.#d.authorization,
      }),
    );
  }
  /** Private Host preparation; it creates no directory, namespace, Thread or Run. */
  prepareWorkspaceFromPluginUi(
    context: PluginUiActionContext,
    authority: ProjectConversationCommitAuthority,
  ) {
    return projectConversationCall(() =>
      preparePluginProjectWorkspace({
        context,
        authority,
        projects: this.#d.projects,
        authorization: this.#d.authorization,
      }),
    );
  }
  /** Explicit Host opt-in, using only the genuine original UI invocation and its independent Conversation authority. */
  createConversationFromNativeObservation(
    input: Readonly<{
      context: PluginUiActionContext;
      authority: ProjectConversationCommitAuthority;
      observation: PluginProjectWorkspaceNativeObservation;
      registration: PluginProjectWorkspaceNativeRegistrationStore;
    }>,
  ) {
    return projectConversationCall(async () => {
      const prepared = await prepareNativeWorkspaceConversation({
        ...input,
        projects: this.#d.projects,
        createdAt: this.#d.clock.now(),
      });
      return this.#createConversation(
        input.context.actor,
        prepared.request,
        input.authority,
        { store: prepared.projects, readScope: prepared.readScope },
      );
    });
  }
  /** Explicit Host opt-in, using only the genuine original UI invocation and its independent Conversation authority. */
  async metadataFromPluginUi(
    context: PluginUiActionContext,
    authority: ProjectConversationCommitAuthority,
  ) {
    const view = conversationUiProjectReader({
      context,
      authority,
      projects: this.#d.projects,
    });
    switch (view.request.action) {
      case PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding:
        return this.#getBinding(
          context.actor,
          view.request.input,
          authority,
          view.projects,
        );
      case PROJECT_CONVERSATIONS_METHOD_ACTIONS.listConversations:
        return this.#listConversations(
          context.actor,
          view.request.input,
          authority,
          view.projects,
        );
      case PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation:
        return this.#createConversation(
          context.actor,
          view.request.input,
          authority,
          { store: view.projects, readScope: view.scope },
        );
      case PROJECT_CONVERSATIONS_METHOD_ACTIONS.openConversation:
        return this.#openConversation(
          context.actor,
          view.request.input,
          authority,
          view.projects,
        );
      case PROJECT_CONVERSATIONS_METHOD_ACTIONS.refreshSource:
        return this.#change(
          "refreshSource",
          context.actor,
          view.request.input,
          authority,
          { store: view.projects, readScope: view.scope },
        );
      case PROJECT_CONVERSATIONS_METHOD_ACTIONS.setState:
        return this.#change(
          "setState",
          context.actor,
          view.request.input,
          authority,
          { store: view.projects, readScope: view.scope },
        );
      default:
        throw new ApplicationError(
          "authorization",
          "plugin_project_read_method_mismatch",
        );
    }
  }
  /** Association adds project metadata only; it never rewrites a Thread or starts a Run. */
  async associateConversation(
    actor: ActorContext,
    input: ProjectConversationAssociationRequest,
    authority: ProjectConversationCommitAuthority,
  ) {
    return projectConversationCall(async () => {
      const request = parseProjectConversationAssociationRequest(input),
        q = await this.#authority(actor, authority);
      await this.#project(q, request.input.projectId, "creativeProject:write");
      const output = (value: unknown) =>
        parseProjectConversationAssociationResponse(request, value);
      if (request.action === associationActions.attach) {
        const receipt = this.#receipt("attach", request.input, q);
        const previous = await this.#d.conversations.loadMutationReceipt({
          actor: q.actor,
          profileId: q.installation.profileId,
          receipt,
        });
        if (previous !== null) {
          await this.#thread(q, previous.binding);
          await q.assertCurrent();
          q.assertActive();
          return output({
            disposition: previous.disposition,
            binding: this.#public(previous.binding),
          });
        }
      }
      const thread = await this.#d.threadStore.loadThreadInSpace({
        ...q.actor,
        threadId: request.input.threadId,
      });
      if (
        thread === null ||
        thread.status !== "active" ||
        thread.createdByActorId !== q.actor.actorId
      )
        throw new ApplicationError(
          "notFound",
          "project_conversation_thread_not_found",
        );
      if (request.action === associationActions.inspect) {
        const alreadyBound = await this.#d.conversations.hasThreadBinding({
          tenantId: q.actor.tenantId,
          spaceId: q.actor.spaceId,
          threadId: thread.threadId,
        });
        await q.assertCurrent();
        q.assertActive();
        return output({
          candidate: alreadyBound
            ? null
            : {
                threadId: thread.threadId,
                threadRevision: thread.revision,
                workspaceId: thread.workspaceId ?? null,
              },
        });
      }
      if (
        thread.revision !== request.input.expectedThreadRevision ||
        (thread.workspaceId ?? null) !== request.input.workspaceId
      )
        throw new ApplicationError(
          "conflict",
          "project_conversation_thread_conflict",
        );
      const now = this.#d.clock.now();
      const binding = createProjectConversationBinding(
        {
          bindingId: this.#d.ids.nextId("artifact"),
          owner: q.actor,
          profileId: q.installation.profileId,
          projectId: request.input.projectId,
          threadId: thread.threadId,
          workspaceId: thread.workspaceId ?? null,
          revision: 1,
          state: "active",
          currentInstallation: q.installation,
          createdAt: now,
          updatedAt: now,
        },
        this.#d.digester,
      );
      const result = await this.#d.conversations.commitBinding(
        {
          kind: "create",
          binding,
          expectedRevision: 0,
          receipt: this.#receipt("attach", request.input, q),
          existingThread: {
            expectedRevision: request.input.expectedThreadRevision,
          },
        },
        { authority: q },
      );
      return output({
        disposition: result.disposition,
        binding: this.#public(result.binding),
      });
    });
  }
  async getBinding(
    actor: ActorContext,
    input: ProjectConversationsRequests["getBinding"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["getBinding"]> {
    return this.#getBinding(actor, input, authority, this.#d.projects);
  }
  async #getBinding(
    actor: ActorContext,
    input: ProjectConversationsRequests["getBinding"],
    authority: ProjectConversationCommitAuthority,
    projects: Pick<CreativeProjectStore, "loadProject">,
  ): Promise<ProjectConversationsResponses["getBinding"]> {
    return projectConversationCall(async () => {
      const request = this.#input("getBinding", input),
        q = await this.#authority(actor, authority),
        b = await readProjectConversationBinding({
          authority: q,
          threadId: request.threadId,
          conversations: this.#d.conversations,
          readProject: (projectId) =>
            this.#project(q, projectId, "creativeProject:read", projects),
          readThread: (binding) => this.#thread(q, binding),
          assertProjectCurrent: (projectId) =>
            authorizeConversationProject({
              authority: q,
              projectId,
              action: "creativeProject:read",
              authorization: this.#d.authorization,
            }),
        });
      return this.#output("getBinding", request, {
        binding: b === null ? null : this.#public(b),
      });
    });
  }
  async listConversations(
    actor: ActorContext,
    input: ProjectConversationsRequests["listConversations"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["listConversations"]> {
    return this.#listConversations(actor, input, authority, this.#d.projects);
  }
  async #listConversations(
    actor: ActorContext,
    input: ProjectConversationsRequests["listConversations"],
    authority: ProjectConversationCommitAuthority,
    projects: Pick<CreativeProjectStore, "loadProject">,
  ) {
    return projectConversationCall(async () => {
      const request = this.#input("listConversations", input),
        q = await this.#authority(actor, authority);
      await this.#project(
        q,
        request.projectId,
        "creativeProject:read",
        projects,
      );
      const page = await this.#d.conversations.listBindings({
        actor: q.actor,
        profileId: q.installation.profileId,
        ...request,
      });
      const bindings = page.bindings.map((b) => this.#public(b));
      let nextThreadId = page.nextThreadId;
      while (
        bindings.length > 0 &&
        Buffer.byteLength(JSON.stringify({ bindings, nextThreadId }), "utf8") >
          24 * 1024
      ) {
        bindings.pop();
        nextThreadId = bindings.at(-1)?.threadId ?? null;
      }
      if (page.bindings.length > 0 && bindings.length === 0)
        throw new ApplicationError(
          "internal",
          "project_conversation_response_invalid",
        );
      await q.assertCurrent();
      q.assertActive();
      return this.#output("listConversations", request, {
        bindings,
        nextThreadId,
      });
    });
  }
  async createConversation(
    actor: ActorContext,
    input: ProjectConversationsRequests["createConversation"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["createConversation"]> {
    return this.#createConversation(actor, input, authority, {
      store: this.#d.projects,
    });
  }
  async #createConversation(
    actor: ActorContext,
    input: ProjectConversationsRequests["createConversation"],
    authority: ProjectConversationCommitAuthority,
    projects: Readonly<{
      store: Pick<CreativeProjectStore, "loadProject">;
      readScope?: PluginProjectReadScope;
    }>,
  ) {
    return projectConversationCall(async () => {
      const request = this.#input("createConversation", input),
        captured = await this.#authority(actor, authority),
        q =
          projects.readScope === undefined
            ? captured
            : ownedConversationProjectWriteAuthority({
                authority: captured,
                projectId: request.projectId,
                authorization: this.#d.authorization,
              });
      await this.#project(
        q,
        request.projectId,
        "creativeProject:write",
        projects.store,
      );
      const receipt = projectConversationReceipt({
          kind: "create",
          input: request,
          authority: q,
          digester: this.#d.digester,
          ...(projects.readScope === undefined
            ? {}
            : { readScope: projects.readScope }),
        }),
        previous = await this.#d.conversations.loadMutationReceipt({
          actor: q.actor,
          profileId: q.installation.profileId,
          receipt,
        });
      if (previous !== null) {
        await this.#thread(q, previous.binding);
        await q.assertCurrent();
        q.assertActive();
        return this.#mutation("createConversation", request, previous);
      }
      const thread = await this.#d.threads.prepareCreateThread(q.actor, {
        kind: "thread.create",
        workspaceId: request.workspaceId,
        title: request.title,
        idempotencyKey: receipt.idempotencyKey,
      });
      const event = thread.events[0];
      if (event?.type !== "thread.created")
        throw new ApplicationError(
          "internal",
          "project_conversation_thread_invalid",
        );
      const now = this.#d.clock.now(),
        binding = createProjectConversationBinding(
          {
            bindingId: this.#d.ids.nextId("artifact"),
            owner: q.actor,
            profileId: q.installation.profileId,
            projectId: request.projectId,
            threadId: event.identity.threadId,
            workspaceId: request.workspaceId,
            revision: 1,
            state: "active",
            currentInstallation: q.installation,
            createdAt: now,
            updatedAt: now,
          },
          this.#d.digester,
        );
      return this.#mutation(
        "createConversation",
        request,
        await this.#d.conversations.commitBinding(
          { kind: "create", binding, expectedRevision: 0, receipt, thread },
          { authority: q },
        ),
      );
    });
  }
  async openConversation(
    actor: ActorContext,
    input: ProjectConversationsRequests["openConversation"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["openConversation"]> {
    return this.#openConversation(actor, input, authority, this.#d.projects);
  }
  async #openConversation(
    actor: ActorContext,
    input: ProjectConversationsRequests["openConversation"],
    authority: ProjectConversationCommitAuthority,
    projects: Pick<CreativeProjectStore, "loadProject">,
  ) {
    return projectConversationCall(async () => {
      const request = this.#input("openConversation", input),
        q = await this.#authority(actor, authority),
        b = await this.#binding(q, request.projectId, request.threadId);
      await this.#project(q, b.projectId, "creativeProject:read", projects);
      await this.#thread(q, b);
      await q.assertCurrent();
      q.assertActive();
      return this.#output("openConversation", request, {
        binding: this.#public(b),
      });
    });
  }
  async refreshSource(
    actor: ActorContext,
    input: ProjectConversationsRequests["refreshSource"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["refreshSource"]> {
    return this.#change("refreshSource", actor, input, authority);
  }
  async setState(
    actor: ActorContext,
    input: ProjectConversationsRequests["setState"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["setState"]> {
    return this.#change("setState", actor, input, authority);
  }
  async #change<M extends "refreshSource" | "setState">(
    method: M,
    actor: ActorContext,
    input: ProjectConversationsRequests[M],
    authority: ProjectConversationCommitAuthority,
    projects: Readonly<{
      store: Pick<CreativeProjectStore, "loadProject">;
      readScope?: PluginProjectReadScope;
    }> = { store: this.#d.projects },
  ): Promise<ProjectConversationsResponses[M]> {
    return projectConversationCall(async () => {
      const request = this.#input(method, input);
      const q = await this.#authority(actor, authority);
      const result = await changeProjectConversationBinding({
        method,
        request,
        authority: q,
        dependencies: this.#d,
        projects: projects.store,
        ...(projects.readScope === undefined
          ? {}
          : { readScope: projects.readScope }),
        loadBinding: (current, projectId, threadId) =>
          this.#binding(current, projectId, threadId, false),
        assertThread: (current, binding) => this.#thread(current, binding),
      });
      return this.#mutation(method, request, result);
    });
  }
  async startStage(
    actor: ActorContext,
    input: ProjectConversationsRequests["startStage"],
    authority: ProjectConversationCommitAuthority,
    options: Readonly<{ projectReadScope?: PluginProjectReadScope }> = {},
  ): Promise<ProjectConversationsResponses["startStage"]> {
    const request = this.#input("startStage", input),
      { result, stageAdmission } = await this.startProjectTurn(
        actor,
        request,
        authority,
        options,
      );
    return this.#output("startStage", request, {
      disposition: result.run.disposition,
      threadId: result.binding.threadId,
      threadRevision: result.turn.threadState.revision,
      runId: result.binding.runId,
      runRevision: result.run.state.revision,
      bindingRevision: stageAdmission.bindingRevision,
      stageAdmissionDigest: stageAdmission.contentDigest,
    });
  }
  async startProjectTurn(
    actor: ActorContext,
    input: ProjectConversationsRequests["startStage"],
    authority: ProjectConversationCommitAuthority,
    options: Readonly<{ projectReadScope?: PluginProjectReadScope }> = {},
  ) {
    return projectConversationCall(async () => {
      const request = this.#input("startStage", input),
        captured = await this.#authority(actor, authority),
        q =
          options.projectReadScope === undefined
            ? captured
            : ownedConversationProjectWriteAuthority({
                authority: captured,
                projectId: request.projectId,
                authorization: this.#d.authorization,
              }),
        projects =
          options.projectReadScope === undefined
            ? this.#d.projects
            : await conversationStageProjectReader({
                scope: options.projectReadScope,
                authority: q,
                request,
                projects: this.#d.projects,
              }),
        b = await this.#binding(q, request.projectId, request.threadId);
      await this.#project(q, b.projectId, "creativeProject:write", projects);
      await this.#thread(q, b);
      if (b.revision !== request.expectedBindingRevision)
        throw new ApplicationError(
          "conflict",
          "project_conversation_revision_conflict",
        );
      const { result, stageAdmission } =
        await this.#d.tasks.createProjectConversationTurnFromHost(
          q.actor,
          {
            pluginId: q.installation.pluginId,
            threadId: b.threadId,
            expectedThreadRevision: request.expectedThreadRevision,
            idempotencyKey: request.idempotencyKey,
            intent: { kind: "generate", input: { prompt: request.content } },
          },
          {
            binding: b,
            stage: request.stage,
            prepareSources: () =>
              projectConversationStageSources({
                authority: q,
                request,
                projects,
                texts: this.#d.texts,
                authorization: this.#d.authorization,
                digester: this.#d.digester,
              }),
            content: request.content,
            ...(request.modelId === undefined
              ? {}
              : { modelId: request.modelId }),
            authority: q,
            conversations: this.#d.conversations,
          },
        );

      return { result, stageAdmission };
    });
  }
  async #authority(
    actor: ActorContext,
    input: ProjectConversationCommitAuthority,
  ) {
    const q = captureProjectConversationAuthority(input);
    assertProjectConversationActor(actor, q);
    await q.assertCurrent();
    q.assertActive();
    return q;
  }
  #project(
    q: ProjectConversationCommitAuthority,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
    projects: Pick<CreativeProjectStore, "loadProject"> = this.#d.projects,
  ) {
    return readConversationProject({
      authority: q,
      projectId,
      action,
      projects,
      authorization: this.#d.authorization,
    });
  }
  async #binding(
    q: ProjectConversationCommitAuthority,
    projectId: string,
    threadId: string,
    current = true,
  ) {
    const raw = await this.#d.conversations.loadBinding({
      actor: q.actor,
      profileId: q.installation.profileId,
      threadId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "project_conversation_not_found");
    const b = parseProjectConversationBinding(raw, this.#d.digester);
    if (
      b.projectId !== projectId ||
      extensionCanonicalJson(b.owner) !== extensionCanonicalJson(q.actor) ||
      b.profileId !== q.installation.profileId ||
      (current &&
        (b.state !== "active" ||
          extensionCanonicalJson(b.currentInstallation) !==
            extensionCanonicalJson(q.installation)))
    )
      throw new ApplicationError(
        "conflict",
        "project_conversation_source_mismatch",
      );
    return b;
  }
  async #thread(
    q: ProjectConversationCommitAuthority,
    b: ProjectConversationBinding,
  ) {
    const t = await this.#d.threadStore.loadThreadInSpace({
      ...q.actor,
      threadId: b.threadId,
    });
    if (
      t === null ||
      t.status === "deleted" ||
      t.createdByActorId !== b.owner.actorId ||
      (t.workspaceId ?? null) !== b.workspaceId
    )
      throw new ApplicationError(
        "notFound",
        "project_conversation_thread_not_found",
      );
  }
  #receipt(
    kind: string,
    input: Readonly<{ idempotencyKey: string }>,
    q: ProjectConversationCommitAuthority,
  ) {
    return projectConversationReceipt({
      kind,
      input,
      authority: q,
      digester: this.#d.digester,
    });
  }
  #input<M extends ProjectConversationsUiMethod>(
    method: M,
    input: ProjectConversationsRequests[M],
  ): ProjectConversationsRequests[M] {
    try {
      return parseProjectConversationsActionRequest({
        action: PROJECT_CONVERSATIONS_METHOD_ACTIONS[method],
        input,
      }).input as ProjectConversationsRequests[M];
    } catch (cause) {
      throw new ApplicationError(
        "validation",
        "project_conversation_command_invalid",
        { cause },
      );
    }
  }
  #output<M extends ProjectConversationsUiMethod>(
    method: M,
    input: ProjectConversationsRequests[M],
    value: unknown,
  ): ProjectConversationsResponses[M] {
    return parseProjectConversationsActionResponse(
      { action: PROJECT_CONVERSATIONS_METHOD_ACTIONS[method], input } as never,
      value,
    ) as ProjectConversationsResponses[M];
  }
  #public(raw: ProjectConversationBinding): PublicProjectConversationBinding {
    return projectConversationPublicBinding(raw, this.#d.digester);
  }
  #mutation<M extends "createConversation" | "refreshSource" | "setState">(
    method: M,
    input: ProjectConversationsRequests[M],
    m: ProjectConversationMutation,
  ) {
    return this.#output(method, input, {
      disposition: m.disposition,
      binding: this.#public(m.binding),
    });
  }
}
