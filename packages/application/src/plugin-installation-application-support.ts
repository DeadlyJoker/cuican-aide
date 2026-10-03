import {
  PluginInstallationError,
  assertPluginProfileScope,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationNextRevision,
  pluginInstallationOpaqueId,
  pluginInstallationRevision,
  pluginInstallationVersion,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type {
  InstallPluginPackageCommand,
  SelectPluginPackageCommand,
} from "./plugin-installation-commands.ts";
import type {
  PluginInstallationHostIdentity,
  PluginPreparedSelection,
} from "./plugin-installation-host-port.ts";
import type {
  InstalledPluginPackageResult,
  PluginInstallationMutationKind,
  PluginInstallationReceipt,
  PluginSelectionResult,
} from "./plugin-installation-store-port.ts";

/** Exact flat command/DTO envelopes; nested values are parsed separately before any await. */
export function installationRecord(input: unknown, fields: readonly string[]) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("plugin_installation_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error("plugin_installation_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          !descriptor.enumerable
        )
          throw new Error("plugin_installation_fields_invalid");
        return [field, descriptor.value] as const;
      }),
    ),
  );
}

export function installationInput<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "validation",
      error instanceof PluginInstallationError
        ? error.code
        : "plugin_installation_command_invalid",
      { cause: error },
    );
  }
}
export function installationStored<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "plugin_installation_store_result_invalid",
      { cause: error },
    );
  }
}
export function installationActor(input: ActorContext): ActorContext {
  return installationInput(() => {
    const value = installationRecord(input, [
      "tenantId",
      "spaceId",
      "principalId",
      "actorId",
    ]);
    return Object.freeze({
      tenantId: pluginInstallationOpaqueId(value.tenantId),
      spaceId: pluginInstallationOpaqueId(value.spaceId),
      principalId: pluginInstallationOpaqueId(value.principalId),
      actorId: pluginInstallationOpaqueId(value.actorId),
    });
  });
}
export function installationProfile(
  input: unknown,
  actor: ActorContext,
): PluginProfileScope {
  try {
    const scope = parsePluginProfileScope(input);
    if (scope.tenantId !== actor.tenantId || scope.spaceId !== actor.spaceId)
      throw new Error("plugin_installation_profile_scope_mismatch");
    return scope;
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "plugin_installation_profile_invalid",
      { cause: error },
    );
  }
}
export function installationInstallCommand(
  input: InstallPluginPackageCommand,
): InstallPluginPackageCommand {
  return installationInput(() => {
    const value = installationRecord(input, [
      "sourceId",
      "expectedPluginId",
      "expectedPackageDigest",
      "expectedSelectionRevision",
      "idempotencyKey",
    ]);
    return Object.freeze({
      sourceId: pluginInstallationOpaqueId(value.sourceId),
      expectedPluginId: pluginInstallationNamespaceId(value.expectedPluginId),
      expectedPackageDigest: pluginInstallationDigest(
        value.expectedPackageDigest,
      ),
      expectedSelectionRevision:
        value.expectedSelectionRevision === null
          ? null
          : pluginInstallationRevision(value.expectedSelectionRevision),
      idempotencyKey: pluginInstallationOpaqueId(value.idempotencyKey),
    });
  });
}
export function installationSelectCommand(
  input: SelectPluginPackageCommand,
): SelectPluginPackageCommand {
  return installationInput(() => {
    const value = installationRecord(input, [
      "pluginId",
      "state",
      "selectedPackageDigest",
      "expectedSelectionRevision",
      "idempotencyKey",
    ]);
    if (
      value.state !== "enabled" &&
      value.state !== "disabled" &&
      value.state !== "uninstalled"
    )
      throw new Error("plugin_installation_state_invalid");
    if (
      (value.state === "uninstalled") !==
      (value.selectedPackageDigest === null)
    )
      throw new Error("plugin_installation_selection_package_invalid");
    return Object.freeze({
      pluginId: pluginInstallationNamespaceId(value.pluginId),
      state: value.state,
      selectedPackageDigest:
        value.selectedPackageDigest === null
          ? null
          : pluginInstallationDigest(value.selectedPackageDigest),
      expectedSelectionRevision: pluginInstallationRevision(
        value.expectedSelectionRevision,
      ),
      idempotencyKey: pluginInstallationOpaqueId(value.idempotencyKey),
    });
  });
}
export function installationLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 50
  )
    throw new ApplicationError(
      "validation",
      "plugin_installation_limit_invalid",
    );
  return value;
}
export function installationReceipt(
  actor: ActorContext,
  scope: PluginProfileScope,
  kind: PluginInstallationMutationKind,
  command: InstallPluginPackageCommand | SelectPluginPackageCommand,
  digester: ContentDigester,
): PluginInstallationReceipt {
  try {
    return Object.freeze({
      idempotencyKey: command.idempotencyKey,
      requestDigest: pluginInstallationDigest(
        digester.sha256(
          canonicalJson({
            schemaVersion: "crewon.plugin-installation-command.v1",
            actor,
            scope,
            kind,
            command,
          }),
        ),
      ),
    });
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "plugin_installation_digester_invalid",
      { cause: error },
    );
  }
}
export function checkedInstallationIdentity(
  input: unknown,
  command: InstallPluginPackageCommand,
): PluginInstallationHostIdentity {
  try {
    const value = installationRecord(input, [
      "pluginId",
      "version",
      "publisherId",
      "packageDigest",
    ]);
    const identity = Object.freeze({
      pluginId: pluginInstallationNamespaceId(value.pluginId),
      version: pluginInstallationVersion(value.version),
      publisherId: pluginInstallationNamespaceId(value.publisherId),
      packageDigest: pluginInstallationDigest(value.packageDigest),
    });
    if (
      identity.pluginId !== command.expectedPluginId ||
      identity.packageDigest !== command.expectedPackageDigest
    )
      throw new Error("plugin_installation_host_identity_mismatch");
    return identity;
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "plugin_installation_host_result_invalid",
      { cause: error },
    );
  }
}
export function checkedInstallationPackage(
  input: unknown,
  scope: PluginProfileScope,
  expected: Readonly<{
    packageDigest: string;
    pluginId?: string;
    identity?: PluginInstallationHostIdentity;
  }>,
): InstalledPluginPackage {
  return installationStored(() => {
    const pkg = parseInstalledPluginPackage(input);
    assertPluginProfileScope(scope, pkg);
    if (
      pkg.packageDigest !== expected.packageDigest ||
      (expected.pluginId !== undefined && pkg.pluginId !== expected.pluginId) ||
      (expected.identity !== undefined &&
        (pkg.version !== expected.identity.version ||
          pkg.publisherId !== expected.identity.publisherId))
    )
      throw new Error("plugin_installation_package_identity_mismatch");
    return pkg;
  });
}
export function checkedInstallationSelection(
  input: unknown,
  scope: PluginProfileScope,
  pluginId: string,
): PluginSelection {
  return installationStored(() => {
    const selection = parsePluginSelection(input);
    assertPluginProfileScope(scope, selection);
    if (selection.pluginId !== pluginId)
      throw new Error("plugin_installation_selection_identity_mismatch");
    return selection;
  });
}
export function checkedInstallationResult(
  input: unknown,
  actor: ActorContext,
  scope: PluginProfileScope,
  command: InstallPluginPackageCommand,
  expected?: Readonly<{
    identity: PluginInstallationHostIdentity;
    selection: PluginSelection;
  }>,
): InstalledPluginPackageResult {
  return installationStored(() => {
    const value = installationRecord(input, [
      "kind",
      "disposition",
      "package",
      "selection",
    ]);
    if (
      value.kind !== "install" ||
      (value.disposition !== "committed" && value.disposition !== "replayed")
    )
      throw new Error("plugin_installation_receipt_invalid");
    const pkg = checkedInstallationPackage(value.package, scope, {
      packageDigest: command.expectedPackageDigest,
      pluginId: command.expectedPluginId,
      identity: expected?.identity,
    });
    const selection = checkedInstallationSelection(
      value.selection,
      scope,
      pkg.pluginId,
    );
    if (selection.publisherId !== pkg.publisherId)
      throw new Error("plugin_installation_publisher_mismatch");
    if (value.disposition === "committed" && expected !== undefined) {
      if (canonicalJson(selection) !== canonicalJson(expected.selection))
        throw new Error("plugin_installation_selection_snapshot_invalid");
    } else if (command.expectedSelectionRevision === null) {
      if (
        selection.revision !== 1 ||
        selection.state !== "disabled" ||
        selection.selectedPackageDigest !== pkg.packageDigest ||
        selection.updatedByPrincipalId !== actor.principalId ||
        selection.updatedByActorId !== actor.actorId
      )
        throw new Error("plugin_installation_initial_selection_invalid");
    } else if (selection.revision === command.expectedSelectionRevision) {
      if (selection.state === "uninstalled")
        throw new Error("plugin_installation_reinstall_invalid");
    } else if (
      selection.revision !==
        pluginInstallationNextRevision(command.expectedSelectionRevision) ||
      selection.state !== "disabled" ||
      selection.selectedPackageDigest !== pkg.packageDigest ||
      selection.updatedByPrincipalId !== actor.principalId ||
      selection.updatedByActorId !== actor.actorId
    ) {
      throw new Error("plugin_installation_reinstall_invalid");
    }
    return Object.freeze({
      kind: "install",
      disposition: value.disposition,
      package: pkg,
      selection,
    });
  });
}
export function checkedSelectionResult(
  input: unknown,
  actor: ActorContext,
  scope: PluginProfileScope,
  command: SelectPluginPackageCommand,
  expected?: PluginSelection,
): PluginSelectionResult {
  return installationStored(() => {
    const value = installationRecord(input, [
      "kind",
      "disposition",
      "selection",
    ]);
    if (
      value.kind !== "select" ||
      (value.disposition !== "committed" && value.disposition !== "replayed")
    )
      throw new Error("plugin_installation_receipt_invalid");
    const selection = checkedInstallationSelection(
      value.selection,
      scope,
      command.pluginId,
    );
    if (
      selection.revision !==
        pluginInstallationNextRevision(command.expectedSelectionRevision) ||
      selection.state !== command.state ||
      selection.selectedPackageDigest !== command.selectedPackageDigest ||
      selection.updatedByPrincipalId !== actor.principalId ||
      selection.updatedByActorId !== actor.actorId ||
      (value.disposition === "committed" &&
        expected !== undefined &&
        canonicalJson(selection) !== canonicalJson(expected))
    )
      throw new Error("plugin_installation_selection_snapshot_invalid");
    return Object.freeze({
      kind: "select",
      disposition: value.disposition,
      selection,
    });
  });
}
export function checkedPreparedSelection(
  input: unknown,
): PluginPreparedSelection {
  try {
    const withPreparation =
      input !== null &&
      typeof input === "object" &&
      Object.hasOwn(input, "prepareCommit");
    const value = installationRecord(
      input,
      withPreparation
        ? ["commit", "abort", "prepareCommit"]
        : ["commit", "abort"],
    );
    if (
      typeof value.commit !== "function" ||
      typeof value.abort !== "function" ||
      (withPreparation && typeof value.prepareCommit !== "function")
    )
      throw new Error("plugin_installation_prepared_handle_invalid");
    return Object.freeze({
      commit: (value.commit as PluginPreparedSelection["commit"]).bind(input),
      abort: (value.abort as PluginPreparedSelection["abort"]).bind(input),
      ...(withPreparation
        ? {
            prepareCommit: (
              value.prepareCommit as NonNullable<
                PluginPreparedSelection["prepareCommit"]
              >
            ).bind(input),
          }
        : {}),
    });
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "plugin_installation_host_result_invalid",
      { cause: error },
    );
  }
}
export function installationPage<T>(
  input: unknown,
  limit: number,
  decode: (item: unknown) => T,
  key: (item: T) => string,
  after: string | null,
): readonly T[] {
  return installationStored(() => {
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > limit
    )
      throw new Error("plugin_installation_page_invalid");
    if (Reflect.ownKeys(input).length !== input.length + 1)
      throw new Error("plugin_installation_page_invalid");
    const page = Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !descriptor.enumerable
      )
        throw new Error("plugin_installation_page_invalid");
      return decode(descriptor.value);
    });
    for (let index = 0; index < page.length; index++) {
      const value = key(page[index]!);
      if (
        (after !== null && value <= after) ||
        (index > 0 && key(page[index - 1]!) >= value)
      )
        throw new Error("plugin_installation_page_order_invalid");
    }
    return Object.freeze(page);
  });
}
export function installationNextCursor(
  input: unknown,
  keys: readonly string[],
  limit: number,
): string | null {
  return installationStored(() => {
    if (input === null) return null;
    if (
      typeof input !== "string" ||
      keys.length !== limit ||
      keys.at(-1) !== input
    )
      throw new Error("plugin_installation_page_cursor_invalid");
    return input;
  });
}
export async function installationUseCase<T>(
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (error instanceof PluginInstallationError) {
      const conflicts = new Set([
        "plugin_installation_revision_conflict",
        "plugin_installation_revision_exhausted",
        "plugin_installation_publisher_conflict",
        "plugin_installation_package_identity_conflict",
        "plugin_installation_idempotency_conflict",
      ]);
      if (conflicts.has(error.code))
        throw new ApplicationError("conflict", error.code, { cause: error });
      if (error.code === "plugin_installation_package_not_found")
        throw new ApplicationError("notFound", error.code, { cause: error });
    }
    throw new ApplicationError(
      "internal",
      "plugin_installation_service_unavailable",
      { cause: error },
    );
  }
}
