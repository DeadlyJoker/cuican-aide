import { readProjectAssetStageRuntimeScope } from "./project-asset-stage-runtime-scope.ts";
import type { ProjectAssetStageStore } from "@crewon/application";
import type { ProjectAssetStageRunAdmission } from "@crewon/domain";
import { createHash } from "node:crypto";
import type {
  ActorContext,
  AuthorizationPort,
  CommitExtensionTurnResult,
  ExtensionRunLocator,
  ExtensionStore,
  PluginInstallationStore,
  RunStore,
  ExternalOperationStore,
  ProjectConversationStore,
  ProjectTextPlanStore,
} from "@crewon/application";
import { loadPluginQuerySource } from "@crewon/application";
import {
  assertPluginTaskFunding,
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionRunBinding,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  parsePluginTaskAdmission,
  pluginInstallationOpaqueId,
  reduceRunLifecycleEvent,
  type ExtensionRunBinding,
  type ExtensionExecutionTarget,
  type PluginTaskAdmission,
  type RunState,
  parsePluginQueryTaskAdmission,
  effectivePluginQueryTaskAdmission,
  assertPluginQueryTaskAdmission,
  type PluginQueryTaskAdmission,
  type PluginTaskAdmissionPin,
  type ProjectStageRunAdmission,
  type ProjectTextPlanRunAdmission,
} from "@crewon/domain";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import { readProjectTextPlanRuntimeScope } from "./project-text-plan-runtime-scope.ts";
import { readProjectStageRuntimeScope } from "./project-stage-runtime-scope.ts";

export type InstalledPluginRunPurpose = "submit" | "observe";
export type InstalledPluginRunSnapshot = Readonly<{
  context: PluginToolRuntimeContext;
}>;
export type InstalledPluginRunContextDependencies = Readonly<{
  extensions: ExtensionStore;
  runs: Pick<RunStore, "loadRunInSpace">;
  installations: PluginInstallationStore;
  authorization: AuthorizationPort;
  operations?: Pick<ExternalOperationStore, "loadExternalOperation">;
  conversations?: Pick<
    ProjectConversationStore,
    "loadStageAdmission" | "readRequiredStageDigest"
  >;
  assetStages?: Pick<
    ProjectAssetStageStore,
    "loadAssetStageAdmission" | "readRequiredAssetStageDigest"
  >;
  plans?: Pick<
    ProjectTextPlanStore,
    "readRequiredPlanDigest" | "loadRunAdmission"
  >;
  resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal: AbortSignal,
  ): Promise<ActorContext | null>;
}>;
type SavedContext = Readonly<{
  admission: PluginTaskAdmission;
  binding: ExtensionRunBinding;
  context: PluginToolRuntimeContext;
  toolPermissionMode: RunState["toolPermissionMode"] | null;
  query: PluginQueryTaskAdmission | null;
  projectStage: ProjectStageRunAdmission | null;
  projectTextPlan: ProjectTextPlanRunAdmission | null;
  projectAssetStage: ProjectAssetStageRunAdmission | null;
}>;
const digester = {
  sha256: (input: string) =>
    `sha256:${createHash("sha256").update(input).digest("hex")}`,
};

export class InstalledPluginRunContextError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "InstalledPluginRunContextError";
    this.code = code;
  }
}
function fail(code: string): never {
  throw new InstalledPluginRunContextError(code);
}

/** Private persisted identity reader, not an installed-file verifier or a Worker dispatcher. */
export class InstalledPluginRunContext {
  readonly #dependencies: InstalledPluginRunContextDependencies;
  readonly #snapshots = new WeakMap<InstalledPluginRunSnapshot, SavedContext>();

  constructor(dependencies: InstalledPluginRunContextDependencies) {
    if (
      dependencies.extensions.pluginAdmissionVersion !==
        "crewon.plugin-task-admission.v1" ||
      typeof dependencies.extensions.loadPluginTaskAdmission !== "function" ||
      typeof dependencies.extensions.loadExtensionTurnReceipt !== "function" ||
      typeof dependencies.runs.loadRunInSpace !== "function" ||
      typeof dependencies.installations.loadPackage !== "function" ||
      typeof dependencies.installations.loadSelection !== "function" ||
      typeof dependencies.authorization.authorize !== "function" ||
      typeof dependencies.resolveActor !== "function" ||
      (dependencies.extensions.loadPluginQueryTaskAdmission !== undefined &&
        dependencies.extensions.pluginQueryAdmissionVersion !==
          "crewon.plugin-query-task-admission.v1")
    )
      fail("installed_plugin_context_port_unavailable");
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async load(
    input: Readonly<{
      locator: ExtensionRunLocator;
      /** Already verified base-runtime target; this reader cannot prove Agent assets or file bytes. */
      expectedTarget: ExtensionExecutionTarget;
      purpose: InstalledPluginRunPurpose;
      signal: AbortSignal;
    }>,
  ): Promise<InstalledPluginRunSnapshot | null> {
    const value = record(input, [
      "locator",
      "expectedTarget",
      "purpose",
      "signal",
    ]);
    const rawLocator = record(value.locator, ["tenantId", "spaceId", "runId"]);
    const locator = Object.freeze({
      tenantId: extensionOpaqueId(rawLocator.tenantId),
      spaceId: extensionOpaqueId(rawLocator.spaceId),
      runId: extensionOpaqueId(rawLocator.runId),
    });
    const target = parseExtensionExecutionTarget(value.expectedTarget);
    const purpose = checkedPurpose(value.purpose);
    const signal = checkedSignal(value.signal);
    const saved = await this.#read(locator, target, signal);
    if (saved === null) return null;
    await this.#authorize(saved, purpose, signal);
    const snapshot = Object.freeze({ context: saved.context });
    this.#snapshots.set(snapshot, saved);
    return snapshot;
  }

  async assertCurrent(
    snapshot: InstalledPluginRunSnapshot,
    purposeInput: InstalledPluginRunPurpose,
    signalInput: AbortSignal,
  ): Promise<void> {
    const previous = this.#snapshots.get(snapshot);
    if (previous === undefined)
      fail("installed_plugin_context_snapshot_invalid");
    const purpose = checkedPurpose(purposeInput);
    const signal = checkedSignal(signalInput);
    const current = await this.#read(
      previous.binding,
      previous.binding.target,
      signal,
    );
    if (
      current === null ||
      extensionCanonicalJson(current) !== extensionCanonicalJson(previous)
    )
      fail("installed_plugin_context_changed");
    await this.#authorize(current, purpose, signal);
  }

  /** Host-only projection from the actual persisted Run; never supplied by a plugin or copied snapshot. */
  verifiedToolPermissionMode(
    snapshot: InstalledPluginRunSnapshot,
  ): RunState["toolPermissionMode"] | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.toolPermissionMode;
  }
  verifiedProjectStage(
    snapshot: InstalledPluginRunSnapshot,
  ): ProjectStageRunAdmission | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.projectStage;
  }

  verifiedProjectAssetStage(
    snapshot: InstalledPluginRunSnapshot,
  ): ProjectAssetStageRunAdmission | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.projectAssetStage;
  }

  verifiedProjectTextPlan(
    snapshot: InstalledPluginRunSnapshot,
  ): ProjectTextPlanRunAdmission | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.projectTextPlan;
  }

  async #read(
    locator: ExtensionRunLocator,
    expectedTarget: ExtensionExecutionTarget,
    signal: AbortSignal,
  ): Promise<SavedContext | null> {
    const extensions = this.#dependencies.extensions;
    signal.throwIfAborted();
    const rawAdmission = await extensions.loadPluginTaskAdmission!(locator);
    signal.throwIfAborted();
    // Only an authoritative absent v1 record follows the unchanged v0 route.
    const rawQuery =
      extensions.loadPluginQueryTaskAdmission === undefined
        ? null
        : await extensions.loadPluginQueryTaskAdmission(locator);
    signal.throwIfAborted();
    if (rawAdmission === null && rawQuery === null) return null;
    if (rawAdmission !== null && rawQuery !== null)
      fail("installed_plugin_admission_conflict");
    const query =
      rawQuery === null ? null : parsePluginQueryTaskAdmission(rawQuery);
    const admission =
      query === null
        ? parsePluginTaskAdmission(rawAdmission)
        : effectivePluginQueryTaskAdmission(query);
    if (
      admission.tenantId !== locator.tenantId ||
      admission.spaceId !== locator.spaceId ||
      admission.runId !== locator.runId
    )
      fail("installed_plugin_admission_scope_mismatch");
    const rawBinding = await extensions.loadExtensionRunBinding(locator);
    signal.throwIfAborted();
    if (rawBinding === null) fail("installed_plugin_binding_missing");
    const binding = parseExtensionRunBinding(rawBinding, digester);
    if (binding.source !== null && query === null)
      fail("installed_plugin_query_source_unsupported");
    const receipt = Object.freeze({
      actorId: admission.actorId,
      idempotencyKey: admission.idempotencyKey,
      requestDigest: admission.requestDigest,
    });
    if (query === null)
      assertPluginTaskAdmission({ admission, binding, receipt }, digester);
    else {
      if (this.#dependencies.operations === undefined)
        fail("installed_plugin_query_operations_unavailable");
      const actor = await this.#actor(admission, signal);
      const source = await loadPluginQuerySource({
        actor,
        pluginId: query.pluginId,
        profileId: query.profileId,
        publisherId: query.publisherId,
        sourceRunId: query.source.runId,
        operationId: query.operationId,
        extensions,
        runs: this.#dependencies.runs,
        operations: this.#dependencies.operations,
        authorization: this.#dependencies.authorization,
        digester,
      });
      signal.throwIfAborted();
      assertPluginQueryTaskAdmission(
        { admission: query, binding, sourceBinding: source.binding, receipt },
        digester,
      );
      if (
        extensionCanonicalJson(query.source) !==
        extensionCanonicalJson(source.admission)
      )
        fail("installed_plugin_query_source_changed");
    }
    if (
      extensionCanonicalJson(binding.target) !==
      extensionCanonicalJson(expectedTarget)
    )
      fail("installed_plugin_target_mismatch");
    const rawReceipt = await extensions.loadExtensionTurnReceipt({
      ...binding,
      receipt,
    });
    signal.throwIfAborted();
    if (rawReceipt === null) fail("installed_plugin_task_receipt_missing");
    const original = validateReceipt(
      rawReceipt,
      binding,
      admission,
      receipt,
      query,
    );
    const run = await this.#dependencies.runs.loadRunInSpace(locator);
    signal.throwIfAborted();
    if (run === null) fail("installed_plugin_run_missing");
    assertRun(run, binding, original);
    const projectAssetStage =
      this.#dependencies.assetStages === undefined
        ? null
        : await readProjectAssetStageRuntimeScope({
            stages: this.#dependencies.assetStages,
            admission,
            binding,
            signal,
          });
    if (
      projectAssetStage !== null &&
      (query !== null ||
        (rawReceipt.turn.threadState.workspaceId ?? null) !==
          projectAssetStage.workspaceId)
    )
      fail("installed_plugin_asset_stage_mismatch");
    const projectStage =
      this.#dependencies.conversations === undefined
        ? null
        : await readProjectStageRuntimeScope({
            conversations: this.#dependencies.conversations,
            admission,
            binding,
            signal,
          });
    if (
      projectStage !== null &&
      (query !== null ||
        (rawReceipt.turn.threadState.workspaceId ?? null) !==
          projectStage.workspaceId)
    )
      fail("installed_plugin_project_stage_mismatch");
    if (projectStage !== null && projectAssetStage !== null)
      fail("installed_plugin_asset_stage_conflict");
    const projectTextPlan =
      this.#dependencies.plans === undefined
        ? null
        : await readProjectTextPlanRuntimeScope({
            plans: this.#dependencies.plans,
            admission,
            binding,
            stage: projectStage,
            signal,
          });
    const rawConfiguration = await extensions.loadExtensionConfiguration({
      ...binding,
      revision: binding.configurationRevision,
    });
    signal.throwIfAborted();
    if (rawConfiguration === null)
      fail("installed_plugin_configuration_missing");
    const configuration = parseExtensionConfiguration(
      rawConfiguration,
      digester,
    );
    if (
      configuration.tenantId !== binding.tenantId ||
      configuration.spaceId !== binding.spaceId ||
      configuration.pluginId !== binding.pluginId ||
      configuration.revision !== binding.configurationRevision ||
      configuration.contentDigest !== binding.configurationDigest ||
      configuration.pluginVersion !== admission.version
    )
      fail("installed_plugin_configuration_mismatch");
    const scope = parsePluginProfileScope({
      tenantId: admission.tenantId,
      spaceId: admission.spaceId,
      profileId: admission.profileId,
    });
    const rawPackage = await this.#dependencies.installations.loadPackage({
      scope,
      packageDigest: admission.packageDigest,
    });
    signal.throwIfAborted();
    if (rawPackage === null) fail("installed_plugin_package_missing");
    const pkg = parseInstalledPluginPackage(rawPackage);
    for (const field of [
      "tenantId",
      "spaceId",
      "profileId",
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
    ] as const)
      if (pkg[field] !== admission[field])
        fail("installed_plugin_package_mismatch");
    const context: PluginToolRuntimeContext = Object.freeze({
      identity: Object.freeze({
        pluginId: pkg.pluginId,
        version: pkg.version,
        packageDigest: pkg.packageDigest,
      }),
      scope,
      run: Object.freeze({
        runId: binding.runId,
        threadId: binding.threadId,
        bindingDigest: binding.bindingDigest,
        inputDigest: binding.inputDigest,
        source: binding.source,
      }),
      configuration: Object.freeze({
        revision: configuration.revision,
        contentDigest: configuration.contentDigest,
        parameters: configuration.parameters,
        credentialBindings: configuration.credentialBindings,
      }),
      target: binding.target,
    });
    return Object.freeze({
      admission,
      binding,
      context,
      toolPermissionMode: run.toolPermissionMode ?? null,
      query,
      projectStage,
      projectTextPlan,
      projectAssetStage,
    });
  }

  async #authorize(
    saved: SavedContext,
    purpose: InstalledPluginRunPurpose,
    signal: AbortSignal,
  ) {
    const { admission, binding } = saved;
    if (saved.query !== null) purpose = "observe";
    const initial = await this.#activation(binding, purpose, signal);
    const selection = await this.#selection(
      saved.query ?? admission,
      purpose,
      signal,
    );
    const actor = await this.#actor(admission, signal);
    for (const request of [
      {
        actor,
        action: "run:execute" as const,
        resource: {
          kind: "run" as const,
          tenantId: binding.tenantId,
          spaceId: binding.spaceId,
          threadId: binding.threadId,
          runId: binding.runId,
        },
      },
      {
        actor,
        action:
          purpose === "submit"
            ? ("extension:run" as const)
            : ("extension:query" as const),
        resource: {
          kind: "extension" as const,
          tenantId: binding.tenantId,
          spaceId: binding.spaceId,
          pluginId: binding.pluginId,
        },
      },
    ]) {
      signal.throwIfAborted();
      const decision =
        await this.#dependencies.authorization.authorize(request);
      signal.throwIfAborted();
      const outcome = Object.getOwnPropertyDescriptor(decision, "outcome");
      if (
        !outcome?.enumerable ||
        !Object.hasOwn(outcome, "value") ||
        outcome.value !== "allow"
      )
        fail("installed_plugin_execution_access_denied");
    }
    const latest = await this.#activation(binding, purpose, signal);
    if (extensionCanonicalJson(initial) !== extensionCanonicalJson(latest))
      fail("installed_plugin_activation_changed");
    const latestSelection = await this.#selection(
      saved.query ?? admission,
      purpose,
      signal,
    );
    if (
      extensionCanonicalJson(selection) !==
      extensionCanonicalJson(latestSelection)
    )
      fail("installed_plugin_selection_changed");
    const currentActor = await this.#actor(admission, signal);
    if (extensionCanonicalJson(currentActor) !== extensionCanonicalJson(actor))
      fail("installed_plugin_execution_identity_unavailable");
  }

  async #selection(
    admission: PluginTaskAdmissionPin,
    purpose: InstalledPluginRunPurpose,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const scope = parsePluginProfileScope({
      tenantId: admission.tenantId,
      spaceId: admission.spaceId,
      profileId: admission.profileId,
    });
    const raw = await this.#dependencies.installations.loadSelection({
      scope,
      pluginId: admission.pluginId,
    });
    signal.throwIfAborted();
    if (raw === null) fail("installed_plugin_selection_missing");
    const selection = parsePluginSelection(raw);
    for (const field of [
      "tenantId",
      "spaceId",
      "profileId",
      "pluginId",
      "publisherId",
    ] as const)
      if (selection[field] !== admission[field])
        fail("installed_plugin_selection_scope_mismatch");
    if (selection.revision < admission.selectionRevision)
      fail("installed_plugin_selection_revision_invalid");
    if (
      selection.revision === admission.selectionRevision &&
      (selection.state !== "enabled" ||
        selection.selectedPackageDigest !== admission.packageDigest)
    )
      fail("installed_plugin_selection_admission_mismatch");
    // Selection gates new operations, while the immutable admission still selects
    // the original package for recovery after upgrade or logical uninstall.
    if (purpose === "submit" && selection.state !== "enabled")
      fail("installed_plugin_generation_disabled");
    return selection;
  }

  async #activation(
    binding: ExtensionRunBinding,
    purpose: InstalledPluginRunPurpose,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const raw =
      await this.#dependencies.extensions.loadExtensionActivation(binding);
    signal.throwIfAborted();
    if (raw === null) fail("installed_plugin_access_revoked");
    const activation = parseExtensionActivation(raw);
    if (
      activation.tenantId !== binding.tenantId ||
      activation.spaceId !== binding.spaceId ||
      activation.pluginId !== binding.pluginId
    )
      fail("installed_plugin_activation_scope_mismatch");
    if (activation.state === "revoked") fail("installed_plugin_access_revoked");
    if (purpose === "submit" && activation.state !== "enabled")
      fail("installed_plugin_generation_disabled");
    return activation;
  }

  async #actor(
    admission: PluginTaskAdmission,
    signal: AbortSignal,
  ): Promise<ActorContext> {
    signal.throwIfAborted();
    const resolved = await this.#dependencies.resolveActor(
      Object.freeze({
        tenantId: admission.tenantId,
        spaceId: admission.spaceId,
        actorId: admission.actorId,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (resolved === null)
      fail("installed_plugin_execution_identity_unavailable");
    const value = record(resolved, [
      "tenantId",
      "spaceId",
      "actorId",
      "principalId",
    ]);
    const actor = Object.freeze({
      tenantId: extensionOpaqueId(value.tenantId),
      spaceId: extensionOpaqueId(value.spaceId),
      actorId: extensionOpaqueId(value.actorId),
      principalId: pluginInstallationOpaqueId(value.principalId),
    });
    for (const field of [
      "tenantId",
      "spaceId",
      "actorId",
      "principalId",
    ] as const)
      if (actor[field] !== admission[field])
        fail("installed_plugin_execution_identity_unavailable");
    return actor;
  }
}

function validateReceipt(
  input: CommitExtensionTurnResult,
  binding: ExtensionRunBinding,
  admission: PluginTaskAdmission,
  receipt: { actorId: string; idempotencyKey: string; requestDigest: string },
  query: PluginQueryTaskAdmission | null = null,
): RunState {
  // The same bounded, accessor-free Domain JSON capture used by v0 config/binding parsing.
  const saved = JSON.parse(
    extensionCanonicalJson(input),
  ) as CommitExtensionTurnResult;
  if (
    saved.schemaVersion !== "crewon.extension-turn-admission.v0" ||
    !saved.turn ||
    !saved.run ||
    saved.run.events.length !== 1 ||
    saved.run.events[0]?.type !== "run.created"
  )
    fail("installed_plugin_task_receipt_invalid");
  if (
    extensionCanonicalJson(
      parseExtensionRunBinding(saved.binding, digester),
    ) !== extensionCanonicalJson(binding)
  )
    fail("installed_plugin_task_receipt_mismatch");
  const original = reduceRunLifecycleEvent(null, saved.run.events[0]);
  assertRun(original, binding, original);
  if (
    extensionCanonicalJson(original) !==
      extensionCanonicalJson(saved.run.state) ||
    extensionCanonicalJson(original) !==
      extensionCanonicalJson(saved.turn.runState) ||
    extensionCanonicalJson(saved.run.events) !==
      extensionCanonicalJson(saved.turn.runEvents)
  )
    fail("installed_plugin_task_receipt_mismatch");
  if (query === null)
    assertPluginTaskFunding(
      {
        ...(saved.creditAdmission === undefined
          ? {}
          : { creditAdmission: saved.creditAdmission }),
        ...(saved.unmeteredAdmission === undefined
          ? {}
          : { unmeteredAdmission: saved.unmeteredAdmission }),
        binding,
        receipt,
        principalId: admission.principalId,
        task: admission,
      },
      digester,
    );
  else if (
    saved.creditAdmission !== undefined ||
    saved.unmeteredAdmission !== undefined
  )
    fail("installed_plugin_task_receipt_owner_mismatch");
  const messages = saved.turn.messages;
  if (
    messages.length !== 1 ||
    messages[0]?.tenantId !== binding.tenantId ||
    messages[0]?.threadId !== binding.threadId ||
    messages[0]?.role !== "user" ||
    messages[0].contentDigest !== binding.inputDigest ||
    digester.sha256(messages[0].content) !== binding.inputDigest ||
    saved.turn.threadState.tenantId !== binding.tenantId ||
    saved.turn.threadState.spaceId !== binding.spaceId ||
    saved.turn.threadState.threadId !== binding.threadId
  )
    fail("installed_plugin_task_receipt_mismatch");
  return original;
}

function assertRun(
  input: RunState,
  binding: ExtensionRunBinding,
  original: RunState,
): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    fail("installed_plugin_run_authority_mismatch");
  const expected = {
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    runId: binding.runId,
    threadId: binding.threadId,
    createdByActorId: binding.actorId,
    agentVersionId: binding.target.agentVersionId,
    authorityId: binding.target.authorityId,
    runtimeGeneration: binding.target.runtimeGeneration,
    policySnapshotId: binding.target.policySnapshotId,
    workspaceBindingId: binding.target.workspaceBindingId,
    origin: null,
    goalBinding: null,
    collaborationMode: original.collaborationMode,
    createdAt: original.createdAt,
  };
  for (const [field, value] of Object.entries(expected)) {
    const item = Object.getOwnPropertyDescriptor(input, field);
    if (
      !item?.enumerable ||
      !Object.hasOwn(item, "value") ||
      item.value !== value
    )
      fail("installed_plugin_run_authority_mismatch");
  }
  for (const field of [
    "purpose",
    "workflowVersionBinding",
    "toolPermissionMode",
    "goalContinuationMode",
  ] as const) {
    const item = Object.getOwnPropertyDescriptor(input, field);
    const reference = Object.getOwnPropertyDescriptor(original, field);
    // Original Turn admission still omits purpose. Preserve that exact immutable shape,
    // with the Domain's default-turn meaning, rather than fabricating a new snapshot field.
    if (
      field === "purpose" &&
      reference !== undefined &&
      reference.value !== "turn"
    )
      fail("installed_plugin_run_authority_mismatch");
    if (field === "workflowVersionBinding" && reference !== undefined)
      fail("installed_plugin_run_authority_mismatch");
    if (
      (item === undefined) !== (reference === undefined) ||
      (item !== undefined &&
        (!item.enumerable ||
          !Object.hasOwn(item, "value") ||
          item.value !== reference?.value))
    )
      fail("installed_plugin_run_authority_mismatch");
  }
}

function record(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).length !== fields.length
  )
    fail("installed_plugin_context_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          fail("installed_plugin_context_fields_invalid");
        return [field, descriptor.value];
      }),
    ),
  );
}
function checkedPurpose(input: unknown): InstalledPluginRunPurpose {
  if (input !== "submit" && input !== "observe")
    fail("installed_plugin_context_purpose_invalid");
  return input;
}
function checkedSignal(input: unknown): AbortSignal {
  if (!(input instanceof AbortSignal))
    fail("installed_plugin_context_signal_invalid");
  input.throwIfAborted();
  return input;
}
