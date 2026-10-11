import { executeCreativeProjectList } from "./creative-project-list-application.ts";
import { pluginProjectReadStore } from "./plugin-project-read-store.ts";
import type { PluginProjectReadOptions } from "./plugin-project-read-scope.ts";
import { executeCreativeProjectMutation } from "./creative-project-mutation-application.ts";
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
  OwnedCreativeProjectCreationStore,
  CreativeProjectReadStore,
  PluginProjectReadStoreBinding,
} from "./creative-project-store-port.ts";
import { assertCreativeProjectCommitCurrent } from "./creative-project-commit-authority.ts";
import {
  checkedCreativeAsset,
  checkedCreativeAssetRevision,
  checkedCreativeBrief,
  checkedCreativeProject,
  compareCreativeIds,
  creativeActor,
  creativeInput,
  creativeLimit,
  creativeOwner,
  creativePage,
  creativeProjectUseCase,
  creativeRecord,
  creativeStored,
  invalidStore,
  type CreativeProjectPreparedRecords,
} from "./creative-project-application-support.ts";

export type CreativeProjectApplicationDependencies = Readonly<{
  store: CreativeProjectStore &
    Partial<OwnedCreativeProjectCreationStore & PluginProjectReadStoreBinding>;
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

  getProject(
    actor: ActorContext,
    query: { projectId: string },
    options?: PluginProjectReadOptions,
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId"],
      (value) => ({ projectId: creativeProjectOpaqueId(value.projectId) }),
      async (_actor, _query, project) => project,
      options,
    );
  }

  listProjects(
    actorInput: ActorContext,
    input: ListCreativeProjectsQuery,
    options?: PluginProjectReadOptions,
  ) {
    return executeCreativeProjectList(
      {
        store: this.#dependencies.store,
        authorize: (actor) =>
          this.#authorize(actor, "creativeProject:list", null),
      },
      actorInput,
      input,
      options,
    );
  }

  getBrief(
    actor: ActorContext,
    query: { projectId: string; briefRevision: number },
    options?: PluginProjectReadOptions,
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "briefRevision"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        briefRevision: creativeProjectRevision(value.briefRevision),
      }),
      async (owner, checked, project, readStore) =>
        this.#brief(
          owner,
          project,
          checked.briefRevision,
          undefined,
          readStore,
        ),
      options,
    );
  }

  listBriefs(
    actor: ActorContext,
    query: { projectId: string; afterBriefRevision: number; limit: number },
    options?: PluginProjectReadOptions,
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
      async (owner, checked, project, readStore) => {
        const raw = await readStore.listBriefs({
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
      options,
    );
  }

  getConceptAsset(
    actor: ActorContext,
    query: { projectId: string; assetId: string },
    options?: PluginProjectReadOptions,
  ) {
    return this.#readOwned(
      actor,
      query,
      ["projectId", "assetId"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        assetId: creativeProjectOpaqueId(value.assetId),
      }),
      async (owner, checked, project, readStore) =>
        this.#asset(owner, project, checked.assetId, undefined, readStore),
      options,
    );
  }

  listConceptAssets(
    actor: ActorContext,
    query: { projectId: string; afterAssetId: string | null; limit: number },
    options?: PluginProjectReadOptions,
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
      async (owner, checked, project, readStore) => {
        const raw = await readStore.listConceptAssets({
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
      options,
    );
  }

  getConceptRevision(
    actor: ActorContext,
    query: { projectId: string; assetId: string; assetRevision: number },
    options?: PluginProjectReadOptions,
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
      async (owner, checked, project, readStore) => {
        const asset = await this.#asset(
          owner,
          project,
          checked.assetId,
          undefined,
          readStore,
        );
        const raw = await readStore.loadConceptRevision({
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
      options,
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
    options?: PluginProjectReadOptions,
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
      async (owner, checked, project, readStore) => {
        const asset = await this.#asset(
          owner,
          project,
          checked.assetId,
          undefined,
          readStore,
        );
        const raw = await readStore.listConceptRevisions({
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
      options,
    );
  }

  #mutate(
    actorInput: ActorContext,
    kind: CreativeProjectMutationKind,
    input: CreativeProjectMutationCommand,
    options?: CreativeProjectCommitOptions,
  ): Promise<CreativeProjectMutationResult> {
    return executeCreativeProjectMutation(
      {
        store: this.#dependencies.store,
        digester: this.#dependencies.digester,
        authorize: (actor, action, projectId) =>
          this.#authorize(actor, action, projectId),
        prepare: (actor, mutationKind, command, receipt, commitOptions) =>
          this.#prepareMutation(
            actor,
            mutationKind,
            command,
            receipt,
            commitOptions,
          ),
      },
      actorInput,
      kind,
      input,
      options,
    );
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
        options?.creationScope === undefined
          ? this.#dependencies.store.commitProjectCreation(
              {
                ...identity,
                project: created.project,
                initialBrief: created.brief,
              },
              options,
            )
          : this.#dependencies.store.commitOwnedProjectCreation!(
              {
                ...identity,
                project: created.project,
                initialBrief: created.brief,
                creationScope: options.creationScope,
              },
              options,
            ),
      );
    }
    const checked = command as Exclude<
      CreativeProjectMutationCommand,
      CreateCreativeProjectCommand
    >;
    const readStore =
      options?.mutationScope === undefined
        ? this.#dependencies.store
        : pluginProjectReadStore(this.#dependencies.store, actor, {
            readScope: options.mutationScope,
          });
    const project = await this.#project(
      actor,
      checked.projectId,
      options?.authority,
      readStore,
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
      readStore: CreativeProjectReadStore,
    ) => Promise<Result>,
    options?: PluginProjectReadOptions,
  ): Promise<Result> {
    return creativeProjectUseCase(async () => {
      const actor = creativeActor(actorInput);
      const query = creativeInput(() =>
        Object.freeze(validate(creativeRecord(input, fields))),
      );
      const readStore = pluginProjectReadStore(
        this.#dependencies.store,
        actor,
        options,
      );
      await this.#authorize(actor, "creativeProject:read", query.projectId);
      const project = await this.#project(
        actor,
        query.projectId,
        undefined,
        readStore,
      );
      const result = await read(actor, query, project, readStore);
      await this.#authorize(actor, "creativeProject:read", query.projectId);
      return result;
    });
  }

  async #project(
    actor: ActorContext,
    projectId: string,
    authority?: CreativeProjectCommitAuthority,
    readStore: CreativeProjectReadStore = this.#dependencies.store,
  ): Promise<CreativeProject> {
    const raw = await readStore.loadProject({
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
    readStore: CreativeProjectReadStore = this.#dependencies.store,
  ): Promise<ProjectBriefRevision> {
    const raw = await readStore.loadBrief({
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
    readStore: CreativeProjectReadStore = this.#dependencies.store,
  ): Promise<ConceptAsset> {
    const raw = await readStore.loadConceptAsset({
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

function prepareCreativeMutation(
  records: CreativeProjectPreparedRecords,
  commit: () => Promise<CreativeProjectMutationResult>,
) {
  return Object.freeze({ records, commit });
}
