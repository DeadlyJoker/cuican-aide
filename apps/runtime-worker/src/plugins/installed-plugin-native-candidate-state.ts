import { isDeepStrictEqual } from "node:util";
import {
  PluginPackageContractError,
  type NativeInstalledPluginPreparationStatus,
} from "@crewon/contracts/plugins";
import {
  ExtensionManifestError,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  type ExtensionConfiguration,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import { LocalPluginPackageError } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import {
  loadInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
import {
  assertNativeInstalledPluginPreparation,
  parseNativePreparationActor,
  type LoadedNativeInstalledPluginPreparation,
} from "./installed-plugin-native-preparation-config.ts";
import { nativePreparationFailure as fail } from "./installed-plugin-native-preparation-files.ts";
import {
  prepareInstalledPluginWorkerAuthority,
  type InstalledPluginWorkerAuthority,
} from "./installed-plugin-worker-authority.ts";
import type {
  InstalledPluginReleaseEntry,
  InstalledPluginReleaseIdentity,
} from "./installed-plugin-release-document.ts";

export type NativeCandidateBlockedReason = Extract<
  NativeInstalledPluginPreparationStatus,
  { state: "blocked" }
>["reasonCode"];
export class NativeCandidateBlocked extends Error {
  readonly reasonCode: NativeCandidateBlockedReason;
  constructor(reasonCode: NativeCandidateBlockedReason) {
    super(`installed_plugin_native_candidate_${reasonCode}`);
    this.reasonCode = reasonCode;
  }
}
class NativeCandidateAuthorityFailure extends Error {
  readonly failure: unknown;
  constructor(failure: unknown) {
    super("installed_plugin_native_candidate_authority_failed");
    this.failure = failure;
  }
}
type Facts = Readonly<{
  selection: PluginSelection;
  installed: InstalledPluginPackage;
  configuration: ExtensionConfiguration;
}>;
export type NativePreparedCandidate = Readonly<{
  facts: Facts;
  registration: InstalledPluginBusinessRegistration;
  entry: InstalledPluginReleaseEntry;
}>;

const packageUnavailableCodes = new Set([
  "plugin_business_manifest_missing",
  "plugin_business_manifest_limit",
  "plugin_business_manifest_digest_mismatch",
  "plugin_business_manifest_invalid",
  "plugin_business_manifest_identity_mismatch",
  "plugin_package_descriptor_invalid",
  "plugin_package_file_limit",
  "plugin_package_total_limit",
  "plugin_package_directory_entry_limit",
  "plugin_package_directory_limit",
  "plugin_package_directory_invalid",
  "plugin_package_file_type_invalid",
  "plugin_package_file_size_mismatch",
  "plugin_package_file_conflict",
  "plugin_package_source_changed",
  "plugin_package_file_undeclared",
  "plugin_package_file_digest_mismatch",
  "plugin_package_artifact_missing",
]);
const unavailableFilesystemCodes = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "EISDIR",
]);
function unavailableFilesystem(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    unavailableFilesystemCodes.has(error.code)
  );
}

/** The same actual authority and SQLite connection own every candidate in this preparation. */
export class NativeCandidateMetadataOwner {
  readonly #loaded: LoadedNativeInstalledPluginPreparation;
  readonly #signal: AbortSignal;
  #authority: InstalledPluginWorkerAuthority | null = null;
  #store: SqliteRunStore | null = null;

  constructor(
    loaded: LoadedNativeInstalledPluginPreparation,
    signal: AbortSignal,
  ) {
    this.#loaded = loaded;
    this.#signal = signal;
  }

  async open(): Promise<void> {
    if (this.#authority !== null || this.#store !== null)
      fail("owner_already_open");
    this.#signal.throwIfAborted();
    assertNativeInstalledPluginPreparation(this.#loaded);
    this.#authority = await prepareInstalledPluginWorkerAuthority(
      this.#loaded.worker,
      this.#loaded.environment,
    );
    await this.current();
    this.#store = new SqliteRunStore(this.#loaded.databasePath);
  }

  get store(): SqliteRunStore {
    if (this.#store === null) fail("store_unavailable");
    return this.#store;
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const owner of [this.#authority, this.#store]) {
      try {
        await owner?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        "installed_plugin_native_candidate_close_failed",
      );
  }

  async current(): Promise<void> {
    this.#signal.throwIfAborted();
    assertNativeInstalledPluginPreparation(this.#loaded);
    if (this.#authority === null) fail("authority_unavailable");
    const { actor, scope } = this.#loaded.configuration;
    const actual = await this.#authority.installedPluginExecution.resolveActor(
      {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      },
      this.#signal,
    );
    this.#signal.throwIfAborted();
    if (
      actual === null ||
      !isDeepStrictEqual(parseNativePreparationActor(actual), actor)
    )
      fail("actor_changed");
    const profile = await this.#authority.resolveProfile(actor, this.#signal);
    this.#signal.throwIfAborted();
    if (
      profile === null ||
      !isDeepStrictEqual(parsePluginProfileScope(profile), scope)
    )
      fail("profile_changed");
    assertNativeInstalledPluginPreparation(this.#loaded);
  }

  async authorizeRead(
    identity: InstalledPluginReleaseIdentity,
  ): Promise<"allow"> {
    await this.current();
    if (this.#authority === null) fail("authority_unavailable");
    const { actor, scope, approvedPackages } = this.#loaded.configuration;
    if (
      !approvedPackages.some((approved) =>
        isDeepStrictEqual(approved, identity),
      )
    )
      throw new NativeCandidateBlocked("notApproved");
    const decision = await this.#authority.authorizeRead(
      { identity, scope, purpose: "read" },
      this.#signal,
    );
    this.#signal.throwIfAborted();
    if (decision !== "allow") throw new NativeCandidateBlocked("readDenied");
    const permission =
      await this.#authority.installedPluginExecution.authorization.authorize({
        actor,
        action: "extension:read",
        resource: {
          kind: "extension",
          tenantId: scope.tenantId,
          spaceId: scope.spaceId,
          pluginId: identity.pluginId,
        },
      });
    this.#signal.throwIfAborted();
    if (permission.outcome !== "allow")
      throw new NativeCandidateBlocked("readDenied");
    await this.current();
    return "allow";
  }

  /** Keeps remote authority/schema failures distinct from invalid installed package data. */
  async authorizePackageRead(
    identity: InstalledPluginReleaseIdentity,
  ): Promise<"allow"> {
    try {
      return await this.authorizeRead(identity);
    } catch (error) {
      if (error instanceof NativeCandidateBlocked) throw error;
      throw new NativeCandidateAuthorityFailure(error);
    }
  }

  async facts(pluginId: string): Promise<Facts> {
    const { scope, approvedPackages } = this.#loaded.configuration;
    const rawSelection = await this.store
      .pluginInstallationStore()
      .loadSelection({ scope, pluginId });
    this.#signal.throwIfAborted();
    if (rawSelection === null) throw new NativeCandidateBlocked("notInstalled");
    const selection = parsePluginSelection(rawSelection);
    if (
      selection.pluginId !== pluginId ||
      !isDeepStrictEqual(scopeOf(selection), scope)
    )
      fail("scope_mismatch");
    if (
      selection.state === "uninstalled" ||
      selection.selectedPackageDigest === null
    )
      throw new NativeCandidateBlocked("notInstalled");
    const rawInstalled = await this.store
      .pluginInstallationStore()
      .loadPackage({ scope, packageDigest: selection.selectedPackageDigest });
    this.#signal.throwIfAborted();
    if (rawInstalled === null)
      throw new NativeCandidateBlocked("packageUnavailable");
    const installed = parseInstalledPluginPackage(rawInstalled);
    if (
      !isDeepStrictEqual(scopeOf(installed), scope) ||
      installed.pluginId !== pluginId
    )
      fail("scope_mismatch");
    if (
      installed.publisherId !== selection.publisherId ||
      installed.packageDigest !== selection.selectedPackageDigest
    )
      fail("package_identity_mismatch");
    if (
      !approvedPackages.some((approved) =>
        isDeepStrictEqual(approved, identityOf(installed)),
      )
    )
      throw new NativeCandidateBlocked("notApproved");
    const saved = await this.store
      .extensionStore()
      .loadLatestExtensionConfiguration({
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        pluginId,
      });
    this.#signal.throwIfAborted();
    if (saved === null)
      throw new NativeCandidateBlocked("configurationMissing");
    if (
      saved.tenantId !== scope.tenantId ||
      saved.spaceId !== scope.spaceId ||
      saved.pluginId !== pluginId
    )
      fail("scope_mismatch");
    return Object.freeze({ selection, installed, configuration: saved });
  }

  async registration(
    facts: Facts,
  ): Promise<InstalledPluginBusinessRegistration> {
    const identity = identityOf(facts.installed);
    await this.authorizeRead(identity);
    return this.packageRead(() =>
      loadInstalledPluginBusinessRegistration({
        installRoot: this.#loaded.worker.installRoot,
        expectedPluginId: identity.pluginId,
        expectedPublisherId: identity.publisherId,
        expectedVersion: identity.version,
        expectedPackageDigest: identity.packageDigest,
        signal: this.#signal,
        authorizeRead: async (candidate) => {
          const actual = {
            pluginId: candidate.descriptor.pluginId,
            publisherId: candidate.descriptor.publisherId,
            version: candidate.descriptor.version,
            packageDigest: candidate.packageDigest,
          };
          if (!isDeepStrictEqual(actual, identity))
            throw new NativeCandidateBlocked("packageUnavailable");
          return this.authorizePackageRead(actual);
        },
      }),
    );
  }

  validate(
    registration: InstalledPluginBusinessRegistration,
    facts: Facts,
  ): ExtensionConfiguration {
    try {
      return validateInstalledPluginConfiguration(
        registration,
        facts.configuration,
      );
    } catch (error) {
      this.#signal.throwIfAborted();
      assertNativeInstalledPluginPreparation(this.#loaded);
      if (
        (error instanceof ExtensionManifestError &&
          error.code === "extension_configuration_invalid") ||
        (error instanceof Error &&
          [
            "installed_plugin_business_configuration_mismatch",
            "installed_plugin_business_credentials_unavailable",
          ].includes(error.message))
      )
        throw new NativeCandidateBlocked("configurationIncompatible");
      throw error;
    }
  }

  /** Only the verifier's explicit package-data errors are isolated. Authority/protocol failures propagate. */
  async packageRead<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      this.#signal.throwIfAborted();
      assertNativeInstalledPluginPreparation(this.#loaded);
      if (error instanceof NativeCandidateAuthorityFailure) throw error.failure;
      if (error instanceof NativeCandidateBlocked) throw error;
      if (
        (error instanceof LocalPluginPackageError &&
          (packageUnavailableCodes.has(error.code) ||
            (error.code === "plugin_package_filesystem_unavailable" &&
              unavailableFilesystem(error.cause)))) ||
        error instanceof PluginPackageContractError ||
        error instanceof ExtensionManifestError ||
        unavailableFilesystem(error) ||
        (error instanceof Error &&
          [
            "installed_plugin_business_execution_unavailable",
            "installed_plugin_business_identity_mismatch",
            "installed_plugin_business_registration_changed",
          ].includes(error.message))
      )
        throw new NativeCandidateBlocked("packageUnavailable");
      throw error;
    }
  }

  async recheck(row: NativePreparedCandidate): Promise<void> {
    await this.current();
    await this.#unchanged(row);
    await this.packageRead(() =>
      revalidateInstalledPluginBusinessRegistration(
        row.registration,
        this.#signal,
      ),
    );
    await this.#unchanged(row);
    await this.current();
    await this.#unchanged(row);
  }

  async recheckFacts(row: NativePreparedCandidate): Promise<void> {
    this.#signal.throwIfAborted();
    assertNativeInstalledPluginPreparation(this.#loaded);
    await this.#unchanged(row);
    this.#signal.throwIfAborted();
    assertNativeInstalledPluginPreparation(this.#loaded);
  }

  async #unchanged(row: NativePreparedCandidate): Promise<void> {
    let actual: Facts;
    try {
      actual = await this.facts(row.facts.installed.pluginId);
    } catch (error) {
      if (error instanceof NativeCandidateBlocked)
        throw new NativeCandidateBlocked("stateChanged");
      throw error;
    }
    if (!isDeepStrictEqual(actual, row.facts))
      throw new NativeCandidateBlocked("stateChanged");
  }
}

function scopeOf(input: {
  tenantId: string;
  spaceId: string;
  profileId: string;
}) {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    profileId: input.profileId,
  };
}
function identityOf(
  input: InstalledPluginPackage,
): InstalledPluginReleaseIdentity {
  return {
    pluginId: input.pluginId,
    publisherId: input.publisherId,
    version: input.version,
    packageDigest: input.packageDigest,
  };
}
