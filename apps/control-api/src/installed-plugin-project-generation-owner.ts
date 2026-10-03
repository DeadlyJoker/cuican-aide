import {
  ApplicationError,
  ExtensionTaskApplicationService,
  PluginUiCommittedTaskAuthority,
  capturePluginUiInvocationCommitAuthority,
  isPluginUiCommittedProjectGenerationAuthority,
  projectGenerationUiTaskCommand,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
  type CreativeProjectStore,
  type PluginInstallationHostProfilePort,
  type PluginInstallationStore,
  type PluginUiActionPort,
  type PluginUiAuthorizationPort,
  type PluginUiOpaqueIdPort,
} from "@crewon/application";
import { parseProjectGenerationUiActionRequest } from "@crewon/contracts/plugins";
import {
  assertProjectGenerationExecutionPublication,
  captureProjectGenerationPublications,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
  type ProjectGenerationPublication,
} from "@crewon/domain";
import {
  PluginNodeHost,
  PluginProjectGenerationActionBridge,
  PluginProjectGenerationExecutionBridge,
  type PluginActivationCandidate,
  type PluginNodePreparedActivation,
  type PluginProjectGenerationDispatchPort,
  type PluginProjectGenerationExecutionResult,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  InstalledPluginTaskActionOwner,
  isInstalledPluginTaskActionOwnerBinding,
} from "./installed-plugin-task-action-owner.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import {
  generationCandidate,
  generationDenied,
  generationInstalledPackage,
  generationInstallRoot,
  generationMethod,
  generationSame,
  generationSameScope,
  generationSavedPrompt,
  generationSelectionMatches,
} from "./installed-plugin-project-generation-support.ts";

export type InstalledPluginProjectGenerationDependencies = Readonly<{
  installRoot: string;
  publications: readonly ProjectGenerationPublication[];
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadConceptRevision">;
  tasks: ExtensionTaskApplicationService;
  taskOwner: InstalledPluginTaskActionOwner;
  committedTasks: PluginUiCommittedTaskAuthority;
  profiles: PluginInstallationHostProfilePort;
  authorization: PluginUiAuthorizationPort;
  resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal: AbortSignal,
  ): Promise<ActorContext | null>;
  authorizePackage(
    input: Readonly<{
      actor: ActorContext;
      scope: import("@crewon/domain").PluginProfileScope;
      candidate: PluginActivationCandidate;
      purpose: "submit";
    }>,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  /** Actual enclosing authenticated request; captured once for the physical invocation. */
  requestSignal(): AbortSignal;
  clock: ApplicationClock;
  ids: PluginUiOpaqueIdPort;
  digester: ContentDigester;
  maximumInvocations?: number;
}>;
type Dispatch = Parameters<PluginProjectGenerationDispatchPort["generate"]>[0];
const owners = new WeakSet<object>();

export function isInstalledPluginProjectGenerationOwner(
  input: unknown,
): input is InstalledPluginProjectGenerationOwner {
  return input !== null && typeof input === "object" && owners.has(input);
}

/** Owns actual target Node resources while retaining the original business UI invocation. */
export class InstalledPluginProjectGenerationOwner
  implements PluginProjectGenerationDispatchPort
{
  readonly taskOwner: InstalledPluginTaskActionOwner;
  readonly actions: PluginUiActionPort;
  readonly hostUiServices: PluginUiHostServiceAvailabilityPort;
  readonly #dependencies: InstalledPluginProjectGenerationDependencies;
  readonly #bridge: PluginProjectGenerationActionBridge;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #pendingActions = new Set<Promise<unknown>>();
  readonly #executions = new Set<PluginProjectGenerationExecutionBridge>();
  readonly #cleanupFailures: unknown[] = [];
  readonly #maximum: number;
  readonly #submit: ExtensionTaskApplicationService["createPublishedProjectTaskFromPlugin"];
  #closing: Promise<void> | null = null;

  constructor(
    provided: InstalledPluginProjectGenerationDependencies,
    metadataServices?: PluginUiHostServiceAvailabilityPort,
  ) {
    const input = pluginSecurityRecord(provided, [
      "installRoot",
      "publications",
      "installations",
      "projects",
      "tasks",
      "taskOwner",
      "committedTasks",
      "profiles",
      "authorization",
      "resolveActor",
      "authorizePackage",
      "requestSignal",
      "clock",
      "ids",
      "digester",
      ...(Object.hasOwn(provided, "maximumInvocations")
        ? ["maximumInvocations"]
        : []),
    ]) as InstalledPluginProjectGenerationDependencies;
    if (
      !(input.tasks instanceof ExtensionTaskApplicationService) ||
      !(input.committedTasks instanceof PluginUiCommittedTaskAuthority) ||
      !isInstalledPluginTaskActionOwnerBinding({
        owner: input.taskOwner,
        tasks: input.tasks,
        committedTasks: input.committedTasks,
      })
    )
      throw new Error(
        "installed_plugin_project_generation_configuration_invalid",
      );
    const maximum = input.maximumInvocations ?? 32;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128)
      throw new Error(
        "installed_plugin_project_generation_configuration_invalid",
      );
    const publications = captureProjectGenerationPublications(
      input.publications,
    );
    if (
      !isPluginUiCommittedProjectGenerationAuthority({
        authority: input.committedTasks,
        publications,
      })
    )
      throw new Error(
        "installed_plugin_project_generation_configuration_invalid",
      );
    this.#maximum = maximum;
    this.#submit = generationMethod(
      input.tasks,
      "createPublishedProjectTaskFromPlugin",
    );
    this.taskOwner = input.taskOwner;
    this.#dependencies = Object.freeze({
      installRoot: generationInstallRoot(input.installRoot),
      publications,
      installations: Object.freeze({
        loadSelection: generationMethod(input.installations, "loadSelection"),
        loadPackage: generationMethod(input.installations, "loadPackage"),
      }),
      projects: Object.freeze({
        loadProject: generationMethod(input.projects, "loadProject"),
        loadConceptRevision: generationMethod(
          input.projects,
          "loadConceptRevision",
        ),
      }),
      tasks: input.tasks,
      taskOwner: input.taskOwner,
      committedTasks: input.committedTasks,
      profiles: Object.freeze({
        resolve: generationMethod(input.profiles, "resolve"),
      }),
      authorization: Object.freeze({
        authorize: generationMethod(input.authorization, "authorize"),
      }),
      resolveActor: generationMethod(input, "resolveActor"),
      authorizePackage: generationMethod(input, "authorizePackage"),
      requestSignal: generationMethod(input, "requestSignal"),
      clock: Object.freeze({ now: generationMethod(input.clock, "now") }),
      ids: Object.freeze({ nextId: generationMethod(input.ids, "nextId") }),
      digester: Object.freeze({
        sha256: generationMethod(input.digester, "sha256"),
      }),
      maximumInvocations: maximum,
    });
    this.#bridge = new PluginProjectGenerationActionBridge({
      publications: this.#dependencies.publications,
      generation: {
        generate: (request) => this.generate(request),
        isAvailable: (request) => this.isAvailable(request),
      },
      committedTasks: input.committedTasks,
    });
    const actions = this.#bridge.actions(input.taskOwner.actions);
    this.actions = Object.freeze({
      invoke: (context: Parameters<PluginUiActionPort["invoke"]>[0]) => {
        const descriptor = Object.getOwnPropertyDescriptor(context, "action");
        if (
          !descriptor ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "string" ||
          !descriptor.value.startsWith("crewon.project-generations.")
        )
          return actions.invoke(context);
        this.#available();
        const work = actions.invoke(context);
        this.#pendingActions.add(work);
        void work.then(
          () => this.#pendingActions.delete(work),
          () => this.#pendingActions.delete(work),
        );
        return work;
      },
    });
    this.hostUiServices = this.#bridge.hostUiServices(metadataServices);
    owners.add(this);
    Object.freeze(this);
  }

  supportsAction(action: string): boolean {
    return action === "crewon.project-generations.v1.generateConcept";
  }

  isAvailable(
    input: Parameters<PluginProjectGenerationDispatchPort["isAvailable"]>[0],
  ): boolean {
    if (this.#lifetime.signal.aborted || this.#cleanupFailures.length)
      return false;
    return (
      this.#dependencies.publications.some((item) =>
        generationSame(item, input.publication),
      ) &&
      input.candidate.packageDigest ===
        input.publication.source.packageDigest &&
      input.candidate.descriptor.pluginId === input.publication.source.pluginId
    );
  }

  generate(
    input: Dispatch,
  ): ReturnType<PluginProjectGenerationDispatchPort["generate"]> {
    this.#available();
    if (this.#pending.size >= this.#maximum)
      throw new ApplicationError("conflict", "project_generation_host_busy");
    const work = this.#generate(input);
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#lifetime.abort();
    this.#bridge.close();
    for (const execution of this.#executions) execution.close();
    return (this.#closing = Promise.allSettled([
      ...this.#pending,
      ...this.#pendingActions,
    ]).then(() => {
      if (this.#cleanupFailures.length)
        throw new AggregateError(
          this.#cleanupFailures,
          "project_generation_host_cleanup_failed",
        );
    }));
  }

  #available(): void {
    if (this.#lifetime.signal.aborted)
      generationDenied("project_generation_host_closed");
    if (this.#cleanupFailures.length)
      generationDenied("project_generation_host_cleanup_failed");
  }

  async #generate(input: Dispatch) {
    const { context } = input;
    const originalInvocation =
      capturePluginUiInvocationCommitAuthority(context);
    const authority = Object.freeze({
      assertCurrent: generationMethod(input.authority, "assertCurrent"),
      assertActive: generationMethod(input.authority, "assertActive"),
    });
    const actor = pluginSecurityActor(context.actor);
    const scope = parsePluginProfileScope(context.scope);
    const sourceSelection = parsePluginSelection(context.selection);
    const sourcePackage = parseInstalledPluginPackage(context.package);
    const sourcePin = parsePluginTaskAdmissionPin(input.sourcePin);
    const publication = this.#dependencies.publications.find((item) =>
      generationSame(item, input.publication),
    );
    if (!publication)
      generationDenied("project_generation_publication_unapproved");
    const parsed = parseProjectGenerationUiActionRequest({
      action: context.action,
      input: context.input,
    });
    if (
      !generationSame(parsed.input, input.request) ||
      !generationSameScope(scope, sourcePackage) ||
      !generationSelectionMatches(sourceSelection, sourcePin) ||
      !generationSame(actor, {
        principalId: sourcePin.principalId,
        actorId: sourcePin.actorId,
        tenantId: sourcePin.tenantId,
        spaceId: sourcePin.spaceId,
      })
    )
      generationDenied("project_generation_source_context_changed");
    const rawSignal = this.#dependencies.requestSignal();
    if (!(rawSignal instanceof AbortSignal))
      generationDenied("project_generation_request_signal_invalid");
    const signal = AbortSignal.any([rawSignal, this.#lifetime.signal]);
    const active = () => {
      this.#available();
      signal.throwIfAborted();
      originalInvocation.assertActive();
      authority.assertActive();
    };
    active();
    await authority.assertCurrent();
    active();
    const target = await generationInstalledPackage({
      installations: this.#dependencies.installations,
      scope,
      pluginId: publication.target.pluginId,
      packageDigest: publication.target.packageDigest,
      assertActive: active,
    });
    const sourceCandidate = await generationCandidate({
      installRoot: this.#dependencies.installRoot,
      package: sourcePackage,
      signal,
    });
    const targetCandidate = await generationCandidate({
      installRoot: this.#dependencies.installRoot,
      package: target.package,
      signal,
    });
    active();
    if (targetCandidate.descriptor.entrypoints.node === null)
      generationDenied("project_generation_execution_entry_missing");
    if (
      !targetCandidate.descriptor.contributions.some(
        (item) => item.id === publication.target.contributionId,
      )
    )
      generationDenied("project_generation_execution_contribution_missing");
    const policy = async (
      pin: Pick<
        PluginTaskAdmissionPin,
        "pluginId" | "packageDigest" | "selectionRevision" | "contributionId"
      >,
    ) => {
      active();
      const decision = await this.#dependencies.authorization.authorize({
        actor,
        action: "invoke",
        resource: {
          kind: "pluginUi",
          ...scope,
          pluginId: pin.pluginId,
          packageDigest: pin.packageDigest,
          selectionRevision: pin.selectionRevision,
          contributionId: pin.contributionId,
        },
      });
      active();
      if (decision.outcome !== "allow")
        generationDenied("project_generation_plugin_authority_changed");
      return decision.authorityEpoch;
    };
    const targetEpoch = await policy({
      pluginId: target.package.pluginId,
      packageDigest: target.package.packageDigest,
      selectionRevision: target.selection.revision,
      contributionId: publication.target.contributionId,
    });
    const executionPin = parsePluginTaskAdmissionPin({
      ...scope,
      ...actor,
      pluginId: target.package.pluginId,
      publisherId: target.package.publisherId,
      version: target.package.version,
      packageDigest: target.package.packageDigest,
      selectionRevision: target.selection.revision,
      contributionId: publication.target.contributionId,
      action: publication.target.action,
      authorityEpoch: targetEpoch,
    });
    assertProjectGenerationExecutionPublication({
      publication,
      sourcePin,
      executionPin,
    });
    const transactionCurrent = async () => {
      active();
      const currentActor = await this.#dependencies.resolveActor(
        {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          actorId: actor.actorId,
        },
        signal,
      );
      active();
      if (
        currentActor === null ||
        !generationSame(pluginSecurityActor(currentActor), actor)
      )
        generationDenied("project_generation_identity_changed");
      const currentScope = parsePluginProfileScope(
        await this.#dependencies.profiles.resolve(actor),
      );
      active();
      if (!generationSame(currentScope, scope))
        generationDenied("project_generation_profile_changed");
      for (const [pin, pkg, candidate] of [
        [sourcePin, sourcePackage, sourceCandidate],
        [executionPin, target.package, targetCandidate],
      ] as const) {
        if ((await policy(pin)) !== pin.authorityEpoch)
          generationDenied("project_generation_plugin_authority_changed");
        await generationCandidate({
          installRoot: this.#dependencies.installRoot,
          package: pkg,
          signal,
          expected: candidate,
        });
        active();
        if (
          (await this.#dependencies.authorizePackage(
            { actor, scope, candidate, purpose: "submit" },
            signal,
          )) !== "allow"
        )
          generationDenied("project_generation_execution_package_denied");
        active();
      }
    };
    const current = async () => {
      await transactionCurrent();
      await generationInstalledPackage({
        installations: this.#dependencies.installations,
        scope,
        pluginId: sourcePin.pluginId,
        packageDigest: sourcePin.packageDigest,
        expectedSelection: sourceSelection,
        expectedPackage: sourcePackage,
        assertActive: active,
      });
      await generationInstalledPackage({
        installations: this.#dependencies.installations,
        scope,
        pluginId: executionPin.pluginId,
        packageDigest: executionPin.packageDigest,
        expectedSelection: target.selection,
        expectedPackage: target.package,
        assertActive: active,
      });
      await authority.assertCurrent();
      active();
    };
    const executionAuthority = Object.freeze({
      assertCurrent: current,
      assertTransactionCurrent: transactionCurrent,
      assertActive: active,
    });
    await current();
    const prompt = await generationSavedPrompt({
      projects: this.#dependencies.projects,
      actor,
      reference: parsed.input.reference,
      digester: this.#dependencies.digester,
      assertActive: active,
    });
    const command = projectGenerationUiTaskCommand(
      { sourcePin, executionPin, request: parsed.input, prompt },
      this.#dependencies.digester,
    );
    const bridge = new PluginProjectGenerationExecutionBridge({
      clock: this.#dependencies.clock,
      ids: this.#dependencies.ids,
    });
    const host = new PluginNodeHost({
      services: [bridge.hostService(), bridge.hostServiceV2()],
    });
    this.#executions.add(bridge);
    let prepared: PluginNodePreparedActivation | undefined;
    let committed = false;
    let output: PluginProjectGenerationExecutionResult | undefined;
    let failure: unknown;
    try {
      prepared = await host.prepare({
        installRoot: this.#dependencies.installRoot,
        expectedPluginId: executionPin.pluginId,
        expectedPackageDigest: executionPin.packageDigest,
        authorizeActivation: async (candidate) => {
          if (!generationSame(candidate, targetCandidate))
            generationDenied("project_generation_plugin_bytes_changed");
          await current();
          return "allow" as const;
        },
      });
      await current();
      prepared.commit({
        authorizeCommit: (candidate) => {
          active();
          return candidate.identity.pluginId === executionPin.pluginId &&
            candidate.identity.version === executionPin.version &&
            candidate.packageDigest === executionPin.packageDigest
            ? "allow"
            : "deny";
        },
      });
      committed = true;
      output = await bridge.execute(host, {
        context,
        publication,
        sourcePin,
        executionPin,
        request: parsed.input,
        targetCandidate,
        command,
        authority: executionAuthority,
        commit: ({
          command: capturedCommand,
          executionPin: capturedPin,
          authority: capturedAuthority,
        }) =>
          this.#submit({
            actor,
            command: capturedCommand,
            reference: parsed.input.reference,
            publication,
            sourcePin,
            executionPin: capturedPin,
            authority: capturedAuthority,
          }),
      });
    } catch (error) {
      failure = error;
    } finally {
      bridge.close();
      this.#executions.delete(bridge);
      // Join real Node cleanup; withdrawal is not physical disposal.
      const cleanup: unknown[] = [];
      if (!committed)
        try {
          await prepared?.abort();
        } catch (error) {
          cleanup.push(error);
        }
      try {
        await host.close();
      } catch (error) {
        cleanup.push(error);
      }
      if (cleanup.length) {
        this.#cleanupFailures.push(...cleanup);
        if (output === undefined)
          failure = new AggregateError(
            [...(failure === undefined ? [] : [failure]), ...cleanup],
            "project_generation_host_cleanup_failed",
          );
      }
    }
    // The durable result remains publishable even if trusted Node cleanup fails after COMMIT.
    if (output !== undefined) return output;
    throw (
      failure ??
      new ApplicationError("internal", "project_generation_host_result_missing")
    );
  }
}
