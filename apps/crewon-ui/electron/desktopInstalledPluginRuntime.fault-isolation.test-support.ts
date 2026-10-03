import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  parseGetPluginSelectionResponse,
  parsePluginInstallationResponse,
  parsePluginSelectionResponse,
  type StartTurnResponse,
  type ThreadMutationResponse,
} from "@crewon/contracts";
import { parseExtensionConfiguration } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
} from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import { DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  nativeInstalledProcessFixture,
  nativeProcessFacts,
  nativeProcessHttp,
  type NativeInstalledProcessFixtureOptions,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";
import {
  nativeIsolationModel,
  ordinaryNativeResponse,
} from "./desktopInstalledPluginRuntime.fault-isolation-model.test-support.ts";
import type { ControlRuntimeSession } from "./runtimeSupervisor.ts";

type NativeFixture = Awaited<ReturnType<typeof nativeInstalledProcessFixture>>;
type Source = NativeFixture["sources"][number];

/** Sources are independently retained real bundles, copied without changing IDs or bytes. */
export async function nativeIsolationProcessFixture(
  professionalDirectory: string,
  kreaDirectory?: string,
  options: NativeInstalledProcessFixtureOptions = {},
) {
  const f = await nativeInstalledProcessFixture(
    await realpath(professionalDirectory),
    options,
  );
  let model: Awaited<ReturnType<typeof nativeIsolationModel>> | undefined;
  try {
    if (kreaDirectory !== undefined) {
      const original = await verifyLocalPluginPackage({
        directory: await realpath(kreaDirectory),
      });
      assert.equal(original.descriptor.pluginId, "crewon.comfyui-krea2");
      assert.equal(original.descriptor.publisherId, "crewon");
      assert.equal(original.descriptor.version, "1.0.0");
      const directory = join(f.directory, "approved-krea2");
      await cp(kreaDirectory, directory, { recursive: true });
      // cp preserves the retained delivery's 0755 mode; Native source roots must be private.
      // Only this fixture's new copy is changed, after proving its owned canonical directory.
      const copiedRoot = await lstat(directory);
      assert.ok(copiedRoot.isDirectory() && !copiedRoot.isSymbolicLink());
      assert.equal(copiedRoot.uid, process.getuid?.());
      assert.equal(await realpath(directory), directory);
      await chmod(directory, 0o700);
      const privateRoot = await lstat(directory);
      assert.equal(privateRoot.dev, copiedRoot.dev);
      assert.equal(privateRoot.ino, copiedRoot.ino);
      assert.equal(privateRoot.mode & 0o777, 0o700);
      const copied = await verifyLocalPluginPackage({ directory });
      assert.equal(copied.packageDigest, original.packageDigest);
      f.sources.push({
        sourceId: "native-isolation-krea2-v1",
        directory,
        pluginId: copied.descriptor.pluginId,
        publisherId: copied.descriptor.publisherId,
        version: copied.descriptor.version,
        packageDigest: copied.packageDigest,
      });
      const approvalPath = join(f.dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
      const approval = JSON.parse(await readFile(approvalPath, "utf8"));
      assert.equal(approval.schemaVersion, DESKTOP_PLUGIN_APPROVAL_SCHEMA);
      assert.ok(copied.descriptor.entrypoints.ui);
      approval.sources = f.sources;
      approval.publications.push({
        pluginId: copied.descriptor.pluginId,
        publisherId: copied.descriptor.publisherId,
        packageDigest: copied.packageDigest,
        publicAssets: [copied.descriptor.entrypoints.ui.path],
      });
      await writeFile(approvalPath, JSON.stringify(approval));
    }
    model = await nativeIsolationModel(f.provider.apiKey);
    f.provider.endpoint = model.endpoint;
    const ownedModel = model;
    let closing: Promise<void> | null = null;
    return {
      ...f,
      model: ownedModel,
      async close() {
        if (closing) return closing;
        closing = (async () => {
          const errors: unknown[] = [];
          try {
            await f.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            await ownedModel.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length)
            throw new AggregateError(
              errors,
              "native_isolation_fixture_cleanup_failed",
            );
        })();
        return closing;
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await f.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      await model?.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    throw new AggregateError(failures, "native_isolation_fixture_failed");
  }
}
export type IsolationFixture = Awaited<
  ReturnType<typeof nativeIsolationProcessFixture>
>;

export async function installIsolationPlugin(
  session: ControlRuntimeSession,
  source: Source,
) {
  const request = {
    sourceId: source.sourceId,
    expectedPluginId: source.pluginId,
    expectedPackageDigest: source.packageDigest,
    expectedSelectionRevision: null,
  };
  const response = await nativeProcessHttp(
    session,
    "POST",
    "/api/v1/plugins/installations",
    request,
    `isolation-install-${source.pluginId}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const installed = parsePluginInstallationResponse(
    await response.json(),
    request,
  );
  assert.equal(installed.selection.state, "disabled");
  assert.equal(installed.selection.selectedPackageDigest, source.packageDigest);
  return installed;
}

export async function configureIsolationPlugin(
  f: IsolationFixture,
  session: ControlRuntimeSession,
  source: Source,
) {
  const parameters =
    source.pluginId === "crewon.comfyui-krea2"
      ? { baseUrl: f.model.supplier }
      : {
          organization: "Actual independently installed professional module",
          providerBaseUrl: f.model.supplier,
        };
  const response = await nativeProcessHttp(
    session,
    "PUT",
    `/api/v1/extensions/${source.pluginId}/configuration`,
    {
      pluginVersion: source.version,
      expectedRevision: 0,
      parameters,
      credentialBindings: [],
    },
    `isolation-configure-${source.pluginId}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const configuration = parseExtensionConfiguration(
    (await response.json()).configuration,
    digester,
  );
  assert.equal(configuration.revision, 1);
  assert.equal(configuration.createdByActorId, actor.actorId);
  return configuration;
}

export async function uninstallIsolationPlugin(
  session: ControlRuntimeSession,
  source: Source,
) {
  const request = {
    state: "uninstalled" as const,
    selectedPackageDigest: null,
    expectedSelectionRevision: 1,
  };
  const response = await nativeProcessHttp(
    session,
    "PUT",
    `/api/v1/plugins/selections/${source.pluginId}`,
    request,
    `isolation-uninstall-${source.pluginId}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const value = parsePluginSelectionResponse(await response.json(), {
    pluginId: source.pluginId,
    request,
  });
  assert.equal(value.projection.outcome, "applied");
  assert.equal(value.mutation.selection.state, "uninstalled");
  assert.equal(value.mutation.selection.revision, 2);
  return value.mutation.selection;
}

export async function writeIsolationRuntimeConfiguration(
  f: IsolationFixture,
  pluginIds: readonly string[],
) {
  const scope = await f.currentProfile();
  assert.ok(scope);
  const worker = f.workerConfiguration(
    join(f.dataDirectory, "unused.json"),
    scope,
  );
  const path = join(f.dataDirectory, DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE);
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: "crewon.desktop-installed-plugin-runtime.v2",
      enabled: true,
      providerBinding: {
        providerId: f.provider.providerId,
        endpoint: f.provider.endpoint,
        responsesEndpoint: `${f.provider.endpoint}/responses`,
        modelId: f.provider.modelId,
        credentialRequired: true,
      },
      plugins: pluginIds.map((pluginId) => ({
        pluginId,
        approvalRequirement: "none",
      })),
      workerAuthorities: {
        actorAuthority: worker.actorAuthority,
        profileAuthority: worker.profileAuthority,
        policyAuthority: worker.policyAuthority,
        packageAuthority: worker.packageAuthority,
        networkAuthority: null,
        timeoutMs: worker.timeoutMs,
      },
    }),
    { mode: 0o600 },
  );
  return path;
}

export function assertIsolationChildren(
  rows: Awaited<ReturnType<NativeFixture["observations"]>>,
  installed: boolean,
) {
  assert.equal(rows.length, 4);
  const release = rows.filter((row) =>
    row.entry.endsWith("/runtime-worker/src/release-main.ts"),
  );
  assert.equal(release.length, 2);
  assert.equal(release[0]!.preparation, true);
  assert.equal(release[0]!.installed, false);
  assert.equal(release[0]!.authorityTokenPresent, true);
  const worker = rows.find((row) =>
    row.entry.endsWith("/runtime-worker/src/main.ts"),
  );
  const control = rows.find((row) =>
    row.entry.endsWith("/control-api/src/main.ts"),
  );
  assert.ok(worker && control);
  assert.equal(control.nativeBootstrap, true);
  for (const row of [release[1]!, worker]) {
    assert.equal(row.preparation, false);
    assert.equal(row.task, false);
    assert.equal(row.installed, installed);
    assert.equal(row.authorityTokenPresent, installed);
  }
  assert.equal(worker.peer, installed);
  assert.equal(release[1]!.peer, false);
  for (const field of [
    "installed",
    "preparation",
    "peer",
    "task",
    "authorityTokenPresent",
  ] as const)
    assert.equal(control[field], false, field);
  for (const row of rows)
    assert.equal(
      row.environment.CREWON_AGENT_VERSION_ID,
      release[0]!.environment.CREWON_AGENT_VERSION_ID,
    );
}

export async function assertIsolationSelection(
  session: ControlRuntimeSession,
  selection: Awaited<ReturnType<typeof installIsolationPlugin>>["selection"],
) {
  const response = await nativeProcessHttp(
    session,
    "GET",
    `/api/v1/plugins/selections/${selection.pluginId}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    parseGetPluginSelectionResponse(await response.json(), {
      pluginId: selection.pluginId,
    }).selection,
    selection,
  );
}

export async function assertIsolationTaskRoutesUnavailable(
  f: IsolationFixture,
  session: ControlRuntimeSession,
) {
  for (const source of f.sources) {
    for (const intent of [
      {
        kind: "generate",
        input:
          source.pluginId === "crewon.comfyui-krea2"
            ? { prompt: "must remain unavailable" }
            : { subject: "must remain unavailable" },
      },
      { kind: "query", sourceRunId: randomUUID(), operationId: randomUUID() },
    ]) {
      const response = await nativeProcessHttp(
        session,
        "POST",
        `/api/v1/extensions/${source.pluginId}/tasks`,
        { threadId: randomUUID(), expectedThreadRevision: 1, intent },
        `isolation-no-task-${source.pluginId}-${intent.kind}`,
      );
      assert.equal(response.status, 404, await response.clone().text());
      assert.equal((await response.json()).error.code, "route_not_found");
    }
  }
}

export async function isolationActivePublication(f: IsolationFixture) {
  const store = new SqliteRunStore(f.databasePath);
  try {
    const active = await store.loadActiveAgentVersionRelease({
      tenantId: actor.tenantId,
    });
    assert.ok(active);
    const assets = await Promise.all(
      active.bundle.deployments.map(async ({ agentVersionId }) => {
        const asset = await store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId,
        });
        assert.ok(asset);
        return parseAgentVersionAsset(asset, digester);
      }),
    );
    const original = assets.find(
      ({ agentVersionId }) =>
        agentVersionId === active.bundle.defaultAgentVersionId,
    );
    assert.ok(original);
    assert.equal(original.model.modelId, f.provider.modelId);
    return { active, assets, original };
  } finally {
    await store.close();
  }
}

export async function runIsolationDefaultAgent(
  f: IsolationFixture,
  session: ControlRuntimeSession,
  defaultAgentVersionId: string,
) {
  const threadResponse = await nativeProcessHttp(
    session,
    "POST",
    "/api/v1/threads",
    { title: "Plugin fault leaves default Agent available" },
    "isolation-default-thread",
  );
  assert.equal(threadResponse.status, 201, await threadResponse.clone().text());
  const { thread } = (await threadResponse.json()) as ThreadMutationResponse;
  const turnResponse = await nativeProcessHttp(
    session,
    "POST",
    `/api/v1/threads/${thread.threadId}/turns`,
    {
      expectedRevision: thread.revision,
      content: "Use the existing default Agent.",
      agentVersionId: null,
      executionIntent: "none",
    },
    "isolation-default-turn",
  );
  assert.equal(turnResponse.status, 201, await turnResponse.clone().text());
  const { run } = (await turnResponse.json()) as StartTurnResponse;
  const stream = await fetch(
    new URL(`/api/v1/runs/${run.runId}/events`, session.baseUrl),
    {
      headers: {
        "authorization": `Bearer ${session.sessionToken}`,
        "origin": session.origin,
        "x-csrf-token": session.csrfToken,
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  assert.equal(stream.status, 200);
  const events = await stream.text();
  assert.ok(events.includes(ordinaryNativeResponse), events);
  assert.ok(events.includes("event: run.completed"), events);
  assert.ok(!events.includes("event: tool."), events);
  const store = new SqliteRunStore(f.databasePath);
  try {
    const completed = await store.loadRun({
      tenantId: actor.tenantId,
      runId: run.runId,
    });
    assert.ok(completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.agentVersionId, defaultAgentVersionId);
  } finally {
    await store.close();
  }
  assert.equal(f.model.requests.length, 1);
  assert.equal(f.model.requests[0]!.model, f.provider.modelId);
  const facts = nativeProcessFacts(f.databasePath);
  assert.equal(
    facts.counts.run_snapshots,
    1,
    "only the actual default Run may exist",
  );
  assert.equal(facts.counts.threads, 1);
  return run.runId;
}

/** Ordinary Run rows are permitted only after an actual default Run; plugin admission/IO/funds remain zero. */
export async function assertIsolationNoPluginExecution(
  f: IsolationFixture,
  ordinaryRun: boolean,
) {
  await f.assertNoNodeImports();
  const facts = nativeProcessFacts(f.databasePath);
  for (const [table, count] of Object.entries(facts.counts)) {
    if (
      /^(?:plugin_(?:task|query_task)_admissions|extension_)/u.test(table) ||
      (!ordinaryRun && !/^(?:agent_version|active_agent_version)/u.test(table))
    )
      assert.equal(count, 0, table);
  }
  assert.equal(
    facts.tables.some((table) => /credit|quote|charge/u.test(table)),
    false,
  );
  assert.equal(f.modelRequests(), 0);
  assert.equal(f.supplierRequests(), 0);
  assert.equal(f.model.supplierRequests(), 0);
  assert.equal(f.model.requests.length, ordinaryRun ? 1 : 0);
}
