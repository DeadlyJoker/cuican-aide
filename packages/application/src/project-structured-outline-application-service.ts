import {
  optionsOf,
  method,
  dataFields,
  outlineUseCase,
} from "./project-structured-outline-application-support.ts";
import {
  assertCreativeProjectScope,
  assertProjectTextRevisionIdentity,
  assertProjectStructuredOutlineInputs,
  changeProjectOutlineDocument,
  creativeProjectRevision,
  creativeProjectTimestamp,
  parseStoredProjectTextArtifactRevision,
  projectOutlineInputBinding,
  projectTextFailure,
  projectTextOpaqueId,
  projectTextRecord,
  saveProjectStructuredOutlineCandidate,
  selectProjectStructuredOutlineRevision,
  structuredProjectTextCanonicalJson,
  structuredProjectTextRecord,
  validateProjectFoundation,
  type CreativeProject,
  type ProjectFoundation,
  type ProjectStructuredOutlineRevision,
  type ProjectTextArtifact,
  type StoredProjectTextArtifactRevision,
  ProjectTextError,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { assertProjectOutlineUiMutationCommand } from "./project-outline-ui-commit-authority.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type {
  CreativeProjectStore,
  CreativeProjectCommitOptions,
  CreativeProjectCommitAuthority,
} from "./creative-project-store-port.ts";
import type { ProjectFoundationStore } from "./project-foundation-store-port.ts";
import type {
  ProjectStructuredOutlineStore,
  StoredProjectTextMutationResult,
} from "./project-structured-outline-store-port.ts";
import {
  captureCreativeProjectCommitAuthority,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitActive,
} from "./creative-project-commit-authority.ts";
import {
  checkedCreativeProject,
  checkedCreativeBrief,
  creativeActor,
  creativeOwner,
} from "./creative-project-application-support.ts";
import { checkedProjectTextArtifact } from "./project-text-application-records.ts";
import {
  projectTextInput,
  projectTextStored,
  projectTextInvalidStore,
  projectTextLimit,
} from "./project-text-application-support.ts";
import {
  parseProjectStructuredOutlineCommand,
  projectStructuredOutlineCommandReceipt,
  type SaveProjectStructuredOutlineCommand,
  type SelectProjectStructuredOutlineCommand,
  type ProjectStructuredOutlineCommand,
  type ProjectStructuredOutlineMutationKind,
} from "./project-structured-outline-commands.ts";

export type ProjectStructuredOutlineApplicationDependencies = Readonly<{
  store: Pick<
    ProjectStructuredOutlineStore,
    | "loadOutline"
    | "loadArtifact"
    | "loadStructuredRevision"
    | "listStructuredRevisions"
    | "loadStructuredMutationReceipt"
    | "commitStructuredOutlineCandidate"
    | "commitStructuredOutlineSelection"
  >;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  foundations: Pick<ProjectFoundationStore, "loadFoundation">;
  authorization: CreativeProjectAuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;
type Query = Readonly<{ projectId: string }>;
type RevisionQuery = Query &
  Readonly<{ artifactId: string; contentRevision: number }>;
export type ProjectStructuredOutlineView = Readonly<{
  artifact: ProjectTextArtifact;
  selectedRevision: StoredProjectTextArtifactRevision | null;
  latestRevision: StoredProjectTextArtifactRevision;
  staleReasons: readonly ("brief-changed" | "foundation-changed")[];
}>;

/** One original outline slot, immutable mixed history and exact small commands for manual work and Agent batches. */
export class ProjectStructuredOutlineApplicationService {
  readonly #d: ProjectStructuredOutlineApplicationDependencies;
  constructor(input: ProjectStructuredOutlineApplicationDependencies) {
    const fields = dataFields(input, [
      "store",
      "projects",
      "foundations",
      "authorization",
      "clock",
      "ids",
      "digester",
    ]);
    const store = fields.store as ProjectStructuredOutlineStore;
    const projects =
      fields.projects as ProjectStructuredOutlineApplicationDependencies["projects"];
    const foundations =
      fields.foundations as ProjectStructuredOutlineApplicationDependencies["foundations"];
    this.#d = Object.freeze({
      store: Object.freeze({
        loadOutline: method(store, "loadOutline"),
        loadArtifact: method(store, "loadArtifact"),
        loadStructuredRevision: method(store, "loadStructuredRevision"),
        listStructuredRevisions: method(store, "listStructuredRevisions"),
        loadStructuredMutationReceipt: method(
          store,
          "loadStructuredMutationReceipt",
        ),
        commitStructuredOutlineCandidate: method(
          store,
          "commitStructuredOutlineCandidate",
        ),
        commitStructuredOutlineSelection: method(
          store,
          "commitStructuredOutlineSelection",
        ),
      }),
      projects: Object.freeze({
        loadProject: method(projects, "loadProject"),
        loadBrief: method(projects, "loadBrief"),
      }),
      foundations: Object.freeze({
        loadFoundation: method(foundations, "loadFoundation"),
      }),
      authorization: Object.freeze({
        authorize: method(
          fields.authorization as CreativeProjectAuthorizationPort,
          "authorize",
        ),
      }),
      clock: Object.freeze({
        now: method(fields.clock as ApplicationClock, "now"),
      }),
      ids: Object.freeze({
        nextId: method(fields.ids as ApplicationIdGenerator, "nextId"),
      }),
      digester: Object.freeze({
        sha256: method(fields.digester as ContentDigester, "sha256"),
      }),
    });
  }
  saveCandidate(
    actor: ActorContext,
    input: SaveProjectStructuredOutlineCommand,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#mutate(actor, "save-outline", input, options);
  }
  selectRevision(
    actor: ActorContext,
    input: SelectProjectStructuredOutlineCommand,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#mutate(actor, "select-revision", input, options);
  }
  getOutline(
    actor: ActorContext,
    query: Query,
  ): Promise<ProjectStructuredOutlineView | null> {
    return this.#read(actor, query, ["projectId"], async (current, project) => {
      const raw = await this.#d.store.loadOutline(
        this.#scope(current, project.projectId),
      );
      if (raw === null) return null;
      const artifact = this.#outline(raw, project);
      const latestRevision = await this.#revision(
        current,
        project,
        artifact,
        artifact.latestContentRevision,
      );
      const selectedRevision =
        artifact.selectedContentRevision === null
          ? null
          : artifact.selectedContentRevision === latestRevision.contentRevision
            ? latestRevision
            : await this.#revision(
                current,
                project,
                artifact,
                artifact.selectedContentRevision,
              );
      const staleReasons: ("brief-changed" | "foundation-changed")[] = [];
      if (selectedRevision !== null) {
        if (
          selectedRevision.brief.briefRevision !== project.latestBriefRevision
        )
          staleReasons.push("brief-changed");
        if (
          selectedRevision.schemaVersion === "crewon.project-text-revision.v2"
        ) {
          const foundation = await this.#foundation(current, project);
          try {
            assertProjectStructuredOutlineInputs(
              selectedRevision,
              foundation,
              this.#d.digester,
            );
          } catch (cause) {
            if (!(cause instanceof ProjectTextError)) throw cause;
            staleReasons.push("foundation-changed");
          }
        }
      }
      return Object.freeze({
        artifact,
        latestRevision,
        selectedRevision,
        staleReasons: Object.freeze(staleReasons),
      });
    });
  }
  getRevision(
    actor: ActorContext,
    query: RevisionQuery,
  ): Promise<StoredProjectTextArtifactRevision> {
    return this.#read(
      actor,
      query,
      ["projectId", "artifactId", "contentRevision"],
      async (current, project, fields) => {
        const artifact = await this.#artifact(
          current,
          project,
          projectTextInput(() => projectTextOpaqueId(fields.artifactId)),
        );
        return this.#revision(
          current,
          project,
          artifact,
          projectTextInput(() =>
            creativeProjectRevision(fields.contentRevision),
          ),
        );
      },
    );
  }
  listRevisions(
    actor: ActorContext,
    query: Query &
      Readonly<{
        artifactId: string;
        afterContentRevision: number;
        limit: number;
      }>,
  ) {
    return this.#read(
      actor,
      query,
      ["projectId", "artifactId", "afterContentRevision", "limit"],
      async (current, project, fields) => {
        const artifact = await this.#artifact(
          current,
          project,
          projectTextInput(() => projectTextOpaqueId(fields.artifactId)),
        );
        const after = projectTextInput(() =>
          creativeProjectRevision(fields.afterContentRevision, { minimum: 0 }),
        );
        const limit = projectTextLimit(fields.limit);
        const page = await this.#d.store.listStructuredRevisions({
          ...this.#scope(current, project.projectId),
          artifactId: artifact.artifactId,
          afterContentRevision: after,
          limit,
        });
        if (!Array.isArray(page.revisions) || page.revisions.length > limit)
          projectTextStored(projectTextInvalidStore);
        const revisions: StoredProjectTextArtifactRevision[] = [];
        let previous = after;
        for (const raw of page.revisions) {
          const revision = await this.#checkedRevision(
            current,
            project,
            artifact,
            raw,
          );
          if (revision.contentRevision <= previous)
            projectTextStored(projectTextInvalidStore);
          previous = revision.contentRevision;
          revisions.push(revision);
        }
        if (
          page.nextContentRevision !== null &&
          (revisions.length === 0 || page.nextContentRevision !== previous)
        )
          projectTextStored(projectTextInvalidStore);
        return Object.freeze({
          revisions: Object.freeze(revisions),
          nextContentRevision: page.nextContentRevision,
        });
      },
    );
  }
  async #mutate(
    actorInput: ActorContext,
    kind: ProjectStructuredOutlineMutationKind,
    input: ProjectStructuredOutlineCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<StoredProjectTextMutationResult> {
    return outlineUseCase(async () => {
      const actor = creativeActor(actorInput),
        command = parseProjectStructuredOutlineCommand(kind, input);
      const authority = captureCreativeProjectCommitAuthority(options, {
        allowTextUiTransaction: true,
        allowPlanTransaction: true,
        allowOutlineUiTransaction: true,
      });
      // Neither legacy UI metadata, text v1, a plan locator nor Run-only callbacks qualify a new content protocol.
      if (
        authority?.transaction !== undefined ||
        authority?.textUiTransaction !== undefined ||
        authority?.planTransaction !== undefined ||
        authority?.runTransaction !== undefined
      )
        throw new ApplicationError(
          "authorization",
          "project_outline_commit_authority_unsupported",
        );
      assertProjectOutlineUiMutationCommand(
        authority,
        actor,
        kind,
        command,
        this.#d.digester,
      );
      const receipt = projectStructuredOutlineCommandReceipt(
        actor,
        kind,
        command,
        this.#d.digester,
      );
      await this.#authorize(actor, "creativeProject:write", command.projectId);
      await assertCreativeProjectCommitCurrent(authority);
      const existing = await this.#d.store.loadStructuredMutationReceipt(
        { actor, kind, receipt },
        optionsOf(authority),
      );
      const project = await this.#project(actor, command.projectId);
      if (existing !== null)
        return this.#replay(existing, actor, project, kind, command, authority);
      const commitOptions = {
        authority: Object.freeze({
          assertCurrent: async () => {
            await this.#authorize(
              actor,
              "creativeProject:write",
              command.projectId,
            );
            if (authority?.outlineUiTransaction)
              await authority.outlineUiTransaction.assertCurrent();
            else await assertCreativeProjectCommitCurrent(authority);
          },
          assertActive: () => assertCreativeProjectCommitActive(authority),
          ...(authority?.outlineUiTransaction === undefined
            ? {}
            : {
                outlineUiTransaction: Object.freeze({
                  ...authority.outlineUiTransaction,
                  assertCurrent: async () => {
                    await this.#authorize(
                      actor,
                      "creativeProject:write",
                      command.projectId,
                    );
                    await authority.outlineUiTransaction!.assertCurrent();
                  },
                }),
              }),
        }),
      };
      let prepared: Readonly<{
        artifact: ProjectTextArtifact;
        contentRevision: ProjectStructuredOutlineRevision;
      }>;
      try {
        prepared = await this.#prepare(actor, project, kind, command);
      } catch (cause) {
        if (
          !(cause instanceof ProjectTextError) ||
          cause.code !== "project_text_revision_conflict"
        )
          throw cause;
        const raced = await this.#d.store.loadStructuredMutationReceipt(
          { actor, kind, receipt },
          commitOptions,
        );
        if (raced === null) throw cause;
        return this.#replay(raced, actor, project, kind, command, authority);
      }
      await this.#authorize(actor, "creativeProject:write", command.projectId);
      await assertCreativeProjectCommitCurrent(authority);
      const common = {
        actor,
        receipt,
        project,
        expectedArtifactRevision: command.expectedArtifactRevision,
        ...prepared,
      };
      const raw =
        kind === "save-outline"
          ? await this.#d.store.commitStructuredOutlineCandidate(
              { ...common, kind },
              commitOptions,
            )
          : await this.#d.store.commitStructuredOutlineSelection(
              common,
              commitOptions,
            );
      const result = await this.#result(raw, actor, project, kind, command);
      if (result.disposition === "replayed")
        return this.#replay(result, actor, project, kind, command, authority);
      if (
        structuredProjectTextCanonicalJson({
          artifact: result.artifact,
          contentRevision: result.contentRevision,
        }) !== structuredProjectTextCanonicalJson(prepared)
      )
        projectTextStored(projectTextInvalidStore);
      return result;
    });
  }
  async #prepare(
    actor: ActorContext,
    project: CreativeProject,
    kind: ProjectStructuredOutlineMutationKind,
    command: ProjectStructuredOutlineCommand,
  ) {
    const foundation = await this.#foundation(actor, project);
    const at = creativeProjectTimestamp(this.#d.clock.now());
    const common = {
      actor,
      project,
      expectedArtifactRevision: command.expectedArtifactRevision,
      at,
    };
    if (kind === "save-outline") {
      const input = command as SaveProjectStructuredOutlineCommand;
      const raw = await this.#d.store.loadOutline(
        this.#scope(actor, project.projectId),
      );
      const artifact = raw === null ? null : this.#outline(raw, project);
      const content = await this.#changedContent(
        actor,
        project,
        artifact,
        input,
        foundation,
      );
      const brief = await this.#brief(actor, project, input.briefRevision);
      const prepared = saveProjectStructuredOutlineCandidate(
        {
          ...common,
          artifact,
          artifactId:
            artifact?.artifactId ??
            projectTextOpaqueId(this.#d.ids.nextId("artifact")),
          brief,
          inputs: projectOutlineInputBinding(foundation, this.#d.digester),
          content,
        },
        this.#d.digester,
      );
      assertProjectStructuredOutlineInputs(
        prepared.contentRevision,
        foundation,
        this.#d.digester,
      );
      return prepared;
    }
    const input = command as SelectProjectStructuredOutlineCommand;
    const artifact = await this.#artifact(actor, project, input.artifactId);
    const contentRevision = this.#structured(
      await this.#revision(actor, project, artifact, input.contentRevision),
    );
    assertProjectStructuredOutlineInputs(
      contentRevision,
      foundation,
      this.#d.digester,
    );
    return selectProjectStructuredOutlineRevision(
      {
        ...common,
        artifact,
        contentRevision,
        latestBrief: await this.#brief(
          actor,
          project,
          project.latestBriefRevision,
        ),
      },
      this.#d.digester,
    );
  }
  async #changedContent(
    actor: ActorContext,
    project: CreativeProject,
    artifact: ProjectTextArtifact | null,
    command: SaveProjectStructuredOutlineCommand,
    foundation?: ProjectFoundation,
  ) {
    if (command.base === null)
      return changeProjectOutlineDocument(null, command.change);
    if (artifact === null) projectTextFailure("project_outline_base_required");
    const base = this.#structured(
      await this.#revision(
        actor,
        project,
        artifact,
        command.base.contentRevision,
      ),
    );
    if (base.contentDigest !== command.base.contentDigest)
      projectTextFailure("project_outline_base_digest_mismatch");
    if (foundation !== undefined)
      assertProjectStructuredOutlineInputs(base, foundation, this.#d.digester);
    // All unsupplied fields are copied from one exact immutable revision, never from client state.
    return changeProjectOutlineDocument(base.content, command.change);
  }
  async #result(
    raw: unknown,
    actor: ActorContext,
    project: CreativeProject,
    kind: ProjectStructuredOutlineMutationKind,
    command: ProjectStructuredOutlineCommand,
  ) {
    const fields = projectTextStored(() =>
      structuredProjectTextRecord(raw, [
        "kind",
        "disposition",
        "artifact",
        "contentRevision",
      ]),
    );
    if (
      fields.kind !== kind ||
      (fields.disposition !== "committed" && fields.disposition !== "replayed")
    )
      projectTextStored(projectTextInvalidStore);
    const artifact = this.#outline(fields.artifact, project);
    const revision = this.#structured(
      await this.#checkedRevision(
        actor,
        project,
        artifact,
        fields.contentRevision,
      ),
    );
    if (artifact.revision !== command.expectedArtifactRevision + 1)
      projectTextStored(projectTextInvalidStore);
    if (kind === "select-revision") {
      const select = command as SelectProjectStructuredOutlineCommand;
      if (
        artifact.artifactId !== select.artifactId ||
        revision.contentRevision !== select.contentRevision ||
        artifact.selectedContentRevision !== select.contentRevision
      )
        projectTextStored(projectTextInvalidStore);
    } else {
      const save = command as SaveProjectStructuredOutlineCommand;
      if (
        revision.contentRevision !== artifact.latestContentRevision ||
        revision.brief.briefRevision !== save.briefRevision ||
        revision.createdByActorId !== actor.actorId
      )
        projectTextStored(projectTextInvalidStore);
      const content = await this.#changedContent(
        actor,
        project,
        artifact,
        save,
      );
      if (
        structuredProjectTextCanonicalJson(content) !==
        structuredProjectTextCanonicalJson(revision.content)
      )
        projectTextStored(projectTextInvalidStore);
    }
    return Object.freeze({
      kind,
      disposition: fields.disposition,
      artifact,
      contentRevision: revision,
    }) as StoredProjectTextMutationResult;
  }
  async #replay(
    raw: unknown,
    actor: ActorContext,
    project: CreativeProject,
    kind: ProjectStructuredOutlineMutationKind,
    command: ProjectStructuredOutlineCommand,
    authority: CreativeProjectCommitAuthority | undefined,
  ) {
    const result = await this.#result(raw, actor, project, kind, command);
    await this.#authorize(actor, "creativeProject:write", command.projectId);
    await assertCreativeProjectCommitCurrent(authority);
    assertCreativeProjectCommitActive(authority);
    return Object.freeze({ ...result, disposition: "replayed" as const });
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
    return outlineUseCase(async () => {
      const actor = creativeActor(actorInput),
        query = projectTextInput(() => projectTextRecord(input, fields));
      const id = projectTextInput(() => projectTextOpaqueId(query.projectId));
      await this.#authorize(actor, "creativeProject:read", id);
      const result = await work(actor, await this.#project(actor, id), query);
      await this.#authorize(actor, "creativeProject:read", id);
      return result;
    });
  }
  #scope(actor: ActorContext, projectId: string) {
    return Object.freeze({ owner: creativeOwner(actor), projectId });
  }
  async #project(actor: ActorContext, projectId: string) {
    const raw = await this.#d.projects.loadProject(
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
  ) {
    const raw = await this.#d.projects.loadBrief({
      ...this.#scope(actor, project.projectId),
      briefRevision,
    });
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_brief_not_found",
      );
    return checkedCreativeBrief(raw, project, this.#d.digester, briefRevision);
  }
  async #foundation(
    actor: ActorContext,
    project: CreativeProject,
  ): Promise<ProjectFoundation> {
    const raw = await this.#d.foundations.loadFoundation(
      this.#scope(actor, project.projectId),
    );
    if (raw === null)
      throw new ApplicationError(
        "conflict",
        "project_outline_confirmed_novel_required",
      );
    const foundation = projectTextStored(() => validateProjectFoundation(raw));
    projectTextStored(() => assertCreativeProjectScope(project, foundation));
    return foundation;
  }
  #outline(raw: unknown, project: CreativeProject): ProjectTextArtifact {
    const artifact = checkedProjectTextArtifact(raw, project);
    if (artifact.kind !== "outline") projectTextStored(projectTextInvalidStore);
    return artifact;
  }
  async #artifact(
    actor: ActorContext,
    project: CreativeProject,
    artifactId: string,
  ) {
    const raw = await this.#d.store.loadArtifact({
      ...this.#scope(actor, project.projectId),
      artifactId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "project_text_artifact_not_found");
    const artifact = this.#outline(raw, project);
    if (artifact.artifactId !== artifactId)
      projectTextStored(projectTextInvalidStore);
    return artifact;
  }
  async #revision(
    actor: ActorContext,
    project: CreativeProject,
    artifact: ProjectTextArtifact,
    contentRevision: number,
  ) {
    const raw = await this.#d.store.loadStructuredRevision({
      ...this.#scope(actor, project.projectId),
      artifactId: artifact.artifactId,
      contentRevision,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "project_text_revision_not_found");
    const revision = await this.#checkedRevision(actor, project, artifact, raw);
    if (revision.contentRevision !== contentRevision)
      projectTextStored(projectTextInvalidStore);
    return revision;
  }
  async #checkedRevision(
    actor: ActorContext,
    project: CreativeProject,
    artifact: ProjectTextArtifact,
    raw: unknown,
  ) {
    const revision = projectTextStored(() =>
      parseStoredProjectTextArtifactRevision(raw, this.#d.digester),
    );
    projectTextStored(() => {
      assertCreativeProjectScope(project, revision);
      assertProjectTextRevisionIdentity(artifact, revision);
    });
    if (
      revision.kind !== "outline" ||
      revision.contentRevision > artifact.latestContentRevision
    )
      projectTextStored(projectTextInvalidStore);
    const brief = await this.#brief(
      actor,
      project,
      revision.brief.briefRevision,
    );
    if (brief.contentDigest !== revision.brief.contentDigest)
      projectTextStored(projectTextInvalidStore);
    return revision;
  }
  #structured(
    revision: StoredProjectTextArtifactRevision,
  ): ProjectStructuredOutlineRevision {
    if (revision.schemaVersion !== "crewon.project-text-revision.v2")
      throw new ApplicationError(
        "conflict",
        "project_outline_structured_revision_required",
      );
    return revision;
  }
  async #authorize(
    actor: ActorContext,
    action: "creativeProject:read" | "creativeProject:write",
    projectId: string,
  ) {
    const decision = await this.#d.authorization.authorize({
      actor,
      action,
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId,
      },
    });
    if (decision.outcome !== "allow")
      throw new ApplicationError(
        "authorization",
        "creative_project_access_denied",
      );
  }
}
