import {
  PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS,
  parseProjectMediaInputStagesActionRequest,
  parseProjectMediaInputStagesActionResponse,
  type ProjectMediaInputStageRequest,
  type ProjectMediaInputStageResponse,
} from "@crewon/contracts/project-media-input-stages";
import {
  extensionCanonicalJson,
  parseProjectConversationBinding,
  parseProjectBriefRevision,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectTextDependencyStatus,
  validateCreativeProject,
  type ProjectMediaInputStageSources,
  type ProjectOutlineRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import type { ProjectConversationStore } from "./project-conversation-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import type { ProjectMediaInputStageStore } from "./project-media-input-stage-store-port.ts";
import type { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import {
  captureProjectMediaInputStageAuthority,
  assertProjectMediaInputStageActor,
  type ProjectMediaInputStageCommitAuthority,
} from "./project-media-input-stage-authority.ts";
import { creativeOwner } from "./creative-project-application-support.ts";

export type ProjectMediaInputStageApplicationDependencies = Readonly<{
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  stages: ProjectMediaInputStageStore;
  threadStore: Pick<ThreadStore, "loadThreadInSpace">;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  texts: Pick<ProjectTextStore, "loadScript" | "loadOutline" | "loadRevision">;
  tasks: Pick<
    ExtensionTaskApplicationService,
    "createProjectMediaInputStageTurnFromHost"
  >;
  authorization: CreativeProjectAuthorizationPort;
  digester: ContentDigester;
}>;
/** Media input preparation through the original Turn/Run and independently approved unmetered transaction. */
export class ProjectMediaInputStageApplicationService {
  readonly #d: ProjectMediaInputStageApplicationDependencies;
  constructor(d: ProjectMediaInputStageApplicationDependencies) {
    if (
      d.stages.version !== "crewon.project-media-input-stage-run-admission.v1"
    )
      throw new Error("project_media_input_stage_store_required");
    this.#d = Object.freeze({
      conversations: Object.freeze({
        loadBinding: d.conversations.loadBinding.bind(d.conversations),
      }),
      stages: Object.freeze({
        version: d.stages.version,
        migrate: d.stages.migrate.bind(d.stages),
        loadMediaInputStageAdmission:
          d.stages.loadMediaInputStageAdmission.bind(d.stages),
        readRequiredMediaInputStageDigest:
          d.stages.readRequiredMediaInputStageDigest.bind(d.stages),
      }),
      threadStore: Object.freeze({
        loadThreadInSpace: d.threadStore.loadThreadInSpace.bind(d.threadStore),
      }),
      projects: Object.freeze({
        loadProject: d.projects.loadProject.bind(d.projects),
        loadBrief: d.projects.loadBrief.bind(d.projects),
      }),
      texts: Object.freeze({
        loadScript: d.texts.loadScript.bind(d.texts),
        loadOutline: d.texts.loadOutline.bind(d.texts),
        loadRevision: d.texts.loadRevision.bind(d.texts),
      }),
      tasks: Object.freeze({
        createProjectMediaInputStageTurnFromHost:
          d.tasks.createProjectMediaInputStageTurnFromHost.bind(d.tasks),
      }),
      authorization: Object.freeze({
        authorize: d.authorization.authorize.bind(d.authorization),
      }),
      digester: Object.freeze({ sha256: d.digester.sha256.bind(d.digester) }),
    });
  }
  async isAvailable(
    actor: ActorContext,
    threadId: string,
    authority: ProjectMediaInputStageCommitAuthority,
  ): Promise<boolean> {
    const q = captureProjectMediaInputStageAuthority(authority);
    assertProjectMediaInputStageActor(actor, q);
    await q.assertCurrent();
    q.assertActive();
    const raw = await this.#d.conversations.loadBinding({
      actor: q.actor,
      profileId: q.installation.profileId,
      threadId,
    });
    if (raw === null) return false;
    const b = parseProjectConversationBinding(raw, this.#d.digester);
    if (
      b.state !== "active" ||
      extensionCanonicalJson(b.owner) !== extensionCanonicalJson(q.actor) ||
      extensionCanonicalJson(b.currentInstallation) !==
        extensionCanonicalJson(q.installation)
    )
      return false;
    const project = await this.#project(q, b.projectId, "creativeProject:read");
    if (!(await this.#allows(q, b.projectId, "creativeProject:write")))
      return false;
    const thread = await this.#d.threadStore.loadThreadInSpace({
      ...q.actor,
      threadId,
    });
    await q.assertCurrent();
    q.assertActive();
    await this.#authorize(q, b.projectId, "creativeProject:read");
    const writable = await this.#allows(
      q,
      b.projectId,
      "creativeProject:write",
    );
    q.assertActive();
    return (
      writable &&
      project.state === "active" &&
      project.latestBriefRevision > 0 &&
      thread !== null &&
      thread.status === "active" &&
      thread.createdByActorId === q.actor.actorId &&
      (thread.workspaceId ?? null) === b.workspaceId
    );
  }
  async startStage(
    actor: ActorContext,
    input: ProjectMediaInputStageRequest,
    authority: ProjectMediaInputStageCommitAuthority,
  ): Promise<ProjectMediaInputStageResponse> {
    const request = parseProjectMediaInputStagesActionRequest({
      action: PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS.startStage,
      input,
    });
    const q = captureProjectMediaInputStageAuthority(authority);
    assertProjectMediaInputStageActor(actor, q);
    await q.assertCurrent();
    q.assertActive();
    const r = request.input;
    const raw = await this.#d.conversations.loadBinding({
      actor: q.actor,
      profileId: q.installation.profileId,
      threadId: r.threadId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "project_conversation_not_found");
    const binding = parseProjectConversationBinding(raw, this.#d.digester);
    if (
      binding.state !== "active" ||
      binding.projectId !== r.projectId ||
      binding.profileId !== q.installation.profileId ||
      extensionCanonicalJson(binding.owner) !==
        extensionCanonicalJson(q.actor) ||
      extensionCanonicalJson(binding.currentInstallation) !==
        extensionCanonicalJson(q.installation)
    )
      throw new ApplicationError(
        "authorization",
        "project_media_input_stage_binding_conflict",
      );
    if (binding.revision !== r.expectedBindingRevision)
      throw new ApplicationError(
        "conflict",
        "project_conversation_revision_conflict",
      );
    await this.#project(q, r.projectId, "creativeProject:write");
    const thread = await this.#d.threadStore.loadThreadInSpace({
      ...q.actor,
      threadId: r.threadId,
    });
    if (
      thread === null ||
      thread.status !== "active" ||
      thread.createdByActorId !== q.actor.actorId ||
      (thread.workspaceId ?? null) !== binding.workspaceId
    )
      throw new ApplicationError(
        "notFound",
        "project_conversation_thread_not_found",
      );
    // Only the trusted PDP callback runs in the transaction; it never borrows the parent Store.
    const liveProjectAuthority: ProjectMediaInputStageCommitAuthority =
      Object.freeze({
        ...q,
        assertCurrent: async () => {
          await q.assertCurrent();
          await this.#authorize(q, r.projectId, "creativeProject:write");
          q.assertActive();
        },
        assertTransactionCurrent: async () => {
          await q.assertTransactionCurrent();
          await this.#authorize(q, r.projectId, "creativeProject:write");
          q.assertActive();
        },
      });
    const { result, mediaInputStageAdmission } =
      await this.#d.tasks.createProjectMediaInputStageTurnFromHost(
        q.actor,
        {
          pluginId: q.installation.pluginId,
          threadId: binding.threadId,
          expectedThreadRevision: r.expectedThreadRevision,
          idempotencyKey: r.idempotencyKey,
          intent: { kind: "generate", input: { prompt: r.content } },
        },
        {
          binding,
          stage: r.stage,
          content: r.content,
          authority: liveProjectAuthority,
          conversations: this.#d.conversations,
          stages: this.#d.stages,
          prepareSources: () => this.#sources(liveProjectAuthority, r),
        },
      );
    return parseProjectMediaInputStagesActionResponse(request, {
      disposition: result.run.disposition,
      threadId: result.binding.threadId,
      threadRevision: result.turn.threadState.revision,
      runId: result.binding.runId,
      runRevision: result.run.state.revision,
      bindingRevision: mediaInputStageAdmission.bindingRevision,
      stageAdmissionDigest: mediaInputStageAdmission.contentDigest,
    });
  }
  async #sources(
    q: ProjectMediaInputStageCommitAuthority,
    r: ProjectMediaInputStageRequest,
  ): Promise<ProjectMediaInputStageSources> {
    const owner = creativeOwner(q.actor),
      project = await this.#project(q, r.projectId, "creativeProject:read");
    if (project.latestBriefRevision !== r.stage.briefRevision) stale();
    const raw = await this.#d.projects.loadBrief({
      owner,
      projectId: r.projectId,
      briefRevision: r.stage.briefRevision,
    });
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_brief_not_found",
      );
    const brief = parseProjectBriefRevision(raw, this.#d.digester);
    let script: ProjectMediaInputStageSources["script"] = null;
    if (r.stage.script !== null) {
      const s = r.stage.script;
      const rawHead = await this.#d.texts.loadScript({
        owner,
        projectId: r.projectId,
        episodeId: s.episodeId,
      });
      if (rawHead === null) stale();
      const head = parseProjectTextArtifact(rawHead);
      if (
        head.artifactId !== s.artifactId ||
        head.selectedContentRevision !== s.contentRevision ||
        head.kind !== "script" ||
        head.episodeId !== s.episodeId
      )
        stale();
      const rawRevision = await this.#d.texts.loadRevision({
        owner,
        projectId: r.projectId,
        artifactId: s.artifactId,
        contentRevision: s.contentRevision,
      });
      if (rawRevision === null) stale();
      const revision = parseProjectTextArtifactRevision(
        rawRevision,
        this.#d.digester,
      );
      if (
        revision.kind !== "script" ||
        revision.episodeId !== s.episodeId ||
        revision.projectId !== r.projectId ||
        revision.artifactId !== s.artifactId
      )
        stale();
      const rawOutline = await this.#d.texts.loadOutline({
        owner,
        projectId: r.projectId,
      });
      const outline =
        rawOutline === null ? null : parseProjectTextArtifact(rawOutline);
      let selectedOutline: ProjectOutlineRevision | null = null;
      if (outline?.selectedContentRevision !== null && outline !== null) {
        const actual = await this.#d.texts.loadRevision({
          owner,
          projectId: r.projectId,
          artifactId: outline.artifactId,
          contentRevision: outline.selectedContentRevision,
        });
        if (actual === null) stale();
        const parsed = parseProjectTextArtifactRevision(
          actual,
          this.#d.digester,
        );
        if (parsed.kind !== "outline") stale();
        selectedOutline = parsed;
      }
      if (
        projectTextDependencyStatus(revision, brief, selectedOutline)
          .dependencyState !== "current"
      )
        stale();
      script = Object.freeze({ ...s, contentDigest: revision.contentDigest });
    }
    await q.assertCurrent();
    q.assertActive();
    return Object.freeze({
      brief: Object.freeze({
        briefRevision: brief.briefRevision,
        contentDigest: brief.contentDigest,
      }),
      script,
    });
  }
  async #authorize(
    q: ProjectMediaInputStageCommitAuthority,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ): Promise<void> {
    if (!(await this.#allows(q, projectId, action)))
      throw new ApplicationError(
        "authorization",
        "creative_project_access_denied",
      );
  }
  async #allows(
    q: ProjectMediaInputStageCommitAuthority,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ): Promise<boolean> {
    return (
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
      ).outcome === "allow"
    );
  }
  async #project(
    q: ProjectMediaInputStageCommitAuthority,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ) {
    await this.#authorize(q, projectId, action);
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
}
function stale(): never {
  throw new ApplicationError(
    "conflict",
    "project_media_input_stage_sources_stale",
  );
}
