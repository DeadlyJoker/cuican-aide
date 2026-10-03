import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SqliteRunStore } from "@crewon/store";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { expect, it } from "vitest";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { prepareNativeInstalledProcessRelease } from "./desktopInstalledPluginRuntime.release.test-support.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeInstalledProcessFixture,
  nativeProcessFacts,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;

it.runIf(packageDirectory !== undefined)(
  "actual Native Supervisor publishes operator inputs from a disabled HTTP-configured package, challenges its Worker and cold-reopens SQLite without execution or funds",
  async () => {
    const f = await nativeInstalledProcessFixture(
      await realpath(packageDirectory!),
    );
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      const source = f.sources[0]!;
      const {
        sourceId: _sourceId,
        directory: _directory,
        ...identity
      } = source;
      const management = f.supervisor(false);
      await management.start();
      const session = management.session();
      expect(
        (await nativeProcessHttp(session, "GET", "/api/v1/health/live")).status,
      ).toBe(200);
      expect(
        (await nativeProcessHttp(session, "GET", "/api/v1/health/ready"))
          .status,
      ).toBe(503);
      const installation = await nativeProcessHttp(
        session,
        "POST",
        "/api/v1/plugins/installations",
        {
          sourceId: source.sourceId,
          expectedPluginId: source.pluginId,
          expectedPackageDigest: source.packageDigest,
          expectedSelectionRevision: null,
        },
        "actual-native-runtime-install",
      );
      expect(installation.status, await installation.clone().text()).toBe(200);
      const installed = await installation.json();
      expect(installed.selection.state).toBe("disabled");
      expect(installed.selection.selectedPackageDigest).toBe(
        source.packageDigest,
      );
      const parameters = {
        organization: "Native source process acceptance",
        providerBaseUrl: `${f.provider.endpoint.split("/v1")[0]}/supplier/`,
      };
      const save = await nativeProcessHttp(
        session,
        "PUT",
        `/api/v1/extensions/${source.pluginId}/configuration`,
        {
          pluginVersion: source.version,
          expectedRevision: 0,
          parameters,
          credentialBindings: [],
        },
        "actual-native-runtime-configuration",
      );
      expect(save.status, await save.clone().text()).toBe(200);
      const saved = (await save.json()).configuration;
      expect(saved.revision).toBe(1);
      expect(saved.createdByActorId).toBe(actor.actorId);
      expect(saved.parameters).toEqual(parameters);
      expect(
        Object.values(nativeProcessFacts(f.databasePath).counts).every(
          (count) => count === 0,
        ),
      ).toBe(true);
      await f.assertNoNodeImports();
      await management.stop();
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);

      // Actual ordinary startup publishes the original default prerequisite. The fixture
      // does not directly publish assets, deployments or any activation.
      const ordinary = f.supervisor(true);
      await ordinary.start();
      expect(
        (
          await nativeProcessHttp(
            ordinary.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
      ).toBe(200);
      await ordinary.stop();
      const ordinaryChildren = await f.observations();
      expect(
        ordinaryChildren.some((row) =>
          row.entry.endsWith("/runtime-worker/src/release-main.ts"),
        ),
      ).toBe(true);
      expect(
        ordinaryChildren.some((row) =>
          row.entry.endsWith("/runtime-worker/src/main.ts"),
        ),
      ).toBe(true);
      expect(ordinaryChildren.every((row) => !row.installed && !row.peer)).toBe(
        true,
      );
      expect(f.requests).toEqual([]);
      const scope = await f.currentProfile();
      assert.ok(scope);
      const prepared = await prepareNativeInstalledProcessRelease({
        dataDirectory: f.dataDirectory,
        scope,
        identity,
        configuration: saved,
        environment: await f.releaseEnvironment(),
      });
      const workerPath = join(f.dataDirectory, "native-installed-worker.json");
      await writeFile(
        workerPath,
        JSON.stringify(f.workerConfiguration(prepared.path, scope)),
        { mode: 0o600 },
      );
      await writeFile(
        join(f.dataDirectory, DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE),
        JSON.stringify({
          schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
          enabled: true,
          workerConfigurationPath: workerPath,
          providerBinding: {
            providerId: f.provider.providerId,
            endpoint: f.provider.endpoint,
            responsesEndpoint: `${f.provider.endpoint}/responses`,
            modelId: f.provider.modelId,
            credentialRequired: true,
          },
        }),
        { mode: 0o600 },
      );
      const originalDocument = await readFile(prepared.path);
      const installedRuntime = f.supervisor(true);
      await installedRuntime.start();
      const runningSession = installedRuntime.session();
      expect(
        (await nativeProcessHttp(runningSession, "GET", "/api/v1/health/ready"))
          .status,
      ).toBe(200);
      await assertPublished(f.databasePath, prepared);
      expect(
        f.requests.some(
          ({ path, body }) => path === "/package" && body.purpose === "read",
        ),
      ).toBe(true);
      expect(f.requests.some(({ path }) => path === "/actor")).toBe(true);
      expect(f.requests.some(({ path }) => path === "/profile")).toBe(true);
      expect(
        f.requests
          .filter(({ path }) => path === "/package")
          .every(
            ({ body }) =>
              body.purpose === "read" &&
              isDeepStrictEqual(body.identity, identity),
          ),
      ).toBe(true);
      const currentChildren = (await f.observations()).slice(
        ordinaryChildren.length,
      );
      expect(
        currentChildren
          .filter((row) => row.entry.includes("/runtime-worker/"))
          .every((row) => row.installed && row.authorityTokenPresent),
      ).toBe(true);
      expect(
        currentChildren.some(
          (row) =>
            row.entry.endsWith("/runtime-worker/src/main.ts") && row.peer,
        ),
      ).toBe(true);
      expect(
        currentChildren.some(
          (row) =>
            row.entry.endsWith("/control-api/src/main.ts") &&
            row.nativeBootstrap &&
            !row.installed &&
            !row.peer &&
            !row.authorityTokenPresent,
        ),
      ).toBe(true);
      const generate = await nativeProcessHttp(
        runningSession,
        "POST",
        `/api/v1/extensions/${source.pluginId}/tasks`,
        {
          threadId: "uncreated-native-thread",
          expectedThreadRevision: 1,
          intent: {
            kind: "generate",
            input: { subject: "Must remain unavailable" },
          },
        },
        "native-runtime-has-no-task-admission",
      );
      expect(generate.status).toBe(404);
      expect((await generate.json()).error.code).toBe("route_not_found");
      const query = await nativeProcessHttp(
        runningSession,
        "POST",
        `/api/v1/extensions/${source.pluginId}/tasks`,
        {
          threadId: randomUUID(),
          expectedThreadRevision: 1,
          intent: {
            kind: "query",
            sourceRunId: randomUUID(),
            operationId: randomUUID(),
          },
        },
        "native-runtime-has-no-query-admission",
      );
      expect(query.status).toBe(404);
      expect((await query.json()).error.code).toBe("route_not_found");
      const selections = await nativeProcessHttp(
        runningSession,
        "GET",
        "/api/v1/plugins/selections",
      );
      expect(selections.status, await selections.clone().text()).toBe(200);
      expect((await selections.json()).selections).toEqual([
        installed.selection,
      ]);
      const read = await nativeProcessHttp(
        runningSession,
        "GET",
        `/api/v1/extensions/${source.pluginId}/configuration?revision=1`,
      );
      expect(read.status).toBe(200);
      expect((await read.json()).configuration).toEqual(saved);
      const beforeRestart = nativeProcessFacts(f.databasePath);
      await installedRuntime.stop();
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
      await rename(source.directory, `${source.directory}-offline`);
      const requestCount = f.requests.length;
      const cold = f.supervisor(true);
      await cold.start();
      expect(
        (await nativeProcessHttp(cold.session(), "GET", "/api/v1/health/ready"))
          .status,
      ).toBe(200);
      await assertPublished(f.databasePath, prepared);
      expect(f.requests.length).toBeGreaterThan(requestCount);
      expect(await readFile(prepared.path)).toEqual(originalDocument);
      expect(
        (
          await (
            await nativeProcessHttp(
              cold.session(),
              "GET",
              `/api/v1/extensions/${source.pluginId}/configuration?revision=1`,
            )
          ).json()
        ).configuration,
      ).toEqual(saved);
      for (const table of [
        "agent_versions",
        "agent_version_deployments",
        "agent_version_release_bundles",
      ])
        expect(nativeProcessFacts(f.databasePath).counts[table]).toBe(
          beforeRestart.counts[table],
        );
      await f.assertNoNodeImports();
      assertNoBusinessRows(nativeProcessFacts(f.databasePath));
      expect(f.modelRequests()).toBe(0);
      expect(f.supplierRequests()).toBe(0);
      await cold.stop();
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
      const beforeDenial = nativeProcessFacts(f.databasePath);
      const beforeDeniedChildren = (await f.observations()).length;
      f.denyPackages();
      const refused = f.supervisor(true);
      await expect(refused.start()).rejects.toThrow(/Runtime release failed/u);
      expect(() => refused.session()).toThrow("control_runtime_unavailable");
      expect(nativeProcessFacts(f.databasePath)).toEqual(beforeDenial);
      expect(
        (await f.observations())
          .slice(beforeDeniedChildren)
          .some(
            (row) =>
              row.entry.endsWith("/control-api/src/main.ts") ||
              row.entry.endsWith("/runtime-worker/src/main.ts"),
          ),
      ).toBe(false);
      await refused.stop();
      await f.assertNoNodeImports();
      expect(f.modelRequests()).toBe(0);
      expect(f.supplierRequests()).toBe(0);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  120_000,
);

it.runIf(packageDirectory !== undefined)(
  "actual ordinary Native default without either plugin opt-in preserves release and ready Control without plugin authorities or schemas",
  async () => {
    const f = await nativeInstalledProcessFixture();
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      const runtime = f.supervisor(true, false);
      await runtime.start();
      expect(
        (
          await nativeProcessHttp(
            runtime.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
      ).toBe(200);
      expect(
        nativeProcessFacts(f.databasePath).tables.filter(
          (name) => name.startsWith("plugin_") || name.startsWith("extension_"),
        ),
      ).toEqual([]);
      expect(
        (await f.observations()).every(
          (row) => !row.nativeBootstrap && !row.installed && !row.peer,
        ),
      ).toBe(true);
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
      expect(f.requests).toEqual([]);
      expect(f.modelRequests()).toBe(0);
      expect(f.supplierRequests()).toBe(0);
      assertNoBusinessRows(nativeProcessFacts(f.databasePath));
      await runtime.stop();
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  60_000,
);

function assertNoBusinessRows(facts: ReturnType<typeof nativeProcessFacts>) {
  for (const [table, count] of Object.entries(facts.counts))
    if (!/^(?:agent_version|active_agent_version)/u.test(table))
      expect(count, table).toBe(0);
  expect(facts.tables.some((table) => /credit|quote|charge/u.test(table))).toBe(
    false,
  );
}

async function assertPublished(
  databasePath: string,
  prepared: Awaited<ReturnType<typeof prepareNativeInstalledProcessRelease>>,
) {
  const store = new SqliteRunStore(databasePath);
  try {
    const active = await store.loadActiveAgentVersionRelease({
      tenantId: actor.tenantId,
    });
    expect(active?.bundle).toEqual(prepared.plan.bundle);
    expect(active?.activation.operator).toEqual({
      principalId: actor.principalId,
      actorId: actor.actorId,
      spaceId: actor.spaceId,
    });
    expect(prepared.previousBundle.defaultAgentVersionId).toBe(
      prepared.plan.bundle.defaultAgentVersionId,
    );
    const entry = prepared.document.entries[0]!;
    const selection = await store.pluginInstallationStore().loadSelection({
      scope: entry.scope,
      pluginId: entry.packageIdentity.pluginId,
    });
    expect(selection?.state).toBe("disabled");
    expect(selection?.selectedPackageDigest).toBe(
      entry.packageIdentity.packageDigest,
    );
    for (const version of prepared.plan.versions) {
      const asset = await store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId: version.agentVersionId,
      });
      assert.ok(asset);
      expect(parseAgentVersionAsset(asset, digester)).toEqual(version);
    }
    for (const deployment of prepared.plan.deployments) {
      const actual = await store.loadAgentVersionDeployment({
        tenantId: actor.tenantId,
        agentVersionId: deployment.agentVersionId,
      });
      assert.ok(actual);
      const { deployedAt: _time, ...candidate } = actual;
      expect(candidate).toEqual(deployment);
    }
  } finally {
    await store.close();
  }
}
