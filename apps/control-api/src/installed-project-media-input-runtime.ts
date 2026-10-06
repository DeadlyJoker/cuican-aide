import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  ApplicationError,
  CreativeProjectApplicationService,
  ProjectAssetApplicationService,
  ProjectAssetReferenceImageApplicationService,
  ProjectMediaInputApplicationService,
  ProjectMaterialTargetApplicationService,
  PluginInstallationApplicationService,
  mediaInputSame,
  materialPreparationFields,
  type ActorContext,
  type ProjectMediaInputRevision,
} from "@crewon/application";
import { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import {
  parseSaveMediaInputRequest,
  parseLoadMediaInputRequest,
  parseSaveMediaInputResponse,
  parseLoadMediaInputResponse,
  type SaveMediaInputRequest,
  type LoadMediaInputRequest,
  type PublicMediaInput,
} from "@crewon/contracts/project-media-inputs";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import {
  assertInstalledPluginTaskRuntimeCoreBinding,
  assertInstalledProjectMediaInputPublications,
  installedProjectConversationTaskAuthority,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";
import {
  captureInstalledProjectMediaInputConfiguration,
  type InstalledProjectMediaInputConfiguration,
} from "./installed-project-media-input-configuration.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";

const issued = new WeakSet<object>();
export function isInstalledProjectMediaInputRuntime(
  input: unknown,
): input is InstalledProjectMediaInputRuntime {
  return input !== null && typeof input === "object" && issued.has(input);
}

/** Same original parent and issued request owner. Only logical metadata enters or leaves this owner. */
export class InstalledProjectMediaInputRuntime {
  readonly #core: InstalledPluginTaskRuntimeCore;
  readonly #service: ProjectMediaInputApplicationService;
  readonly #assertActive: () => void;
  readonly #lifetime: AbortController;
  readonly #physical = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  private constructor(
    core: InstalledPluginTaskRuntimeCore,
    service: ProjectMediaInputApplicationService,
    assertActive: () => void,
    lifetime: AbortController,
  ) {
    this.#core = core;
    this.#service = service;
    this.#assertActive = assertActive;
    this.#lifetime = lifetime;
    issued.add(this);
  }
  static async prepare(
    input: Readonly<{
      core: InstalledPluginTaskRuntimeCore;
      store: SqliteRunStore | PostgresDomainStore;
      configuration: InstalledProjectMediaInputConfiguration;
    }>,
  ): Promise<InstalledProjectMediaInputRuntime> {
    if (types.isProxy(input))
      throw new Error("installed_project_media_input_configuration_invalid");
    const r = materialPreparationFields(input, [
      "core",
      "store",
      "configuration",
    ]);
    input = r as typeof input;
    if (types.isProxy(input.store))
      throw new Error("installed_project_media_input_store_invalid");
    const authority = installedProjectConversationTaskAuthority(input.core);
    assertInstalledPluginTaskRuntimeCoreBinding(input.core, {
      store: input.store,
      requests: authority.requests,
    });
    const configuration = captureInstalledProjectMediaInputConfiguration(
      input.configuration,
    );
    assertInstalledProjectMediaInputPublications(input.core, configuration);
    const lifetime = new AbortController();
    const active = () => {
      lifetime.signal.throwIfAborted();
      authority.assertActive();
    };
    const actorCurrent = (actor: ActorContext) => {
      active();
      authority.requests.currentSignal().throwIfAborted();
      if (!mediaInputSame(actor, authority.requests.currentActor())) denied();
    };
    const current = async (actor: ActorContext) => {
      actorCurrent(actor);
      await authority.requests.assertCurrent();
      actorCurrent(actor);
    };
    const projects = input.store.creativeProjectStore(),
      texts = input.store.projectTextStore();
    const assets = input.store.projectAssetStore({
        verifier: configuration.verifier,
      }),
      store = assets.projectMediaInputStore();
    // Explicit opt-in migrates actual borrowed adapters, never a replacement DB or a media-I/O journal.
    await projects.migrate();
    active();
    await texts.migrate();
    active();
    await assets.migrate();
    active();
    await store.migrate();
    active();
    const clock = new SystemApplicationClock(),
      digester = new NodeSha256ContentDigester(),
      ids = new UuidV7ApplicationIdGenerator();
    const projectAuthorization = Object.freeze({
      authorize: async (
        request: Parameters<
          InstalledProjectMediaInputConfiguration["projects"]["authorize"]
        >[0],
      ) => {
        await current(request.actor);
        if (request.action !== "creativeProject:read") denied();
        const result = await configuration.projects.authorize(request);
        await current(request.actor);
        return result;
      },
    });
    const projectService = new CreativeProjectApplicationService({
      store: projects,
      authorization: projectAuthorization,
      clock,
      ids,
      digester,
    });
    const assetService = new ProjectAssetApplicationService({
      store: assets,
      projects,
      texts,
      authorization: projectAuthorization,
      clock,
      ids,
      digester,
    });
    const sources = new ProjectAssetReferenceImageApplicationService({
      projects: projectService,
      assets: assetService,
      store: assets,
      digester,
    });
    const unavailable = async (): Promise<never> => denied();
    const installations = new PluginInstallationApplicationService({
      store: input.store.pluginInstallationStore(),
      profiles: {
        resolve: async (actor) => {
          await current(actor);
          return authority.requests.currentScope();
        },
      },
      authorization: {
        authorize: async (request) => {
          await current(request.actor);
          if (
            request.action !== "pluginInstallation:read" ||
            !mediaInputSame(
              {
                tenantId: request.resource.tenantId,
                spaceId: request.resource.spaceId,
                profileId: request.resource.profileId,
              },
              authority.requests.currentScope(),
            )
          )
            denied();
          const result = await configuration.installations.authorize(request);
          await current(request.actor);
          return result;
        },
      },
      host: { install: unavailable, prepareSelection: unavailable },
      clock,
      digester,
    });
    const targets = new ProjectMaterialTargetApplicationService({
      installations,
      configurations: input.core.extensions,
    });
    const authorization = Object.freeze({
      authorize: async (
        request: Parameters<
          InstalledProjectMediaInputConfiguration["authorization"]["authorize"]
        >[0],
      ) => {
        await current(request.actor);
        if (request.action === "projectMediaInput:qualify") denied();
        const result = await configuration.authorization.authorize(request);
        await current(request.actor);
        return result;
      },
      assertActive: (
        request: Parameters<
          InstalledProjectMediaInputConfiguration["authorization"]["assertActive"]
        >[0],
      ) => {
        actorCurrent(request.actor);
        configuration.authorization.assertActive(request);
        actorCurrent(request.actor);
      },
    });
    const service = new ProjectMediaInputApplicationService({
      store,
      sources,
      targets,
      reviews: configuration.reviews,
      authorization,
      clock,
      ids: { nextMediaInputId: () => randomUUID() },
    });
    return new InstalledProjectMediaInputRuntime(
      input.core,
      service,
      active,
      lifetime,
    );
  }
  saveInput(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: SaveMediaInputRequest,
    signal?: AbortSignal,
  ) {
    const command = parseSaveMediaInputRequest(input);
    return this.#run(request, actor, signal, async () => {
      const { configurationRevision, ...logical } = command;
      const outcome =
        await ProjectMediaInputApplicationService.prototype.saveInput.call(
          this.#service,
          actor,
          {
            ...logical,
            target: {
              pluginId: "crewon.short-drama",
              profileId: this.#core.requests.currentScope().profileId,
              configurationRevision,
            },
          },
        );
      return parseSaveMediaInputResponse(command, {
        disposition: outcome.disposition,
        input: publicInput(outcome.input),
      });
    });
  }
  loadInput(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: LoadMediaInputRequest,
    signal?: AbortSignal,
  ) {
    const query = parseLoadMediaInputRequest(input);
    return this.#run(request, actor, signal, async () => {
      const state =
        await ProjectMediaInputApplicationService.prototype.loadInput.call(
          this.#service,
          actor,
          query,
        );
      return parseLoadMediaInputResponse(query, {
        state:
          state === null
            ? null
            : {
                input: publicInput(state.input),
                latestInputRevision: state.latestInputRevision,
              },
      });
    });
  }
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  #run<T>(
    request: ControlApiRequestContext,
    actor: ActorContext,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    this.#assertActive();
    const pending = this.#core.requests
      .run(
        {
          request,
          actor,
          preparation: "configuration",
          signal: AbortSignal.any([
            this.#lifetime.signal,
            ...(signal ? [signal] : []),
          ]),
        },
        work,
      )
      .catch((error) => {
        throw publicFailure(error);
      });
    this.#physical.add(pending);
    void pending.then(
      () => this.#physical.delete(pending),
      () => this.#physical.delete(pending),
    );
    return pending;
  }
}
function publicInput(input: ProjectMediaInputRevision): PublicMediaInput {
  return Object.freeze({
    projectId: input.projectId,
    mediaInputId: input.mediaInputId,
    inputRevision: input.inputRevision,
    item: input.item,
    briefRevision: input.brief.briefRevision,
    script:
      input.script === null
        ? null
        : {
            artifactId: input.script.artifactId,
            contentRevision: input.script.contentRevision,
          },
    workflowId: input.workflow.workflowId,
    configurationRevision: input.target.configuration.revision,
    prompt: input.prompt,
    references: Object.fromEntries(
      input.references.map((ref) => [ref.role, ref.preparation.source.query]),
    ),
    createdAt: input.createdAt,
    contentDigest: input.contentDigest,
  });
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "installed_project_media_input_denied",
  );
}
function publicFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof ApplicationError)
    return error;
  if (
    [
      "project_media_input_not_found",
      "project_media_input_owner_mismatch",
      "project_media_input_actor_changed",
    ].includes(error.message)
  )
    return new ApplicationError("notFound", "project_media_input_not_found");
  if (
    [
      "revision_conflict",
      "idempotency_conflict",
      "brief_stale",
      "project_archived",
      "target_changed",
      "item_changed",
      "source_changed",
      "script_episode_mismatch",
      "workflow_unreviewed",
    ].some((code) => error.message === `project_media_input_${code}`)
  )
    return new ApplicationError("conflict", error.message);
  if (
    [
      "project_material_target_selection_unavailable",
      "project_material_target_configuration_unavailable",
      "project_material_target_changed",
    ].includes(error.message)
  )
    return new ApplicationError(
      "conflict",
      "project_media_input_target_unavailable",
    );
  return error;
}
