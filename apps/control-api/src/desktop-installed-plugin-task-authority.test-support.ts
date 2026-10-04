import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type {
  ActorContext,
  AuthorizationPort,
  ExtensionCreditQuotePort,
  PluginUiAuthorizationPort,
} from "@crewon/application";
import {
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  parseInstalledPluginPeerRequest,
  type InstalledPluginPeerRequest,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  createExtensionRunBinding,
  extensionCanonicalJson,
} from "@crewon/domain";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import {
  createDesktopPluginConfigurationRuntime,
  type DesktopPluginConfigurationRuntime,
} from "./desktop-plugin-configuration-runtime.ts";
import {
  createDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { DesktopInstalledPluginActivationOwner } from "./desktop-installed-plugin-activation-owner.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_ENV,
  loadDesktopInstalledPluginActivationEnvironment,
  parseDesktopInstalledPluginActivationConfig,
} from "./desktop-installed-plugin-activation-environment.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  loadDesktopInstalledPluginTaskEnvironment,
  parseDesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import { DesktopInstalledPluginTaskAuthority } from "./desktop-installed-plugin-task-authority.ts";
import {
  nativeConfigurationActor as actor,
  nativeConfigurationScope as scope,
  nativeConfigurationManifest as manifest,
  nativeConfigurationSave as save,
} from "./desktop-plugin-configuration.test-support.ts";
import { activationTarget as target } from "./desktop-installed-plugin-activation.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

export { actor, scope, target };
export const nativeTaskDigester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});
export const nativeTaskQuote = Object.freeze({
  poolId: "named-synthetic-native-authority-personal-pool",
  priceRevision: 17,
  quotedCredits: "9007199254740993",
});
export function nativeTaskDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type PolicyRole = "task" | "ui" | "package" | "quote" | "activation";
type Call = Readonly<{
  role: PolicyRole;
  input: unknown;
  signal: AbortSignal | undefined;
}>;
type Binding = ConstructorParameters<
  typeof DesktopInstalledPluginTaskAuthority
>[0];
const session = "named-native-task-session-token-0000000000000";
const csrf = "named-native-task-csrf-token-000000000000000";
const environment = Object.freeze({
  CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "p".repeat(32),
  TEST_NATIVE_ACTIVATION_TOKEN: "a".repeat(32),
  TEST_NATIVE_TASK_POLICY_TOKEN: "t".repeat(32),
  TEST_NATIVE_UI_POLICY_TOKEN: "u".repeat(32),
  TEST_NATIVE_PACKAGE_TOKEN: "k".repeat(32),
  TEST_NATIVE_QUOTE_TOKEN: "q".repeat(32),
});
const endpointRoles: Readonly<
  Record<string, Readonly<{ role: PolicyRole; token: string }>>
> = Object.freeze({
  "https://named-native-authority-fixture.example/tasks": {
    role: "task",
    token: environment.TEST_NATIVE_TASK_POLICY_TOKEN,
  },
  "https://named-native-authority-fixture.example/ui": {
    role: "ui",
    token: environment.TEST_NATIVE_UI_POLICY_TOKEN,
  },
  "https://named-native-authority-fixture.example/packages": {
    role: "package",
    token: environment.TEST_NATIVE_PACKAGE_TOKEN,
  },
  "https://named-native-authority-fixture.example/quotes": {
    role: "quote",
    token: environment.TEST_NATIVE_QUOTE_TOKEN,
  },
  "https://named-native-authority-fixture.example/activation": {
    role: "activation",
    token: environment.TEST_NATIVE_ACTIVATION_TOKEN,
  },
});

/** Real installed bytes, Native profile claim, Standalone identity and SQLite. The peer,
 * policies, target, prices and pool are named synthetic boundaries, never a paid provider proof. */
export async function nativeTaskAuthorityFixture(
  t: TestContext,
  options: Readonly<{
    publicationSource?: "private-files" | "programmatic";
    nodeActions?: "task";
  }> = {},
) {
  let store: SqliteRunStore | undefined;
  let installation: DesktopPluginInstallationRuntime | undefined;
  let metadata: DesktopPluginConfigurationRuntime | undefined;
  let installed: DesktopPluginConfigurationRuntime | undefined;
  let activationOwner: DesktopInstalledPluginActivationOwner | undefined;
  let authority: DesktopPluginAuthority | undefined;
  const taskOwners = new Set<DesktopInstalledPluginTaskAuthority>();
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await Promise.allSettled([...taskOwners].map((owner) => owner.close()));
      await installed?.close();
      await metadata?.close();
      await activationOwner?.close();
      await installation?.close();
      await authority?.close();
      await store?.close();
    },
  });
  const directory = join(files.root, "actual-native-task-source");
  await mkdir(directory, { mode: 0o700 });
  const entries = [
    {
      path: "node.mjs",
      bytes: Buffer.from(
        options.nodeActions === "task"
          ? "export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.native-business',setup(context){const tasks=context.services.getOptional('crewon.tasks','1');context.services.provide('test.native-business','1',{actions:[{contributionId:'workbench',action:'image.generate',kind:'generateTask'}],invoke({input,invocationRef}){return tasks.createTask({...input,invocationRef});}});}};"
          : "export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.native-business',setup(){return {dispose(){}};}};",
      ),
    },
    {
      path: "ui.mjs",
      bytes: Buffer.from(
        "export default {apiVersion:'crewon.plugin-ui.v1',mount(){return {update(){},dispose(){}};}};",
      ),
    },
    { path: "business.json", bytes: Buffer.from(JSON.stringify(manifest)) },
  ];
  const descriptor: PluginPackageDescriptor = {
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    hostApi: PLUGIN_PACKAGE_HOST_API,
    pluginId: manifest.pluginId,
    publisherId: "test.native-publisher",
    version: manifest.version,
    title: "Named Native task authority fixture",
    description:
      "Actual installed package; named synthetic peer and policies, no real funding or provider.",
    entrypoints: {
      node: "node.mjs",
      ui: { path: "ui.mjs", mode: "trustedModule" },
    },
    businessManifestPath: "business.json",
    requires: [
      { service: "crewon.execution", apiVersion: "1", optional: true },
      ...(options.nodeActions === "task"
        ? [{ service: "crewon.tasks", apiVersion: "1", optional: true }]
        : []),
    ],
    provides:
      options.nodeActions === "task"
        ? [{ service: manifest.pluginId, apiVersion: "1" }]
        : [],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        slot: "main.content",
        title: "Authority fixture",
      },
    ],
    files: entries.map((entry) => ({
      path: entry.path,
      byteLength: entry.bytes.byteLength,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    })),
  };
  for (const entry of entries)
    await writeFile(join(directory, entry.path), entry.bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const verified = await verifyLocalPluginPackage({ directory });
  const source = {
    sourceId: "actual-native-task-business",
    directory,
    pluginId: descriptor.pluginId,
    publisherId: descriptor.publisherId,
    version: descriptor.version,
    packageDigest: verified.packageDigest,
  };
  const bootstrap = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "named-native-task-authority-owner-epoch-01",
    installRoot: files.installRoot,
    sources: [source],
    publications: [
      {
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
  });
  const bootstrapPath = join(files.root, "native-bootstrap.json");
  const activationPath = join(files.root, "native-activation.json");
  const taskPath = join(files.root, "native-tasks.json");
  await writeFile(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });
  const databasePath = join(files.root, "native-task-authority.sqlite");
  store = new SqliteRunStore(databasePath);
  await store.pluginInstallationStore().migrate();
  const registry = await createDesktopPluginSourceRegistry(bootstrap);
  authority = new DesktopPluginAuthority(bootstrap);
  const nativeAuthority = authority;
  const clock = { now: () => "2026-10-04T00:00:00.000Z" };
  installation = await createDesktopPluginInstallationRuntime(
    { configuration: bootstrap, registry, authority },
    { store, clock, digester: nativeTaskDigester },
  );
  const actualInstallation = installation;
  const identity = new StandaloneIdentity({
    actor,
    sessionToken: session,
    csrfToken: csrf,
    allowedOrigins: ["crewon://desktop"],
  });
  const request = (): ControlApiRequestContext => ({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts/named-native-task/actions",
    remoteAddress: "127.0.0.1",
    headers: {
      "authorization": `Bearer ${session}`,
      "origin": "crewon://desktop",
      "x-csrf-token": csrf,
    },
  });
  await installation.service.install(actor, {
    sourceId: source.sourceId,
    expectedPluginId: source.pluginId,
    expectedPackageDigest: source.packageDigest,
    expectedSelectionRevision: null,
    idempotencyKey: "named-native-task-install",
  });
  metadata = await createDesktopPluginConfigurationRuntime(
    { configuration: bootstrap, registry, authority, installation },
    { store, identity, clock, digester: nativeTaskDigester },
  );
  const metadataOnly = metadata;
  const saved = await metadata.requests.run(
    { request: request(), actor, preparation: "configuration" },
    () =>
      metadataOnly.extensions.saveConfiguration(actor, {
        ...save,
        pluginId: source.pluginId,
        idempotencyKey: "named-native-task-configuration",
      }),
  );
  const configuration = saved.configuration;
  await metadata.close();
  const activationDocument = {
    schemaVersion: "crewon.desktop-installed-plugin-activation.v1",
    actor,
    scope,
    installRoot: files.installRoot,
    peer: {
      origin: "http://127.0.0.1:3299",
      tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    },
    authority: {
      url: "https://named-native-authority-fixture.example/activation",
      serviceTokenEnvironmentVariable: "TEST_NATIVE_ACTIVATION_TOKEN",
    },
    timeoutMs: 30000,
    entries: [
      {
        identity: {
          pluginId: source.pluginId,
          publisherId: source.publisherId,
          version: source.version,
          packageDigest: source.packageDigest,
          manifestDigest: configuration.manifestDigest,
          implementationDigest: configuration.implementationDigest,
        },
        configuration,
        target,
      },
    ],
  };
  await writeFile(activationPath, JSON.stringify(activationDocument), {
    mode: 0o600,
  });
  const activation =
    options.publicationSource === "programmatic"
      ? parseDesktopInstalledPluginActivationConfig(
          activationDocument,
          environment,
        )
      : await loadDesktopInstalledPluginActivationEnvironment(
          {
            ...environment,
            [DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_ENV]: activationPath,
          },
          { securityMode: "standalone", desktopBootstrapPath: bootstrapPath },
        );
  assert.ok(activation);
  const calls: Call[] = [],
    peerCalls: InstalledPluginPeerRequest[] = [];
  const state = {
    responses: {
      task: { outcome: "allow" },
      ui: {
        outcome: "allow",
        authorityEpoch: "named-remote-native-task-ui-epoch",
      },
      package: { outcome: "allow" },
      quote: nativeTaskQuote,
      activation: { outcome: "allow" },
    } as Record<PolicyRole, unknown>,
    before: {} as Partial<
      Record<PolicyRole, (signal: AbortSignal | undefined) => Promise<void>>
    >,
    statuses: {} as Partial<Record<PolicyRole, number>>,
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const destination = String(url);
    const endpoint = endpointRoles[destination];
    if (endpoint) {
      assert.equal(init?.cache, "no-store");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${endpoint.token}`,
      );
      const input: unknown = JSON.parse(String(init?.body));
      const signal = init?.signal ?? undefined;
      calls.push({ role: endpoint.role, input, signal });
      // The deliberate fixture may ignore signal; actual owner close must still join this fetch.
      await state.before[endpoint.role]?.(signal);
      return Response.json(state.responses[endpoint.role], {
        status: state.statuses[endpoint.role] ?? 200,
      });
    }
    assert.equal(
      destination,
      "http://127.0.0.1:3299/private/v1/installed-plugins",
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${environment.CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN}`,
    );
    const input = parseInstalledPluginPeerRequest(
      JSON.parse(String(init?.body)),
    );
    peerCalls.push(input);
    assert.deepEqual(input.actor, actor);
    assert.deepEqual(input.scope, scope);
    const common = {
      protocol: "crewon.installed-plugin-peer-response.v1",
      requestId: input.requestId,
      operation: input.operation,
      actor,
      scope,
    };
    if (input.operation === "catalog")
      return Response.json({
        ...common,
        entries: [
          {
            identity: activation.publication.entries[0]!.identity,
            manifest,
            configuration,
            configuredTarget: target,
          },
        ],
      });
    if (input.operation === "prepareCandidate") {
      // Exact named synthetic peer echo; actual Worker readiness remains a separate process proof.
      assert.deepEqual(
        input.identity,
        activation.publication.entries[0]!.identity,
      );
      assert.deepEqual(input.configuration, configuration);
      assert.deepEqual(input.expectedTarget, target);
      return Response.json({
        ...common,
        identity: input.identity,
        configurationDigest: input.configuration.contentDigest,
        expectedTarget: input.expectedTarget,
        expectedSelectionRevision: input.expectedSelectionRevision,
        result: { outcome: "ready", target },
      });
    }
    if (input.operation === "readiness")
      return Response.json({
        ...common,
        identity: input.identity,
        configurationDigest: input.configuration.contentDigest,
        expectedTarget: input.expectedTarget,
        result: { outcome: "ready", target },
      });
    throw new Error("named_native_authority_fixture_unexpected_peer_operation");
  };
  activationOwner = new DesktopInstalledPluginActivationOwner(
    {
      configuration: bootstrap,
      activation,
      registry,
      authority,
      installation,
      store,
    },
    { fetch },
  );
  actualInstallation.bindActivation(activationOwner);
  installed = await createDesktopPluginConfigurationRuntime(
    {
      configuration: bootstrap,
      registry,
      authority,
      installation,
      activation: activationOwner,
    },
    { store, identity, clock, digester: nativeTaskDigester },
  );
  const actualInstalled = installed;
  const taskDocument = {
    schemaVersion: "crewon.desktop-installed-plugin-tasks.v1",
    actor,
    scope,
    authorityEpoch: bootstrap.authorityEpoch,
    installRoot: files.installRoot,
    activationDigest: nativeTaskDigester.sha256(
      extensionCanonicalJson(activation.publication),
    ),
    uiPublications: [
      {
        pluginId: source.pluginId,
        packageDigest: source.packageDigest,
        contributionId: "workbench",
      },
    ],
    taskPolicyAuthority: {
      url: "https://named-native-authority-fixture.example/tasks",
      serviceTokenEnvironmentVariable: "TEST_NATIVE_TASK_POLICY_TOKEN",
    },
    uiPolicyAuthority: {
      url: "https://named-native-authority-fixture.example/ui",
      serviceTokenEnvironmentVariable: "TEST_NATIVE_UI_POLICY_TOKEN",
    },
    packageAuthority: {
      url: "https://named-native-authority-fixture.example/packages",
      serviceTokenEnvironmentVariable: "TEST_NATIVE_PACKAGE_TOKEN",
    },
    quoteAuthority: {
      url: "https://named-native-authority-fixture.example/quotes",
      serviceTokenEnvironmentVariable: "TEST_NATIVE_QUOTE_TOKEN",
    },
    timeoutMs: 30000,
    maximumPackages: 8,
  };
  await writeFile(taskPath, JSON.stringify(taskDocument), { mode: 0o600 });
  const tasks =
    options.publicationSource === "programmatic"
      ? parseDesktopInstalledPluginTaskConfig(taskDocument, environment)
      : await loadDesktopInstalledPluginTaskEnvironment(
          {
            ...environment,
            [DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV]: taskPath,
          },
          {
            securityMode: "standalone",
            desktopBootstrapPath: bootstrapPath,
            activationConfigPath: activationPath,
          },
        );
  assert.ok(tasks);
  const binding: Binding = {
    configuration: bootstrap,
    tasks,
    activation,
    activationOwner,
    installed: actualInstalled,
    registry,
    authority,
    installation,
    store,
  };
  const createAuthority = (changes: Partial<Binding> = {}) => {
    const owner = new DesktopInstalledPluginTaskAuthority(
      { ...binding, ...changes },
      { digester: nativeTaskDigester, fetch },
    );
    taskOwners.add(owner);
    return owner;
  };
  const owner = createAuthority();
  const quoteInput: Parameters<ExtensionCreditQuotePort["quoteGeneration"]>[0] =
    {
      actor,
      binding: createExtensionRunBinding(
        {
          schemaVersion: "crewon.extension-run-binding.v0",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId: source.pluginId,
          actorId: actor.actorId,
          runId: "named-native-task-run",
          threadId: "named-native-task-thread",
          configurationRevision: configuration.revision,
          configurationDigest: configuration.contentDigest,
          inputDigest: nativeTaskDigester.sha256(
            extensionCanonicalJson({
              organization: "Named synthetic quote input",
            }),
          ),
          source: null,
          target,
        },
        nativeTaskDigester,
      ),
      input: { organization: "Named synthetic quote input" },
      commandRequestDigest: nativeTaskDigester.sha256(
        "named-original-native-task-command",
      ),
    };
  const businessRequest: Parameters<AuthorizationPort["authorize"]>[0] = {
    actor,
    action: "extension:run",
    resource: {
      kind: "extension",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: source.pluginId,
    },
  };
  const uiRequest: Parameters<PluginUiAuthorizationPort["authorize"]>[0] = {
    actor,
    action: "mount",
    resource: {
      kind: "pluginUi",
      ...scope,
      pluginId: source.pluginId,
      packageDigest: source.packageDigest,
      selectionRevision: 1,
      contributionId: "workbench",
    },
  };
  const packageRequest: Parameters<
    DesktopInstalledPluginTaskAuthority["authorizePackage"]
  >[0] = {
    actor,
    scope,
    candidate: {
      descriptor: verified.descriptor,
      packageDigest: source.packageDigest,
    },
    purpose: "submit",
  };
  const run = <T>(
    work: () => Promise<T>,
    input: Readonly<{
      preparation?: "execution" | "configuration";
      request?: ControlApiRequestContext;
      actor?: ActorContext;
      signal?: AbortSignal;
    }> = {},
  ) =>
    actualInstalled.requests.run(
      {
        request: input.request ?? request(),
        actor: input.actor ?? actor,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.preparation === "execution"
          ? {}
          : { preparation: "configuration" as const }),
      },
      work,
    );
  async function replaceProfileLock() {
    const lockRoot = databasePath + ".plugin-profile-locks";
    const names = (await readdir(lockRoot)).filter((path) =>
      path.endsWith(".sqlite"),
    );
    assert.equal(names.length, 1);
    const path = join(lockRoot, names[0]!);
    await rename(
      path,
      join(files.root, "original-held-native-task-profile.sqlite"),
    );
    const replacement = new DatabaseSync(path);
    replacement.close();
    await chmod(path, 0o600);
  }
  let deployment: Promise<void> | undefined;
  /** Real persisted asset/release assembly for the named fixture target; no policy, funds or live provider are supplied. */
  function seedDeployment(): Promise<void> {
    return (deployment ??= (async () => {
      await binding.store.registerAgentVersion({
        schemaVersion: "crewon.agent-version-asset.v0",
        tenantId: actor.tenantId,
        agentVersionId: target.agentVersionId,
        contentDigest: target.agentVersionContentDigest,
        createdAt: clock.now(),
        definitionJson: JSON.stringify({
          schemaVersion: "crewon.agent-version.v0",
          agentVersionId: target.agentVersionId,
          runtimeGeneration: target.runtimeGeneration,
          policySnapshotId: target.policySnapshotId,
        }),
      });
      const releaseId = nativeTaskDigester.sha256(
        "named-native-factory-release-fixture",
      );
      await binding.store.activateAgentVersionRelease({
        bundle: {
          schemaVersion: "crewon.agent-version-release-bundle.v0",
          tenantId: actor.tenantId,
          releaseId,
          manifestDigest: releaseId,
          defaultAgentVersionId: target.agentVersionId,
          deployments: [
            {
              schemaVersion: "crewon.agent-version-deployment.v0",
              tenantId: actor.tenantId,
              agentVersionId: target.agentVersionId,
              contentDigest: target.agentVersionContentDigest,
              materializationDigest: target.materializationDigest,
              authorityId: target.authorityId,
              workspaceBindingId: target.workspaceBindingId,
            },
          ],
        },
        activation: {
          schemaVersion: "crewon.agent-version-release-activation.v0",
          tenantId: actor.tenantId,
          releaseId,
          activationId: "named-native-factory-release-activation",
          previousReleaseId: null,
          operator: {
            principalId: actor.principalId,
            actorId: actor.actorId,
            spaceId: actor.spaceId,
          },
          activatedAt: clock.now(),
        },
        expectedActiveReleaseId: null,
      });
    })());
  }
  return {
    ...files,
    databasePath,
    bootstrapPath,
    activationPath,
    taskPath,
    source,
    descriptor: verified.descriptor,
    configuration,
    store,
    identity,
    registry,
    authority: nativeAuthority,
    installation: actualInstallation,
    installed: actualInstalled,
    metadataOnly,
    activation,
    activationOwner,
    binding,
    owner,
    createAuthority,
    taskDocument,
    activationDocument,
    environment,
    state,
    calls,
    peerCalls,
    request,
    run,
    businessRequest,
    uiRequest,
    packageRequest,
    quoteInput,
    replaceProfileLock,
    seedDeployment,
    clock,
    fetch,
  };
}
