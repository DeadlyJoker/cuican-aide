import { AsyncLocalStorage } from "node:async_hooks";
import {
  parseListMediaInputsRequest,
  parseListMediaInputsResponse,
  type ListMediaInputsRequest,
  parseMediaInputOptionsRequest,
  parseMediaInputOptionsResponse,
  type MediaInputOptionsRequest,
} from "@crewon/contracts/project-media-input-catalog";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  ApplicationError,
  capturePluginProjectMediaInputInvocationAuthority,
  type PluginUiActionContext,
  type PluginProjectMediaInputInvocationAuthority,
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
  readonly #uiPackages: readonly string[];
  readonly #reviews: readonly import("@crewon/application").ProjectMediaWorkflowReview[];
  readonly #selection: PluginInstallationApplicationService["getSelection"];
  readonly #uiInvocations: AsyncLocalStorage<PluginProjectMediaInputInvocationAuthority>;
  readonly #physical = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  private constructor(
    core: InstalledPluginTaskRuntimeCore,
    service: ProjectMediaInputApplicationService,
    assertActive: () => void,
    lifetime: AbortController,
    uiInvocations: AsyncLocalStorage<PluginProjectMediaInputInvocationAuthority>,
    uiPackages: readonly string[],
    reviews: readonly import("@crewon/application").ProjectMediaWorkflowReview[],
    installations: PluginInstallationApplicationService,
  ) {
    this.#core = core;
    this.#service = service;
    this.#assertActive = assertActive;
    this.#lifetime = lifetime;
    this.#uiInvocations = uiInvocations;
    this.#uiPackages = Object.freeze([...uiPackages]);
    this.#reviews = reviews;
    this.#selection =
      PluginInstallationApplicationService.prototype.getSelection.bind(
        installations,
      );
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
    const uiInvocations =
      new AsyncLocalStorage<PluginProjectMediaInputInvocationAuthority>();
    const active = () => {
      lifetime.signal.throwIfAborted();
      authority.assertActive();
    };
    const actorCurrent = (actor: ActorContext) => {
      active();
      authority.requests.currentSignal().throwIfAborted();
      uiInvocations.getStore()?.assertActive();
      if (!mediaInputSame(actor, authority.requests.currentActor())) denied();
    };
    const current = async (actor: ActorContext) => {
      actorCurrent(actor);
      await authority.requests.assertCurrent();
      await uiInvocations.getStore()?.assertCurrent();
      actorCurrent(actor);
    };
    const transactionCurrent = async (actor: ActorContext) => {
      actorCurrent(actor);
      await authority.requests.assertCurrent();
      await uiInvocations.getStore()?.assertTransactionCurrent();
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
      authorizeTransaction: async (
        request: Parameters<
          InstalledProjectMediaInputConfiguration["authorization"]["authorize"]
        >[0],
      ) => {
        await transactionCurrent(request.actor);
        if (request.action === "projectMediaInput:qualify") denied();
        const result = await configuration.authorization.authorize(request);
        await transactionCurrent(request.actor);
        return result;
      },
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
      uiInvocations,
      configuration.reviews.map((r) => r.targetIdentity.packageDigest),
      configuration.reviews,
      installations,
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
      return this.#save(actor, command);
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
      return this.#load(actor, query);
    });
  }
  listInputs(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: ListMediaInputsRequest,
    signal?: AbortSignal,
  ) {
    const query = parseListMediaInputsRequest(input);
    return this.#run(request, actor, signal, () => this.#list(actor, query));
  }
  getOptions(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: MediaInputOptionsRequest,
    signal?: AbortSignal,
  ) {
    const query = parseMediaInputOptionsRequest(input);
    return this.#run(request, actor, signal, () => this.#options(actor, query));
  }
  /** A live Application invocation and original authenticated request are both required. */
  saveInputFromPluginUi(context: PluginUiActionContext, signal: AbortSignal) {
    return this.#ui(context, signal, () => {
      if (context.action !== "crewon.project-media-inputs.v1.saveInput")
        denied();
      return this.#save(
        context.actor,
        parseSaveMediaInputRequest(context.input),
      );
    });
  }
  loadInputFromPluginUi(context: PluginUiActionContext, signal: AbortSignal) {
    return this.#ui(context, signal, () => {
      if (context.action !== "crewon.project-media-inputs.v1.loadInput")
        denied();
      return this.#load(
        context.actor,
        parseLoadMediaInputRequest(context.input),
      );
    });
  }
  listInputsFromPluginUi(context: PluginUiActionContext, signal: AbortSignal) {
    return this.#ui(context, signal, () => {
      if (context.action !== "crewon.project-media-inputs.v1.listInputs")
        denied();
      return this.#list(
        context.actor,
        parseListMediaInputsRequest(context.input),
      );
    });
  }
  getOptionsFromPluginUi(context: PluginUiActionContext, signal: AbortSignal) {
    return this.#ui(context, signal, async () => {
      if (context.action !== "crewon.project-media-inputs.v1.getOptions")
        denied();
      return this.#options(
        context.actor,
        parseMediaInputOptionsRequest(context.input),
        context.package.packageDigest,
      );
    });
  }
  async #options(
    actor: ActorContext,
    query: MediaInputOptionsRequest,
    uiPackageDigest?: string,
  ) {
    // The same read purpose and SQL project ownership also protect an empty catalog.
    const projectQuery = { ...query, afterMediaInputId: null, limit: 1 };
    await this.#list(actor, projectQuery);
    const selectionQuery = { pluginId: "crewon.short-drama" };
    const selection = await this.#selection(actor, selectionQuery);
    const configurationQuery = { ...selectionQuery, revision: null };
    const configuration = await this.#core.extensions.getConfiguration(
      actor,
      configurationQuery,
    );
    await this.#core.requests.assertCurrent();
    if (
      uiPackageDigest !== undefined &&
      selection?.selectedPackageDigest !== uiPackageDigest
    )
      denied();
    const workflows =
      configuration === null || selection?.state !== "enabled"
        ? []
        : [
            ...new Set(
              this.#reviews
                .filter(
                  (r) =>
                    r.targetIdentity.packageDigest ===
                      selection.selectedPackageDigest &&
                    r.targetIdentity.version === configuration.pluginVersion &&
                    r.targetIdentity.manifestDigest ===
                      configuration.manifestDigest &&
                    r.targetIdentity.implementationDigest ===
                      configuration.implementationDigest,
                )
                .map((r) => r.workflow.workflowId),
            ),
          ];
    const currentSelection = await this.#selection(actor, selectionQuery);
    const currentConfiguration = await this.#core.extensions.getConfiguration(
      actor,
      configurationQuery,
    );
    await this.#core.requests.assertCurrent();
    if (
      !mediaInputSame(selection, currentSelection) ||
      !mediaInputSame(configuration, currentConfiguration)
    )
      throw new ApplicationError(
        "conflict",
        "project_media_input_target_unavailable",
      );
    // Revalidate project/read authority after installation and configuration I/O.
    await this.#list(actor, projectQuery);
    return parseMediaInputOptionsResponse({
      configuration:
        configuration === null || workflows.length === 0
          ? null
          : { revision: configuration.revision, workflows },
    });
  }
  async #list(actor: ActorContext, query: ListMediaInputsRequest) {
    const result =
      await ProjectMediaInputApplicationService.prototype.listInputs.call(
        this.#service,
        actor,
        query,
      );
    return parseListMediaInputsResponse(query, result);
  }
  assertAvailable(): void {
    this.#assertActive();
  }
  async #save(actor: ActorContext, command: SaveMediaInputRequest) {
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
  }
  async #load(actor: ActorContext, query: LoadMediaInputRequest) {
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
  }
  #ui<T>(
    context: PluginUiActionContext,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const captured = capturePluginProjectMediaInputInvocationAuthority(context);
    const scope = this.#core.requests.currentScope();
    if (
      context.package.pluginId !== "crewon.short-drama" ||
      !this.#uiPackages.includes(context.package.packageDigest) ||
      !mediaInputSame(context.scope, scope)
    )
      denied();
    const guard = Object.freeze({
      assertActive: () => {
        this.#assertActive();
        signal.throwIfAborted();
        captured.assertActive();
      },
      assertCurrent: async () => {
        guard.assertActive();
        await captured.assertCurrent();
        guard.assertActive();
      },
      assertTransactionCurrent: async () => {
        guard.assertActive();
        await captured.assertTransactionCurrent();
        guard.assertActive();
      },
    });
    guard.assertActive();
    // currentSignal is issued only by this Core's actual request owner; calling outside it fails.
    this.#core.requests.currentSignal().throwIfAborted();
    const pending = this.#uiInvocations
      .run(guard, async () => {
        await guard.assertCurrent();
        return work();
      })
      .catch((error) => {
        throw publicFailure(error);
      });
    return this.#track(pending);
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
    return this.#track(pending);
  }
  #track<T>(pending: Promise<T>): Promise<T> {
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
