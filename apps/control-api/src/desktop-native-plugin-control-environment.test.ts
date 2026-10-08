import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  renameSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
} from "@crewon/domain";
import {
  loadDesktopNativePluginControlEnvironment,
  assertDesktopNativePluginControlConfigCurrent,
  assertDesktopNativePluginControlComposition,
} from "./desktop-native-plugin-control-environment.ts";
import { DesktopNativePluginActivationAuthority } from "./desktop-native-plugin-activation-authority.ts";
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { assertDesktopNativeProjectHistoricalQueryPreparedTarget } from "./desktop-native-project-historical-query-composition.ts";
import { assertDesktopNativePluginTaskComposition } from "./desktop-native-plugin-task-runtime.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { SqliteRunStore } from "@crewon/store";
import { canonicalDesktopPluginConfiguration } from "./desktop-plugin-configuration-canonical.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { captureDesktopProjectCompositionConfig } from "./desktop-project-execution-startup.ts";
import { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  createDesktopPluginInstallationRuntime,
  assertDesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";

const actor = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
};
const digest = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const sha = { sha256: (value: string) => digest(value) };
const nativeOnly = { skip: process.platform === "win32" };
/** Private-file issue boundary only; the named entry is not a Worker or supplier execution proof. */
async function fixture(
  t: TestContext,
  options: Readonly<{
    historical?: boolean;
    historicalTarget?: Record<string, unknown>;
    preparedHistoricalTarget?: false;
    retainedSourceCount?: number;
    sourceDirectoryPadding?: number;
  }> = {},
) {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-native-control-"),
  );
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scope = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "native-control-profile",
    },
    identity = {
      pluginId: "example.image",
      publisherId: "example.publisher",
      version: "1.0.0",
      packageDigest: digest("named-package"),
    };
  const source = {
      ...identity,
      sourceId: "image",
      directory: join(directory, "source"),
    },
    installRoot = join(directory, "plugins");
  mkdirSync(installRoot, { mode: 0o700 });
  const preparedIdentity =
    options.preparedHistoricalTarget === false
      ? {
          ...identity,
          pluginId: "example.other",
          packageDigest: digest("other-prepared-package"),
        }
      : identity;
  const identities =
    options.preparedHistoricalTarget === false
      ? [identity, preparedIdentity]
      : Array.from(
          { length: options.retainedSourceCount ?? 1 },
          (_, index) => ({
            ...identity,
            version: `${index + 1}.0.0`,
            packageDigest:
              index === 0
                ? identity.packageDigest
                : digest(`retained-${index}`),
          }),
        );
  const sources = identities.map((value, index) => ({
    ...source,
    ...value,
    sourceId: index === 0 ? source.sourceId : `image-${index}`,
    directory:
      index === 0 ? source.directory : join(directory, `source-${index}`),
  }));
  if (options.sourceDirectoryPadding !== undefined)
    for (const source of sources)
      source.directory = join(
        source.directory,
        "x".repeat(options.sourceDirectoryPadding),
      );
  const publications =
    options.historical === true
      ? [
          {
            pluginId: identity.pluginId,
            publisherId: identity.publisherId,
            packageDigest: identity.packageDigest,
            publicAssets: ["ui.mjs"],
          },
        ]
      : [];
  const projectSource = {
    pluginId: identity.pluginId,
    packageDigest: identity.packageDigest,
    contributionId: "studio",
  };
  const projects =
    options.historical === true
      ? {
          version: "crewon.desktop-project-execution.v1",
          pluginUi: { publications: [projectSource] },
          generationReads: { version: "crewon.project-generation-read.v1" },
          generationReadUi: { publications: [projectSource] },
          historicalQueries: {
            version: "crewon.desktop-project-historical-query.v1",
            publications: [
              {
                source: projectSource,
                target: {
                  ...identity,
                  manifestDigest: digest("named-manifest"),
                  implementationDigest: digest("named-implementation"),
                  contributionId: "studio",
                  action: "image.query",
                  ...options.historicalTarget,
                },
              },
            ],
          },
        }
      : undefined;
  const approval = {
    schemaVersion:
      options.historical === true
        ? "crewon.desktop-plugin-approval.v3"
        : "crewon.desktop-plugin-approval.v1",
    sources,
    publications,
    ...(projects === undefined ? {} : { projects }),
  };
  const approvalPath = join(directory, "plugin-approvals.json"),
    profilePath = join(directory, "plugin-profile.json"),
    policyPath = join(directory, "plugin-native-policy.json");
  writeFileSync(approvalPath, JSON.stringify(approval), { mode: 0o600 });
  writeFileSync(
    profilePath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-plugin-profile.v1",
      actor,
      scope,
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-native-plugin-policy.v1",
      packages: identities.map((value) => ({
        ...value,
        approvalRequirement: "none",
      })),
      networkGrants: [],
    }),
    { mode: 0o600 },
  );
  const bootstrap = {
      schemaVersion:
        options.historical === true
          ? "crewon.desktop-plugin-bootstrap.v3"
          : "crewon.desktop-plugin-bootstrap.v1",
      actor,
      scope,
      authorityEpoch: "native-control-original-epoch-00000001",
      installRoot,
      sources,
      publications,
      ...(projects === undefined ? {} : { projects }),
    },
    bytes = Buffer.from(JSON.stringify(bootstrap)),
    bootstrapPath = join(
      directory,
      `plugin-bootstrap-${createHash("sha256").update(bytes).digest("hex")}.json`,
    );
  writeFileSync(bootstrapPath, bytes, { mode: 0o600 });
  const databasePath = join(directory, "control.sqlite"),
    db = new DatabaseSync(databasePath);
  db.close();
  chmodSync(databasePath, 0o600);
  const issuedDirectory = join(directory, ".native-plugin-authority-test");
  mkdirSync(issuedDirectory, { mode: 0o700 });
  const controlDirectory = join(
    directory,
    ".installed-plugin-preparation-test",
  );
  mkdirSync(controlDirectory, { mode: 0o700 });
  const authorityPath = join(issuedDirectory, "authority.json"),
    controlPath = join(controlDirectory, "native-control.json");
  const authority = {
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: "named-native-control-authority",
    actor,
    scope,
    installRoot,
    controlDatabasePath: databasePath,
    bootstrapPath,
    bootstrapDigest: digest(readFileSync(bootstrapPath)),
    approvalPath,
    approvalDigest: digest(readFileSync(approvalPath)),
    profilePath,
    profileDigest: digest(readFileSync(profilePath)),
    policyPath,
    policyDigest: digest(readFileSync(policyPath)),
    packages: identities,
    networkGrants: [],
  };
  writeFileSync(authorityPath, JSON.stringify(authority), { mode: 0o600 });
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: preparedIdentity.pluginId,
      pluginVersion: preparedIdentity.version,
      revision: 1,
      manifestDigest: digest("named-manifest"),
      implementationDigest: digest("named-implementation"),
      parameters: {},
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-04T00:00:00.000Z",
    },
    sha,
  );
  const target = {
    executionAuthority: "crewonKernel",
    agentVersionId: "named-existing-release",
    agentVersionContentDigest: digest("named-agent"),
    materializationDigest: digest("named-materialization"),
    authorityId: "named-local-kernel",
    runtimeGeneration: "named-runtime",
    policySnapshotId: "named-policy",
    workspaceBindingId: null,
  };
  const document = {
    schemaVersion: "crewon.desktop-native-plugin-control.v1",
    authorityPath,
    peer: {
      origin: "http://127.0.0.1:3299",
      tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    },
    entries: [
      {
        identity: {
          ...preparedIdentity,
          manifestDigest: configuration.manifestDigest,
          implementationDigest: configuration.implementationDigest,
        },
        configuration,
        configuredTarget: target,
      },
    ],
  };
  writeFileSync(controlPath, JSON.stringify(document), { mode: 0o600 });
  const environment = {
    CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH: controlPath,
    CREWON_DESKTOP_NATIVE_PLUGIN_AUTHORITY_PATH: authorityPath,
    CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "p".repeat(32),
  };
  const input = {
    securityMode: "standalone" as const,
    desktopBootstrapPath: bootstrapPath,
    databasePath,
  };
  const load = () => {
    const value = loadDesktopNativePluginControlEnvironment(environment, input);
    assert.ok(value);
    return value;
  };
  return {
    directory,
    authorityPath,
    controlPath,
    policyPath,
    approvalPath,
    bootstrapPath,
    profilePath,
    databasePath,
    document,
    environment,
    input,
    load,
    configuration,
    bootstrap: await loadDesktopPluginConfiguration(bootstrapPath, { actor }),
  };
}
test(
  "Native startup retains exact authority for approved bootstraps above 64 KiB",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, {
      historical: true,
      retainedSourceCount: 32,
      sourceDirectoryPadding: 2_200,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(f.bootstrap)) > 65_536);
    assert.throws(
      () => extensionCanonicalJson(f.bootstrap),
      /extension_json_limit/u,
    );
    const nativeControl = f.load();
    assert.doesNotThrow(() =>
      assertDesktopNativePluginControlComposition({
        configuration: f.bootstrap,
        nativeControl,
      }),
    );
    const startup = composeDesktopProjectStartup({
      configuration: f.bootstrap,
      actor,
      nativeControl,
    });
    assert.ok(startup.creativeProjects?.historicalQueries);
    assert.doesNotThrow(() =>
      captureDesktopProjectCompositionConfig({
        configuration: f.bootstrap,
        projects: startup.creativeProjects,
        tasks: undefined,
        activation: undefined,
        nativeControl,
      }),
    );
    const registry = await DesktopPluginSourceRegistry.create(f.bootstrap);
    const authority = new DesktopPluginAuthority(f.bootstrap);
    const store = new SqliteRunStore(f.databasePath);
    await store.pluginInstallationStore().migrate();
    const installation = await createDesktopPluginInstallationRuntime(
      { configuration: f.bootstrap, registry, authority },
      {
        store,
        clock: { now: () => "2026-10-09T00:00:00.000Z" },
        digester: sha,
      },
    );
    try {
      assert.doesNotThrow(() =>
        assertDesktopPluginInstallationRuntime(installation, {
          configuration: f.bootstrap,
          registry,
          authority,
          store,
        }),
      );
      assert.throws(
        () =>
          assertDesktopPluginInstallationRuntime(installation, {
            configuration: {
              ...f.bootstrap,
              authorityEpoch: "native-control-altered-epoch-00000001",
            },
            registry,
            authority,
            store,
          }),
        /desktop_plugin_installation_runtime_configuration_mismatch/u,
      );
    } finally {
      await installation.close();
      await authority.close();
      await store.close();
    }
    assert.throws(
      () =>
        assertDesktopNativePluginControlComposition({
          configuration: {
            ...f.bootstrap,
            authorityEpoch: "native-control-altered-epoch-00000001",
          },
          nativeControl,
        }),
      /desktop_native_plugin_control_configuration_invalid/u,
    );
  },
);
test(
  "Native bootstrap canonicalization preserves existing digest bytes",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, { historical: true });
    assert.equal(
      canonicalDesktopPluginConfiguration(f.bootstrap),
      extensionCanonicalJson(f.bootstrap),
    );
  },
);
test(
  "Native task startup accepts prepared historical query ports but rejects declaration drift",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, { historical: true });
    const nativeControl = f.load();
    if (f.bootstrap.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      throw new Error("expected-v3");
    const store = new SqliteRunStore(join(f.directory, "projects.sqlite"));
    try {
      await store.creativeProjectStore().migrate();
      await store.extensionStore().migrate();
      await store.extensionStore().migrateProjectGenerations();
      const prepared = await prepareCreativeProjects(store, {
        pluginUi: f.bootstrap.projects.pluginUi,
        generationReads: f.bootstrap.projects.generationReads,
        generationReadUi: f.bootstrap.projects.generationReadUi,
        historicalQueries: f.bootstrap.projects.historicalQueries,
        authorization: {
          authorize: async () => {
            assert.fail("startup must not execute query authorization");
          },
        },
      });
      assert.ok(prepared?.historicalQueries);
      const input = { configuration: f.bootstrap, nativeControl };
      assert.doesNotThrow(() =>
        assertDesktopNativePluginTaskComposition({
          ...input,
          creativeProjects: prepared,
        }),
      );
      for (const historicalQueries of [
        undefined,
        { ...prepared.historicalQueries, publications: [] },
        {
          ...prepared.historicalQueries,
          version: "foreign" as typeof prepared.historicalQueries.version,
        },
      ]) {
        assert.throws(
          () =>
            assertDesktopNativePluginTaskComposition({
              ...input,
              creativeProjects: { historicalQueries },
            }),
          /desktop_native_project_historical_query_configuration_invalid/u,
        );
      }
    } finally {
      await store.close();
    }
  },
);
test(
  "signed Native historical declarations require their actual approved and prepared full target",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, { historical: true });
    const config = f.load();
    assertDesktopNativePluginControlComposition({
      configuration: f.bootstrap,
      nativeControl: config,
    });
    assert.equal(
      f.bootstrap.schemaVersion,
      "crewon.desktop-plugin-bootstrap.v3",
    );
    if (f.bootstrap.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      throw new Error("expected-v3");
    const publication =
      f.bootstrap.projects.historicalQueries!.publications[0]!;
    assert.equal(
      assertDesktopNativeProjectHistoricalQueryPreparedTarget({
        configuration: f.bootstrap,
        nativeControl: config,
        ...publication,
      }),
      config.publication.entries[0],
    );
    for (const changed of [
      {
        ...publication,
        source: { ...publication.source, contributionId: "foreign" },
      },
      {
        ...publication,
        target: {
          ...publication.target,
          action: "image.generate" as "image.query",
        },
      },
    ]) {
      assert.throws(() =>
        assertDesktopNativeProjectHistoricalQueryPreparedTarget({
          configuration: f.bootstrap,
          nativeControl: config,
          ...changed,
        }),
      );
    }
    assert.throws(() =>
      assertDesktopNativePluginControlComposition({
        configuration: f.bootstrap,
        nativeControl: { ...config },
      }),
    );
    // Main's existing withdrawal marker revokes the private owner immediately.
    writeFileSync(join(dirname(f.authorityPath), "withdrawn.json"), "{}", {
      mode: 0o600,
    });
    assert.throws(() =>
      assertDesktopNativePluginControlComposition({
        configuration: f.bootstrap,
        nativeControl: config,
      }),
    );
  },
);
test(
  "a signed query-only declaration without a prepared target preserves base Control but per-query validation refuses",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, {
        historical: true,
        preparedHistoricalTarget: false,
      }),
      config = f.load();
    assertDesktopNativePluginControlComposition({
      configuration: f.bootstrap,
      nativeControl: config,
    });
    if (f.bootstrap.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      throw new Error("expected-v3");
    const publication =
      f.bootstrap.projects.historicalQueries!.publications[0]!;
    assert.throws(
      () =>
        assertDesktopNativeProjectHistoricalQueryPreparedTarget({
          configuration: f.bootstrap,
          nativeControl: config,
          ...publication,
        }),
      /target_unavailable/,
    );
  },
);
test(
  "syntactically valid historical targets cannot lend absent Node approval or a different implementation",
  nativeOnly,
  async (t) => {
    for (const historicalTarget of [
      { pluginId: "example.foreign" },
      { manifestDigest: digest("foreign-manifest") },
      { packageDigest: digest("foreign-package") },
    ]) {
      const f = await fixture(t, { historical: true, historicalTarget });
      const config = f.load();
      assert.throws(
        () =>
          assertDesktopNativePluginControlComposition({
            configuration: f.bootstrap,
            nativeControl: config,
          }),
        /desktop_native_project_historical_query_configuration_invalid/,
      );
    }
  },
);
test(
  "explicit Native Control source pins the original owner, database, configuration, peer and policy, without remote credentials",
  nativeOnly,
  async (t) => {
    const f = await fixture(t),
      config = f.load();
    assertDesktopNativePluginControlComposition({
      configuration: f.bootstrap,
      nativeControl: config,
    });
    assert.equal(
      config.publication.entries[0]?.configuration.contentDigest,
      f.configuration.contentDigest,
    );
    assert.equal(
      config.authority.authorityId,
      "named-native-control-authority",
    );
    assert.ok(!JSON.stringify(config).includes("p".repeat(32)));
    assert.throws(() =>
      assertDesktopNativePluginControlConfigCurrent({ ...config }),
    );
    assert.throws(() =>
      assertDesktopNativePluginControlComposition({
        configuration: {
          ...f.bootstrap,
          authorityEpoch: "foreign-original-epoch-000000000",
        },
        nativeControl: config,
      }),
    );
    const policy = new DesktopNativePluginActivationAuthority(config);
    assert.deepEqual(
      await policy.decide(
        { actor, pluginId: "example.image" },
        new AbortController().signal,
      ),
      { outcome: "allow" },
    );
    await assert.rejects(() =>
      policy.decide(
        {
          actor: { ...actor, principalId: "foreign" },
          pluginId: "example.image",
        },
        new AbortController().signal,
      ),
    );
    await assert.rejects(() =>
      policy.decide(
        { actor, pluginId: "example.foreign" },
        new AbortController().signal,
      ),
    );
    await policy.close();
    await assert.rejects(() =>
      policy.decide(
        { actor, pluginId: "example.image" },
        new AbortController().signal,
      ),
    );
  },
);
test(
  "no Native opt-in reads no files or environment accessors; explicit input rejects aliases, production, foreign DB and token getters",
  nativeOnly,
  async (t) => {
    let calls = 0;
    const absent = {};
    Object.defineProperty(
      absent,
      "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
      {
        get() {
          calls++;
          throw new Error("getter");
        },
      },
    );
    assert.equal(
      loadDesktopNativePluginControlEnvironment(absent, {
        securityMode: "standalone",
      }),
      undefined,
    );
    assert.equal(calls, 0);
    const f = await fixture(t);
    for (const input of [
      { ...f.input, securityMode: "production" as const },
      { ...f.input, databasePath: join(f.directory, "other.sqlite") },
      { ...f.input, desktopBootstrapPath: f.approvalPath },
    ])
      assert.throws(() =>
        loadDesktopNativePluginControlEnvironment(f.environment, input),
      );
    const environment = { ...f.environment };
    Object.defineProperty(
      environment,
      "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
      {
        get() {
          calls++;
          return "p".repeat(32);
        },
      },
    );
    assert.throws(() =>
      loadDesktopNativePluginControlEnvironment(environment, f.input),
    );
    assert.equal(calls, 0);
    for (const patch of [
      { peer: { ...f.document.peer, origin: "https://127.0.0.1:3299" } },
      { peer: { ...f.document.peer, tokenEnvironmentVariable: "OTHER_TOKEN" } },
      {
        entries: [
          {
            ...f.document.entries[0],
            identity: {
              ...f.document.entries[0]!.identity,
              packageDigest: digest("foreign"),
            },
          },
        ],
      },
      { schemaVersion: "crewon.desktop-installed-plugin-activation.v1" },
      { unexpected: true },
    ]) {
      writeFileSync(f.controlPath, JSON.stringify({ ...f.document, ...patch }));
      assert.throws(() => f.load());
    }
  },
);
test(
  "Native policy withdrawal and each original approval/profile/bootstrap file replacement invalidate an existing Control owner",
  nativeOnly,
  async (t) => {
    for (const key of [
      "policyPath",
      "approvalPath",
      "profilePath",
      "bootstrapPath",
    ] as const) {
      const f = await fixture(t),
        config = f.load(),
        path = f[key],
        bytes = readFileSync(path);
      writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
      assert.throws(() =>
        assertDesktopNativePluginControlConfigCurrent(config),
      );
    }
    const f = await fixture(t),
      config = f.load();
    renameSync(f.databasePath, `${f.databasePath}.old`);
    const db = new DatabaseSync(f.databasePath);
    db.close();
    assert.throws(() => assertDesktopNativePluginControlConfigCurrent(config));
  },
);
test(
  "Native Control rejects shared-readable private documents and hardlink authorities before lending a peer",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    chmodSync(f.controlPath, 0o644);
    assert.throws(() => f.load());
    const linked = await fixture(t);
    linkSync(
      linked.authorityPath,
      join(linked.directory, "authority-hardlink.json"),
    );
    assert.throws(() => linked.load());
  },
);
test(
  "Main's sibling withdrawal marker immediately revokes an already captured Native Control owner without reading its contents",
  nativeOnly,
  async (t) => {
    const f = await fixture(t),
      config = f.load(),
      policy = new DesktopNativePluginActivationAuthority(config);
    assert.deepEqual(
      await policy.decide(
        { actor, pluginId: "example.image" },
        new AbortController().signal,
      ),
      { outcome: "allow" },
    );
    const marker = join(dirname(f.authorityPath), "withdrawn.json");
    writeFileSync(marker, "invalid JSON: contents carry no permission", {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(marker, 0o000);
    assert.throws(
      () => assertDesktopNativePluginControlConfigCurrent(config),
      /withdrawn/,
    );
    assert.throws(() => f.load());
    await assert.rejects(
      () =>
        policy.decide(
          { actor, pluginId: "example.image" },
          new AbortController().signal,
        ),
      /withdrawn/,
    );
    unlinkSync(marker);
    assert.throws(
      () => assertDesktopNativePluginControlConfigCurrent(config),
      /withdrawn/,
    );
    await assert.rejects(
      () =>
        policy.decide(
          { actor, pluginId: "example.image" },
          new AbortController().signal,
        ),
      /withdrawn/,
    );
    await policy.close();
  },
);
