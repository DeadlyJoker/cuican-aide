import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  parseDesktopProjectHistoricalQueriesConfiguration,
  type DesktopProjectHistoricalQueriesConfiguration,
} from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseInstalledPluginPackage,
  parsePluginSelection,
  type ExtensionConfiguration,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  loadInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
} from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
  type DesktopPluginBootstrap,
  type DesktopPluginBootstrapManifest,
} from "./desktopPluginBootstrap.ts";
import { captureDesktopNativePluginPolicy } from "./desktopNativePluginAuthority.ts";
import type { DesktopInstalledPluginRuntime } from "./desktopInstalledPluginRuntime.ts";
import type { DesktopLocalPluginHistoricalQueryPreview } from "../src/lib/desktop/desktopLocalPluginExecutionSetupProtocol.ts";
import { fields } from "./desktopLocalPluginSourceImportFiles.ts";
import {
  setupHash,
  type PolicyDocument,
  type SetupSnapshot,
} from "./desktopLocalPluginExecutionSetupSnapshot.ts";

const KREA = "crewon.comfyui-krea2";
declare const targetBrand: unique symbol;
/** Captured before stop; it is never a renderer-supplied target or a Node grant. */
export type DesktopLocalHistoricalProjectQueryTarget = Readonly<{
  [targetBrand]: true;
}>;
type Target =
  DesktopProjectHistoricalQueriesConfiguration["publications"][number]["target"];
type Records = Readonly<{
  selection: PluginSelection;
  pkg: InstalledPluginPackage;
  configuration: ExtensionConfiguration;
}>;
type Captured = Readonly<{
  dataDirectory: string;
  database: Stats;
  manifest: DesktopPluginBootstrapManifest;
  records: Records;
  source: DesktopLocalPluginHistoricalQueryPreview["source"];
  target: Target;
  entry: DesktopInstalledPluginRuntime["expectedCatalogEntries"][number];
  targetSource: DesktopPluginApprovalSettings["sources"][number];
  packageApproval: PolicyDocument["packages"][number];
  networkGrants: PolicyDocument["networkGrants"];
  signal: AbortSignal;
  assertActive(): void;
}>;
const captured = new WeakMap<
  DesktopLocalHistoricalProjectQueryTarget,
  Captured
>();
const unavailable = new WeakSet<Error>();
export function isDesktopLocalHistoricalProjectQueryTargetUnavailable(
  error: unknown,
): boolean {
  return error instanceof Error && unavailable.has(error);
}
function invalid(reason: string): never {
  const error = new Error(`desktop_historical_project_query_${reason}`);
  if (
    ["target_unavailable", "target_unapproved", "target_unprepared"].includes(
      reason,
    )
  )
    unavailable.add(error);
  throw error;
}
function json(input: unknown, limit = 128 * 1024) {
  if (typeof input !== "string" || Buffer.byteLength(input) > limit)
    invalid("record_invalid");
  return JSON.parse(input);
}
function pinDatabase(path: string, expected?: Stats): Stats {
  const actual = lstatSync(path);
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1 ||
    actual.uid !== process.getuid?.() ||
    (expected !== undefined &&
      ["dev", "ino", "mode", "uid"].some(
        (key) => actual[key as keyof Stats] !== expected[key as keyof Stats],
      ))
  )
    invalid("database_changed");
  return actual;
}
function records(
  dataDirectory: string,
  manifest: DesktopPluginBootstrapManifest,
  expected?: Stats,
) {
  const path = join(dataDirectory, "control.sqlite"),
    database = pinDatabase(path, expected);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    pinDatabase(path, database);
    for (const name of [
      "plugin_installation_schema_version",
      "plugin_profile_selections",
      "installed_plugin_packages",
      "extension_configurations",
    ]) {
      const row = db
        .prepare("SELECT type FROM sqlite_master WHERE name=? LIMIT 2")
        .all(name);
      if (row.length !== 1 || row[0]!.type !== "table")
        invalid("database_schema");
    }
    const version = db
      .prepare(
        "SELECT id,version FROM plugin_installation_schema_version LIMIT 2",
      )
      .all();
    if (
      version.length !== 1 ||
      version[0]!.id !== 1 ||
      version[0]!.version !== 1
    )
      invalid("database_schema");
    const scope = manifest.scope;
    const rows = db
      .prepare(
        "SELECT * FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=? LIMIT 2",
      )
      .all(scope.tenantId, scope.spaceId, scope.profileId, KREA);
    if (rows.length !== 1) invalid("target_unavailable");
    const row = rows[0]!,
      selection = parsePluginSelection(json(row.record_json, 8192));
    if (
      selection.state !== "enabled" ||
      selection.selectedPackageDigest === null
    )
      invalid("target_unavailable");
    for (const [field, column] of [
      ["revision", "revision"],
      ["state", "state"],
      ["publisherId", "publisher_id"],
      ["selectedPackageDigest", "selected_package_digest"],
    ] as const)
      if (selection[field] !== row[column]) invalid("selection_invalid");
    const packages = db
      .prepare(
        "SELECT * FROM installed_plugin_packages WHERE tenant_id=? AND space_id=? AND profile_id=? AND package_digest=? LIMIT 2",
      )
      .all(
        scope.tenantId,
        scope.spaceId,
        scope.profileId,
        selection.selectedPackageDigest,
      );
    if (packages.length !== 1) invalid("target_unavailable");
    const packageRow = packages[0]!,
      pkg = parseInstalledPluginPackage(json(packageRow.record_json, 8192));
    for (const [field, column] of [
      ["pluginId", "plugin_id"],
      ["publisherId", "publisher_id"],
      ["version", "version"],
      ["packageDigest", "package_digest"],
    ] as const)
      if (pkg[field] !== packageRow[column]) invalid("package_invalid");
    for (const key of ["tenantId", "spaceId", "profileId"] as const)
      if (selection[key] !== scope[key] || pkg[key] !== scope[key])
        invalid("scope_mismatch");
    if (
      selection.pluginId !== KREA ||
      pkg.pluginId !== KREA ||
      selection.publisherId !== pkg.publisherId ||
      selection.selectedPackageDigest !== pkg.packageDigest
    )
      invalid("target_unavailable");
    const saved = db
      .prepare(
        "SELECT revision,configuration_json FROM extension_configurations WHERE tenant_id=? AND space_id=? AND plugin_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(scope.tenantId, scope.spaceId, KREA);
    if (saved === undefined) invalid("target_unavailable");
    const configuration = parseExtensionConfiguration(
      json(saved.configuration_json),
      { sha256: setupHash },
    );
    if (
      configuration.revision !== saved.revision ||
      configuration.pluginId !== KREA ||
      configuration.pluginVersion !== pkg.version ||
      configuration.tenantId !== scope.tenantId ||
      configuration.spaceId !== scope.spaceId
    )
      invalid("configuration_mismatch");
    db.exec("COMMIT");
    pinDatabase(path, database);
    return {
      database,
      records: Object.freeze({ selection, pkg, configuration }),
    };
  } finally {
    db.close();
  }
}
function active(value: Captured) {
  value.signal.throwIfAborted();
  value.assertActive();
}
function authority(
  value: Captured,
  approval: DesktopPluginApprovalSettings,
  policy: PolicyDocument | null,
) {
  active(value);
  if (
    !approval.sources.some((source) =>
      isDeepStrictEqual(source, value.targetSource),
    ) ||
    !policy?.packages.some((pkg) =>
      isDeepStrictEqual(pkg, value.packageApproval),
    ) ||
    !isDeepStrictEqual(
      policy.networkGrants.filter(
        (grant) => grant.packageDigest === value.target.packageDigest,
      ),
      value.networkGrants,
    )
  )
    invalid("approval_changed");
}
function runtimeEntry(value: Captured, runtime: DesktopInstalledPluginRuntime) {
  active(value);
  runtime.assertCurrent();
  if (!isDeepStrictEqual(runtime.scope, value.manifest.scope))
    invalid("runtime_scope");
  const entries = runtime.expectedCatalogEntries.filter(
    (entry) => entry.identity.pluginId === KREA,
  );
  if (entries.length > 1) invalid("target_ambiguous");
  if (entries.length !== 1 || !isDeepStrictEqual(entries[0], value.entry))
    invalid("target_unprepared");
  runtime.assertCurrent();
  active(value);
}

/** Metadata only: real installed bytes, saved configuration and an already approved live target. */
export async function captureDesktopLocalHistoricalProjectQueryTarget(
  input: Readonly<{
    dataDirectory: string;
    bootstrap: DesktopPluginBootstrap;
    runtime: DesktopInstalledPluginRuntime | null;
    snapshot: SetupSnapshot;
    signal: AbortSignal;
    assertCurrent(): void;
  }>,
): Promise<
  Readonly<{
    claim: DesktopLocalHistoricalProjectQueryTarget;
    preview: DesktopLocalPluginHistoricalQueryPreview;
  }>
> {
  input.signal.throwIfAborted();
  input.assertCurrent();
  if (input.runtime === null) invalid("target_unavailable");
  const manifest = assertDesktopPluginBootstrapIssued(input.bootstrap);
  if (
    manifest !== input.snapshot.manifest ||
    manifest.installRoot !== join(input.dataDirectory, "plugins")
  )
    invalid("scope_mismatch");
  const policy = captureDesktopNativePluginPolicy(
    input.dataDirectory,
    input.bootstrap,
  );
  if (policy === null) invalid("target_unavailable");
  const result = records(
    input.dataDirectory,
    manifest,
    input.snapshot.database,
  );
  const pkg = result.records.pkg;
  const packageApproval = policy.packages.find((p) =>
    ["pluginId", "publisherId", "version", "packageDigest"].every(
      (key) => p[key as keyof typeof p] === pkg[key as keyof typeof pkg],
    ),
  );
  const targetSource = input.snapshot.approval.sources.find((s) =>
    ["pluginId", "publisherId", "version", "packageDigest"].every(
      (key) => s[key as keyof typeof s] === pkg[key as keyof typeof pkg],
    ),
  );
  if (packageApproval === undefined || targetSource === undefined)
    invalid("target_unapproved");
  const source = Object.freeze({
    pluginId: input.snapshot.pkg.pluginId,
    packageDigest: input.snapshot.pkg.packageDigest,
    contributionId: "workbench",
  });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: manifest.installRoot,
    expectedPluginId: pkg.pluginId,
    expectedPublisherId: pkg.publisherId,
    expectedVersion: pkg.version,
    expectedPackageDigest: pkg.packageDigest,
    signal: input.signal,
    authorizeRead: async () => {
      input.signal.throwIfAborted();
      input.assertCurrent();
      policy.assertCurrent();
      return "allow";
    },
  });
  validateInstalledPluginConfiguration(
    registration,
    result.records.configuration,
  );
  const verified = await verifyLocalPluginPackage({
    directory: join(
      manifest.installRoot,
      "packages",
      pkg.packageDigest.slice(7),
    ),
    signal: input.signal,
  });
  if (verified.packageDigest !== pkg.packageDigest)
    invalid("target_bytes_changed");
  const descriptor = verified.descriptor;
  const contribution = descriptor.contributions.find(
    (item) => item.kind === "module" && item.slot === "main.content",
  );
  if (
    descriptor.entrypoints.node === null ||
    descriptor.businessManifestPath === null ||
    contribution === undefined
  )
    invalid("target_entry_missing");
  const entries = input.runtime.expectedCatalogEntries.filter(
    (entry) => entry.identity.pluginId === KREA,
  );
  if (entries.length > 1) invalid("target_ambiguous");
  if (entries.length !== 1) invalid("target_unprepared");
  const raw = entries[0]!,
    identity = fields(raw.identity, [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
    ]);
  const preparedIdentity = {
    ...registration.identity,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
  };
  if (!isDeepStrictEqual(identity, preparedIdentity))
    invalid("target_identity_mismatch");
  const configuration = parseExtensionConfiguration(raw.configuration, {
      sha256: setupHash,
    }),
    targetRuntime = parseExtensionExecutionTarget(raw.configuredTarget);
  if (
    !isDeepStrictEqual(configuration, result.records.configuration) ||
    targetRuntime.workspaceBindingId !== null
  )
    invalid("target_configuration_mismatch");
  const target = Object.freeze({
    ...preparedIdentity,
    contributionId: contribution.id,
    action: "image.query" as const,
  });
  const claim = Object.freeze({}) as DesktopLocalHistoricalProjectQueryTarget;
  const value: Captured = Object.freeze({
    dataDirectory: input.dataDirectory,
    database: result.database,
    manifest,
    records: result.records,
    source,
    target,
    entry: Object.freeze({
      identity: Object.freeze({ ...raw.identity }),
      configuration: configuration as unknown as typeof raw.configuration,
      configuredTarget: Object.freeze({
        ...targetRuntime,
      }) as typeof raw.configuredTarget,
    }),
    targetSource,
    packageApproval,
    networkGrants: Object.freeze(
      policy.networkGrants.filter((g) => g.packageDigest === pkg.packageDigest),
    ),
    signal: input.signal,
    assertActive: input.assertCurrent,
  });
  captured.set(claim, value);
  await assertDesktopLocalHistoricalProjectQueryTargetCurrent(claim, {
    approval: input.snapshot.approval,
    policy: input.snapshot.policy,
    runtime: input.runtime,
  });
  policy.assertCurrent();
  return Object.freeze({
    claim,
    preview: Object.freeze({
      source,
      target,
      selectionRevision: result.records.selection.revision,
      configurationRevision: configuration.revision,
      configurationDigest: configuration.contentDigest,
      scope: "query-existing-generations",
      methods: Object.freeze(["GET"] as const),
    }),
  });
}

export async function assertDesktopLocalHistoricalProjectQueryTargetCurrent(
  claim: DesktopLocalHistoricalProjectQueryTarget,
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    policy: PolicyDocument | null;
    runtime?: DesktopInstalledPluginRuntime;
  }>,
) {
  const value = captured.get(claim);
  if (value === undefined) invalid("claim_invalid");
  authority(value, input.approval, input.policy);
  if (input.runtime !== undefined) runtimeEntry(value, input.runtime);
  if (
    !isDeepStrictEqual(
      records(value.dataDirectory, value.manifest, value.database).records,
      value.records,
    )
  )
    invalid("records_changed");
  for (const directory of [
    join(
      value.manifest.installRoot,
      "packages",
      value.target.packageDigest.slice(7),
    ),
    value.targetSource.directory,
  ]) {
    const verified = await verifyLocalPluginPackage({
      directory,
      signal: value.signal,
    });
    if (
      verified.packageDigest !== value.target.packageDigest ||
      verified.descriptor.pluginId !== value.target.pluginId ||
      verified.descriptor.publisherId !== value.target.publisherId ||
      verified.descriptor.version !== value.target.version
    )
      invalid("target_bytes_changed");
    active(value);
  }
  assertDesktopLocalHistoricalProjectQueryTargetSynchronous(claim, input);
  if (input.runtime !== undefined) runtimeEntry(value, input.runtime);
}

/** Final synchronous SQLite/policy CAS; the outer original Setup writer owns the complete private file pins. */
export function assertDesktopLocalHistoricalProjectQueryTargetSynchronous(
  claim: DesktopLocalHistoricalProjectQueryTarget,
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    policy: PolicyDocument | null;
  }>,
) {
  const value = captured.get(claim);
  if (value === undefined) invalid("claim_invalid");
  authority(value, input.approval, input.policy);
  if (
    !isDeepStrictEqual(
      records(value.dataDirectory, value.manifest, value.database).records,
      value.records,
    )
  )
    invalid("records_changed");
}

/** Called only after physical stop. Never assert the withdrawn old runtime here. */
export function composeDesktopLocalHistoricalProjectQueryApproval(
  input: Readonly<{
    claim: DesktopLocalHistoricalProjectQueryTarget;
    approval: DesktopPluginApprovalSettings;
    policy: PolicyDocument | null;
  }>,
): DesktopPluginApprovalSettings {
  assertDesktopLocalHistoricalProjectQueryTargetSynchronous(input.claim, input);
  const value = captured.get(input.claim)!;
  const approval = parseDesktopPluginApproval(input.approval);
  if (approval.schemaVersion !== "crewon.desktop-plugin-approval.v3")
    invalid("execution_approval_required");
  const publication = { source: value.source, target: value.target };
  const previous = approval.projects.historicalQueries?.publications ?? [];
  const existing = previous.find(
    (p) =>
      isDeepStrictEqual(p.source, value.source) &&
      isDeepStrictEqual(p.target, value.target),
  );
  const historicalQueries = parseDesktopProjectHistoricalQueriesConfiguration(
    {
      version: "crewon.desktop-project-historical-query.v1",
      publications: [
        ...previous,
        ...(existing === undefined ? [publication] : []),
      ],
    },
    {
      publications: approval.publications.map(
        ({ pluginId, packageDigest }) => ({ pluginId, packageDigest }),
      ),
    },
  );
  return parseDesktopPluginApproval({
    ...approval,
    projects: { ...approval.projects, historicalQueries },
  });
}
