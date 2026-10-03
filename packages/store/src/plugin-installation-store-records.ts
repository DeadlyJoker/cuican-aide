import type {
  ActorContext,
  CommitPluginSelectionInput,
  PluginInstallationMutationKind,
  PluginInstallationMutationResult,
  PluginInstallationReceipt,
  RecordInstalledPluginPackageInput,
} from "@crewon/application";
import {
  PluginInstallationError,
  assertInstalledPluginPackageIdentity,
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationNextRevision,
  pluginInstallationOpaqueId,
  pluginInstallationRevision,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";

export function installationFailure(code: string): never {
  throw new PluginInstallationError(code);
}

/** Strict fixed-shape internal recipes; no getters or arbitrary fragments are visited. */
function installationRecord(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    installationFailure("plugin_installation_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    installationFailure("plugin_installation_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          !descriptor.enumerable
        )
          installationFailure("plugin_installation_fields_invalid");
        return [field, descriptor.value];
      }),
    ),
  );
}

export type InstallationIdentity = Readonly<{
  scope: PluginProfileScope;
  actor: ActorContext;
  kind: PluginInstallationMutationKind;
  receipt: PluginInstallationReceipt;
}>;
export type PreparedInstallation = InstallationIdentity &
  (
    | Readonly<{
        kind: "install";
        package: InstalledPluginPackage;
        expectedSelectionRevision: number | null;
      }>
    | Readonly<{
        kind: "select";
        selection: PluginSelection;
        expectedSelectionRevision: number;
        beforeCommit?: NonNullable<CommitPluginSelectionInput["beforeCommit"]>;
      }>
  );

export function installationScopeValues(scope: PluginProfileScope): string[] {
  return [scope.tenantId, scope.spaceId, scope.profileId];
}

export function installationActor(
  input: unknown,
  scope: PluginProfileScope,
): ActorContext {
  const value = installationRecord(input, [
    "tenantId",
    "spaceId",
    "principalId",
    "actorId",
  ]);
  const actor = Object.freeze({
    tenantId: pluginInstallationOpaqueId(value.tenantId),
    spaceId: pluginInstallationOpaqueId(value.spaceId),
    principalId: pluginInstallationOpaqueId(value.principalId),
    actorId: pluginInstallationOpaqueId(value.actorId),
  });
  if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
    installationFailure("plugin_installation_scope_mismatch");
  return actor;
}

function identity(
  value: Readonly<Record<string, unknown>>,
  kind: PluginInstallationMutationKind,
): InstallationIdentity {
  const scope = parsePluginProfileScope(value.scope);
  const receipt = installationRecord(value.receipt, [
    "idempotencyKey",
    "requestDigest",
  ]);
  return Object.freeze({
    scope,
    actor: installationActor(value.actor, scope),
    kind,
    receipt: Object.freeze({
      idempotencyKey: pluginInstallationOpaqueId(receipt.idempotencyKey),
      requestDigest: pluginInstallationDigest(receipt.requestDigest),
    }),
  });
}

export function installationReceiptIdentity(
  input: unknown,
): InstallationIdentity {
  const value = installationRecord(input, [
    "scope",
    "actor",
    "kind",
    "receipt",
  ]);
  if (value.kind !== "install" && value.kind !== "select")
    installationFailure("plugin_installation_mutation_kind_invalid");
  return identity(value, value.kind);
}

export function prepareInstallation(
  input: RecordInstalledPluginPackageInput,
): PreparedInstallation & { kind: "install" } {
  const value = installationRecord(input, [
    "scope",
    "actor",
    "receipt",
    "package",
    "expectedSelectionRevision",
  ]);
  const id = identity(value, "install");
  const pkg = parseInstalledPluginPackage(value.package);
  assertPluginProfileScope(id.scope, pkg);
  if (
    pkg.installedByPrincipalId !== id.actor.principalId ||
    pkg.installedByActorId !== id.actor.actorId
  )
    installationFailure("plugin_installation_actor_mismatch");
  return Object.freeze({
    ...id,
    kind: "install",
    package: pkg,
    expectedSelectionRevision:
      value.expectedSelectionRevision === null
        ? null
        : pluginInstallationRevision(value.expectedSelectionRevision),
  });
}

export function prepareSelection(
  input: CommitPluginSelectionInput,
): PreparedInstallation & { kind: "select" } {
  const withGuard =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "beforeCommit");
  const value = installationRecord(input, [
    "scope",
    "actor",
    "receipt",
    "selection",
    "expectedSelectionRevision",
    ...(withGuard ? ["beforeCommit"] : []),
  ]);
  if (withGuard && typeof value.beforeCommit !== "function")
    installationFailure("plugin_installation_before_commit_invalid");
  const id = identity(value, "select");
  const selection = parsePluginSelection(value.selection);
  assertPluginProfileScope(id.scope, selection);
  if (
    selection.updatedByPrincipalId !== id.actor.principalId ||
    selection.updatedByActorId !== id.actor.actorId
  )
    installationFailure("plugin_installation_actor_mismatch");
  const expectedSelectionRevision = pluginInstallationRevision(
    value.expectedSelectionRevision,
  );
  if (
    selection.revision !==
    pluginInstallationNextRevision(expectedSelectionRevision)
  )
    installationFailure("plugin_installation_revision_conflict");
  return Object.freeze({
    ...id,
    kind: "select",
    selection,
    expectedSelectionRevision,
    ...(withGuard
      ? {
          beforeCommit: (
            value.beforeCommit as NonNullable<
              CommitPluginSelectionInput["beforeCommit"]
            >
          ).bind(input),
        }
      : {}),
  });
}

/** Only local synchronous work may run while a profile transaction is held. */
export function assertSelectionCommitGuard(
  prepared: PreparedInstallation,
): void {
  if (prepared.kind !== "select" || prepared.beforeCommit === undefined) return;
  const returned: unknown = prepared.beforeCommit(
    Object.freeze({ selection: prepared.selection }),
  );
  if (returned !== undefined) {
    void Promise.resolve(returned).catch(() => {});
    installationFailure(
      "plugin_installation_before_commit_must_be_synchronous",
    );
  }
}

export function installationReadInput(
  input: unknown,
  fields: readonly string[],
) {
  const value = installationRecord(input, ["scope", ...fields]);
  return { value, scope: parsePluginProfileScope(value.scope) };
}

export function installationPageLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 50
  )
    installationFailure("plugin_installation_limit_invalid");
  return value;
}

export function installationJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 32768)
    installationFailure("plugin_installation_record_invalid");
  return json;
}

function storedJson(value: unknown): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 32768)
      installationFailure("plugin_installation_record_invalid");
    try {
      return JSON.parse(value);
    } catch {
      installationFailure("plugin_installation_record_invalid");
    }
  }
  return value;
}

function rowScope(
  row: Record<string, unknown>,
  scope: PluginProfileScope,
): void {
  if (
    row.tenant_id !== scope.tenantId ||
    row.space_id !== scope.spaceId ||
    row.profile_id !== scope.profileId
  )
    installationFailure("plugin_installation_record_invalid");
}

export function decodeInstallationPackage(
  row: Record<string, unknown> | undefined,
  scope: PluginProfileScope,
): InstalledPluginPackage | null {
  if (row === undefined) return null;
  rowScope(row, scope);
  const pkg = parseInstalledPluginPackage(storedJson(row.record_json));
  assertPluginProfileScope(scope, pkg);
  if (
    pkg.pluginId !== row.plugin_id ||
    pkg.version !== row.version ||
    pkg.publisherId !== row.publisher_id ||
    pkg.packageDigest !== row.package_digest
  )
    installationFailure("plugin_installation_record_invalid");
  return pkg;
}

export function decodeInstallationSelection(
  row: Record<string, unknown> | undefined,
  scope: PluginProfileScope,
): PluginSelection | null {
  if (row === undefined) return null;
  rowScope(row, scope);
  const selection = parsePluginSelection(storedJson(row.record_json));
  assertPluginProfileScope(scope, selection);
  const revision =
    typeof row.revision === "string" && /^[1-9][0-9]*$/u.test(row.revision)
      ? Number(row.revision)
      : row.revision;
  if (
    selection.pluginId !== row.plugin_id ||
    selection.publisherId !== row.publisher_id ||
    selection.revision !== revision ||
    selection.state !== row.state ||
    selection.selectedPackageDigest !== row.selected_package_digest
  )
    installationFailure("plugin_installation_record_invalid");
  return selection;
}

export function decodeInstallationReceipt(
  row: Record<string, unknown> | undefined,
  id: InstallationIdentity,
): PluginInstallationMutationResult | null {
  if (row === undefined) return null;
  rowScope(row, id.scope);
  if (
    row.principal_id !== id.actor.principalId ||
    row.actor_id !== id.actor.actorId ||
    row.kind !== id.kind ||
    row.idempotency_key !== id.receipt.idempotencyKey
  )
    installationFailure("plugin_installation_record_invalid");
  if (pluginInstallationDigest(row.request_digest) !== id.receipt.requestDigest)
    installationFailure("plugin_installation_idempotency_conflict");
  const value = installationRecord(
    storedJson(row.result_json),
    id.kind === "install"
      ? ["kind", "disposition", "package", "selection"]
      : ["kind", "disposition", "selection"],
  );
  if (value.kind !== id.kind || value.disposition !== "committed")
    installationFailure("plugin_installation_record_invalid");
  const selection = parsePluginSelection(value.selection);
  assertPluginProfileScope(id.scope, selection);
  if (selection.pluginId !== row.plugin_id)
    installationFailure("plugin_installation_record_invalid");
  if (id.kind === "select") {
    if (
      selection.updatedByPrincipalId !== id.actor.principalId ||
      selection.updatedByActorId !== id.actor.actorId
    )
      installationFailure("plugin_installation_record_invalid");
    return Object.freeze({
      kind: "select",
      disposition: "replayed",
      selection,
    });
  }
  const pkg = parseInstalledPluginPackage(value.package);
  assertPluginProfileScope(id.scope, pkg);
  if (
    pkg.pluginId !== selection.pluginId ||
    pkg.publisherId !== selection.publisherId
  )
    installationFailure("plugin_installation_record_invalid");
  return Object.freeze({
    kind: "install",
    disposition: "replayed",
    package: pkg,
    selection,
  });
}

export function verifyInstallationReplay(
  prepared: PreparedInstallation,
  result: PluginInstallationMutationResult,
): void {
  if (prepared.kind !== result.kind)
    installationFailure("plugin_installation_record_invalid");
  if (prepared.kind === "install" && result.kind === "install") {
    assertInstalledPluginPackageIdentity(result.package, prepared.package);
  } else if (prepared.kind === "select" && result.kind === "select") {
    for (const field of [
      "pluginId",
      "publisherId",
      "revision",
      "state",
      "selectedPackageDigest",
    ] as const)
      if (prepared.selection[field] !== result.selection[field])
        installationFailure("plugin_installation_idempotency_conflict");
  }
}

export function verifyInstallationMutation(
  prepared: PreparedInstallation,
  current: {
    selection: PluginSelection | null;
    digestPackage: InstalledPluginPackage | null;
    versionPackage: InstalledPluginPackage | null;
    selectedPackage: InstalledPluginPackage | null;
  },
): PluginInstallationMutationResult {
  const selection = current.selection;
  if ((selection?.revision ?? null) !== prepared.expectedSelectionRevision)
    installationFailure("plugin_installation_revision_conflict");
  const publisher =
    prepared.kind === "install"
      ? prepared.package.publisherId
      : prepared.selection.publisherId;
  if (selection && selection.publisherId !== publisher)
    installationFailure("plugin_installation_publisher_conflict");
  if (selection) {
    assertPluginProfileScope(prepared.scope, selection);
    assertPluginSelectionPackage({
      selection,
      package: current.selectedPackage,
    });
  }
  if (prepared.kind === "select") {
    if (selection === null)
      installationFailure("plugin_installation_revision_conflict");
    if (
      prepared.selection.selectedPackageDigest !== null &&
      current.digestPackage === null
    )
      installationFailure("plugin_installation_package_not_found");
    assertPluginSelectionPackage({
      selection: prepared.selection,
      package: current.digestPackage,
    });
    if (prepared.selection.pluginId !== selection.pluginId)
      installationFailure("plugin_installation_record_invalid");
    return Object.freeze({
      kind: "select",
      disposition: "committed",
      selection: prepared.selection,
    });
  }
  if (current.versionPackage)
    assertInstalledPluginPackageIdentity(
      current.versionPackage,
      prepared.package,
    );
  if (current.digestPackage)
    assertInstalledPluginPackageIdentity(
      current.digestPackage,
      prepared.package,
    );
  const pkg =
    current.versionPackage ?? current.digestPackage ?? prepared.package;
  const resultSelection =
    selection !== null && selection.state !== "uninstalled"
      ? selection
      : parsePluginSelection({
          schemaVersion: "crewon.plugin-selection.v1",
          ...prepared.scope,
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          revision:
            selection === null
              ? 1
              : pluginInstallationNextRevision(selection.revision),
          state: "disabled",
          selectedPackageDigest: pkg.packageDigest,
          updatedAt: prepared.package.installedAt,
          updatedByPrincipalId: prepared.actor.principalId,
          updatedByActorId: prepared.actor.actorId,
        });
  assertPluginSelectionPackage({
    selection: resultSelection,
    package: resultSelection === selection ? current.selectedPackage : pkg,
  });
  return Object.freeze({
    kind: "install",
    disposition: "committed",
    package: pkg,
    selection: resultSelection,
  });
}
