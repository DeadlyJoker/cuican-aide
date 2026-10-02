import { join } from "node:path";
import { ApplicationError, type ActorContext } from "@crewon/application";
import {
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationOpaqueId,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import { verifyLocalPluginPackage } from "./local-plugin-package-verifier.ts";
import type { PluginNodeHost } from "./plugin-node-host.ts";

/** A current host-issued actor; installedByActorId is historical audit, never startup authority. */
export type PluginInstalledSelectionRecoveryInput = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  selection: PluginSelection;
  package: InstalledPluginPackage | null;
}>;
export type PluginInstalledSelectionRecoveryPolicy = Readonly<{
  /**
   * Synchronous current permission AND exact durable selection predicate. An asynchronous database
   * read or comparison only against the supplied selection is not a current authority implementation.
   * Distributed writers require an owner-coordinated, confirmed durable projection.
   */
  authorizeCurrent(
    input: PluginInstalledSelectionRecoveryInput,
  ): "allow" | "deny";
  /** Current runtime/configuration/data compatibility, including a disabled selected version. */
  validateCompatibility(
    input: PluginInstalledSelectionRecoveryInput &
      Readonly<{ descriptor: PluginPackageDescriptor | null }>,
  ): Promise<void>;
}>;
export type VerifiedRecovery = Readonly<{
  input: PluginInstalledSelectionRecoveryInput;
  descriptor: PluginPackageDescriptor | null;
}>;

export function recoveryRecord(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new ApplicationError("validation", "plugin_recovery_input_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new ApplicationError("validation", "plugin_recovery_input_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          !descriptor.enumerable
        )
          throw new ApplicationError(
            "validation",
            "plugin_recovery_input_invalid",
          );
        return [field, descriptor.value];
      }),
    ),
  );
}

export function recoveryInput(
  raw: PluginInstalledSelectionRecoveryInput,
  profile: PluginProfileScope,
): PluginInstalledSelectionRecoveryInput {
  const value = recoveryRecord(raw, ["actor", "scope", "selection", "package"]);
  const scope = parsePluginProfileScope(value.scope);
  assertPluginProfileScope(profile, scope);
  const who = recoveryRecord(value.actor, [
    "tenantId",
    "spaceId",
    "principalId",
    "actorId",
  ]);
  const actor = Object.freeze({
    tenantId: pluginInstallationOpaqueId(who.tenantId),
    spaceId: pluginInstallationOpaqueId(who.spaceId),
    principalId: pluginInstallationOpaqueId(who.principalId),
    actorId: pluginInstallationOpaqueId(who.actorId),
  });
  if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
    throw new ApplicationError(
      "authorization",
      "plugin_profile_scope_mismatch",
    );
  const selection = parsePluginSelection(value.selection);
  assertPluginProfileScope(scope, selection);
  const pkg =
    value.package === null ? null : parseInstalledPluginPackage(value.package);
  assertPluginSelectionPackage({ selection, package: pkg });
  return Object.freeze({ actor, scope, selection, package: pkg });
}

export function recoveryPolicy(
  raw: PluginInstalledSelectionRecoveryPolicy,
): PluginInstalledSelectionRecoveryPolicy {
  const value = recoveryRecord(raw, [
    "authorizeCurrent",
    "validateCompatibility",
  ]);
  if (
    typeof value.authorizeCurrent !== "function" ||
    typeof value.validateCompatibility !== "function"
  )
    throw new ApplicationError("internal", "plugin_recovery_policy_missing");
  return value as PluginInstalledSelectionRecoveryPolicy;
}

export function assertRecoveryCurrent(
  input: PluginInstalledSelectionRecoveryInput,
  policy: PluginInstalledSelectionRecoveryPolicy,
): void {
  if (policy.authorizeCurrent(input) !== "allow")
    throw new ApplicationError(
      "authorization",
      "plugin_recovery_current_denied",
    );
}

export async function verifyRecovery(
  input: PluginInstalledSelectionRecoveryInput,
  installRoot: string,
  policy: PluginInstalledSelectionRecoveryPolicy,
): Promise<VerifiedRecovery> {
  assertRecoveryCurrent(input, policy);
  let descriptor: PluginPackageDescriptor | null = null;
  if (input.package) {
    const pkg = input.package;
    const verified = await verifyLocalPluginPackage({
      directory: join(installRoot, "packages", pkg.packageDigest.slice(7)),
    });
    assertRecoveryCurrent(input, policy);
    descriptor = verified.descriptor;
    if (
      verified.packageDigest !== pkg.packageDigest ||
      descriptor.pluginId !== pkg.pluginId ||
      descriptor.version !== pkg.version ||
      descriptor.publisherId !== pkg.publisherId
    )
      throw new ApplicationError("internal", "plugin_installed_bytes_mismatch");
    if (input.selection.state === "enabled" && !descriptor.entrypoints.node)
      throw new ApplicationError("conflict", "plugin_node_entry_missing");
  }
  await policy.validateCompatibility(Object.freeze({ ...input, descriptor }));
  assertRecoveryCurrent(input, policy);
  return Object.freeze({ input, descriptor });
}

/** Required dependencies define ordering; absent/mismatched optional services remain optional. */
export function orderRecoveries(
  records: readonly VerifiedRecovery[],
  nodeHost: PluginNodeHost,
): readonly VerifiedRecovery[] {
  const replacing = new Set(
    records.map(({ input }) => input.selection.pluginId),
  );
  const available = new Map(
    nodeHost
      .serviceIdentities()
      .filter(
        ({ provider }) =>
          provider === null || !replacing.has(provider.pluginId),
      )
      .map((service) => [
        service.service,
        {
          apiVersion: service.apiVersion,
          record: null as VerifiedRecovery | null,
        },
      ]),
  );
  for (const record of records) {
    if (record.input.selection.state !== "enabled") continue;
    for (const provision of record.descriptor!.provides) {
      if (available.has(provision.service))
        throw new ApplicationError("conflict", "plugin_service_conflict");
      available.set(provision.service, {
        apiVersion: provision.apiVersion,
        record,
      });
    }
  }
  const remaining = new Map<VerifiedRecovery, Set<VerifiedRecovery>>();
  for (const record of records) {
    const dependencies = new Set<VerifiedRecovery>();
    if (record.input.selection.state === "enabled") {
      for (const requirement of record.descriptor!.requires) {
        if (requirement.optional) continue;
        const provider = available.get(requirement.service);
        if (!provider || provider.apiVersion !== requirement.apiVersion)
          throw new ApplicationError(
            "conflict",
            "plugin_dependency_unavailable",
          );
        if (provider.record) dependencies.add(provider.record);
      }
    }
    remaining.set(record, dependencies);
  }
  const ordered: VerifiedRecovery[] = [];
  while (remaining.size) {
    const ready = [...remaining].find(
      ([, dependencies]) => dependencies.size === 0,
    );
    if (!ready)
      throw new ApplicationError("conflict", "plugin_dependency_cycle");
    const record = ready[0];
    ordered.push(record);
    remaining.delete(record);
    for (const dependencies of remaining.values()) dependencies.delete(record);
  }
  return Object.freeze(ordered);
}
