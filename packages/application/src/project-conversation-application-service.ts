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
  validateCreativeProject,
  parseProjectBriefRevision,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  type ProjectConversationBinding,
  type ProjectStageSources,
} from "@crewon/domain";
import type {
  ProjectConversationCommitAuthority,
  ProjectConversationStore,
  ProjectConversationMutation,
} from "./project-conversation-store-port.ts";
import type { ThreadApplicationService } from "./thread-application-service.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
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
import { creativeOwner } from "./creative-project-application-support.ts";
export type ProjectConversationApplicationDependencies = Readonly<{
  conversations: ProjectConversationStore;
  threads: Pick<ThreadApplicationService, "prepareCreateThread">;
  threadStore: Pick<ThreadStore, "loadThreadInSpace">;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  texts: Pick<ProjectTextStore, "loadOutline" | "loadRevision">;
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
  /** Association adds project metadata only; it never rewrites a Thread or starts a Run. */
  async associateConversation(
    actor: ActorContext,
    input: ProjectConversationAssociationRequest,
    authority: ProjectConversationCommitAuthority,
  ) {
    return this.#call(async () => {
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
    return this.#call(async () => {
      const request = this.#input("getBinding", input),
        q = await this.#authority(actor, authority),
        b = await this.#d.conversations.loadBinding({
          actor: q.actor,
          profileId: q.installation.profileId,
          threadId: request.threadId,
        });
      if (b === null) {
        if (
          await this.#d.conversations.hasThreadBinding({
            tenantId: q.actor.tenantId,
            spaceId: q.actor.spaceId,
            threadId: request.threadId,
          })
        )
          throw new ApplicationError(
            "authorization",
            "project_conversation_source_mismatch",
          );
        return this.#output("getBinding", request, { binding: null });
      }
      await this.#project(q, b.projectId, "creativeProject:read");
      await this.#thread(q, b);
      await q.assertCurrent();
      q.assertActive();
      return this.#output("getBinding", request, { binding: this.#public(b) });
    });
  }
  async listConversations(
    actor: ActorContext,
    input: ProjectConversationsRequests["listConversations"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["listConversations"]> {
    return this.#call(async () => {
      const request = this.#input("listConversations", input),
        q = await this.#authority(actor, authority);
      await this.#project(q, request.projectId, "creativeProject:read");
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
    return this.#call(async () => {
      const request = this.#input("createConversation", input),
        q = await this.#authority(actor, authority);
      await this.#project(q, request.projectId, "creativeProject:write");
      const receipt = this.#receipt("create", request, q),
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
    return this.#call(async () => {
      const request = this.#input("openConversation", input),
        q = await this.#authority(actor, authority),
        b = await this.#binding(q, request.projectId, request.threadId);
      await this.#project(q, b.projectId, "creativeProject:read");
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
  ): Promise<ProjectConversationsResponses[M]> {
    return this.#call(async () => {
      const request = this.#input(method, input),
        q = await this.#authority(actor, authority);
      await this.#project(q, request.projectId, "creativeProject:write");
      const kind = method === "refreshSource" ? "refresh-source" : "set-state",
        receipt = this.#receipt(kind, request, q),
        previous = await this.#d.conversations.loadMutationReceipt({
          actor: q.actor,
          profileId: q.installation.profileId,
          receipt,
        });
      if (previous !== null) {
        await q.assertCurrent();
        q.assertActive();
        return this.#mutation(method, request, previous);
      }
      const b = await this.#binding(
        q,
        request.projectId,
        request.threadId,
        false,
      );
      await this.#thread(q, b);
      if (b.revision !== request.expectedBindingRevision)
        throw new ApplicationError(
          "conflict",
          "project_conversation_revision_conflict",
        );
      if (
        b.currentInstallation.pluginId !== q.installation.pluginId ||
        b.currentInstallation.publisherId !== q.installation.publisherId
      )
        throw new ApplicationError(
          "authorization",
          "project_conversation_source_mismatch",
        );
      const { schemaVersion: _schema, contentDigest: _digest, ...body } = b;
      const binding = createProjectConversationBinding(
        {
          ...body,
          revision: b.revision + 1,
          updatedAt: this.#d.clock.now(),
          currentInstallation:
            method === "refreshSource" ? q.installation : b.currentInstallation,
          state:
            method === "setState"
              ? (request as ProjectConversationsRequests["setState"]).state
              : b.state,
        },
        this.#d.digester,
      );
      return this.#mutation(
        method,
        request,
        await this.#d.conversations.commitBinding(
          { kind, binding, expectedRevision: b.revision, receipt },
          { authority: q },
        ),
      );
    });
  }
  async startStage(
    actor: ActorContext,
    input: ProjectConversationsRequests["startStage"],
    authority: ProjectConversationCommitAuthority,
  ): Promise<ProjectConversationsResponses["startStage"]> {
    const request = this.#input("startStage", input),
      { result, stageAdmission } = await this.startProjectTurn(
        actor,
        request,
        authority,
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
  ) {
    return this.#call(async () => {
      const request = this.#input("startStage", input),
        q = await this.#authority(actor, authority),
        b = await this.#binding(q, request.projectId, request.threadId);
      await this.#project(q, b.projectId, "creativeProject:write");
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
            prepareSources: () => this.#sources(q, request),
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
  async #sources(
    q: ProjectConversationCommitAuthority,
    request: ProjectConversationsRequests["startStage"],
  ): Promise<ProjectStageSources> {
    const owner = creativeOwner(q.actor),
      project = await this.#project(
        q,
        request.projectId,
        "creativeProject:read",
      ),
      stage = request.stage,
      briefRevision =
        stage.kind === "discussion"
          ? project.latestBriefRevision
          : stage.briefRevision;
    const raw =
        briefRevision === 0
          ? null
          : await this.#d.projects.loadBrief({
              owner,
              projectId: request.projectId,
              briefRevision,
            }),
      brief =
        raw === null ? null : parseProjectBriefRevision(raw, this.#d.digester);
    if (stage.kind !== "discussion" && brief === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_brief_not_found",
      );
    let outline: ProjectStageSources["outline"] = null;
    if (stage.kind === "script" && stage.outline !== null) {
      const rawHead = await this.#d.texts.loadOutline({
        owner,
        projectId: request.projectId,
      });
      if (rawHead === null)
        throw new ApplicationError(
          "notFound",
          "project_text_artifact_not_found",
        );
      const head = parseProjectTextArtifact(rawHead);
      if (head.artifactId !== stage.outline.artifactId)
        throw new ApplicationError(
          "conflict",
          "project_text_dependencies_stale",
        );
      const rawRevision = await this.#d.texts.loadRevision({
        owner,
        projectId: request.projectId,
        ...stage.outline,
      });
      if (rawRevision === null)
        throw new ApplicationError(
          "notFound",
          "project_text_revision_not_found",
        );
      const revision = parseProjectTextArtifactRevision(
        rawRevision,
        this.#d.digester,
      );
      if (
        revision.kind !== "outline" ||
        !revision.content.episodes.some(
          (e) => e.episodeId === stage.episodeId,
        ) ||
        revision.brief.briefRevision !== stage.briefRevision
      )
        throw new ApplicationError(
          "conflict",
          "project_text_dependencies_stale",
        );
      outline = { ...stage.outline, contentDigest: revision.contentDigest };
    }
    return Object.freeze({
      brief:
        brief === null
          ? null
          : Object.freeze({
              briefRevision: brief.briefRevision,
              contentDigest: brief.contentDigest,
            }),
      outline,
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
  async #project(
    q: ProjectConversationCommitAuthority,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ) {
    if (
      (
        await this.#d.authorization.authorize({
          actor: q.actor,
          action,
          resource: {
            kind: "creativeProject",
            tenantId: q.actor.tenantId,
            spaceId: q.actor.spaceId,
            projectId,
          },
        })
      ).outcome !== "allow"
    )
      throw new ApplicationError(
        "authorization",
        "creative_project_access_denied",
      );
    const raw = await this.#d.projects.loadProject({
      owner: creativeOwner(q.actor),
      projectId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    const p = validateCreativeProject(raw);
    if (
      p.tenantId !== q.actor.tenantId ||
      p.spaceId !== q.actor.spaceId ||
      p.ownerPrincipalId !== q.actor.principalId ||
      p.projectId !== projectId
    )
      throw new ApplicationError(
        "authorization",
        "creative_project_access_denied",
      );
    if (p.state !== "active" && action === "creativeProject:write")
      throw new ApplicationError("conflict", "creative_project_archived");
    return p;
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
    return {
      actor: q.actor,
      idempotencyKey: `project-conversation:${this.#d.digester.sha256(extensionCanonicalJson([q.actor, q.installation.profileId, input.idempotencyKey])).slice(7)}`,
      requestDigest: this.#d.digester.sha256(
        extensionCanonicalJson({
          version: "crewon.project-conversation-command.v1",
          kind,
          actor: q.actor,
          installation: q.installation,
          input,
        }),
      ),
    };
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
    const b = parseProjectConversationBinding(raw, this.#d.digester),
      i = b.currentInstallation;
    return {
      bindingId: b.bindingId,
      projectId: b.projectId,
      threadId: b.threadId,
      workspaceId: b.workspaceId,
      revision: b.revision,
      state: b.state,
      source: {
        pluginId: i.pluginId,
        publisherId: i.publisherId,
        version: i.version,
        packageDigest: i.packageDigest,
        selectionRevision: i.selectionRevision,
      },
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
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
  async #call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const code =
        error instanceof Error
          ? error.message
          : "project_conversation_service_unavailable";
      throw new ApplicationError(
        code.includes("not_found")
          ? "notFound"
          : code.includes("conflict") || code.includes("mismatch")
            ? "conflict"
            : code.includes("authority")
              ? "authorization"
              : "internal",
        code,
        { cause: error },
      );
    }
  }
}
