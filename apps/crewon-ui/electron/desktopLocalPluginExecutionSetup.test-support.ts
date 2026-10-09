import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionConfiguration } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { installLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-installer.ts";
import { loadInstalledPluginBusinessRegistration } from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import { createDesktopLocalPluginExecutionSetupOwner } from "./desktopLocalPluginExecutionSetup.ts";
import type { DesktopInstalledPluginRuntime } from "./desktopInstalledPluginRuntime.ts";
export const fixtureHash = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Actual immutable installation + original SQLite mutations. The declared Node entry throws if imported. */
export async function executionSetupFixture(
  options: Readonly<{
    version?: string;
    /** Copied into the owned fixture source; the supplied package is never mutated. */
    packageDirectory?: string;
    /** Test-only immutable package data; cannot replace the original entrypoints or business manifest. */
    packageDataFiles?: readonly Readonly<{ path: string; bytes: Buffer }>[];
    /** Test-only descriptor upgrade; original frozen package bytes stay untouched. */
    assetUiProtocol?: "2";
    projectContext?: boolean;
    historicalQueries?: boolean;
    contract?: "legacy" | "assets";
    omitServices?: readonly string[];
    omitOperations?: readonly string[];
    requirements?: readonly Readonly<{
      service: string;
      apiVersion: string;
      optional: boolean;
    }>[];
  }> = {},
) {
  const version = options.version ?? "12.0.0";
  const assets = options.contract === "assets" || version === "19.0.0";
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-local-execution-setup-")),
  );
  chmodSync(directory, 0o700);
  const dataDirectory = join(directory, "native"),
    source = join(directory, "source");
  mkdirSync(dataDirectory, { mode: 0o700 });
  mkdirSync(source, { mode: 0o700 });
  // Tracked original 24-tool v1 bytes copied from dist/39.0.0/business.json.
  // The historical fixture overrides its version explicitly; this is not a released package39.
  const originalBusinessBytes = readFileSync(
    fileURLToPath(
      new URL("./test-fixtures/short-drama-business-v1.json", import.meta.url),
    ),
  );
  if (
    fixtureHash(originalBusinessBytes) !==
    "sha256:9afce0e5f9c6089dcc615710e8bbfa7b8a92e8a77d5521c689f02a868be96f7c"
  )
    throw new Error("historical_business_fixture_bytes_changed");
  const currentBusiness = JSON.parse(originalBusinessBytes.toString("utf8"));
  // Historical fixtures retain their original protocol; new versions explicitly choose a contract.
  const baseBusiness = assets
    ? currentBusiness
    : {
        ...currentBusiness,
        schemaVersion: "crewon.extension-manifest.v0",
        hostApi: "crewon.extensions.v0",
        tools: currentBusiness.tools.filter(
          (tool: { operationId: string }) =>
            !tool.operationId.startsWith("asset_") &&
            !tool.operationId.startsWith("media_"),
        ),
      };
  const business = {
    ...baseBusiness,
    tools: baseBusiness.tools.filter(
      (tool: { operationId: string }) =>
        !options.omitOperations?.includes(tool.operationId) &&
        (options.projectContext === true ||
          tool.operationId !== "project_context_read"),
    ),
  };
  const files = new Map([
    [
      "node.mjs",
      Buffer.from("throw new Error('metadata_preview_must_not_import_node');"),
    ],
    [
      "ui.mjs",
      Buffer.from("throw new Error('metadata_preview_must_not_import_ui');"),
    ],
    [
      "business.json",
      Buffer.from(
        JSON.stringify({
          ...business,
          version,
        }),
      ),
    ],
  ]);
  for (const item of options.packageDataFiles ?? []) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(item.path) ||
      item.path
        .split("/")
        .some(
          (segment) => segment === ".." || segment === "." || segment === "",
        ) ||
      files.has(item.path)
    )
      throw new Error("fixture_package_data_path_invalid");
    files.set(item.path, Buffer.from(item.bytes));
  }
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), bytes);
  }
  const descriptor = {
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version,
    title: "Actual installed metadata fixture",
    description:
      "Never imported; lifecycle ports below are named test doubles.",
    entrypoints: {
      node: "node.mjs",
      ui: { path: "ui.mjs", mode: "trustedModule" },
    },
    businessManifestPath: "business.json",
    requires: [
      { service: "crewon.execution", apiVersion: "1", optional: false },
      ...[
        "crewon.creative-projects",
        "crewon.plugin-ui-recovery",
        "crewon.project-generation-reads",
        "crewon.project-generations",
        "crewon.project-generation-queries",
        "crewon.project-generation-selections",
        "crewon.project-generation-contexts",
        ...([
          "14.0.0",
          "15.0.0",
          "16.0.0",
          "17.0.0",
          "18.0.0",
          "19.0.0",
        ].includes(version) || assets
          ? ["crewon.project-texts"]
          : []),
        ...(["15.0.0", "16.0.0", "17.0.0", "18.0.0", "19.0.0"].includes(
          version,
        ) || assets
          ? ["crewon.project-text-recovery"]
          : []),
        ...(options.historicalQueries === true || version === "18.0.0"
          ? ["crewon.project-historical-queries"]
          : []),
        ...(["17.0.0", "18.0.0", "19.0.0"].includes(version) || assets
          ? ["crewon.project-text-plans"]
          : []),
        ...(["18.0.0", "19.0.0"].includes(version) || assets
          ? ["crewon.project-planning-drafts"]
          : []),
        ...(assets
          ? [
              "crewon.project-assets",
              "crewon.project-asset-recovery",
              "crewon.project-asset-stages",
              "crewon.project-asset-tools",
              "crewon.project-asset-context",
            ]
          : []),
        ...(options.projectContext === true
          ? [
              "crewon.project-conversations",
              "crewon.project-context",
              "crewon.project-tools",
            ]
          : []),
      ].map((service) => ({ service, apiVersion: "1", optional: true })),
    ],
    provides: [],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        title: "Workbench",
        slot: "main.content",
      },
    ],
    files: [...files].map(([path, bytes]) => ({
      path,
      byteLength: bytes.length,
      sha256: fixtureHash(bytes).slice(7),
    })),
  };
  descriptor.requires = descriptor.requires
    .filter((entry) => !options.omitServices?.includes(entry.service))
    .filter(
      (entry) =>
        !options.requirements?.some(
          (replacement) => replacement.service === entry.service,
        ),
    )
    .concat(options.requirements ?? []);
  writeFileSync(join(source, "crewon.plugin.json"), JSON.stringify(descriptor));
  if (options.packageDirectory !== undefined)
    cpSync(options.packageDirectory, source, { recursive: true });
  if (options.assetUiProtocol === "2") {
    const path = join(source, "crewon.plugin.json");
    const copied = JSON.parse(readFileSync(path, "utf8"));
    copied.requires = copied.requires.map(
      (r: { service: string; apiVersion: string; optional: boolean }) =>
        ["crewon.project-assets", "crewon.project-asset-recovery"].includes(
          r.service,
        )
          ? { ...r, apiVersion: "2" }
          : r,
    );
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify(copied));
  }
  const installRoot = join(dataDirectory, "plugins");
  mkdirSync(installRoot, { mode: 0o700 });
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const identity = {
    pluginId: installed.descriptor.pluginId,
    publisherId: installed.descriptor.publisherId,
    version: installed.descriptor.version,
    packageDigest: installed.packageDigest,
  };
  const approvalPath = join(dataDirectory, "plugin-approvals.json"),
    policyPath = join(dataDirectory, "plugin-native-policy.json");
  const approval = {
    schemaVersion: "crewon.desktop-plugin-approval.v1",
    sources: [
      { ...identity, sourceId: "explicit-short-source", directory: source },
    ],
    publications: [
      {
        pluginId: identity.pluginId,
        publisherId: identity.publisherId,
        packageDigest: identity.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
  };
  writeFileSync(approvalPath, JSON.stringify(approval), { mode: 0o600 });
  let bootstrap = (await prepareDesktopPluginBootstrap({
    dataDirectory,
    actor,
    sessionEntropy: fixtureHash("fixture-original-session"),
  }))!;
  const scope = bootstrap.scope,
    store = new SqliteRunStore(join(dataDirectory, "control.sqlite"));
  await store.pluginInstallationStore().migrate();
  await store.extensionStore().migrate();
  const installedRecord = await store
    .pluginInstallationStore()
    .recordInstalledPackage({
      scope,
      actor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...identity,
        installedAt: "2026-10-05T00:00:00.000Z",
        installedByActorId: actor.actorId,
        installedByPrincipalId: actor.principalId,
      },
      expectedSelectionRevision: null,
      receipt: {
        idempotencyKey: "install-fixture",
        requestDigest: fixtureHash("install-fixture"),
      },
    });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot,
    expectedPluginId: identity.pluginId,
    expectedPublisherId: identity.publisherId,
    expectedVersion: identity.version,
    expectedPackageDigest: identity.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  }).catch(async (error) => {
    await bootstrap.cleanup();
    await store.close();
    removeFixtureDirectory(directory);
    throw error;
  });
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: identity.pluginId,
      pluginVersion: identity.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: {
        baseUrl: "https://comfy.example:8443/",
        preset: "krea2-portrait",
      },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-05T00:00:00.000Z",
    },
    { sha256: fixtureHash },
  );
  await store.extensionStore().saveExtensionConfiguration({
    configuration,
    expectedRevision: 0,
    receipt: {
      actorId: actor.actorId,
      idempotencyKey: "save-fixture",
      requestDigest: fixtureHash("save-fixture"),
    },
  });
  let current = true;
  const owners: ReturnType<
    typeof createDesktopLocalPluginExecutionSetupOwner
  >[] = [];
  const entry = {
    identity: {
      ...identity,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
    },
    configuration:
      configuration as unknown as DesktopInstalledPluginRuntime["expectedCatalogEntries"][number]["configuration"],
    configuredTarget: {
      executionAuthority: "crewonKernel",
      agentVersionId: "fixture-derived-agent",
      agentVersionContentDigest: fixtureHash("agent"),
      materializationDigest: fixtureHash("materialization"),
      authorityId: "fixture-authority",
      runtimeGeneration: "fixture-generation",
      policySnapshotId: "fixture-policy",
      workspaceBindingId: null,
    } as DesktopInstalledPluginRuntime["expectedCatalogEntries"][number]["configuredTarget"],
  };
  let runtimeWithdrawn = false;
  const fakePreparedRuntime = () =>
    Object.freeze({
      scope,
      expectedCatalogEntries: [entry],
      assertCurrent() {
        if (runtimeWithdrawn) throw new Error("fixture_runtime_withdrawn");
      },
    }) as unknown as DesktopInstalledPluginRuntime;
  let session = 0;
  return {
    directory,
    dataDirectory,
    source,
    installed,
    identity,
    scope,
    store,
    configuration,
    approval,
    approvalPath,
    policyPath,
    entry,
    get bootstrap() {
      return bootstrap;
    },
    installedSelection: installedRecord.selection,
    create(lifetime?: number) {
      const owner = createDesktopLocalPluginExecutionSetupOwner({
        dataDirectory,
        assertCurrent() {
          if (!current) throw new Error("fixture_document_withdrawn");
        },
        ...(lifetime === undefined ? {} : { previewLifetimeMs: lifetime }),
      });
      owners.push(owner);
      return owner;
    },
    withdrawDocument() {
      current = false;
    },
    withdrawRuntime() {
      runtimeWithdrawn = true;
    },
    fakePreparedRuntime,
    async stop() {
      runtimeWithdrawn = true;
      await bootstrap.cleanup();
    },
    async start() {
      bootstrap = (await prepareDesktopPluginBootstrap({
        dataDirectory,
        actor,
        sessionEntropy: fixtureHash(`fixture-session-${++session}`),
      }))!;
      runtimeWithdrawn = false;
    },
    async cleanup() {
      for (const owner of owners) await owner.close();
      await bootstrap.cleanup();
      await store.close();
      removeFixtureDirectory(directory);
    },
  };
}

function removeFixtureDirectory(directory: string) {
  function unlock(path: string) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const child of readdirSync(path)) unlock(join(path, child));
    }
  }
  unlock(directory);
  rmSync(directory, { recursive: true });
}
