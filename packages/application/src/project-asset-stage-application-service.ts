import {
  PROJECT_ASSET_STAGES_METHOD_ACTIONS,
  parseProjectAssetStagesActionRequest,
  parseProjectAssetStagesActionResponse,
  type ProjectAssetStageRequest,
  type ProjectAssetStageResponse,
  parseProjectAssetScriptSourceRequest,
  parseProjectAssetScriptSourceResponse,
  type ProjectAssetScriptSourceRequest,
  type ProjectAssetScriptSourceResponse,
} from "@crewon/contracts/project-asset-stages";
import {
  extensionCanonicalJson,
  parseProjectConversationBinding,
  parseProjectBriefRevision,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectTextDependencyStatus,
  validateCreativeProject,
  type ProjectAssetStageSources,
  type ProjectOutlineRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  CreativeProjectStore,
  PluginProjectReadStoreBinding,
} from "./creative-project-store-port.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import type { ProjectConversationStore } from "./project-conversation-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import type { ProjectAssetStageStore } from "./project-asset-stage-store-port.ts";
import type { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import {
  captureProjectAssetStageAuthority,
  assertProjectAssetStageActor,
  type ProjectAssetStageCommitAuthority,
} from "./project-asset-stage-authority.ts";
import {
  issuePluginProjectAssetStageReadScope,
  type ProjectAssetStageReadRequest,
} from "./project-asset-stage-read-scope.ts";
import { creativeOwner } from "./creative-project-application-support.ts";

export type ProjectAssetStageApplicationDependencies = Readonly<{
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  stages: ProjectAssetStageStore;
  threadStore: Pick<ThreadStore, "loadThreadInSpace">;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief"> &
    Partial<PluginProjectReadStoreBinding>;
  texts: Pick<
    ProjectTextStore,
    "loadScript" | "loadOutline" | "loadRevision" | "bindProjectReads"
  >;
  tasks: Pick<
    ExtensionTaskApplicationService,
    "createProjectAssetStageTurnFromHost"
  >;
  authorization: CreativeProjectAuthorizationPort;
  digester: ContentDigester;
}>;
type StageReaders = Readonly<{
  scope?: import("./plugin-project-read-scope.ts").PluginProjectReadScope;
  stages: ProjectAssetStageStore;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  texts: Pick<ProjectTextStore, "loadScript" | "loadOutline" | "loadRevision">;
}>;
/** Independent asset execution admission, using the original Turn/Run/funding transaction. */
export class ProjectAssetStageApplicationService {
  readonly #d: ProjectAssetStageApplicationDependencies;
  constructor(d: ProjectAssetStageApplicationDependencies) {
    if (d.stages.version !== "crewon.project-asset-stage-run-admission.v1")
      throw new Error("project_asset_stage_store_required");
    this.#d = Object.freeze({
      conversations: Object.freeze({
        loadBinding: d.conversations.loadBinding.bind(d.conversations),
      }),
      stages: Object.freeze({
        version: d.stages.version,
        ...(d.stages.bindProjectReads === undefined
          ? {}
          : { bindProjectReads: d.stages.bindProjectReads.bind(d.stages) }),
        migrate: d.stages.migrate.bind(d.stages),
        loadAssetStageAdmission: d.stages.loadAssetStageAdmission.bind(
          d.stages,
        ),
        readRequiredAssetStageDigest:
          d.stages.readRequiredAssetStageDigest.bind(d.stages),
      }),
      threadStore: Object.freeze({
        loadThreadInSpace: d.threadStore.loadThreadInSpace.bind(d.threadStore),
      }),
      projects: Object.freeze({
        ...(d.projects.bindProjectReads === undefined
          ? {}
          : { bindProjectReads: d.projects.bindProjectReads.bind(d.projects) }),
        loadProject: d.projects.loadProject.bind(d.projects),
        loadBrief: d.projects.loadBrief.bind(d.projects),
      }),
      texts: Object.freeze({
        ...(d.texts.bindProjectReads === undefined
          ? {}
          : { bindProjectReads: d.texts.bindProjectReads.bind(d.texts) }),
        loadScript: d.texts.loadScript.bind(d.texts),
        loadOutline: d.texts.loadOutline.bind(d.texts),
        loadRevision: d.texts.loadRevision.bind(d.texts),
      }),
      tasks: Object.freeze({
        createProjectAssetStageTurnFromHost:
          d.tasks.createProjectAssetStageTurnFromHost.bind(d.tasks),
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
    authority: ProjectAssetStageCommitAuthority,
  ): Promise<boolean> {
    const q = captureProjectAssetStageAuthority(authority);
    assertProjectAssetStageActor(actor, q);
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
    const readers = await this.#readers(q, b, {
      action: "crewon.project-asset-stage-read.v1",
      input: { purpose: "availability", projectId: b.projectId, threadId },
    });
    const project = await this.#project(
      q,
      b.projectId,
      "creativeProject:read",
      readers.projects,
    );
    if (!(await this.#allows(q, b.projectId, "creativeProject:write")))
      return false;
    const thread = await this.#d.threadStore.loadThreadInSpace({
      ...q.actor,
      threadId,
    });
    await q.assertCurrent();
    q.assertActive();
    await this.#authorize(q, b.projectId, "creativeProject:read");
    await this.#assertBindingCurrent(q, b);
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
    input: ProjectAssetStageRequest,
    authority: ProjectAssetStageCommitAuthority,
  ): Promise<ProjectAssetStageResponse> {
    const request = parseProjectAssetStagesActionRequest({
      action: PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage,
      input,
    });
    const q = captureProjectAssetStageAuthority(authority);
    assertProjectAssetStageActor(actor, q);
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
        "project_asset_stage_binding_conflict",
      );
    if (binding.revision !== r.expectedBindingRevision)
      throw new ApplicationError(
        "conflict",
        "project_conversation_revision_conflict",
      );
    const readers = await this.#readers(q, binding, {
      action: "crewon.project-asset-stage-read.v1",
      input: { ...r, purpose: "start-stage" },
    });
    await this.#project(
      q,
      r.projectId,
      "creativeProject:write",
      readers.projects,
    );
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
    const liveProjectAuthority: ProjectAssetStageCommitAuthority =
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
    const { result, assetStageAdmission } =
      await this.#d.tasks.createProjectAssetStageTurnFromHost(
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
          ...(r.modelId === undefined ? {} : { modelId: r.modelId }),
          authority: liveProjectAuthority,
          ...(readers.scope === undefined
            ? {}
            : { projectReadScope: readers.scope }),
          conversations: this.#d.conversations,
          stages: readers.stages,
          prepareSources: () => this.#sources(liveProjectAuthority, r, readers),
        },
      );
    return parseProjectAssetStagesActionResponse(request, {
      disposition: result.run.disposition,
      threadId: result.binding.threadId,
      threadRevision: result.turn.threadState.revision,
      runId: result.binding.runId,
      runRevision: result.run.state.revision,
      bindingRevision: assetStageAdmission.bindingRevision,
      stageAdmissionDigest: assetStageAdmission.contentDigest,
    });
  }
  async #readers(
    q: ProjectAssetStageCommitAuthority,
    binding: import("@crewon/domain").ProjectConversationBinding,
    request: ProjectAssetStageReadRequest,
  ): Promise<StageReaders> {
    await this.#authorize(q, binding.projectId, "creativeProject:read");
    q.assertActive();
    // The original negative filter identifies ordinary projects without lending
    // protected access. Absent/hidden projects must pass the exact bound reader.
    const ordinary = await this.#d.projects.loadProject({
      owner: creativeOwner(q.actor),
      projectId: binding.projectId,
    });
    await q.assertCurrent();
    q.assertActive();
    if (ordinary !== null) return this.#d;
    if (
      this.#d.projects.bindProjectReads === undefined ||
      this.#d.texts.bindProjectReads === undefined
    )
      throw new ApplicationError(
        "authorization",
        "project_asset_stage_read_scope_unavailable",
      );
    const scope = issuePluginProjectAssetStageReadScope({
      authority: q,
      binding,
      request,
      digester: this.#d.digester,
    });
    if (
      request.input.purpose === "start-stage" &&
      this.#d.stages.bindProjectReads === undefined
    )
      throw new ApplicationError(
        "authorization",
        "project_asset_stage_read_scope_unavailable",
      );
    return Object.freeze({
      scope,
      projects: this.#d.projects.bindProjectReads(scope),
      texts: this.#d.texts.bindProjectReads(scope),
      stages:
        request.input.purpose === "start-stage"
          ? this.#d.stages.bindProjectReads!(scope)
          : this.#d.stages,
    });
  }
  async getScriptSource(
    actor: ActorContext,
    input: ProjectAssetScriptSourceRequest,
    authority: ProjectAssetStageCommitAuthority,
  ): Promise<ProjectAssetScriptSourceResponse> {
    const r = parseProjectAssetScriptSourceRequest(input),
      q = captureProjectAssetStageAuthority(authority);
    assertProjectAssetStageActor(actor, q);
    await q.assertCurrent();
    q.assertActive();
    const raw = await this.#d.conversations.loadBinding({
      actor: q.actor,
      profileId: q.installation.profileId,
      threadId: r.threadId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "project_conversation_not_found");
    const b = parseProjectConversationBinding(raw, this.#d.digester);
    const readers = await this.#readers(q, b, {
      action: "crewon.project-asset-stage-read.v1",
      input: { ...r, purpose: "script-source" },
    });
    if (
      b.state !== "active" ||
      b.projectId !== r.projectId ||
      b.threadId !== r.threadId ||
      b.revision !== r.expectedBindingRevision ||
      extensionCanonicalJson(b.owner) !== extensionCanonicalJson(q.actor) ||
      extensionCanonicalJson(b.currentInstallation) !==
        extensionCanonicalJson(q.installation)
    )
      throw new ApplicationError(
        "authorization",
        "project_asset_stage_binding_conflict",
      );
    const thread = await this.#d.threadStore.loadThreadInSpace({
      ...q.actor,
      threadId: r.threadId,
    });
    if (
      thread === null ||
      thread.status !== "active" ||
      thread.createdByActorId !== q.actor.actorId ||
      (thread.workspaceId ?? null) !== b.workspaceId
    )
      throw new ApplicationError(
        "notFound",
        "project_conversation_thread_not_found",
      );
    const project = await this.#project(
      q,
      r.projectId,
      "creativeProject:read",
      readers.projects,
    );
    if (project.latestBriefRevision !== r.briefRevision) stale();
    const headRaw = await readers.texts.loadScript({
      owner: creativeOwner(q.actor),
      projectId: r.projectId,
      episodeId: r.episodeId,
    });
    const head = headRaw === null ? null : parseProjectTextArtifact(headRaw);
    let script: ProjectAssetScriptSourceResponse["script"] = null;
    if (head !== null && head.selectedContentRevision !== null) {
      const stageRequest: ProjectAssetStageRequest = {
        projectId: r.projectId,
        threadId: r.threadId,
        expectedThreadRevision: thread.revision,
        expectedBindingRevision: r.expectedBindingRevision,
        stage: {
          kind: "assets",
          assetKind: "character",
          briefRevision: r.briefRevision,
          script: {
            artifactId: head.artifactId,
            episodeId: r.episodeId,
            contentRevision: head.selectedContentRevision,
          },
        },
        content: "read selected source",
        idempotencyKey: "read-only-script-source",
      };
      await this.#sources(q, stageRequest, readers);
      script = stageRequest.stage.script;
    }
    await q.assertCurrent();
    await this.#authorize(q, r.projectId, "creativeProject:read");
    q.assertActive();
    await this.#assertBindingCurrent(q, b);
    return parseProjectAssetScriptSourceResponse(r, {
      projectId: r.projectId,
      threadId: r.threadId,
      bindingRevision: b.revision,
      briefRevision: r.briefRevision,
      episodeId: r.episodeId,
      script,
    });
  }
  async #sources(
    q: ProjectAssetStageCommitAuthority,
    r: ProjectAssetStageRequest,
    readers: StageReaders,
  ): Promise<ProjectAssetStageSources> {
    const owner = creativeOwner(q.actor),
      project = await this.#project(
        q,
        r.projectId,
        "creativeProject:read",
        readers.projects,
      );
    if (project.latestBriefRevision !== r.stage.briefRevision) stale();
    const raw = await readers.projects.loadBrief({
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
    let script: ProjectAssetStageSources["script"] = null;
    if (r.stage.script !== null) {
      const s = r.stage.script;
      const rawHead = await readers.texts.loadScript({
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
      const rawRevision = await readers.texts.loadRevision({
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
      const rawOutline = await readers.texts.loadOutline({
        owner,
        projectId: r.projectId,
      });
      const outline =
        rawOutline === null ? null : parseProjectTextArtifact(rawOutline);
      let selectedOutline: ProjectOutlineRevision | null = null;
      if (outline?.selectedContentRevision !== null && outline !== null) {
        const actual = await readers.texts.loadRevision({
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
  async #assertBindingCurrent(
    q: ProjectAssetStageCommitAuthority,
    expected: import("@crewon/domain").ProjectConversationBinding,
  ) {
    const raw = await this.#d.conversations.loadBinding({
      actor: q.actor,
      profileId: q.installation.profileId,
      threadId: expected.threadId,
    });
    if (
      raw === null ||
      extensionCanonicalJson(
        parseProjectConversationBinding(raw, this.#d.digester),
      ) !== extensionCanonicalJson(expected)
    )
      throw new ApplicationError(
        "conflict",
        "project_asset_stage_binding_conflict",
      );
    await q.assertCurrent();
    q.assertActive();
  }
  async #authorize(
    q: ProjectAssetStageCommitAuthority,
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
    q: ProjectAssetStageCommitAuthority,
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
    q: ProjectAssetStageCommitAuthority,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
    projects: StageReaders["projects"] = this.#d.projects,
  ) {
    await this.#authorize(q, projectId, action);
    const raw = await projects.loadProject({
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
  throw new ApplicationError("conflict", "project_asset_stage_sources_stale");
}
