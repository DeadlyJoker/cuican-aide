import {
  appendConceptAssetRevision,
  appendProjectBriefRevision,
  createConceptAsset,
  createCreativeProject,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  renameCreativeProject,
  setCreativeProjectState,
  type CreativeProject,
  type ConceptAsset,
  type ProjectBriefRevision,
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
  AppendConceptAssetRevisionCommand,
  AppendProjectBriefCommand,
  CreateConceptAssetCommand,
  CreateCreativeProjectCommand,
  CreativeProjectMutationCommand,
  ListCreativeProjectsQuery,
  RenameCreativeProjectCommand,
  SetCreativeProjectStateCommand,
} from "./creative-project-commands.ts";
import type {
  AppendProjectBriefResult,
  ChangeConceptAssetResult,
  ChangeCreativeProjectMetadataResult,
  CreateCreativeProjectResult,
  CreativeProjectMutationKind,
  CreativeProjectMutationReceipt,
  CreativeProjectMutationResult,
  CreativeProjectCommitOptions,
  CreativeProjectCommitAuthority,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import {
  captureCreativeProjectCommitAuthority,
  assertCreativeProjectCommitCurrent,
} from "./creative-project-commit-authority.ts";
import {
  assertCreativeCommittedRecords,
  checkedCreativeAsset,
  checkedCreativeAssetRevision,
  checkedCreativeBrief,
  checkedCreativeMutationResult,
  checkedCreativeProject,
  compareCreativeIds,
  creativeActor,
  creativeInput,
  creativeLimit,
  creativeListQuery,
  creativeMutationCommand,
  creativeOwner,
  creativePage,
  creativeProjectUseCase,
  creativeReceipt,
  creativeRecord,
  creativeStored,
  creativeStoredRecord,
  invalidStore,
  type CreativeProjectPreparedRecords,
} from "./creative-project-application-support.ts";

export type CreativeProjectApplicationDependencies = Readonly<{
  store: CreativeProjectStore;
  authorization: CreativeProjectAuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;

/** Owned metadata/history use cases; no Run, supplier, result selection or billing. */
export class CreativeProjectApplicationService {
  readonly #dependencies: CreativeProjectApplicationDependencies;
  constructor(dependencies: CreativeProjectApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  createProject(
    actor: ActorContext,
    command: CreateCreativeProjectCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<CreateCreativeProjectResult> {
    return this.#mutate(
      actor,
      "create-project",
      command,
      options,
    ) as Promise<CreateCreativeProjectResult>;
  }
  renameProject(
    actor: ActorContext,
    command: RenameCreativeProjectCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ChangeCreativeProjectMetadataResult> {
    return this.#mutate(
      actor,
      "rename-project",
      command,
      options,
    ) as Promise<ChangeCreativeProjectMetadataResult>;
  }
  setProjectState(
    actor: ActorContext,
    command: SetCreativeProjectStateCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ChangeCreativeProjectMetadataResult> {
    return this.#mutate(
      actor,
      "set-project-state",
      command,
      options,
    ) as Promise<ChangeCreativeProjectMetadataResult>;
  }
  appendBrief(
    actor: ActorContext,
    command: AppendProjectBriefCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<AppendProjectBriefResult> {
    return this.#mutate(
      actor,
      "append-brief",
      command,
      options,
    ) as Promise<AppendProjectBriefResult>;
  }
  createConcept(
    actor: ActorContext,
    command: CreateConceptAssetCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ChangeConceptAssetResult> {
    return this.#mutate(
      actor,
      "create-concept",
      command,
      options,
    ) as Promise<ChangeConceptAssetResult>;
  }
  appendConceptRevision(
    actor: ActorContext,
    command: AppendConceptAssetRevisionCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<ChangeConceptAssetResult> {
    return this.#mutate(
      actor,
      "append-concept",
      command,
      options,
    ) as Promise<ChangeConceptAssetResult>;
  }

  getProject(actor: ActorContext, query: { projectId: string }) {
    return this.#readOwned(
      actor,
      query,
      ["projectId"],
      (value) => ({ projectId: creativeProjectOpaqueId(value.projectId) }),
      async (_actor, _query, project) => project,
    );
  }

  listProjects(actorInput: ActorContext, input: ListCreativeProjectsQuery) {
    return creativeProjectUseCase(async () => {
      const actor = creativeActor(actorInput);
      const query = creativeListQuery(input);
      await this.#authorize(actor, "creativeProject:list", null);
      const raw = await this.#dependencies.store.listProjects({
        owner: creativeOwner(actor),
        ...query,
      });
      const page = creativeStoredRecord(raw, ["projects", "next"]);
      const seen = new Set<string>();
      const projects = creativePage(
        page.projects,
        query.limit,
        (item) => {
          const project = checkedCreativeProject(item, creativeOwner(actor));
          if (seen.has(project.projectId)) creativeStored(invalidStore);
          seen.add(project.projectId);
          if (
            (query.state !== "all" && project.state !== query.state) ||
            (query.after !== null && !projectBefore(project, query.after))
          )
            creativeStored(invalidStore);
          return project;
        },
        (previous, next) => projectBefore(next, previous),
      );
      const next = creativeStored(() => {
        if (page.next === null) return null;
        const cursor = creativeRecord(page.next, ["updatedAt", "projectId"]);
        const value = Object.freeze({
          updatedAt: creativeProjectTimestamp(cursor.updatedAt),
          projectId: creativeProjectOpaqueId(cursor.projectId),
        });
        const last = projects.at(-1);
        if (
          last === undefined ||
          value.updatedAt !== last.updatedAt ||
          value.projectId !== last.projectId
        )
          invalidStore();
        return value;
      });
      await this.#authorize(actor, "creativeProject:list", null);
      return Object.freeze({ projects, next });
    });
  }

  getBrief(
    actor: ActorContext,
    query: { projectId: string; briefRevision: number },
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "briefRevision"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        briefRevision: creativeProjectRevision(value.briefRevision),
      }),
      async (owner, checked, project) =>
        this.#brief(owner, project, checked.briefRevision),
    );
  }

  listBriefs(
    actor: ActorContext,
    query: { projectId: string; afterBriefRevision: number; limit: number },
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "afterBriefRevision", "limit"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        afterBriefRevision: creativeProjectRevision(value.afterBriefRevision, {
          minimum: 0,
        }),
        limit: creativeLimit(value.limit),
      }),
      async (owner, checked, project) => {
        const raw = await this.#dependencies.store.listBriefs({
          owner: creativeOwner(owner),
          ...checked,
        });
        return creativePage(
          raw,
          checked.limit,
          (item) => {
            const brief = checkedCreativeBrief(
              item,
              project,
              this.#dependencies.digester,
            );
            if (brief.briefRevision <= checked.afterBriefRevision)
              creativeStored(invalidStore);
            return brief;
          },
          (left, right) => left.briefRevision < right.briefRevision,
        );
      },
    );
  }

  getConceptAsset(
    actor: ActorContext,
    query: { projectId: string; assetId: string },
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "assetId"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        assetId: creativeProjectOpaqueId(value.assetId),
      }),
      async (owner, checked, project) =>
        this.#asset(owner, project, checked.assetId),
    );
  }

  listConceptAssets(
    actor: ActorContext,
    query: { projectId: string; afterAssetId: string | null; limit: number },
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "afterAssetId", "limit"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        afterAssetId:
          value.afterAssetId === null
            ? null
            : creativeProjectOpaqueId(value.afterAssetId),
        limit: creativeLimit(value.limit),
      }),
      async (owner, checked, project) => {
        const raw = await this.#dependencies.store.listConceptAssets({
          owner: creativeOwner(owner),
          ...checked,
        });
        return creativePage(
          raw,
          checked.limit,
          (item) => {
            const asset = checkedCreativeAsset(item, project);
            if (
              checked.afterAssetId !== null &&
              compareCreativeIds(asset.assetId, checked.afterAssetId) <= 0
            )
              creativeStored(invalidStore);
            return asset;
          },
          (left, right) => compareCreativeIds(left.assetId, right.assetId) < 0,
        );
      },
    );
  }

  getConceptRevision(
    actor: ActorContext,
    query: { projectId: string; assetId: string; assetRevision: number },
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "assetId", "assetRevision"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        assetId: creativeProjectOpaqueId(value.assetId),
        assetRevision: creativeProjectRevision(value.assetRevision),
      }),
      async (owner, checked, project) => {
        const asset = await this.#asset(owner, project, checked.assetId);
        const raw = await this.#dependencies.store.loadConceptRevision({
          owner: creativeOwner(owner),
          ...checked,
        });
        if (raw === null)
          throw new ApplicationError(
            "notFound",
            "creative_project_asset_revision_not_found",
          );
        return checkedCreativeAssetRevision(
          raw,
          project,
          this.#dependencies.digester,
          checked.assetId,
          {
            assetRevision: checked.assetRevision,
            latestAssetRevision: asset.latestAssetRevision,
          },
        );
      },
    );
  }

  listConceptRevisions(
    actor: ActorContext,
    query: {
      projectId: string;
      assetId: string;
      afterAssetRevision: number;
      limit: number;
    },
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "assetId", "afterAssetRevision", "limit"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        assetId: creativeProjectOpaqueId(value.assetId),
        afterAssetRevision: creativeProjectRevision(value.afterAssetRevision, {
          minimum: 0,
        }),
        limit: creativeLimit(value.limit),
      }),
      async (owner, checked, project) => {
        const asset = await this.#asset(owner, project, checked.assetId);
        const raw = await this.#dependencies.store.listConceptRevisions({
          owner: creativeOwner(owner),
          ...checked,
        });
        return creativePage(
          raw,
          checked.limit,
          (item) => {
            const revision = checkedCreativeAssetRevision(
              item,
              project,
              this.#dependencies.digester,
              checked.assetId,
              { latestAssetRevision: asset.latestAssetRevision },
            );
            if (revision.assetRevision <= checked.afterAssetRevision)
              creativeStored(invalidStore);
            return revision;
          },
          (left, right) => left.assetRevision < right.assetRevision,
        );
      },
    );
  }

  #mutate(
    actorInput: ActorContext,
    kind: CreativeProjectMutationKind,
    input: CreativeProjectMutationCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<CreativeProjectMutationResult> {
    return creativeProjectUseCase(async () => {
      const authority = captureCreativeProjectCommitAuthority(options);
      const commitOptions =
        authority === undefined ? undefined : Object.freeze({ authority });
      const actor = creativeActor(actorInput);
      const command = creativeMutationCommand(kind, input);
      const projectId = "projectId" in command ? command.projectId : null;
      const action =
        kind === "create-project"
          ? "creativeProject:create"
          : "creativeProject:write";
      const receipt = creativeReceipt(
        actor,
        kind,
        command,
        this.#dependencies.digester,
      );
      await this.#authorize(actor, action, projectId);
      if (authority !== undefined)
        await assertCreativeProjectCommitCurrent(authority);
      const previous = await this.#dependencies.store.loadMutationReceipt({
        actor,
        kind,
        receipt,
      });
      if (authority !== undefined)
        await assertCreativeProjectCommitCurrent(authority);
      if (previous !== null) {
        const result = checkedCreativeMutationResult(
          previous,
          actor,
          kind,
          command,
          this.#dependencies.digester,
        );
        await this.#authorize(actor, action, projectId);
        if (authority !== undefined)
          await assertCreativeProjectCommitCurrent(authority);
        return Object.freeze({ ...result, disposition: "replayed" as const });
      }
      const prepared = await this.#prepareMutation(
        actor,
        kind,
        command,
        receipt,
        commitOptions,
      );
      await this.#authorize(actor, action, projectId);
      if (authority !== undefined)
        await assertCreativeProjectCommitCurrent(authority);
      const raw = await prepared.commit();
      const result = checkedCreativeMutationResult(
        raw,
        actor,
        kind,
        command,
        this.#dependencies.digester,
      );
      assertCreativeCommittedRecords(result, prepared.records);
      return result;
    });
  }

  async #prepareMutation(
    actor: ActorContext,
    kind: CreativeProjectMutationKind,
    command: CreativeProjectMutationCommand,
    receipt: CreativeProjectMutationReceipt,
    options?: CreativeProjectCommitOptions,
  ): Promise<ReturnType<typeof prepareCreativeMutation>> {
    const identity = { actor, receipt };
    if (kind === "create-project") {
      const checked = command as CreateCreativeProjectCommand;
      const at = creativeProjectTimestamp(this.#dependencies.clock.now());
      const project = createCreativeProject({
        scope: {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          projectId: creativeProjectOpaqueId(
            this.#dependencies.ids.nextId("creativeProject"),
          ),
        },
        title: checked.title,
        actor,
        at,
      });
      const created = appendProjectBriefRevision(
        {
          project,
          actor,
          expectedProjectRevision: 1,
          text: checked.briefText,
          at,
        },
        this.#dependencies.digester,
      );
      return prepareCreativeMutation(created, () =>
        this.#dependencies.store.commitProjectCreation(
          {
            ...identity,
            project: created.project,
            initialBrief: created.brief,
          },
          options,
        ),
      );
    }
    const checked = command as Exclude<
      CreativeProjectMutationCommand,
      CreateCreativeProjectCommand
    >;
    const project = await this.#project(
      actor,
      checked.projectId,
      options?.authority,
    );
    const at = creativeProjectTimestamp(this.#dependencies.clock.now());
    const common = {
      project,
      actor,
      expectedProjectRevision: checked.expectedProjectRevision,
      at,
    };
    if (kind === "rename-project") {
      const renamed = renameCreativeProject({
        ...common,
        title: (command as RenameCreativeProjectCommand).title,
      });
      return prepareCreativeMutation({ project: renamed }, () =>
        this.#dependencies.store.commitProjectMetadata(
          {
            ...identity,
            kind,
            expectedProjectRevision: checked.expectedProjectRevision,
            project: renamed,
          },
          options,
        ),
      );
    }
    if (kind === "set-project-state") {
      const changed = setCreativeProjectState({
        ...common,
        state: (command as SetCreativeProjectStateCommand).state,
      });
      return prepareCreativeMutation({ project: changed }, () =>
        this.#dependencies.store.commitProjectMetadata(
          {
            ...identity,
            kind,
            expectedProjectRevision: checked.expectedProjectRevision,
            project: changed,
          },
          options,
        ),
      );
    }
    if (kind === "append-brief") {
      const changed = appendProjectBriefRevision(
        { ...common, text: (command as AppendProjectBriefCommand).text },
        this.#dependencies.digester,
      );
      return prepareCreativeMutation(changed, () =>
        this.#dependencies.store.commitProjectBrief(
          {
            ...identity,
            expectedProjectRevision: checked.expectedProjectRevision,
            ...changed,
          },
          options,
        ),
      );
    }
    const conceptCommand = command as
      | CreateConceptAssetCommand
      | AppendConceptAssetRevisionCommand;
    const brief = await this.#brief(
      actor,
      project,
      conceptCommand.briefRevision,
      options?.authority,
    );
    if (kind === "create-concept") {
      const input = command as CreateConceptAssetCommand;
      const changed = createConceptAsset(
        {
          ...common,
          brief,
          name: input.name,
          prompt: input.prompt,
          assetId: creativeProjectOpaqueId(
            this.#dependencies.ids.nextId("conceptAsset"),
          ),
        },
        this.#dependencies.digester,
      );
      return prepareCreativeMutation(changed, () =>
        this.#dependencies.store.commitConceptRevision(
          {
            ...identity,
            kind,
            expectedProjectRevision: checked.expectedProjectRevision,
            ...changed,
          },
          options,
        ),
      );
    }
    const input = command as AppendConceptAssetRevisionCommand;
    const asset = await this.#asset(
      actor,
      project,
      input.assetId,
      options?.authority,
    );
    const changed = appendConceptAssetRevision(
      {
        ...common,
        asset,
        brief,
        prompt: input.prompt,
        expectedAssetMetadataRevision: input.expectedAssetMetadataRevision,
      },
      this.#dependencies.digester,
    );
    return prepareCreativeMutation(changed, () =>
      this.#dependencies.store.commitConceptRevision(
        {
          ...identity,
          kind: "append-concept",
          expectedProjectRevision: checked.expectedProjectRevision,
          expectedAssetMetadataRevision: input.expectedAssetMetadataRevision,
          ...changed,
        },
        options,
      ),
    );
  }

  #readOwned<Query extends { projectId: string }, Result>(
    actorInput: ActorContext,
    input: unknown,
    fields: readonly string[],
    validate: (value: Record<string, unknown>) => Query,
    read: (
      actor: ActorContext,
      query: Query,
      project: CreativeProject,
    ) => Promise<Result>,
  ): Promise<Result> {
    return creativeProjectUseCase(async () => {
      const actor = creativeActor(actorInput);
      const query = creativeInput(() =>
        Object.freeze(validate(creativeRecord(input, fields))),
      );
      await this.#authorize(actor, "creativeProject:read", query.projectId);
      const project = await this.#project(actor, query.projectId);
      const result = await read(actor, query, project);
      await this.#authorize(actor, "creativeProject:read", query.projectId);
      return result;
    });
  }

  async #project(
    actor: ActorContext,
    projectId: string,
    authority?: CreativeProjectCommitAuthority,
  ): Promise<CreativeProject> {
    const raw = await this.#dependencies.store.loadProject({
      owner: creativeOwner(actor),
      projectId,
    });
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    if (raw === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    return checkedCreativeProject(raw, creativeOwner(actor), projectId);
  }
  async #brief(
    actor: ActorContext,
    project: CreativeProject,
    briefRevision: number,
    authority?: CreativeProjectCommitAuthority,
  ): Promise<ProjectBriefRevision> {
    const raw = await this.#dependencies.store.loadBrief({
      owner: creativeOwner(actor),
      projectId: project.projectId,
      briefRevision,
    });
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
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
  async #asset(
    actor: ActorContext,
    project: CreativeProject,
    assetId: string,
    authority?: CreativeProjectCommitAuthority,
  ): Promise<ConceptAsset> {
    const raw = await this.#dependencies.store.loadConceptAsset({
      owner: creativeOwner(actor),
      projectId: project.projectId,
      assetId,
    });
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_asset_not_found",
      );
    return checkedCreativeAsset(raw, project, assetId);
  }
  async #authorize(
    actor: ActorContext,
    action: CreativeProjectAuthorizationAction,
    projectId: string | null,
  ): Promise<void> {
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
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }
}

function projectBefore(
  left: { updatedAt: string; projectId: string },
  right: { updatedAt: string; projectId: string },
): boolean {
  return (
    left.updatedAt < right.updatedAt ||
    (left.updatedAt === right.updatedAt &&
      compareCreativeIds(left.projectId, right.projectId) < 0)
  );
}

function prepareCreativeMutation(
  records: CreativeProjectPreparedRecords,
  commit: () => Promise<CreativeProjectMutationResult>,
) {
  return Object.freeze({ records, commit });
}
