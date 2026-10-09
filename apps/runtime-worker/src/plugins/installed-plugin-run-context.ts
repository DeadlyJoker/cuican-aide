import {
  validateReceipt,
  assertRun,
} from "./installed-plugin-run-context-data.ts";
import { readProjectMediaInputStageRuntimeScope } from "./project-media-input-stage-runtime-scope.ts";
import type { ProjectMediaInputStageStore } from "@crewon/application";
import type { ProjectMediaInputStageRunAdmission } from "@crewon/domain";
import { readProjectAssetStageRuntimeScope } from "./project-asset-stage-runtime-scope.ts";
import type { ProjectAssetStageStore } from "@crewon/application";
import type { ProjectAssetStageRunAdmission } from "@crewon/domain";
import { createHash } from "node:crypto";
import type {
  ActorContext,
  AuthorizationPort,
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
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionRunBinding,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginTaskAdmission,
  pluginInstallationOpaqueId,
  type InstalledPluginPackage,
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
import { readProjectFoundationRuntimeScope } from "./project-foundation-runtime-scope.ts";
import type { ProjectFoundationRunAdmissionStore } from "@crewon/application";
import type { ProjectFoundationRunAdmission } from "@crewon/domain";
import type { PluginCompositionStore } from "@crewon/application";
import type { PluginCompositionLock } from "@crewon/contracts/plugins";
import { readInstalledPluginRunSelection } from "./installed-plugin-run-selection.ts";
import { authorizeInstalledPluginCompositionNode } from "./installed-plugin-composition-node-authority.ts";
import { readInstalledPluginRunComposition } from "./installed-plugin-run-composition.ts";

import { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";
export { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";

export type InstalledPluginRunPurpose = "submit" | "observe";
export type InstalledPluginRunSnapshot = Readonly<{
  context: PluginToolRuntimeContext;
}>;
export type InstalledPluginRunContextDependencies = Readonly<{
  extensions: ExtensionStore;
  runs: Pick<RunStore, "loadRunInSpace">;
  installations: PluginInstallationStore;
  authorization: AuthorizationPort;
  /** Explicit original-lock reader; omission preserves rejection of composed Runs. No migration/write capability. */
  compositions?: Pick<PluginCompositionStore, "loadLock">;
  operations?: Pick<ExternalOperationStore, "loadExternalOperation">;
  conversations?: Pick<
    ProjectConversationStore,
    "loadStageAdmission" | "readRequiredStageDigest"
  >;
  assetStages?: Pick<
    ProjectAssetStageStore,
    "loadAssetStageAdmission" | "readRequiredAssetStageDigest"
  >;
  mediaInputStages?: Pick<
    ProjectMediaInputStageStore,
    "loadMediaInputStageAdmission" | "readRequiredMediaInputStageDigest"
  >;
  plans?: Pick<
    ProjectTextPlanStore,
    "readRequiredPlanDigest" | "loadRunAdmission"
  >;
  foundationRuns?: ProjectFoundationRunAdmissionStore;
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
  projectMediaInputStage: ProjectMediaInputStageRunAdmission | null;
  projectFoundation: ProjectFoundationRunAdmission | null;
  composition: PluginCompositionLock | null;
}>;
const digester = {
  sha256: (input: string) =>
    `sha256:${createHash("sha256").update(input).digest("hex")}`,
};

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
      (dependencies.compositions !== undefined &&
        (dependencies.extensions.compositionBindingVersion !==
          "crewon.extension-run-binding.v1" ||
          typeof dependencies.compositions.loadLock !== "function")) ||
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
      extensionCanonicalJson({
        ...current,
        composition: current.composition?.lockDigest ?? null,
      }) !==
        extensionCanonicalJson({
          ...previous,
          composition: previous.composition?.lockDigest ?? null,
        })
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
  /** Actual immutable task identity, available only to this reader's host-owned snapshot. */
  verifiedTaskAdmission(
    snapshot: InstalledPluginRunSnapshot,
  ): PluginTaskAdmission {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.admission;
  }
  /** Validated original metadata from a genuine, root-authorized snapshot; not provider execution approval. */
  verifiedComposition(
    snapshot: InstalledPluginRunSnapshot,
  ): PluginCompositionLock | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.composition;
  }
  /** Current policy for one actual captured root/provider, never an arbitrary node DTO. */
  async assertCompositionNodeCurrent(
    snapshot: InstalledPluginRunSnapshot,
    pluginId: string,
    purposeInput: InstalledPluginRunPurpose,
    signalInput: AbortSignal,
  ): Promise<InstalledPluginPackage> {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    if (saved.composition === null)
      fail("installed_plugin_composition_missing");
    const purpose = checkedPurpose(purposeInput),
      signal = checkedSignal(signalInput);
    return authorizeInstalledPluginCompositionNode({
      lock: saved.composition,
      rootPluginId: saved.admission.pluginId,
      pluginId,
      installations: this.#dependencies.installations,
      authorization: this.#dependencies.authorization,
      purpose,
      signal,
      assertRun: () => this.assertCurrent(snapshot, purpose, signal),
      resolveActor: () => this.#actor(saved.admission, signal),
    });
  }
  verifiedProjectStage(
    snapshot: InstalledPluginRunSnapshot,
  ): ProjectStageRunAdmission | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.projectStage;
  }

  /** Attached host facts, available only through this reader's genuine snapshot. */
  verifiedProjectFoundation(
    snapshot: InstalledPluginRunSnapshot,
  ): ProjectFoundationRunAdmission | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.projectFoundation;
  }

  verifiedProjectMediaInputStage(
    snapshot: InstalledPluginRunSnapshot,
  ): ProjectMediaInputStageRunAdmission | null {
    const saved = this.#snapshots.get(snapshot);
    if (saved === undefined) fail("installed_plugin_context_snapshot_invalid");
    return saved.projectMediaInputStage;
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
    // Reading the original graph is explicit; it never enables a single-package executor.
    if (
      binding.schemaVersion === "crewon.extension-run-binding.v1" &&
      this.#dependencies.compositions === undefined
    )
      fail("installed_plugin_composition_execution_unavailable");
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
    if (
      rawReceipt.projectMediaInputStageAdmission !== undefined &&
      this.#dependencies.mediaInputStages === undefined
    )
      fail("installed_plugin_media_input_stage_runtime_unavailable");
    const original = validateReceipt(
      rawReceipt,
      binding,
      admission,
      receipt,
      query,
      fail,
    );
    const run = await this.#dependencies.runs.loadRunInSpace(locator);
    signal.throwIfAborted();
    if (run === null) fail("installed_plugin_run_missing");
    assertRun(run, binding, original, fail);
    const projectMediaInputStage =
      this.#dependencies.mediaInputStages === undefined
        ? null
        : await readProjectMediaInputStageRuntimeScope({
            stages: this.#dependencies.mediaInputStages,
            admission,
            binding,
            signal,
          });
    if (
      extensionCanonicalJson(
        rawReceipt.projectMediaInputStageAdmission ?? null,
      ) !== extensionCanonicalJson(projectMediaInputStage) ||
      (projectMediaInputStage !== null &&
        (query !== null ||
          (rawReceipt.turn.threadState.workspaceId ?? null) !==
            projectMediaInputStage.workspaceId))
    )
      fail("installed_plugin_media_input_stage_mismatch");
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
    const projectFoundation =
      this.#dependencies.foundationRuns === undefined
        ? null
        : await readProjectFoundationRuntimeScope({
            foundations: this.#dependencies.foundationRuns,
            admission,
            binding,
            stageAdmission: projectStage,
            signal,
          });
    if (
      projectFoundation !== null &&
      (query !== null ||
        (rawReceipt.turn.threadState.workspaceId ?? null) !==
          projectFoundation.workspaceId)
    )
      fail("installed_plugin_project_foundation_mismatch");
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
    if (
      projectMediaInputStage !== null &&
      (projectStage !== null ||
        projectAssetStage !== null ||
        projectTextPlan !== null)
    )
      fail("installed_plugin_media_input_stage_conflict");
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
    const composition = await readInstalledPluginRunComposition({
      binding,
      admission,
      compositions: this.#dependencies.compositions,
      signal,
      fail,
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
      projectMediaInputStage,
      projectFoundation,
      composition,
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

  #selection(
    admission: PluginTaskAdmissionPin,
    purpose: InstalledPluginRunPurpose,
    signal: AbortSignal,
  ) {
    return readInstalledPluginRunSelection(
      this.#dependencies.installations,
      admission,
      purpose,
      signal,
    );
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
