import {
  appendProjectBriefRevision,
  confirmProjectProposal,
  createCreativeProject,
  createProjectFoundation,
  createProjectProposal,
  creativeProjectOpaqueId,
  creativeProjectTimestamp,
  extensionCanonicalJson,
  parseProjectSource,
  parseProjectSourceChapter,
  parseProjectSourceChunk,
  setProjectFoundationCreativeStartMode,
  setProjectFoundationSource,
  updateProjectFoundationParameters,
  validateProjectProposal,
  type CreativeProject,
  type ProjectFoundation,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  CreativeProjectAuthorizationAction,
  CreativeProjectAuthorizationPort,
} from "./creative-project-authorization-port.ts";
import type {
  CreativeProjectMutationReceipt,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import {
  checkedCreativeProject,
  creativeActor,
  creativeOwner,
} from "./creative-project-application-support.ts";
import type * as Commands from "./project-foundation-commands.ts";
import type {
  ProjectFoundationCommitAuthority,
  ProjectFoundationCommitOptions,
  ProjectFoundationMutationKind,
  ProjectFoundationMutationResult,
  ProjectFoundationStore,
} from "./project-foundation-store-port.ts";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitCurrent,
  captureProjectFoundationCommitAuthority,
  qualifyProjectFoundationPluginCommit,
} from "./project-foundation-commit-authority.ts";
import {
  capturePreparedProjectSource,
  type PreparedProjectSource,
  type ProjectSourcePreparationPort,
} from "./project-source-preparation-port.ts";
import {
  checkedFoundation,
  checkedFoundationResult,
  checkedProposal,
  checkedSource,
  foundationCommand,
  foundationEqual,
  foundationStored,
  foundationUseCase,
} from "./project-foundation-application-support.ts";
import { ProjectFoundationReader } from "./project-foundation-application-reads.ts";
import {
  bindSourceAdoption,
  captureProjectSourceAdoptionAuthority,
} from "./project-source-adoption-authority.ts";

export type ProjectFoundationApplicationDependencies = Readonly<{
  projects: Pick<CreativeProjectStore, "loadProject">;
  store: ProjectFoundationStore;
  sourcePreparation: ProjectSourcePreparationPort;
  authorization: CreativeProjectAuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
  /** Explicit legacy test/internal ingestion only; production defaults to durable upload admission. */
  sourceAdmission?: "trusted-internal-recipe";
}>;
type Prepared = Readonly<{
  records: Partial<ProjectFoundationMutationResult>;
  commit(): Promise<ProjectFoundationMutationResult>;
}>;
const actualFoundationServices = new WeakSet<object>();
export function isProjectFoundationApplicationService(input: unknown): input is ProjectFoundationApplicationService {
  return input !== null && typeof input === "object" && actualFoundationServices.has(input);
}
/** Metadata/source/proposal use cases over the original project identity. No upload endpoint,
 * supplier execution, second project/thread store, or permission grant is introduced here. */
export class ProjectFoundationApplicationService {
  readonly #dependencies: ProjectFoundationApplicationDependencies;
  readonly #reader: ProjectFoundationReader;
  readonly #sourceAdmission: ProjectFoundationApplicationDependencies["sourceAdmission"];
  constructor(dependencies: ProjectFoundationApplicationDependencies) {
    if (
      dependencies.sourceAdmission !== undefined &&
      dependencies.sourceAdmission !== "trusted-internal-recipe"
    )
      throw new ApplicationError(
        "validation",
        "project_foundation_source_admission_invalid",
      );
    this.#dependencies = dependencies;
    this.#sourceAdmission = dependencies.sourceAdmission;
    this.#reader = new ProjectFoundationReader({
      projects: dependencies.projects,
      store: dependencies.store,
      digester: dependencies.digester,
      authorize: (actor, projectId) =>
        this.#authorize(actor, "creativeProject:read", projectId),
    });
    actualFoundationServices.add(this);
  }
  createProject(
    actor: ActorContext,
    command: Commands.CreateProjectFoundationCommand,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#mutate(actor, "create-project", command, options);
  }
  updateParameters(
    actor: ActorContext,
    command: Commands.UpdateProjectFoundationParametersCommand,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#mutate(actor, "update-parameters", command, options);
  }
  appendSource(
    actor: ActorContext,
    command: Commands.AppendProjectFoundationSourceCommand,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#mutate(actor, "append-source", command, options);
  }
  saveProposal(
    actor: ActorContext,
    command: Commands.SaveProjectProposalCommand,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#mutate(actor, "save-proposal", command, options);
  }
  confirmProposal(
    actor: ActorContext,
    command: Commands.ConfirmProjectProposalCommand,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#mutate(actor, "confirm-proposal", command, options);
  }
  chooseCreativeStartMode(
    actor: ActorContext,
    command: Commands.ChooseProjectFoundationStartModeCommand,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#mutate(actor, "choose-direct-script", command, options);
  }
  getFoundation(actor: ActorContext, query: Commands.ProjectFoundationQuery) {
    return this.#reader.getFoundation(actor, query);
  }
  getSource(actor: ActorContext, query: Commands.ProjectSourceQuery) {
    return this.#reader.getSource(actor, query);
  }
  readSourcePage(actor: ActorContext, query: Commands.ProjectSourcePageQuery) {
    return this.#reader.readSourcePage(actor, query);
  }
  listSourceChapters(
    actor: ActorContext,
    query: Commands.ProjectSourceChaptersQuery,
  ) {
    return this.#reader.listSourceChapters(actor, query);
  }
  getProposal(actor: ActorContext, query: Commands.ProjectProposalQuery) {
    return this.#reader.getProposal(actor, query);
  }
  listProposals(actor: ActorContext, query: Commands.ProjectProposalsQuery) {
    return this.#reader.listProposals(actor, query);
  }

  #mutate(
    actorInput: ActorContext,
    kind: ProjectFoundationMutationKind,
    input: Commands.ProjectFoundationMutationCommand,
    options?: ProjectFoundationCommitOptions,
  ) {
    return foundationUseCase(async () => {
      const actor = creativeActor(actorInput);
      const command = foundationCommand(kind, input);
      const captured = captureProjectFoundationCommitAuthority(options);
      qualifyProjectFoundationPluginCommit(captured, actor, kind);
      const projectId = "projectId" in command ? command.projectId : null;
      const action =
        kind === "create-project"
          ? "creativeProject:create"
          : "creativeProject:write";
      const current = () => this.#authorize(actor, action, projectId);
      const authority = bindPolicy(captured, current);
      const commitOptions = Object.freeze({ authority });
      const receipt = Object.freeze({
        idempotencyKey: command.idempotencyKey,
        requestDigest: this.#dependencies.digester.sha256(
          extensionCanonicalJson({
            schemaVersion: "crewon.project-foundation-command.v1",
            actor,
            kind,
            command,
          }),
        ),
      });
      await assertProjectFoundationCommitCurrent(authority);
      const previous = await this.#dependencies.store.loadMutationReceipt(
        { actor, kind, receipt },
        commitOptions,
      );
      if (previous !== null) {
        const result = checkedFoundationResult(
          previous,
          actor,
          kind,
          command,
          this.#dependencies.digester,
        );
        await assertProjectFoundationCommitCurrent(authority);
        return Object.freeze({ ...result, disposition: "replayed" as const });
      }
      await assertProjectFoundationCommitCurrent(authority);
      const prepared = await this.#prepare(
        actor,
        kind,
        command,
        receipt,
        commitOptions,
      );
      await assertProjectFoundationCommitCurrent(authority);
      const raw = await prepared.commit();
      const result = checkedFoundationResult(
        raw,
        actor,
        kind,
        command,
        this.#dependencies.digester,
      );
      if (result.disposition === "committed") {
        // A confirmed commit is a durable fact. Only validate its data, never reauthorize it.
        foundationStored(() => {
          for (const key of Object.keys(
            prepared.records,
          ) as (keyof ProjectFoundationMutationResult)[])
            foundationEqual(result[key], prepared.records[key]);
        });
      } else await assertProjectFoundationCommitCurrent(authority);
      return result;
    });
  }
  async #prepare(
    actor: ActorContext,
    kind: ProjectFoundationMutationKind,
    command: Commands.ProjectFoundationMutationCommand,
    receipt: CreativeProjectMutationReceipt,
    options: ProjectFoundationCommitOptions,
  ): Promise<Prepared> {
    const identity = { actor, receipt };
    if (kind === "create-project") {
      const requested = command as Commands.CreateProjectFoundationCommand;
      const preparation =
        requested.sourceUpload === null
          ? null
          : await this.#prepareSource(actor, requested.sourceUpload, null);
      const sourceOptions = bindSourceAdoption(
        options,
        preparation?.authority ?? null,
      );
      await assertProjectFoundationCommitCurrent(sourceOptions.authority);
      const at = creativeProjectTimestamp(this.#dependencies.clock.now());
      const initial = createCreativeProject({
        scope: {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          projectId: creativeProjectOpaqueId(
            this.#dependencies.ids.nextId("creativeProject"),
          ),
        },
        title: requested.title,
        actor,
        at,
      });
      const { project, brief } = appendProjectBriefRevision(
        {
          project: initial,
          actor,
          expectedProjectRevision: initial.revision,
          text: requested.briefText,
          at,
        },
        this.#dependencies.digester,
      );
      const sourceRecords = scopeSource(
        preparation?.source ?? null,
        project,
        actor,
        1,
        at,
      );
      const foundation = createProjectFoundation({
        project,
        actor,
        expectedProjectRevision: project.revision,
        origin: requested.origin,
        parameters: requested.parameters,
        source:
          sourceRecords.source === null
            ? null
            : { revision: 1, digest: sourceRecords.source.digest },
        creativeStartMode: requested.creativeStartMode,
        at,
      });
      return {
        records: {
          project,
          brief,
          foundation,
          source: sourceRecords.source,
          proposal: null,
        },
        commit: () =>
          this.#dependencies.store.commitCreation(
            {
              ...identity,
              project,
              initialBrief: brief,
              foundation,
              ...sourceRecords,
            },
            sourceOptions,
          ),
      };
    }
    const requested = command as Exclude<
      Commands.ProjectFoundationMutationCommand,
      Commands.CreateProjectFoundationCommand
    >;
    const project = await this.#project(actor, requested.projectId);
    await assertProjectFoundationCommitCurrent(options.authority);
    if (project.state !== "active")
      throw new ApplicationError(
        "conflict",
        "project_foundation_project_archived",
      );
    const raw = await this.#dependencies.store.loadFoundation({
      owner: creativeOwner(actor),
      projectId: project.projectId,
    });
    await assertProjectFoundationCommitCurrent(options.authority);
    if (raw === null)
      throw new ApplicationError("notFound", "project_foundation_not_found");
    const foundation = checkedFoundation(raw, project);
    if (foundation.revision !== requested.expectedFoundationRevision)
      throw new ApplicationError(
        "conflict",
        "project_foundation_revision_conflict",
      );
    await this.#validateDependencies(actor, project, foundation);
    await assertProjectFoundationCommitCurrent(options.authority);
    const at = creativeProjectTimestamp(this.#dependencies.clock.now());
    const mutation = {
      project,
      foundation,
      actor,
      expectedFoundationRevision: requested.expectedFoundationRevision,
      at,
    };
    if (kind === "save-proposal") {
      const checked = command as Commands.SaveProjectProposalCommand;
      const previous =
        checked.expectedProposalRevision === 0
          ? null
          : await this.#proposal(
              actor,
              project,
              checked.expectedProposalRevision,
            );
      const provisional = createProjectProposal({
        ...mutation,
        previousProposal: previous,
        expectedProposalRevision: checked.expectedProposalRevision,
        kind: checked.kind,
        text: checked.text,
        contentDigest: this.#dependencies.digester.sha256(""),
        at,
      });
      const { contentDigest: _digest, ...body } = provisional;
      const proposal = validateProjectProposal({
        ...body,
        contentDigest: this.#dependencies.digester.sha256(
          extensionCanonicalJson(body),
        ),
      });
      return {
        records: { project, foundation, proposal, source: null, brief: null },
        commit: () =>
          this.#dependencies.store.commitProposal(
            {
              ...identity,
              project,
              foundation,
              expectedFoundationRevision: requested.expectedFoundationRevision,
              proposal,
            },
            options,
          ),
      };
    }
    let next: ProjectFoundation;
    let changeOptions = options;
    let sourceRecords = scopeSource(null, project, actor, 1, at);
    let proposal = null as ReturnType<typeof validateProjectProposal> | null;
    if (kind === "update-parameters")
      next = updateProjectFoundationParameters({
        ...mutation,
        parameters: (
          command as Commands.UpdateProjectFoundationParametersCommand
        ).parameters,
      });
    else if (kind === "append-source") {
      const preparation = await this.#prepareSource(
        actor,
        (command as Commands.AppendProjectFoundationSourceCommand).sourceUpload,
        project.projectId,
      );
      changeOptions = bindSourceAdoption(options, preparation.authority);
      await assertProjectFoundationCommitCurrent(changeOptions.authority);
      const revision = (foundation.source?.revision ?? 0) + 1;
      sourceRecords = scopeSource(
        preparation.source,
        project,
        actor,
        revision,
        at,
      );
      next = setProjectFoundationSource({
        ...mutation,
        source: { revision, digest: sourceRecords.source!.digest },
      });
    } else if (kind === "confirm-proposal") {
      const checked = command as Commands.ConfirmProjectProposalCommand;
      proposal = await this.#proposal(actor, project, checked.proposalRevision);
      if (proposal.contentDigest !== checked.proposalDigest)
        throw new ApplicationError(
          "conflict",
          "project_foundation_proposal_digest_mismatch",
        );
      next = confirmProjectProposal({ ...mutation, proposal });
    } else
      next = setProjectFoundationCreativeStartMode({
        ...mutation,
        creativeStartMode: (
          command as Commands.ChooseProjectFoundationStartModeCommand
        ).creativeStartMode,
      });
    return {
      records: {
        foundation: next,
        source: sourceRecords.source,
        proposal,
        brief: null,
      },
      commit: () =>
        this.#dependencies.store.commitFoundationChange(
          {
            ...identity,
            kind: kind as
              | "update-parameters"
              | "append-source"
              | "confirm-proposal"
              | "choose-direct-script",
            expectedFoundationRevision: requested.expectedFoundationRevision,
            foundation: next,
            ...sourceRecords,
            proposal,
          },
          changeOptions,
        ),
    };
  }
  async #project(actor: ActorContext, projectId: string) {
    const raw = await this.#dependencies.projects.loadProject({
      owner: creativeOwner(actor),
      projectId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    return checkedCreativeProject(raw, creativeOwner(actor), projectId);
  }
  async #proposal(
    actor: ActorContext,
    project: CreativeProject,
    revision: number,
  ) {
    const raw = await this.#dependencies.store.loadProposal({
      owner: creativeOwner(actor),
      projectId: project.projectId,
      revision,
    });
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_foundation_proposal_not_found",
      );
    return checkedProposal(raw, project, this.#dependencies.digester, revision);
  }
  async #validateDependencies(
    actor: ActorContext,
    project: CreativeProject,
    foundation: ProjectFoundation,
  ) {
    if (foundation.source !== null) {
      const raw = await this.#dependencies.store.loadSource({
        owner: creativeOwner(actor),
        projectId: project.projectId,
        revision: foundation.source.revision,
      });
      if (raw === null)
        throw new ApplicationError(
          "conflict",
          "project_foundation_source_reference_invalid",
        );
      const source = checkedSource(raw, project, foundation.source.revision);
      if (source.digest !== foundation.source.digest)
        throw new ApplicationError(
          "conflict",
          "project_foundation_source_digest_mismatch",
        );
    }
  }
  async #prepareSource(
    actor: ActorContext,
    sourceUpload: Commands.ProjectSourceUploadReference,
    projectId: string | null,
  ) {
    const request = Object.freeze({ actor, ...sourceUpload, projectId });
    const port = this.#dependencies.sourcePreparation,
      captureAdoption = port.captureAdoptionAuthority;
    const raw = await port.loadPrepared(request);
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_foundation_source_upload_not_found",
      );
    const prepared = capturePreparedProjectSource(
      raw,
      request,
      this.#dependencies.digester,
    );
    if (
      prepared.provenance === undefined &&
      this.#sourceAdmission !== "trusted-internal-recipe"
    )
      throw new ApplicationError(
        "validation",
        "project_foundation_source_provenance_required",
      );
    if (prepared.provenance === undefined)
      return { source: prepared, authority: null };
    if (typeof captureAdoption !== "function")
      throw new ApplicationError(
        "validation",
        "project_foundation_source_adoption_authority_required",
      );
    const authority = captureProjectSourceAdoptionAuthority(
      captureAdoption.call(port, request),
      request,
    );
    return { source: prepared, authority };
  }
  async #authorize(
    actor: ActorContext,
    action: CreativeProjectAuthorizationAction,
    projectId: string | null,
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
function bindPolicy(
  original: ProjectFoundationCommitAuthority | undefined,
  authorize: () => Promise<void>,
): ProjectFoundationCommitAuthority {
  return Object.freeze({
    async assertCurrent() {
      await authorize();
      await assertProjectFoundationCommitCurrent(original);
    },
    assertActive() {
      assertProjectFoundationCommitActive(original);
    },
    ...(original?.transaction === undefined
      ? {}
      : {
          transaction: Object.freeze({
            ...original.transaction,
            async assertCurrent() {
              await authorize();
              await original.transaction!.assertCurrent();
            },
          }),
        }),
  });
}
function scopeSource(
  prepared: PreparedProjectSource | null,
  project: CreativeProject,
  actor: ActorContext,
  revision: number,
  at: string,
) {
  if (prepared === null) return { source: null, chunks: [], chapters: [] };
  const scope = {
    tenantId: project.tenantId,
    spaceId: project.spaceId,
    projectId: project.projectId,
  };
  const source = parseProjectSource({
    schemaVersion: "crewon.project-source.v1",
    ...scope,
    revision,
    digest: prepared.digest,
    fileDigest: prepared.fileDigest,
    fileName: prepared.fileName,
    format: prepared.format,
    byteLength: prepared.byteLength,
    characterLength: prepared.characterLength,
    createdByActorId: actor.actorId,
    createdAt: at,
  });
  const chunks = prepared.chunks.map((chunk) =>
    parseProjectSourceChunk({ ...scope, sourceRevision: revision, ...chunk }),
  );
  const chapters = prepared.chapters.map((chapter) =>
    parseProjectSourceChapter({
      ...scope,
      sourceRevision: revision,
      ...chapter,
    }),
  );
  return {
    source,
    chunks,
    chapters,
    ...(prepared.provenance === undefined
      ? {}
      : { sourceUpload: prepared.provenance }),
  };
}
