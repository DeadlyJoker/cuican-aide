import {
  checkedProjectTextArtifactPage,
  checkedProjectTextRevisionPage,
  captureProjectTextDependencies,
  checkedProjectTextArtifact,
  checkedProjectTextRevision,
  checkedProjectTextMutationResult,
  projectTextDataFields,
  requiredProjectTextRevision,
} from "./project-text-application-records.ts";
import {
  assertCreativeProjectScope,
  assertProjectTextRevisionIdentity,
  projectTextOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  extensionCanonicalJson,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectTextDependencyStatus,
  projectTextRecord,
  saveProjectOutlineCandidate,
  saveProjectScriptCandidate,
  selectProjectTextRevision,
  setProjectTextArtifactLocked,
  ProjectTextError,
  type CreativeProject,
  type ProjectBriefRevision,
  type ProjectOutlineRevision,
  type ProjectTextArtifact,
  type ProjectTextArtifactRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectCommitOptions,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
} from "./creative-project-commit-authority.ts";
import {
  checkedCreativeBrief,
  checkedCreativeProject,
  compareCreativeIds,
  creativeActor,
  creativeOwner,
} from "./creative-project-application-support.ts";
import type {
  SaveProjectOutlineCandidateCommand,
  SaveProjectScriptCandidateCommand,
  SelectProjectTextRevisionCommand,
  SetProjectTextArtifactLockedCommand,
  ProjectTextMutationCommand,
} from "./project-text-commands.ts";
import type {
  ProjectTextArtifactView,
  ProjectTextMutationKind,
  ProjectTextMutationResult,
  ProjectTextStore,
} from "./project-text-store-port.ts";
import {
  captureProjectTextCommitAuthority,
  parseProjectTextMutationCommand,
  projectTextInput,
  projectTextInvalidStore,
  projectTextLimit,
  projectTextMutationReceipt,
  projectTextStored,
  projectTextUseCase,
} from "./project-text-application-support.ts";

export type ProjectTextApplicationDependencies = Readonly<{
  store: ProjectTextStore;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  authorization: CreativeProjectAuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;
type ProjectQuery = Readonly<{ projectId: string }>;
type ArtifactQuery = ProjectQuery & Readonly<{ artifactId: string }>;

/** UI and Agent share these owned metadata commands; no model, tool, Run or supplier is invoked. */
export class ProjectTextApplicationService {
  readonly #dependencies: ProjectTextApplicationDependencies;
  constructor(dependencies: ProjectTextApplicationDependencies) {
    this.#dependencies = captureProjectTextDependencies(dependencies);
  }
  saveOutlineCandidate(
    actor: ActorContext,
    command: SaveProjectOutlineCandidateCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult> {
    return this.#mutate(actor, "save-outline", command, options);
  }
  saveScriptCandidate(
    actor: ActorContext,
    command: SaveProjectScriptCandidateCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult> {
    return this.#mutate(actor, "save-script", command, options);
  }
  selectRevision(
    actor: ActorContext,
    command: SelectProjectTextRevisionCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult> {
    return this.#mutate(actor, "select-revision", command, options);
  }
  setLocked(
    actor: ActorContext,
    command: SetProjectTextArtifactLockedCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult> {
    return this.#mutate(actor, "set-lock", command, options);
  }

  getOutline(
    actor: ActorContext,
    query: ProjectQuery,
  ): Promise<ProjectTextArtifactView | null> {
    return this.#read(actor, query, ["projectId"], async (current, project) => {
      const raw = await this.#dependencies.store.loadOutline(
        this.#scope(current, project.projectId),
      );
      if (raw === null) return null;
      const artifact = checkedProjectTextArtifact(raw, project);
      if (artifact.kind !== "outline")
        projectTextStored(projectTextInvalidStore);
      return this.#view(current, project, artifact);
    });
  }
  getScript(
    actor: ActorContext,
    query: ProjectQuery & Readonly<{ episodeId: string }>,
  ): Promise<ProjectTextArtifactView | null> {
    return this.#read(
      actor,
      query,
      ["projectId", "episodeId"],
      async (current, project, checked) => {
        const episodeId = projectTextInput(() =>
          projectTextOpaqueId(checked.episodeId),
        );
        const raw = await this.#dependencies.store.loadScript({
          ...this.#scope(current, project.projectId),
          episodeId,
        });
        if (raw === null) return null;
        const artifact = checkedProjectTextArtifact(raw, project);
        if (artifact.kind !== "script" || artifact.episodeId !== episodeId)
          projectTextStored(projectTextInvalidStore);
        return this.#view(current, project, artifact);
      },
    );
  }
  getArtifact(
    actor: ActorContext,
    query: ArtifactQuery,
  ): Promise<ProjectTextArtifactView | null> {
    return this.#read(
      actor,
      query,
      ["projectId", "artifactId"],
      async (current, project, checked) => {
        const artifactId = projectTextInput(() =>
          projectTextOpaqueId(checked.artifactId),
        );
        const artifact = await this.#artifact(current, project, artifactId);
        return artifact === null
          ? null
          : this.#view(current, project, artifact);
      },
    );
  }
  getRevision(
    actor: ActorContext,
    query: ArtifactQuery & Readonly<{ contentRevision: number }>,
  ): Promise<ProjectTextArtifactRevision> {
    return this.#read(
      actor,
      query,
      ["projectId", "artifactId", "contentRevision"],
      async (current, project, checked) => {
        const artifactId = projectTextInput(() =>
          projectTextOpaqueId(checked.artifactId),
        );
        const contentRevision = projectTextInput(() =>
          creativeProjectRevision(checked.contentRevision),
        );
        const artifact = await this.#requiredArtifact(
          current,
          project,
          artifactId,
        );
        const revision = await this.#revision(
          current,
          project,
          artifact,
          contentRevision,
        );
        await this.#validateDependencies(current, project, revision);
        return revision;
      },
    );
  }
  listArtifacts(
    actor: ActorContext,
    query: ProjectQuery &
      Readonly<{ afterArtifactId: string | null; limit: number }>,
  ) {
    return this.#read(
      actor,
      query,
      ["projectId", "afterArtifactId", "limit"],
      async (current, project, checked) => {
        const afterArtifactId = projectTextInput(() =>
          checked.afterArtifactId === null
            ? null
            : projectTextOpaqueId(checked.afterArtifactId),
        );
        const limit = projectTextLimit(checked.limit);
        const raw = await this.#dependencies.store.listArtifacts({
          ...this.#scope(current, project.projectId),
          afterArtifactId,
          limit,
        });
        return checkedProjectTextArtifactPage(
          raw,
          project,
          afterArtifactId,
          limit,
        );
      },
    );
  }
  listRevisions(
    actor: ActorContext,
    query: ArtifactQuery &
      Readonly<{ afterContentRevision: number; limit: number }>,
  ) {
    return this.#read(
      actor,
      query,
      ["projectId", "artifactId", "afterContentRevision", "limit"],
      async (current, project, checked) => {
        const artifactId = projectTextInput(() =>
          projectTextOpaqueId(checked.artifactId),
        );
        const afterContentRevision = projectTextInput(() =>
          creativeProjectRevision(checked.afterContentRevision, { minimum: 0 }),
        );
        const limit = projectTextLimit(checked.limit);
        const artifact = await this.#requiredArtifact(
          current,
          project,
          artifactId,
        );
        const raw = await this.#dependencies.store.listRevisions({
          ...this.#scope(current, project.projectId),
          artifactId,
          afterContentRevision,
          limit,
        });
        const page = checkedProjectTextRevisionPage(
          raw,
          project,
          artifact,
          afterContentRevision,
          limit,
          this.#dependencies.digester,
        );
        for (const revision of page.revisions)
          await this.#validateDependencies(current, project, revision);
        return page;
      },
    );
  }

  #mutate(
    actorInput: ActorContext,
    kind: ProjectTextMutationKind,
    input: ProjectTextMutationCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult> {
    return projectTextUseCase(async () => {
      const authority = captureProjectTextCommitAuthority(options);
      const actor = creativeActor(actorInput);
      const command = parseProjectTextMutationCommand(kind, input);
      const receipt = projectTextMutationReceipt(
        actor,
        kind,
        command,
        this.#dependencies.digester,
      );
      await this.#authorize(actor, "creativeProject:write", command.projectId);
      await assertCreativeProjectCommitCurrent(authority);
      const previous = await this.#dependencies.store.loadMutationReceipt({
        actor,
        kind,
        receipt,
      });
      await assertCreativeProjectCommitCurrent(authority);
      const project = await this.#project(actor, command.projectId);
      if (previous !== null) {
        return this.#replayed(
          previous,
          actor,
          project,
          kind,
          command,
          authority,
        );
      }
      // This callback is policy-only: implementations must not borrow this Store's pool.
      // The Store rechecks the actual owner/project/dependencies on its existing connection.
      const commitOptions = Object.freeze({
        authority: Object.freeze({
          assertCurrent: async () => {
            await this.#authorize(
              actor,
              "creativeProject:write",
              command.projectId,
            );
            await assertCreativeProjectCommitCurrent(authority);
          },
          assertActive: () => assertCreativeProjectCommitActive(authority),
        }),
      });
      let prepared: Readonly<{
        artifact: ProjectTextArtifact;
        contentRevision: ProjectTextArtifactRevision | null;
      }>;
      try {
        prepared = await this.#prepare(actor, project, kind, command);
      } catch (cause) {
        // A concurrent identical command may commit between preflight receipt and head reads.
        if (
          !(cause instanceof ProjectTextError) ||
          cause.code !== "project_text_revision_conflict"
        )
          throw cause;
        await assertCreativeProjectCommitCurrent(authority);
        const raced = await this.#dependencies.store.loadMutationReceipt({
          actor,
          kind,
          receipt,
        });
        if (raced === null) throw cause;
        return this.#replayed(raced, actor, project, kind, command, authority);
      }
      await this.#authorize(actor, "creativeProject:write", command.projectId);
      await assertCreativeProjectCommitCurrent(authority);
      const common = {
        actor,
        receipt,
        project,
        expectedArtifactRevision: command.expectedArtifactRevision,
        artifact: prepared.artifact,
      };
      const raw =
        kind === "save-outline" || kind === "save-script"
          ? await this.#dependencies.store.commitCandidate(
              {
                ...common,
                kind,
                contentRevision: requiredProjectTextRevision(
                  prepared.contentRevision,
                ),
              },
              commitOptions,
            )
          : kind === "select-revision"
            ? await this.#dependencies.store.commitSelection(
                {
                  ...common,
                  contentRevision: requiredProjectTextRevision(
                    prepared.contentRevision,
                  ),
                },
                commitOptions,
              )
            : await this.#dependencies.store.commitLock(common, commitOptions);
      const result = checkedProjectTextMutationResult(
        raw,
        actor,
        project,
        kind,
        command,
        this.#dependencies.digester,
      );
      if (result.disposition === "replayed")
        return this.#replayed(result, actor, project, kind, command, authority);
      if (
        result.disposition === "committed" &&
        extensionCanonicalJson({
          artifact: result.artifact,
          contentRevision: result.contentRevision,
        }) !== extensionCanonicalJson(prepared)
      )
        projectTextStored(projectTextInvalidStore);
      return result;
    });
  }
  async #replayed(
    raw: unknown,
    actor: ActorContext,
    project: CreativeProject,
    kind: ProjectTextMutationKind,
    command: ProjectTextMutationCommand,
    authority: CreativeProjectCommitAuthority | undefined,
  ): Promise<ProjectTextMutationResult> {
    const result = checkedProjectTextMutationResult(
      raw,
      actor,
      project,
      kind,
      command,
      this.#dependencies.digester,
    );
    if (result.contentRevision !== null)
      await this.#validateDependencies(actor, project, result.contentRevision);
    await this.#authorize(actor, "creativeProject:write", command.projectId);
    await assertCreativeProjectCommitCurrent(authority);
    return Object.freeze({ ...result, disposition: "replayed" });
  }
  async #prepare(
    actor: ActorContext,
    project: CreativeProject,
    kind: ProjectTextMutationKind,
    command: ProjectTextMutationCommand,
  ) {
    const at = creativeProjectTimestamp(this.#dependencies.clock.now());
    const common = {
      actor,
      project,
      expectedArtifactRevision: command.expectedArtifactRevision,
      at,
    };
    if (kind === "save-outline" || kind === "save-script") {
      const input = command as
        | SaveProjectOutlineCandidateCommand
        | SaveProjectScriptCandidateCommand;
      const brief = await this.#brief(actor, project, input.briefRevision);
      const raw =
        kind === "save-outline"
          ? await this.#dependencies.store.loadOutline(
              this.#scope(actor, project.projectId),
            )
          : await this.#dependencies.store.loadScript({
              ...this.#scope(actor, project.projectId),
              episodeId: (input as SaveProjectScriptCandidateCommand).episodeId,
            });
      const artifact =
        raw === null ? null : checkedProjectTextArtifact(raw, project);
      if (
        artifact !== null &&
        (artifact.kind !== (kind === "save-outline" ? "outline" : "script") ||
          (kind === "save-script" &&
            artifact.episodeId !==
              (input as SaveProjectScriptCandidateCommand).episodeId))
      )
        projectTextStored(projectTextInvalidStore);
      const artifactId =
        artifact?.artifactId ??
        projectTextOpaqueId(this.#dependencies.ids.nextId("artifact"));
      if (kind === "save-outline")
        return saveProjectOutlineCandidate(
          {
            ...common,
            artifact,
            artifactId,
            brief,
            content: (input as SaveProjectOutlineCandidateCommand).content,
          },
          this.#dependencies.digester,
        );
      const script = input as SaveProjectScriptCandidateCommand;
      const outline =
        script.outline === null
          ? null
          : await this.#outlineRevision(
              actor,
              project,
              script.outline.artifactId,
              script.outline.contentRevision,
            );
      return saveProjectScriptCandidate(
        {
          ...common,
          artifact,
          artifactId,
          brief,
          episodeId: script.episodeId,
          outline,
          content: script.content,
        },
        this.#dependencies.digester,
      );
    }
    const input = command as
      | SelectProjectTextRevisionCommand
      | SetProjectTextArtifactLockedCommand;
    const artifact = await this.#requiredArtifact(
      actor,
      project,
      input.artifactId,
    );
    if (kind === "set-lock")
      return {
        ...setProjectTextArtifactLocked({
          ...common,
          artifact,
          locked: (input as SetProjectTextArtifactLockedCommand).locked,
        }),
        contentRevision: null,
      };
    const contentRevision = await this.#revision(
      actor,
      project,
      artifact,
      (input as SelectProjectTextRevisionCommand).contentRevision,
    );
    await this.#validateDependencies(actor, project, contentRevision);
    const latestBrief = await this.#brief(
      actor,
      project,
      project.latestBriefRevision,
    );
    const selectedOutline = await this.#selectedOutline(actor, project);
    return selectProjectTextRevision(
      { ...common, artifact, contentRevision, latestBrief, selectedOutline },
      this.#dependencies.digester,
    );
  }
  #read<T>(
    actorInput: ActorContext,
    input: unknown,
    fields: readonly string[],
    work: (
      actor: ActorContext,
      project: CreativeProject,
      query: Record<string, unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    return projectTextUseCase(async () => {
      const actor = creativeActor(actorInput);
      const query = projectTextInput(() => projectTextRecord(input, fields));
      const projectId = projectTextInput(() =>
        projectTextOpaqueId(query.projectId),
      );
      await this.#authorize(actor, "creativeProject:read", projectId);
      const project = await this.#project(actor, projectId);
      const result = await work(actor, project, query);
      await this.#authorize(actor, "creativeProject:read", projectId);
      return result;
    });
  }
  #scope(actor: ActorContext, projectId: string) {
    return Object.freeze({ owner: creativeOwner(actor), projectId });
  }
  async #project(actor: ActorContext, projectId: string) {
    const raw = await this.#dependencies.projects.loadProject(
      this.#scope(actor, projectId),
    );
    if (raw === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    return checkedCreativeProject(raw, creativeOwner(actor), projectId);
  }
  async #brief(
    actor: ActorContext,
    project: CreativeProject,
    briefRevision: number,
  ): Promise<ProjectBriefRevision> {
    const raw = await this.#dependencies.projects.loadBrief({
      ...this.#scope(actor, project.projectId),
      briefRevision,
    });
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_brief_not_found",
      );
    return checkedCreativeBrief(
      raw,
      project,
      this.#dependencies.digester,
      briefRevision,
    );
  }
  async #artifact(
    actor: ActorContext,
    project: CreativeProject,
    artifactId: string,
  ) {
    const raw = await this.#dependencies.store.loadArtifact({
      ...this.#scope(actor, project.projectId),
      artifactId,
    });
    return raw === null
      ? null
      : checkedProjectTextArtifact(raw, project, artifactId);
  }
  async #requiredArtifact(
    actor: ActorContext,
    project: CreativeProject,
    artifactId: string,
  ) {
    const artifact = await this.#artifact(actor, project, artifactId);
    if (artifact === null)
      throw new ApplicationError("notFound", "project_text_artifact_not_found");
    return artifact;
  }
  async #revision(
    actor: ActorContext,
    project: CreativeProject,
    artifact: ProjectTextArtifact,
    contentRevision: number,
  ) {
    const raw = await this.#dependencies.store.loadRevision({
      ...this.#scope(actor, project.projectId),
      artifactId: artifact.artifactId,
      contentRevision,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "project_text_revision_not_found");
    return checkedProjectTextRevision(
      raw,
      project,
      artifact,
      contentRevision,
      this.#dependencies.digester,
    );
  }
  async #outlineRevision(
    actor: ActorContext,
    project: CreativeProject,
    artifactId: string,
    contentRevision: number,
  ): Promise<ProjectOutlineRevision> {
    const artifact = await this.#requiredArtifact(actor, project, artifactId);
    const revision = await this.#revision(
      actor,
      project,
      artifact,
      contentRevision,
    );
    if (revision.kind !== "outline")
      throw new ApplicationError(
        "conflict",
        "project_text_outline_reference_invalid",
      );
    return revision;
  }
  async #selectedOutline(
    actor: ActorContext,
    project: CreativeProject,
  ): Promise<ProjectOutlineRevision | null> {
    const raw = await this.#dependencies.store.loadOutline(
      this.#scope(actor, project.projectId),
    );
    if (raw === null) return null;
    const artifact = checkedProjectTextArtifact(raw, project);
    if (artifact.kind !== "outline") projectTextStored(projectTextInvalidStore);
    if (artifact.selectedContentRevision === null) return null;
    const selected = await this.#outlineRevision(
      actor,
      project,
      artifact.artifactId,
      artifact.selectedContentRevision,
    );
    await this.#validateDependencies(actor, project, selected);
    return selected;
  }
  async #validateDependencies(
    actor: ActorContext,
    project: CreativeProject,
    revision: ProjectTextArtifactRevision,
  ) {
    const brief = await this.#brief(
      actor,
      project,
      revision.brief.briefRevision,
    );
    if (brief.contentDigest !== revision.brief.contentDigest)
      projectTextStored(projectTextInvalidStore);
    if (revision.kind === "script" && revision.outline !== null) {
      const outline = await this.#outlineRevision(
        actor,
        project,
        revision.outline.artifactId,
        revision.outline.contentRevision,
      );
      if (
        outline.contentDigest !== revision.outline.contentDigest ||
        outline.brief.briefRevision !== revision.brief.briefRevision ||
        outline.brief.contentDigest !== revision.brief.contentDigest ||
        !outline.content.episodes.some(
          (episode) => episode.episodeId === revision.episodeId,
        )
      )
        projectTextStored(projectTextInvalidStore);
    }
  }
  async #view(
    actor: ActorContext,
    project: CreativeProject,
    artifact: ProjectTextArtifact,
  ): Promise<ProjectTextArtifactView> {
    const selectedRevision =
      artifact.selectedContentRevision === null
        ? null
        : await this.#revision(
            actor,
            project,
            artifact,
            artifact.selectedContentRevision,
          );
    if (selectedRevision !== null)
      await this.#validateDependencies(actor, project, selectedRevision);
    const latestBrief = await this.#brief(
      actor,
      project,
      project.latestBriefRevision,
    );
    const selectedOutline =
      artifact.kind === "script"
        ? await this.#selectedOutline(actor, project)
        : null;
    return Object.freeze({
      artifact,
      selectedRevision,
      ...projectTextDependencyStatus(
        selectedRevision,
        latestBrief,
        selectedOutline,
      ),
    });
  }
  async #authorize(
    actor: ActorContext,
    action: "creativeProject:read" | "creativeProject:write",
    projectId: string,
  ) {
    try {
      const decision = await this.#dependencies.authorization.authorize(
        Object.freeze({
          actor,
          action,
          resource: Object.freeze({
            kind: "creativeProject",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            projectId,
          }),
        }),
      );
      if (decision.outcome !== "allow")
        throw new ApplicationError("authorization", "authorization_denied");
    } catch (cause) {
      if (cause instanceof ApplicationError) throw cause;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause,
      });
    }
  }
}
