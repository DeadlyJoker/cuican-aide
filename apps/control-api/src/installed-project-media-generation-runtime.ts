import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import {
  ApplicationError,
  materialPreparationFields,
  mediaInputSame,
  projectMediaInputBound,
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
  type PluginUiInvocationCommitAuthority,
  type ActorContext,
  type ProjectMediaInputAuthorizationPort,
  type ProjectMediaGenerationAuthorizationPort,
} from "@crewon/application";
import {
  ProjectMediaMaterialPreparer,
  ProjectMediaGenerationCommands,
  ProjectMediaGenerationTaskPreparer,
  type ProjectMediaGenerationAdmission,
} from "@crewon/media-runtime";
import {
  parseGenerateProjectMediaRequest,
  parseGenerateProjectMediaResponse,
  type GenerateProjectMediaRequest,
  parseProjectMediaGenerationUiRequest,
  CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE,
} from "@crewon/contracts/project-media-generations";
import {
  ControlApiIdentityError,
  type ControlApiRequestContext,
} from "./control-api-ports.ts";
import {
  installedProjectMediaGenerationTaskAuthority,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";
import {
  captureInstalledProjectMediaGenerationConfiguration,
  type InstalledProjectMediaGenerationConfiguration,
} from "./installed-project-media-generation-configuration.ts";
import { InstalledProjectMediaGenerationAdmissions } from "./installed-project-media-generation-admissions.ts";

type Invocation = {
  actor: ActorContext;
  command: GenerateProjectMediaRequest;
  admission: ProjectMediaGenerationAdmission | null;
  ui: Readonly<{
    context: PluginUiActionContext;
    authority: PluginUiInvocationCommitAuthority;
    signal: AbortSignal;
  }> | null;
};
const issued = new WeakSet<object>();
export function isInstalledProjectMediaGenerationRuntime(
  input: unknown,
): input is InstalledProjectMediaGenerationRuntime {
  return input !== null && typeof input === "object" && issued.has(input);
}

/** Request-scoped generation through the original TaskCore; owns only preparation resources. */
export class InstalledProjectMediaGenerationRuntime {
  readonly #core: InstalledPluginTaskRuntimeCore;
  readonly #commands: ProjectMediaGenerationCommands;
  readonly #invocations: AsyncLocalStorage<Invocation>;
  readonly #lifetime: AbortController;
  readonly #assertActive: () => void;
  readonly #release: () => Promise<void>;
  readonly #physical = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  private constructor(input: {
    core: InstalledPluginTaskRuntimeCore;
    commands: ProjectMediaGenerationCommands;
    invocations: AsyncLocalStorage<Invocation>;
    lifetime: AbortController;
    assertActive(): void;
    release(): Promise<void>;
  }) {
    this.#core = input.core;
    this.#commands = input.commands;
    this.#invocations = input.invocations;
    this.#lifetime = input.lifetime;
    this.#assertActive = input.assertActive;
    this.#release = input.release;
    issued.add(this);
  }
  static async prepare(
    input: Readonly<{
      core: InstalledPluginTaskRuntimeCore;
      configuration: InstalledProjectMediaGenerationConfiguration;
    }>,
  ): Promise<InstalledProjectMediaGenerationRuntime> {
    const fields = materialPreparationFields(input, ["core", "configuration"]);
    const core = fields.core as InstalledPluginTaskRuntimeCore,
      host = installedProjectMediaGenerationTaskAuthority(core),
      configuration = captureInstalledProjectMediaGenerationConfiguration(
        fields.configuration as InstalledProjectMediaGenerationConfiguration,
      ),
      lifetime = new AbortController(),
      invocations = new AsyncLocalStorage<Invocation>();
    if (
      configuration.reviews.some(
        (r) =>
          !host.publications.some(
            (p) =>
              p.pluginId === r.targetIdentity.pluginId &&
              p.packageDigest === r.targetIdentity.packageDigest,
          ),
      )
    )
      denied();
    const active = () => {
      lifetime.signal.throwIfAborted();
      host.assertActive();
    };
    const context = (actor: ActorContext) => {
      active();
      host.requests.currentSignal().throwIfAborted();
      const state = invocations.getStore();
      if (
        !state ||
        !mediaInputSame(actor, state.actor) ||
        !mediaInputSame(actor, host.requests.currentActor()) ||
        host.requests.currentScope().profileId !== configuration.profileId
      )
        denied();
      state.admission?.assertActive();
      state.ui?.signal.throwIfAborted();
      state.ui?.authority.assertActive();
      return state;
    };
    const assertActive = (actor: ActorContext) => {
      context(actor);
    };
    const assertCurrent = async (actor: ActorContext) => {
      const state = context(actor);
      if (!state.admission) denied();
      await state.admission.assertCurrent();
      await state.ui?.authority.assertCurrent();
      context(actor);
    };
    const assertTransactionCurrent = async (actor: ActorContext) => {
      const state = context(actor);
      if (!state.admission) denied();
      await state.admission.assertTransactionCurrent();
      if (state.ui) await state.ui.authority.transaction!.assertCurrent();
      context(actor);
    };
    const metadataContext = (
      permission: Parameters<
        ProjectMediaInputAuthorizationPort["authorize"]
      >[0],
    ) => {
      const { command } = context(permission.actor),
        r = permission.resource;
      if (
        permission.action === "projectMediaInput:write" ||
        r.projectId !== command.projectId ||
        r.mediaInputId !== command.mediaInputId ||
        r.inputRevision !== command.inputRevision
      )
        denied();
    };
    const metadataAuthorization =
      Object.freeze<ProjectMediaInputAuthorizationPort>({
        authorize: async (p) => {
          metadataContext(p);
          await assertCurrent(p.actor);
          const result = await configuration.metadataAuthorization.authorize(p);
          await assertCurrent(p.actor);
          return result;
        },
        authorizeTransaction: async (p) => {
          metadataContext(p);
          await assertTransactionCurrent(p.actor);
          const result = await (
            configuration.metadataAuthorization.authorizeTransaction ??
            configuration.metadataAuthorization.authorize
          )(p);
          await assertTransactionCurrent(p.actor);
          return result;
        },
        assertActive: (p) => {
          metadataContext(p);
          const result = configuration.metadataAuthorization.assertActive(p);
          metadataContext(p);
          return result;
        },
      });
    // Generation's lower qualifier invokes this same PDP inside the Turn. Do not perform DB/file I/O here.
    const purposeContext = (
      p: Parameters<ProjectMediaGenerationAuthorizationPort["authorize"]>[0],
    ) => {
      const { command } = context(p.actor);
      const {
        projectId,
        mediaInputId,
        inputRevision,
        expectedInputRevision,
        executionId,
      } = command;
      if (p.action !== "projectMedia:generate") denied();
      if (
        !mediaInputSame(p.resource, {
          projectId,
          mediaInputId,
          inputRevision,
          expectedInputRevision,
          executionId,
        })
      )
        throw new ApplicationError(
          "conflict",
          "project_media_generation_replay_conflict",
        );
    };
    const authorization =
      Object.freeze<ProjectMediaGenerationAuthorizationPort>({
        authorize: async (p) => {
          purposeContext(p);
          await assertTransactionCurrent(p.actor);
          const result = await configuration.authorization.authorize(p);
          await assertTransactionCurrent(p.actor);
          return result;
        },
        assertActive: (p) => {
          purposeContext(p);
          const result = configuration.authorization.assertActive(p);
          purposeContext(p);
          return result;
        },
      });
    const admissions =
        await InstalledProjectMediaGenerationAdmissions.prepare(core),
      extensions = host.store.extensionStore(),
      store = host.store
        .projectAssetStore({ verifier: configuration.verifier })
        .projectMediaInputStore();
    active();
    await store.migrate();
    active();
    await extensions.migrateProjectMediaGenerations();
    active();
    let release: (() => Promise<void>) | undefined;
    try {
      const owner = await configuration.createMaterials(
        Object.freeze({
          store: host.store,
          signal: lifetime.signal,
          metadataAuthorization,
          assertCurrent,
          assertTransactionCurrent,
          assertActive,
        }),
      );
      release = projectMediaInputBound<() => Promise<void>>(owner, "close");
      const values = materialPreparationFields(owner, ["materials", "close"]);
      if (
        types.isProxy(values.materials) ||
        !(values.materials instanceof ProjectMediaMaterialPreparer)
      )
        denied();
      active();
      const preparer = new ProjectMediaGenerationTaskPreparer({
        materials: values.materials,
        store,
        extensions,
        reviews: configuration.reviews,
        metadataAuthorization,
        authorization,
        verifier: configuration.verifier,
      });
      const commands = new ProjectMediaGenerationCommands({
        profileId: configuration.profileId,
        preparer,
        tasks: core.extensionTasks,
        extensions,
        admissions: {
          resolve: async (request) => {
            const state = context(request.actor);
            if (!mediaInputSame(state.command, request.command)) denied();
            const result = await admissions.resolve(request);
            context(request.actor);
            if (
              state.ui &&
              (result.pin.packageDigest !==
                state.ui.context.package.packageDigest ||
                result.pin.pluginId !== state.ui.context.package.pluginId ||
                result.pin.profileId !== state.ui.context.scope.profileId ||
                result.pin.contributionId !==
                  state.ui.context.lease.contributionId)
            )
              denied();
            state.admission = result;
            return result;
          },
        },
      });
      return new InstalledProjectMediaGenerationRuntime({
        core,
        commands,
        invocations,
        lifetime,
        assertActive: active,
        release,
      });
    } catch (error) {
      lifetime.abort();
      try {
        await release?.();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "installed_project_media_generation_startup_cleanup_failed",
        );
      }
      throw error;
    }
  }
  assertAvailable(): void {
    this.#assertActive();
  }
  generate(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: GenerateProjectMediaRequest,
    signal?: AbortSignal,
  ) {
    this.#availableSlot();
    const command = parseGenerateProjectMediaRequest(input);
    return this.#track(
      this.#core.requests.run(
        {
          request,
          actor,
          signal: AbortSignal.any([
            this.#lifetime.signal,
            ...(signal ? [signal] : []),
          ]),
        },
        () => this.#execute(command, null),
      ),
    );
  }
  generateFromPluginUi(context: PluginUiActionContext, signal: AbortSignal) {
    // A copied lease or ordinary action context cannot grant generation authority.
    const authority = capturePluginUiInvocationCommitAuthority(context);
    this.#availableSlot();
    const request = parseProjectMediaGenerationUiRequest({
      action: context.action,
      input: context.input,
    });
    if (
      authority.transaction === undefined ||
      !mediaInputSame(context.actor, this.#core.requests.currentActor()) ||
      !mediaInputSame(context.scope, this.#core.requests.currentScope()) ||
      context.package.pluginId !== "crewon.short-drama" ||
      context.lease.contributionId !== "workbench" ||
      !context.lease.descriptor.requires.some(
        (r) =>
          r.service === CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE &&
          r.apiVersion === "1",
      ) ||
      !context.lease.descriptor.contributions.some(
        (c) =>
          c.id === context.lease.contributionId &&
          c.kind === "module" &&
          c.slot === "main.content",
      )
    )
      denied();
    return this.#track(
      this.#execute(request.input, { context, authority, signal }),
    );
  }
  #availableSlot() {
    this.#assertActive();
    if (this.#physical.size >= 16)
      throw new ApplicationError("conflict", "project_media_generation_busy");
  }
  #execute(command: GenerateProjectMediaRequest, ui: Invocation["ui"]) {
    return this.#invocations.run(
      {
        actor: this.#core.requests.currentActor(),
        command,
        admission: null,
        ui,
      },
      async () => {
        const signal = AbortSignal.any([
          this.#lifetime.signal,
          this.#core.requests.currentSignal(),
          ...(ui ? [ui.signal] : []),
        ]);
        signal.throwIfAborted();
        await ui?.authority.assertCurrent();
        signal.throwIfAborted();
        const result = await this.#commands.generate(
          this.#core.requests.currentActor(),
          command,
          { signal },
        );
        // Preserve the actual durable receipt even if response delivery is cancelled later.
        return parseGenerateProjectMediaResponse(command, {
          disposition: result.run.disposition,
          projectId: command.projectId,
          mediaInputId: command.mediaInputId,
          inputRevision: command.inputRevision,
          executionId: command.executionId,
          threadId: result.binding.threadId,
          threadRevision: result.turn.threadState.revision,
          runId: result.binding.runId,
        });
      },
    );
  }
  #track<T>(work: Promise<T>): Promise<T> {
    const pending = work.catch((error) => {
      throw publicFailure(error);
    });
    this.#physical.add(pending);
    void pending.then(
      () => this.#physical.delete(pending),
      () => this.#physical.delete(pending),
    );
    return pending;
  }
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= (async () => {
      await Promise.allSettled([...this.#physical]);
      await this.#commands.close();
      await this.#release();
    })());
  }
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_media_generation_denied",
  );
}
function publicFailure(error: unknown): unknown {
  if (
    error instanceof ApplicationError ||
    error instanceof ControlApiIdentityError
  )
    return error;
  if (
    error instanceof Error &&
    /^(project_media_generation|project_media_input)_(denied|owner_mismatch)$/u.test(
      error.message,
    )
  )
    return new ApplicationError(
      "authorization",
      "project_media_generation_denied",
    );
  if (
    error instanceof Error &&
    /^(project_media_generation|project_media_input)_(materials_unavailable|replay_conflict|revision_conflict|idempotency_conflict|target_changed|source_changed|item_changed|material_changed|brief_stale|project_archived)$/u.test(
      error.message,
    )
  )
    return new ApplicationError(
      "conflict",
      "project_media_generation_unavailable",
    );
  if (error instanceof Error && error.name === "AbortError") return error;
  return new ApplicationError("internal", "project_media_generation_failed", {
    cause: error,
  });
}
