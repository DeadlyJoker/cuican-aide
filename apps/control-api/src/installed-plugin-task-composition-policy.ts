import {
  ApplicationError,
  type ContentDigester,
  type PluginCompositionStore,
} from "@crewon/application";
import {
  parsePluginCompositionLock,
  type PluginCompositionScope,
} from "@crewon/contracts/plugins";
import {
  parsePluginProfileScope,
  pluginInstallationDigest,
  pluginInstallationOpaqueId,
  type PluginProfileScope,
} from "@crewon/domain";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export const INSTALLED_PLUGIN_TASK_COMPOSITION_POLICY_SCHEMA =
  "crewon.installed-plugin-task-composition-policy.v1";

/** Trusted host deployment only. This policy grants no package, task or recovery permission. */
export type InstalledPluginTaskCompositionPolicy = Readonly<{
  schemaVersion: typeof INSTALLED_PLUGIN_TASK_COMPOSITION_POLICY_SCHEMA;
  scope: PluginProfileScope;
  authorityEpoch: string;
  /** The actual owner's live proof, including its current scope and authority epoch. */
  assertCurrent(): PluginCompositionScope;
}>;

export type InstalledPluginTaskCompositionReader = Readonly<
  Pick<PluginCompositionStore, "loadCurrent" | "loadLock">
>;

function scope(input: unknown): PluginProfileScope {
  return parsePluginProfileScope(
    pluginSecurityRecord(input, ["tenantId", "spaceId", "profileId"]),
  );
}

function currentAuthority(input: unknown): PluginCompositionScope {
  const value = pluginSecurityRecord(input, [
    "tenantId",
    "spaceId",
    "profileId",
    "authorityEpoch",
  ]);
  return Object.freeze({
    ...scope({
      tenantId: value.tenantId,
      spaceId: value.spaceId,
      profileId: value.profileId,
    }),
    authorityEpoch: pluginInstallationOpaqueId(value.authorityEpoch),
  });
}

function sameScope(left: PluginProfileScope, right: PluginProfileScope) {
  return (
    left.tenantId === right.tenantId &&
    left.spaceId === right.spaceId &&
    left.profileId === right.profileId
  );
}

function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}

/** Read only the Core's actual Store. Neither startup nor a reader migrates or publishes a graph. */
export function createInstalledPluginTaskCompositionReader(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    policy: InstalledPluginTaskCompositionPolicy | undefined;
    digester: ContentDigester;
    assertActive(): void;
  }>,
): InstalledPluginTaskCompositionReader | undefined {
  if (input.policy === undefined) return undefined;
  const provided = input.policy;
  const policy = pluginSecurityRecord(provided, [
    "schemaVersion",
    "scope",
    "authorityEpoch",
    "assertCurrent",
  ]);
  if (
    policy.schemaVersion !== INSTALLED_PLUGIN_TASK_COMPOSITION_POLICY_SCHEMA ||
    typeof policy.assertCurrent !== "function" ||
    (!(input.store instanceof SqliteRunStore) &&
      !(input.store instanceof PostgresDomainStore))
  )
    throw new Error("installed_plugin_task_composition_policy_invalid");
  const expected = Object.freeze({
    ...scope(policy.scope),
    authorityEpoch: pluginInstallationOpaqueId(policy.authorityEpoch),
  });
  const assertOwner = policy.assertCurrent.bind(provided) as () => unknown;
  const assertActive = input.assertActive.bind(input);
  const digester = Object.freeze({
    sha256: input.digester.sha256.bind(input.digester),
  });
  const assertCurrent = () => {
    assertActive();
    const actual = currentAuthority(assertOwner());
    assertActive();
    if (
      !sameScope(actual, expected) ||
      actual.authorityEpoch !== expected.authorityEpoch
    )
      denied("installed_plugin_task_composition_authority_changed");
  };
  // Verify the live policy before obtaining even a borrowed storage adapter.
  assertCurrent();
  const compositions = input.store
    .pluginInstallationStore()
    .compositionStore?.();
  if (compositions === undefined)
    throw new ApplicationError(
      "conflict",
      "plugin_task_composition_port_unavailable",
    );
  const loadCurrent = compositions.loadCurrent.bind(compositions);
  const loadLock = compositions.loadLock.bind(compositions);
  const assertScope = (requested: unknown) => {
    const checked = scope(requested);
    if (!sameScope(checked, expected))
      denied("installed_plugin_task_composition_scope_mismatch");
    return checked;
  };
  const read = async (
    requestedScope: PluginProfileScope,
    load: () => ReturnType<PluginCompositionStore["loadCurrent"]>,
    kind: Readonly<{ type: "current" } | { type: "lock"; lockDigest: string }>,
  ) => {
    assertCurrent();
    const value = await load();
    assertCurrent();
    if (value === null) return null;
    const lock = parsePluginCompositionLock(value, digester);
    if (!sameScope(lock.scope, requestedScope))
      denied("installed_plugin_task_composition_scope_mismatch");
    if (
      kind.type === "current" &&
      lock.scope.authorityEpoch !== expected.authorityEpoch
    )
      denied("installed_plugin_task_composition_authority_changed");
    if (kind.type === "lock" && lock.lockDigest !== kind.lockDigest)
      throw new ApplicationError("conflict", "plugin_task_composition_invalid");
    // A historical lock retains its own epoch; current authority is checked above.
    assertCurrent();
    return lock;
  };
  return Object.freeze({
    loadCurrent: async (request) => {
      const value = pluginSecurityRecord(request, ["scope"]);
      const requested = assertScope(value.scope);
      return read(requested, () => loadCurrent({ scope: requested }), {
        type: "current",
      });
    },
    loadLock: async (request) => {
      const value = pluginSecurityRecord(request, ["scope", "lockDigest"]);
      const requested = assertScope(value.scope);
      const lockDigest = pluginInstallationDigest(value.lockDigest);
      return read(requested, () => loadLock({ scope: requested, lockDigest }), {
        type: "lock",
        lockDigest,
      });
    },
  });
}
