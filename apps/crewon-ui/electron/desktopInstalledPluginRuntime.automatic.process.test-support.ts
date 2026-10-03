import assert from "node:assert/strict";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  parseGetPluginSelectionResponse,
  parsePluginInstallationResponse,
} from "@crewon/contracts";
import {
  parseExtensionConfiguration,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import {
  installedPluginReleaseDigester as digester,
  readInstalledPluginReleaseDocument,
} from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import { DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeInstalledProcessFixture,
  nativeProcessFacts,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";
import type { ControlRuntimeSession } from "./runtimeSupervisor.ts";

export const automaticPreparationPrefix = ".installed-plugin-preparation-";
type Fixture = Awaited<ReturnType<typeof nativeInstalledProcessFixture>>;

/** Installs and configures through actual Native management HTTP; no Agent is
 * published here and no operator release document is compiled by the fixture. */
export async function nativeAutomaticProcessFixture(packageDirectory: string) {
  const f = await nativeInstalledProcessFixture(
    await realpath(packageDirectory),
  );
  try {
    const source = f.sources[0]!;
    const management = f.supervisor(false);
    await management.start();
    const session = management.session();
    assert.equal(
      (await nativeProcessHttp(session, "GET", "/api/v1/health/ready")).status,
      503,
    );
    const request = {
      sourceId: source.sourceId,
      expectedPluginId: source.pluginId,
      expectedPackageDigest: source.packageDigest,
      expectedSelectionRevision: null,
    };
    const install = await nativeProcessHttp(
      session,
      "POST",
      "/api/v1/plugins/installations",
      request,
      "automatic-native-management-install",
    );
    assert.equal(install.status, 200, await install.clone().text());
    const installed = parsePluginInstallationResponse(
      await install.json(),
      request,
    );
    const configuration = await saveAutomaticConfiguration(f, session, 0);
    assert.equal(configuration.revision, 1);
    assert.equal(configuration.createdByActorId, actor.actorId);
    assert.ok(
      Object.values(nativeProcessFacts(f.databasePath).counts).every(
        (count) => count === 0,
      ),
      "management must not publish the default or plugin Agent",
    );
    await f.assertNoNodeImports();
    await management.stop();
    assert.deepEqual(await nativeBootstrapFiles(f.dataDirectory), []);
    const scope = await f.currentProfile();
    assert.ok(scope);
    const worker = f.workerConfiguration(
      join(f.dataDirectory, "unused.json"),
      scope,
    );
    const fixedConfiguration = {
      schemaVersion: "crewon.desktop-installed-plugin-runtime.v2",
      enabled: true,
      providerBinding: {
        providerId: f.provider.providerId,
        endpoint: f.provider.endpoint,
        responsesEndpoint: `${f.provider.endpoint}/responses`,
        modelId: f.provider.modelId,
        credentialRequired: true,
      },
      plugins: [{ pluginId: source.pluginId, approvalRequirement: "none" }],
      workerAuthorities: {
        actorAuthority: worker.actorAuthority,
        profileAuthority: worker.profileAuthority,
        policyAuthority: worker.policyAuthority,
        packageAuthority: worker.packageAuthority,
        networkAuthority: worker.networkAuthority,
        timeoutMs: worker.timeoutMs,
      },
    };
    const fixedPath = join(
      f.dataDirectory,
      DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE,
    );
    await writeFile(fixedPath, JSON.stringify(fixedConfiguration), {
      mode: 0o600,
    });
    assert.deepEqual(
      await automaticPreparationDirectories(f.dataDirectory),
      [],
    );
    const initialChildren = await f.observations();
    assert.equal(initialChildren.length, 1);
    assert.ok(initialChildren[0]!.entry.endsWith("/control-api/src/main.ts"));
    assert.equal(f.requests.length, 0);
    return { ...f, installed, configuration, fixedPath };
  } catch (error) {
    await closeNativeProcessFixture(f, { error });
    throw error;
  }
}

export async function saveAutomaticConfiguration(
  f: Fixture,
  session: ControlRuntimeSession,
  expectedRevision: number,
): Promise<ExtensionConfiguration> {
  const source = f.sources[0]!;
  const response = await nativeProcessHttp(
    session,
    "PUT",
    `/api/v1/extensions/${source.pluginId}/configuration`,
    {
      pluginVersion: source.version,
      expectedRevision,
      parameters: {
        organization: `Native automatic startup revision ${expectedRevision + 1}`,
        providerBaseUrl: `${f.provider.endpoint.split("/v1")[0]}/supplier/`,
      },
      credentialBindings: [],
    },
    `automatic-native-management-configuration-${expectedRevision + 1}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  return parseExtensionConfiguration(value.configuration, digester);
}

export async function automaticPreparationDirectories(dataDirectory: string) {
  return (await readdir(dataDirectory))
    .filter((name) => name.startsWith(automaticPreparationPrefix))
    .sort();
}

/** Read the real Main/CLI output while its private owner is still alive. */
export async function automaticPreparationSnapshot(dataDirectory: string) {
  const directories = await automaticPreparationDirectories(dataDirectory);
  assert.equal(directories.length, 1);
  const directory = join(dataDirectory, directories[0]!);
  const metadata = await lstat(directory);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert.equal(metadata.uid, process.getuid?.());
  assert.equal(metadata.mode & 0o777, 0o700);
  const names = (await readdir(directory)).sort();
  assert.deepEqual(names, ["preparation.json", "release.json", "worker.json"]);
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      const stat = await lstat(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.uid, metadata.uid);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o777, 0o600);
      return { name, ino: stat.ino, bytes: await readFile(path) };
    }),
  );
  const document = readInstalledPluginReleaseDocument(
    join(directory, "release.json"),
  );
  const worker = JSON.parse(
    files.find(({ name }) => name === "worker.json")!.bytes.toString("utf8"),
  );
  assert.equal(worker.releaseDocumentPath, join(directory, "release.json"));
  assert.equal(worker.installRoot, join(dataDirectory, "plugins"));
  assert.equal(worker.schemaVersion, "crewon.installed-plugin-worker.v1");
  assert.equal(worker.networkAuthority, null);
  const preparation = JSON.parse(
    files
      .find(({ name }) => name === "preparation.json")!
      .bytes.toString("utf8"),
  );
  assert.equal(
    preparation.workerConfigurationPath,
    join(directory, "worker.json"),
  );
  assert.deepEqual(preparation.actor, actor);
  assert.deepEqual(preparation.scope, document.entries[0]!.scope);
  assert.deepEqual(preparation.plugins, [
    {
      pluginId: document.entries[0]!.packageIdentity.pluginId,
      approvalRequirement: document.entries[0]!.approvalRequirement,
    },
  ]);
  assert.ok(
    preparation.approvedPackages.some((identity: unknown) =>
      isDeepStrictEqual(identity, document.entries[0]!.packageIdentity),
    ),
  );
  return { directory, ino: metadata.ino, files, document };
}

export async function automaticPublishedSnapshot(
  f: Fixture,
  preparation: Awaited<ReturnType<typeof automaticPreparationSnapshot>>,
  configuration: ExtensionConfiguration,
) {
  const store = new SqliteRunStore(f.databasePath);
  try {
    const document = preparation.document;
    assert.equal(document.entries.length, 1);
    const entry = document.entries[0]!;
    const {
      sourceId: _sourceId,
      directory: _directory,
      ...identity
    } = f.sources[0]!;
    assert.deepEqual(entry.packageIdentity, identity);
    assert.deepEqual(entry.scope, await f.currentProfile());
    assert.deepEqual(entry.configuration, configuration);
    assert.equal(entry.approvalRequirement, "none");
    assert.notEqual(
      entry.version.agentVersionId,
      document.defaultAgentVersionId,
    );
    assert.notEqual(
      entry.modelSource.version.agentVersionId,
      document.defaultAgentVersionId,
    );
    assert.equal(entry.version.model.modelId, f.provider.modelId);
    assert.deepEqual(entry.version.model, entry.modelSource.version.model);
    const provider = entry.modelSource.runtimeBinding.provider;
    assert.equal(provider.kind, "directResponses");
    if (provider.kind !== "directResponses")
      throw new Error("automatic_native_source_provider_missing");
    assert.equal(provider.endpoint, `${f.provider.endpoint}/responses`);
    assert.equal(provider.apiKeyEnvironment, "CREWON_MODEL_API_KEY");
    assert.equal(
      entry.modelSource.runtimeBinding.toolRuntimeMode,
      "independent",
    );
    assert.deepEqual(entry.modelSource.version.tools, []);
    const active = await store.loadActiveAgentVersionRelease({
      tenantId: actor.tenantId,
    });
    assert.ok(active);
    assert.equal(
      active.bundle.defaultAgentVersionId,
      document.defaultAgentVersionId,
    );
    assert.deepEqual(active.activation.operator, {
      principalId: actor.principalId,
      actorId: actor.actorId,
      spaceId: actor.spaceId,
    });
    const assets = await Promise.all(
      active.bundle.deployments.map(async (deployment) => {
        const asset = await store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: deployment.agentVersionId,
        });
        assert.ok(asset);
        const current = await store.loadAgentVersionDeployment({
          tenantId: actor.tenantId,
          agentVersionId: deployment.agentVersionId,
        });
        assert.ok(current);
        const { deployedAt: _time, ...candidate } = current;
        assert.deepEqual(candidate, deployment);
        return {
          asset,
          deployment: current,
          compiled: parseAgentVersionAsset(asset, digester),
        };
      }),
    );
    for (const version of [entry.modelSource.version, entry.version])
      assert.deepEqual(
        assets.find(
          ({ compiled }) => compiled.agentVersionId === version.agentVersionId,
        )?.compiled,
        version,
      );
    const sourceDeployment = assets.find(
      ({ compiled }) =>
        compiled.agentVersionId === entry.modelSource.version.agentVersionId,
    )!.deployment;
    const { deployedAt: _sourceTime, ...sourceCandidate } = sourceDeployment;
    assert.deepEqual(sourceCandidate, entry.modelSource.deployment);
    const derivedDeployment = assets.find(
      ({ compiled }) =>
        compiled.agentVersionId === entry.version.agentVersionId,
    )!.deployment;
    assert.equal(
      derivedDeployment.materializationDigest,
      entry.target.materializationDigest,
    );
    assert.equal(derivedDeployment.authorityId, entry.target.authorityId);
    assert.equal(
      derivedDeployment.workspaceBindingId,
      entry.target.workspaceBindingId,
    );
    const original = assets.find(
      ({ compiled }) =>
        compiled.agentVersionId === document.defaultAgentVersionId,
    );
    assert.ok(original);
    assert.equal(original.compiled.model.modelId, f.provider.modelId);
    assert.deepEqual(original.compiled.model, entry.modelSource.version.model);
    assert.equal(
      original.compiled.instructions,
      entry.modelSource.version.instructions,
    );
    return { active, assets, entry, original };
  } finally {
    await store.close();
  }
}

export async function assertAutomaticHistoricalPublication(
  f: Fixture,
  previous: Awaited<ReturnType<typeof automaticPublishedSnapshot>>,
) {
  const store = new SqliteRunStore(f.databasePath);
  try {
    assert.deepEqual(
      await store.loadAgentVersionReleaseBundle({
        tenantId: actor.tenantId,
        releaseId: previous.active.bundle.releaseId,
      }),
      previous.active.bundle,
    );
    for (const { asset, deployment } of previous.assets) {
      assert.deepEqual(
        await store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: asset.agentVersionId,
        }),
        asset,
      );
      assert.deepEqual(
        await store.loadAgentVersionDeployment({
          tenantId: actor.tenantId,
          agentVersionId: asset.agentVersionId,
        }),
        deployment,
      );
    }
  } finally {
    await store.close();
  }
}

export async function assertAutomaticManagementOnly(
  f: Fixture,
  session: ControlRuntimeSession,
  selection: Awaited<
    ReturnType<typeof nativeAutomaticProcessFixture>
  >["installed"]["selection"],
  configuration: ExtensionConfiguration,
) {
  const pluginId = f.sources[0]!.pluginId;
  const read = await nativeProcessHttp(
    session,
    "GET",
    `/api/v1/plugins/selections/${pluginId}`,
  );
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual(
    parseGetPluginSelectionResponse(await read.json(), { pluginId }).selection,
    selection,
  );
  const saved = await nativeProcessHttp(
    session,
    "GET",
    `/api/v1/extensions/${pluginId}/configuration?revision=${configuration.revision}`,
  );
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual((await saved.json()).configuration, configuration);
  for (const intent of [
    { kind: "generate", input: { subject: "must remain unavailable" } },
    { kind: "query", sourceRunId: randomUUID(), operationId: randomUUID() },
  ]) {
    const response = await nativeProcessHttp(
      session,
      "POST",
      `/api/v1/extensions/${pluginId}/tasks`,
      {
        threadId: randomUUID(),
        expectedThreadRevision: 1,
        intent,
      },
      `automatic-native-no-task-${intent.kind}`,
    );
    assert.equal(response.status, 404, await response.clone().text());
    assert.equal((await response.json()).error.code, "route_not_found");
  }
  await assertAutomaticNoExecution(f);
}

export async function assertAutomaticNoExecution(f: Fixture) {
  await f.assertNoNodeImports();
  const facts = nativeProcessFacts(f.databasePath);
  for (const [table, count] of Object.entries(facts.counts))
    if (!/^(?:agent_version|active_agent_version)/u.test(table))
      assert.equal(count, 0, table);
  assert.equal(
    facts.tables.some((table) => /credit|quote|charge/u.test(table)),
    false,
  );
  assert.equal(f.modelRequests(), 0);
  assert.equal(f.supplierRequests(), 0);
}
