import { createHash } from "node:crypto";
import {
  PluginCompositionStoreError,
  type CommitPluginCompositionInput,
} from "@crewon/application";
import {
  parsePluginCompositionLock,
  type PluginCompositionLock,
} from "@crewon/contracts/plugins";
import {
  assertPluginProfileScope,
  parsePluginProfileScope,
  pluginInstallationDigest,
  pluginInstallationOpaqueId,
  pluginInstallationRevision,
  type PluginProfileScope,
} from "@crewon/domain";
import { installationActor } from "./plugin-installation-store-records.ts";

export const compositionStoreDigester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
export function compositionStoreFail(code: string): never {
  throw new PluginCompositionStoreError(code);
}
function record(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    compositionStoreFail("plugin_composition_input_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    compositionStoreFail("plugin_composition_input_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const property = Object.getOwnPropertyDescriptor(input, field);
        if (!property?.enumerable || !("value" in property))
          compositionStoreFail("plugin_composition_input_invalid");
        return [field, property.value];
      }),
    ),
  );
}
export function compositionRead(
  input: unknown,
  options: { kind: "current" | "digest" },
): Readonly<{ scope: PluginProfileScope; lockDigest: string | null }> {
  const digest = options.kind === "digest";
  const value = record(input, digest ? ["scope", "lockDigest"] : ["scope"]);
  return Object.freeze({
    scope: parsePluginProfileScope(value.scope),
    lockDigest: digest ? pluginInstallationDigest(value.lockDigest) : null,
  });
}
export function compositionCommit(
  input: unknown,
): CommitPluginCompositionInput {
  const value = record(input, ["scope", "actor", "lock", "expectedRevision"]);
  const scope = record(value.scope, [
    "tenantId",
    "spaceId",
    "profileId",
    "authorityEpoch",
  ]);
  const profile = parsePluginProfileScope({
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: scope.profileId,
  });
  const actor = installationActor(value.actor, profile);
  const expectedRevision =
    value.expectedRevision === null
      ? null
      : pluginInstallationRevision(value.expectedRevision);
  const lock = parsePluginCompositionLock(value.lock, compositionStoreDigester);
  const authorityEpoch = pluginInstallationOpaqueId(scope.authorityEpoch);
  assertPluginProfileScope(profile, compositionProfile(lock.scope));
  if (lock.scope.authorityEpoch !== authorityEpoch)
    compositionStoreFail("plugin_composition_scope_mismatch");
  if (
    lock.revision !== (expectedRevision ?? 0) + 1 ||
    !Number.isSafeInteger(lock.revision)
  )
    compositionStoreFail("plugin_composition_revision_conflict");
  return Object.freeze({
    scope: Object.freeze({ ...profile, authorityEpoch }),
    actor,
    lock,
    expectedRevision,
  });
}
export function decodeCompositionRow(
  row: Record<string, unknown>,
  scope: PluginProfileScope,
): PluginCompositionLock {
  const lock = parsePluginCompositionLock(
    typeof row.lock_json === "string"
      ? JSON.parse(row.lock_json)
      : row.lock_json,
    compositionStoreDigester,
  );
  assertPluginProfileScope(
    compositionProfile(scope),
    compositionProfile(lock.scope),
  );
  if (
    row.tenant_id !== lock.scope.tenantId ||
    row.space_id !== lock.scope.spaceId ||
    row.profile_id !== lock.scope.profileId ||
    row.authority_epoch !== lock.scope.authorityEpoch ||
    String(row.revision) !== String(lock.revision) ||
    row.lock_digest !== lock.lockDigest
  )
    compositionStoreFail("plugin_composition_record_invalid");
  pluginInstallationOpaqueId(row.actor_id);
  pluginInstallationOpaqueId(row.principal_id);
  return lock;
}
export function assertCompositionVersion(
  rows: readonly Record<string, unknown>[],
): void {
  if (
    rows.length !== 1 ||
    String(rows[0]?.id) !== "1" ||
    String(rows[0]?.version) !== "1"
  )
    compositionStoreFail("plugin_composition_schema_unsupported");
}
export function compositionScopeValues(scope: PluginProfileScope): string[] {
  return [scope.tenantId, scope.spaceId, scope.profileId];
}

export function compositionProfile(
  scope: PluginProfileScope,
): PluginProfileScope {
  return {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: scope.profileId,
  };
}
