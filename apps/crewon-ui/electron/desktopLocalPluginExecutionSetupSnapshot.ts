import { captureDesktopLocalShortDramaMediaInputs } from "./desktopLocalShortDramaMediaInputs.ts";
import {
  captureDesktopLocalShortDramaMediaGenerations,
  SHORT_MEDIA_UPLOAD_PATHS,
} from "./desktopLocalShortDramaMediaGenerations.ts";
import { createHash } from "node:crypto";
import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  parseDesktopNativePluginAuthority,
  type DesktopNativePluginNetworkGrant,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  parseInstalledPluginPackage,
  parsePluginSelection,
  type ExtensionConfiguration,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import {
  loadInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
} from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import {
  verifyLocalPluginPackage,
  captureLocalPluginPackage,
} from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
  type DesktopPluginBootstrap,
  type DesktopPluginBootstrapManifest,
} from "./desktopPluginBootstrap.ts";
import {
  captureDesktopNativePluginPolicy,
  DESKTOP_NATIVE_PLUGIN_POLICY_FILE,
} from "./desktopNativePluginAuthority.ts";
import {
  assertApproval,
  assertParents,
  assertPrivateDirectory,
  fields,
  parseJson,
  pinParents,
  readApproval,
  type DirectoryPin,
  type FileSnapshot,
} from "./desktopLocalPluginSourceImportFiles.ts";

import { assertDesktopLocalShortDramaExecutionContract } from "./desktopLocalShortDramaExecutionContract.ts";

export const SHORT_PLUGIN_ID = "crewon.short-drama";
export const SHORT_NETWORK_PATHS = Object.freeze([
  Object.freeze({ method: "POST" as const, path: "/prompt" }),
  Object.freeze({ method: "GET" as const, path: "/queue" }),
  Object.freeze({ method: "GET" as const, operationPathPrefix: "/history/" }),
  Object.freeze({ method: "GET" as const, path: "/view" }),
]);
const SHORT_MEDIA_NETWORK_PATHS = Object.freeze([
  ...SHORT_NETWORK_PATHS,
  ...SHORT_MEDIA_UPLOAD_PATHS,
]);
export type PolicyDocument = Readonly<{
  schemaVersion: "crewon.desktop-native-plugin-policy.v1";
  packages: readonly Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    approvalRequirement: "none" | "perAction";
  }>[];
  networkGrants: readonly DesktopNativePluginNetworkGrant[];
}>;
export type SetupSnapshot = {
  manifest: DesktopPluginBootstrapManifest;
  parents: readonly DirectoryPin[];
  database: Stats;
  approvalFile: FileSnapshot;
  profileFile: FileSnapshot;
  policyFile: FileSnapshot | null;
  approval: DesktopPluginApprovalSettings;
  policy: PolicyDocument | null;
  descriptor: PluginPackageDescriptor;
  selection: PluginSelection;
  pkg: InstalledPluginPackage;
  configuration: ExtensionConfiguration;
  mediaInputs: ReturnType<typeof captureDesktopLocalShortDramaMediaInputs>;
  mediaGenerations: ReturnType<
    typeof captureDesktopLocalShortDramaMediaGenerations
  >;
  baseUrl: string;
  preset: "krea2-portrait" | "krea2-character-three-view";
};
export const setupHash = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export function setupInvalid(reason: string): never {
  throw new Error(`desktop_plugin_execution_setup_${reason}`);
}
export function setupPaths(dataDirectory: string) {
  return {
    approval: join(dataDirectory, "plugin-approvals.json"),
    policy: join(dataDirectory, DESKTOP_NATIVE_PLUGIN_POLICY_FILE),
    profile: join(dataDirectory, "plugin-profile.json"),
    database: join(dataDirectory, "control.sqlite"),
  };
}

/** Existing SQLite opened read-only: a preview cannot migrate, install or save a configuration. */
export function readSetupRecords(
  dataDirectory: string,
  scope: PluginProfileScope,
  expectedDatabase?: Stats,
) {
  const path = setupPaths(dataDirectory).database;
  const before = databasePin(path);
  if (expectedDatabase !== undefined) assertDatabase(path, expectedDatabase);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("BEGIN");
    assertDatabase(path, before);
    const version = database
      .prepare(
        "SELECT id,version FROM plugin_installation_schema_version LIMIT 2",
      )
      .all();
    if (
      version.length !== 1 ||
      version[0]!.id !== 1 ||
      version[0]!.version !== 1
    )
      setupInvalid("installation_schema");
    const values = [scope.tenantId, scope.spaceId, scope.profileId];
    const selectionRow = database
      .prepare(
        "SELECT * FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=? LIMIT 2",
      )
      .all(...values, SHORT_PLUGIN_ID);
    if (selectionRow.length !== 1) setupInvalid("selection_missing");
    const selection = parsePluginSelection(
      boundedJson(selectionRow[0]!.record_json, 8192),
    );
    for (const [field, column] of [
      ["revision", "revision"],
      ["state", "state"],
      ["publisherId", "publisher_id"],
      ["selectedPackageDigest", "selected_package_digest"],
    ] as const)
      if (selection[field] !== selectionRow[0]![column])
        setupInvalid("selection_record");
    if (
      selection.state === "uninstalled" ||
      selection.selectedPackageDigest === null
    )
      setupInvalid("selection_missing");
    const packageRow = database
      .prepare(
        "SELECT * FROM installed_plugin_packages WHERE tenant_id=? AND space_id=? AND profile_id=? AND package_digest=? LIMIT 2",
      )
      .all(...values, selection.selectedPackageDigest);
    if (packageRow.length !== 1) setupInvalid("installation_missing");
    const pkg = parseInstalledPluginPackage(
      boundedJson(packageRow[0]!.record_json, 8192),
    );
    for (const [field, column] of [
      ["pluginId", "plugin_id"],
      ["version", "version"],
      ["publisherId", "publisher_id"],
      ["packageDigest", "package_digest"],
    ] as const)
      if (pkg[field] !== packageRow[0]![column])
        setupInvalid("installation_record");
    for (const key of ["tenantId", "spaceId", "profileId"] as const)
      if (selection[key] !== scope[key] || pkg[key] !== scope[key])
        setupInvalid("scope");
    if (
      pkg.pluginId !== SHORT_PLUGIN_ID ||
      selection.pluginId !== pkg.pluginId ||
      selection.publisherId !== pkg.publisherId ||
      selection.selectedPackageDigest !== pkg.packageDigest
    )
      setupInvalid("installation_identity");
    const configurationRow = database
      .prepare(
        "SELECT revision,configuration_json FROM extension_configurations WHERE tenant_id=? AND space_id=? AND plugin_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(scope.tenantId, scope.spaceId, SHORT_PLUGIN_ID);
    if (configurationRow === undefined) setupInvalid("configuration_missing");
    const configuration = parseExtensionConfiguration(
      boundedJson(configurationRow.configuration_json, 128 * 1024),
      { sha256: setupHash },
    );
    if (configurationRow.revision !== configuration.revision)
      setupInvalid("configuration_record");
    if (
      configuration.tenantId !== scope.tenantId ||
      configuration.spaceId !== scope.spaceId
    )
      setupInvalid("scope");
    database.exec("COMMIT");
    assertDatabase(path, before);
    return { database: before, selection, pkg, configuration };
  } finally {
    database.close();
  }
}

export async function captureSetupSnapshot(input: {
  dataDirectory: string;
  bootstrap: DesktopPluginBootstrap;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<SetupSnapshot> {
  input.signal.throwIfAborted();
  input.assertCurrent();
  const manifest = assertDesktopPluginBootstrapIssued(input.bootstrap);
  if (manifest.installRoot !== join(input.dataDirectory, "plugins"))
    setupInvalid("install_root");
  const parents = pinParents(input.dataDirectory);
  assertPrivateDirectory(input.dataDirectory);
  const paths = setupPaths(input.dataDirectory);
  const approvalFile = readApproval(paths.approval),
    profileFile = readApproval(paths.profile);
  if (approvalFile === null || profileFile === null)
    setupInvalid("approval_missing");
  const approval = parseDesktopPluginApproval(parseJson(approvalFile.bytes));
  const existing = captureDesktopNativePluginPolicy(
    input.dataDirectory,
    input.bootstrap,
  );
  const policyFile = readApproval(paths.policy);
  const policy =
    existing === null
      ? null
      : Object.freeze({
          schemaVersion: "crewon.desktop-native-plugin-policy.v1" as const,
          packages: existing.packages,
          networkGrants: existing.networkGrants,
        });
  if (
    existing?.policyDigest !==
    (policyFile === null ? undefined : setupHash(policyFile.bytes))
  )
    setupInvalid("policy_changed");
  const records = readSetupRecords(input.dataDirectory, manifest.scope);
  const source = approval.sources.find((candidate) =>
    ["pluginId", "publisherId", "version", "packageDigest"].every(
      (key) =>
        candidate[key as keyof typeof candidate] ===
        records.pkg[key as keyof typeof records.pkg],
    ),
  );
  if (source === undefined) setupInvalid("source_unapproved");
  const root = join(
    manifest.installRoot,
    "packages",
    records.pkg.packageDigest.slice(7),
  );
  const packageSnapshot = await captureLocalPluginPackage(
    { directory: root, signal: input.signal },
    true,
  );
  const verified = packageSnapshot.verification;
  const descriptor = verified.descriptor;
  if (
    verified.packageDigest !== records.pkg.packageDigest ||
    descriptor.pluginId !== SHORT_PLUGIN_ID ||
    descriptor.publisherId !== "example.publisher" ||
    descriptor.publisherId !== records.pkg.publisherId ||
    descriptor.version !== records.pkg.version ||
    descriptor.entrypoints.node === null ||
    descriptor.entrypoints.ui === null ||
    descriptor.businessManifestPath === null ||
    !descriptor.contributions.some(
      (entry) =>
        entry.id === "workbench" &&
        entry.kind === "module" &&
        entry.slot === "main.content",
    ) ||
    !approval.publications.some(
      (entry) =>
        entry.pluginId === descriptor.pluginId &&
        entry.publisherId === descriptor.publisherId &&
        entry.packageDigest === records.pkg.packageDigest &&
        entry.publicAssets.includes(descriptor.entrypoints.ui!.path),
    )
  )
    setupInvalid("package_unsupported");
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: manifest.installRoot,
    expectedPluginId: records.pkg.pluginId,
    expectedPublisherId: records.pkg.publisherId,
    expectedVersion: records.pkg.version,
    expectedPackageDigest: records.pkg.packageDigest,
    signal: input.signal,
    async authorizeRead(candidate) {
      input.assertCurrent();
      input.signal.throwIfAborted();
      return candidate.packageDigest === records.pkg.packageDigest &&
        candidate.descriptor.pluginId === records.pkg.pluginId &&
        candidate.descriptor.publisherId === records.pkg.publisherId &&
        candidate.descriptor.version === records.pkg.version
        ? "allow"
        : "deny";
    },
  });
  assertDesktopLocalShortDramaExecutionContract(
    descriptor,
    registration.manifest,
  );
  const configuration = validateInstalledPluginConfiguration(
    registration,
    records.configuration,
  );
  const parameters = fields(configuration.parameters, ["baseUrl", "preset"]);
  if (
    typeof parameters.baseUrl !== "string" ||
    (parameters.preset !== "krea2-portrait" &&
      parameters.preset !== "krea2-character-three-view")
  )
    setupInvalid("configuration_unsupported");
  const snapshot: SetupSnapshot = {
    manifest,
    parents,
    ...records,
    approvalFile,
    profileFile,
    policyFile,
    approval,
    policy,
    descriptor,
    configuration,
    mediaInputs: captureDesktopLocalShortDramaMediaInputs(
      packageSnapshot,
      configuration,
    ),
    mediaGenerations: null,
    baseUrl: parameters.baseUrl,
    preset: parameters.preset,
  };
  snapshot.mediaGenerations = captureDesktopLocalShortDramaMediaGenerations({
    snapshot: packageSnapshot,
    manifest: registration.manifest,
    mediaInputs: snapshot.mediaInputs,
    approval,
    uploadApproved:
      policy?.networkGrants.some(
        (grant) =>
          grant.packageDigest === snapshot.pkg.packageDigest &&
          grant.baseUrl === snapshot.baseUrl &&
          grant.baseUrlParameter === "baseUrl" &&
          isDeepStrictEqual(grant.paths, SHORT_MEDIA_NETWORK_PATHS),
      ) === true,
  });
  // The original authority parser checks canonical HTTPS and the exact bounded path rules.
  mergeSetupPolicy(
    input.dataDirectory,
    snapshot,
    input.bootstrap.bootstrapPath,
  );
  await assertSetupSnapshot(
    input.dataDirectory,
    snapshot,
    input.signal,
    input.assertCurrent,
  );
  existing?.assertCurrent();
  if (assertDesktopPluginBootstrapIssued(input.bootstrap) !== manifest)
    setupInvalid("bootstrap_changed");
  return snapshot;
}

export async function assertSetupSnapshot(
  dataDirectory: string,
  snapshot: SetupSnapshot,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  const assertFiles = () => {
    signal.throwIfAborted();
    assertCurrent();
    assertParents(snapshot.parents);
    assertPrivateDirectory(dataDirectory);
    const paths = setupPaths(dataDirectory);
    assertApproval(paths.approval, snapshot.approvalFile);
    assertApproval(paths.profile, snapshot.profileFile);
    assertApproval(paths.policy, snapshot.policyFile);
  };
  assertFiles();
  const records = readSetupRecords(
    dataDirectory,
    snapshot.manifest.scope,
    snapshot.database,
  );
  if (
    !isDeepStrictEqual(records.selection, snapshot.selection) ||
    !isDeepStrictEqual(records.pkg, snapshot.pkg) ||
    !isDeepStrictEqual(records.configuration, snapshot.configuration)
  )
    setupInvalid("records_changed");
  for (const directory of [
    join(
      snapshot.manifest.installRoot,
      "packages",
      snapshot.pkg.packageDigest.slice(7),
    ),
    snapshot.approval.sources.find(
      (source) => source.packageDigest === snapshot.pkg.packageDigest,
    )!.directory,
  ]) {
    const verified = await verifyLocalPluginPackage({ directory, signal });
    if (
      verified.packageDigest !== snapshot.pkg.packageDigest ||
      !isDeepStrictEqual(verified.descriptor, snapshot.descriptor)
    )
      setupInvalid("package_changed");
  }
  assertFiles();
  const after = readSetupRecords(
    dataDirectory,
    snapshot.manifest.scope,
    snapshot.database,
  );
  if (
    !isDeepStrictEqual(after.selection, snapshot.selection) ||
    !isDeepStrictEqual(after.pkg, snapshot.pkg) ||
    !isDeepStrictEqual(after.configuration, snapshot.configuration)
  )
    setupInvalid("records_changed");
}

export function mergeSetupPolicy(
  dataDirectory: string,
  snapshot: SetupSnapshot,
  bootstrapPath: string,
  mediaGenerations: "preserve" | "enable" = "preserve",
): PolicyDocument {
  if (mediaGenerations === "enable" && snapshot.mediaGenerations === null)
    setupInvalid("media_generation_unavailable");
  const pkg = {
    pluginId: snapshot.pkg.pluginId,
    publisherId: snapshot.pkg.publisherId,
    version: snapshot.pkg.version,
    packageDigest: snapshot.pkg.packageDigest,
    approvalRequirement: "none" as const,
  };
  const grant = {
    ...pkg,
    baseUrl: snapshot.baseUrl,
    baseUrlParameter: "baseUrl",
    paths: SHORT_NETWORK_PATHS,
  };
  const { approvalRequirement: _unused, ...networkGrant } = grant;
  const previousPackage = snapshot.policy?.packages.find(
    (entry) => entry.packageDigest === pkg.packageDigest,
  );
  const previousGrant = snapshot.policy?.networkGrants.find(
    (entry) =>
      entry.packageDigest === pkg.packageDigest &&
      entry.baseUrlParameter === "baseUrl",
  );
  const mediaNetworkGrant = {
    ...networkGrant,
    paths: SHORT_MEDIA_NETWORK_PATHS,
  };
  const previousMediaGrant = isDeepStrictEqual(
    previousGrant,
    mediaNetworkGrant,
  );
  if (
    (previousPackage !== undefined &&
      !isDeepStrictEqual(previousPackage, pkg)) ||
    (previousGrant !== undefined &&
      !isDeepStrictEqual(previousGrant, networkGrant) &&
      !previousMediaGrant)
  )
    setupInvalid("policy_conflict");
  const packages = [
    ...(snapshot.policy?.packages ?? []),
    ...(previousPackage === undefined ? [pkg] : []),
  ];
  if (packages.length > 32) setupInvalid("policy_limit");
  const selectedGrant =
    mediaGenerations === "enable" || previousMediaGrant
      ? mediaNetworkGrant
      : networkGrant;
  const networkGrants =
    previousGrant === undefined
      ? [...(snapshot.policy?.networkGrants ?? []), selectedGrant]
      : snapshot.policy!.networkGrants.map((entry) =>
          entry === previousGrant ? selectedGrant : entry,
        );
  const paths = setupPaths(dataDirectory),
    digest = `sha256:${"0".repeat(64)}`;
  const parsed = parseDesktopNativePluginAuthority({
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: "policy-validation",
    actor: snapshot.manifest.actor,
    scope: snapshot.manifest.scope,
    installRoot: snapshot.manifest.installRoot,
    controlDatabasePath: paths.database,
    bootstrapPath,
    bootstrapDigest: digest,
    approvalPath: paths.approval,
    approvalDigest: digest,
    profilePath: paths.profile,
    profileDigest: digest,
    policyPath: paths.policy,
    policyDigest: digest,
    packages: packages.map(
      ({ approvalRequirement: _requirement, ...entry }) => entry,
    ),
    networkGrants,
  });
  return Object.freeze({
    schemaVersion: "crewon.desktop-native-plugin-policy.v1",
    packages: Object.freeze(packages),
    networkGrants: parsed.networkGrants,
  });
}
function boundedJson(input: unknown, maximum: number) {
  if (typeof input !== "string" || Buffer.byteLength(input) > maximum)
    setupInvalid("record_invalid");
  return JSON.parse(input);
}
function databasePin(path: string): Stats {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.()
  )
    setupInvalid("database");
  return stat;
}
function assertDatabase(path: string, expected: Stats) {
  const actual = databasePin(path);
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.mode !== expected.mode ||
    actual.uid !== expected.uid
  )
    setupInvalid("database_changed");
}
