import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  InstalledPluginPeerClient,
  type InstalledPluginPeerCandidatePreparationInput,
} from "../../control-api/src/installed-plugin-peer-client.ts";
import { InstalledPluginPeerTransport } from "../../control-api/src/installed-plugin-peer-transport.ts";
import {
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  parseInstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import { candidatePreparationSnapshot } from "./desktopInstalledPluginRuntime.candidate-preparation.test-support.ts";
import { parseDesktopInstalledPluginRuntimeConfiguration } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  assertIsolationChildren,
  installIsolationPlugin,
  nativeIsolationProcessFixture,
  writeIsolationRuntimeConfiguration,
} from "./desktopInstalledPluginRuntime.fault-isolation.test-support.ts";
import { nativeCandidateAuthority } from "./desktopInstalledPluginRuntime.candidate-authority.test-support.ts";
import {
  nativeProcessFacts,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

/** Actual Native HTTP installation/configuration and original automatic release/Worker.
 * Observer delegates every real factory/readiness call; it grants no permission. */
export async function nativeCandidateProcessFixture(
  input: Readonly<{
    professionalDirectory: string;
    kreaDirectory: string;
    network: "public" | "private" | "missing";
  }>,
) {
  const f = await nativeIsolationProcessFixture(
    input.professionalDirectory,
    input.kreaDirectory,
  );
  let authority:
    | Awaited<ReturnType<typeof nativeCandidateAuthority>>
    | undefined;
  const clients = new Set<
    InstalledPluginPeerClient | InstalledPluginPeerTransport
  >();
  try {
    const peerMetadataPath = join(f.directory, "candidate-worker-peer.jsonl"),
      auditPath = join(f.directory, "candidate-runtime-observation.jsonl");
    const observerPath = join(f.directory, "observe-candidate-runtime.mjs");
    await writeFile(
      observerPath,
      candidateObserver(peerMetadataPath, auditPath),
      { mode: 0o600 },
    );
    process.env.NODE_OPTIONS =
      `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(observerPath).href}`.trim();
    const management = f.supervisor(false);
    await management.start();
    const installed: Awaited<ReturnType<typeof installIsolationPlugin>>[] = [];
    for (const source of f.sources)
      installed.push(
        await installIsolationPlugin(management.session(), source),
      );
    const configurations: ExtensionConfiguration[] = [];
    for (const source of f.sources) {
      const response = await nativeProcessHttp(
        management.session(),
        "PUT",
        `/api/v1/extensions/${source.pluginId}/configuration`,
        {
          pluginVersion: source.version,
          expectedRevision: 0,
          parameters:
            source.pluginId === "crewon.comfyui-krea2"
              ? {
                  baseUrl:
                    input.network === "private"
                      ? "https://127.0.0.1/"
                      : "https://8.8.8.8/",
                }
              : {
                  organization: "Actual native factory comparison",
                  providerBaseUrl: "https://8.8.8.8/",
                },
          credentialBindings: [],
        },
        `candidate-configure-${source.pluginId}`,
      );
      assert.equal(response.status, 200, await response.clone().text());
      configurations.push(
        parseExtensionConfiguration(
          (await response.json()).configuration,
          digester,
        ),
      );
    }
    await f.assertNoNodeImports();
    assert.ok(
      Object.values(nativeProcessFacts(f.databasePath).counts).every(
        (count) => count === 0,
      ),
    );
    await management.stop();
    authority = await nativeCandidateAuthority(f);
    const fixedPath = await writeIsolationRuntimeConfiguration(
      f,
      f.sources.map(({ pluginId }) => pluginId),
    );
    const configuration = JSON.parse(await readFile(fixedPath, "utf8"));
    configuration.workerAuthorities.packageAuthority.url = `${authority.origin}/package`;
    configuration.workerAuthorities.networkAuthority =
      input.network === "missing"
        ? null
        : {
            url: `${authority.origin}/network`,
            serviceTokenEnvironmentVariable: "NATIVE_INSTALLED_AUTHORITY_TOKEN",
          };
    await writeFile(fixedPath, JSON.stringify(configuration));
    const fixedConfiguration =
      parseDesktopInstalledPluginRuntimeConfiguration(configuration);
    assert.ok(
      fixedConfiguration.enabled &&
        fixedConfiguration.schemaVersion ===
          "crewon.desktop-installed-plugin-runtime.v2",
    );
    const scope = await f.currentProfile();
    assert.ok(scope);
    const snapshotInput = {
      dataDirectory: f.dataDirectory,
      scope,
      approvedPackages: f.sources.map(
        ({ sourceId: _id, directory: _directory, ...identity }) => identity,
      ),
      plugins: fixedConfiguration.plugins,
      configurations,
      workerAuthorities: fixedConfiguration.workerAuthorities,
    };
    const runtime = f.supervisor(true);
    const ownedAuthority = authority;
    async function start() {
      const beforeChildren = (await f.observations()).length;
      await runtime.start();
      assert.equal(
        (
          await nativeProcessHttp(
            runtime.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
        200,
      );
      assertIsolationChildren(
        (await f.observations()).slice(beforeChildren),
        true,
      );
      const preparation = await candidatePreparationSnapshot(snapshotInput);
      const records = (await readFile(peerMetadataPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; token: string });
      const worker = (await f.observations()).findLast(({ entry }) =>
        entry.endsWith("/runtime-worker/src/main.ts"),
      );
      assert.ok(worker);
      const peer = records.findLast(({ pid }) => pid === worker.pid);
      assert.ok(peer);
      const metadata = await lstat(peerMetadataPath);
      assert.equal(metadata.mode & 0o777, 0o600);
      assert.equal(metadata.uid, process.getuid?.());
      assert.equal(metadata.nlink, 1);
      assert.ok(
        typeof peer.token === "string" && /^[a-f0-9]{64}$/u.test(peer.token),
        "actual_peer_token_invalid",
      );
      const origins = [
        ...f.logs
          .join("")
          .matchAll(
            /CrewON Installed Plugin Peer origin (http:\/\/127\.0\.0\.1:[1-9][0-9]*)/gu,
          ),
      ];
      const origin = origins.at(-1)?.[1];
      assert.ok(origin);
      const client = new InstalledPluginPeerClient({
        origin,
        token: peer.token,
        deadlineMs: 10_000,
      });
      const transport = new InstalledPluginPeerTransport({
        origin,
        token: peer.token,
        deadlineMs: 10_000,
      });
      clients.add(client);
      clients.add(transport);
      return { preparation, client, transport, workerPid: peer.pid };
    }
    const started = await start();
    await f.assertNoNodeImports();
    function candidate(
      pluginId: string,
    ): InstalledPluginPeerCandidatePreparationInput {
      const entry = started.preparation.document.entries.find(
        ({ packageIdentity }) => packageIdentity.pluginId === pluginId,
      );
      assert.ok(entry);
      const selection = installed.find(
        ({ selection }) => selection.pluginId === pluginId,
      )!.selection;
      return {
        actor,
        scope: entry.scope,
        identity: {
          ...entry.packageIdentity,
          manifestDigest: entry.configuration.manifestDigest,
          implementationDigest: entry.configuration.implementationDigest,
        },
        configuration: entry.configuration,
        expectedTarget: entry.target,
        expectedSelectionRevision: selection.revision,
      };
    }
    async function observations() {
      try {
        return (await readFile(auditPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                pid: number;
                event: string;
                requiredServices?: string[];
              },
          );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
    }
    const owned = {
      ...f,
      authority: ownedAuthority,
      installed,
      configurations,
      fixedPath,
      runtime,
      ...started,
      start,
      candidate,
      candidateObservations: observations,
      preparationSnapshot: () => candidatePreparationSnapshot(snapshotInput),
      async installedImports() {
        try {
          return (
            await readFile(
              join(f.directory, "plugin-node-imports.jsonl"),
              "utf8",
            )
          )
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { pid: number; url: string });
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return [];
          throw error;
        }
      },
      async close() {
        const errors: unknown[] = [];
        try {
          await runtime.stop();
        } catch (error) {
          errors.push(error);
        }
        for (const client of clients)
          try {
            await client.close();
          } catch (error) {
            errors.push(error);
          }
        try {
          await ownedAuthority.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await f.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            "native_candidate_fixture_cleanup_failed",
          );
      },
    };
    return owned;
  } catch (error) {
    const errors: unknown[] = [error];
    for (const client of clients)
      try {
        await client.close();
      } catch (cleanup) {
        errors.push(cleanup);
      }
    try {
      await authority?.close();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    try {
      await f.close();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    throw new AggregateError(errors, "native_candidate_fixture_failed");
  }
}
export type CandidateFixture = Awaited<
  ReturnType<typeof nativeCandidateProcessFixture>
>;

export async function assertCandidateDoesNotActivate(f: CandidateFixture) {
  const catalog = await f.client.prepare({
    actor,
    scope: f.candidate("crewon.comfyui-krea2").scope,
  });
  assert.deepEqual(catalog.catalog.list(), []);
  const input = f.candidate("crewon.comfyui-krea2");
  await assert.rejects(
    f.transport.post(
      parseInstalledPluginPeerRequest({
        protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
        requestId: randomUUID(),
        operation: "readiness",
        actor,
        scope: input.scope,
        identity: input.identity,
        configuration: input.configuration,
        expectedTarget: input.expectedTarget,
      }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "installed_plugin_peer_unavailable",
  );
  for (const installed of f.installed) {
    const response = await nativeProcessHttp(
      f.runtime.session(),
      "GET",
      `/api/v1/plugins/selections/${installed.selection.pluginId}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).selection, installed.selection);
    const activation = await nativeProcessHttp(
      f.runtime.session(),
      "GET",
      `/api/v1/extensions/${installed.selection.pluginId}/activation`,
    );
    assert.equal(activation.status, 200);
    assert.equal((await activation.json()).activation, null);
  }
}

export async function assertCandidateNoExecution(
  f: CandidateFixture,
  ordinaryRun = false,
) {
  const facts = nativeProcessFacts(f.databasePath);
  for (const [table, count] of Object.entries(facts.counts))
    if (
      /^(?:plugin_(?:task|query_task)_admissions|extension_)/u.test(table) ||
      (!ordinaryRun && !/^(?:agent_version|active_agent_version)/u.test(table))
    )
      assert.equal(count, 0, table);
  assert.equal(
    facts.tables.some((table) => /credit|quote|charge/u.test(table)),
    false,
  );
  assert.equal(f.model.requests.length, ordinaryRun ? 1 : 0);
  assert.equal(f.modelRequests(), 0);
  assert.equal(f.supplierRequests(), 0);
  assert.equal(f.model.supplierRequests(), 0);
  assert.equal(
    f.authority.requests.some(({ body }) => body.kind === "run"),
    false,
  );
}

function candidateObserver(peerPath: string, auditPath: string) {
  const registry = new URL(
    "../../../packages/plugin-host/src/plugin-execution-registry.ts",
    import.meta.url,
  ).href;
  const readiness = new URL(
    "../../runtime-worker/src/plugins/installed-plugin-execution-readiness.ts",
    import.meta.url,
  ).href;
  return `import {appendFileSync} from 'node:fs';
import {PluginExecutionRegistry} from ${JSON.stringify(registry)};
import {InstalledPluginExecutionReadinessOwner} from ${JSON.stringify(readiness)};
const record=(event,extra={})=>appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({pid:process.pid,event,...extra})+'\\n',{mode:0o600});
if(process.argv[1]?.endsWith('/runtime-worker/src/main.ts')&&process.env.CREWON_INSTALLED_PLUGIN_PEER_TOKEN)appendFileSync(${JSON.stringify(peerPath)},JSON.stringify({pid:process.pid,token:process.env.CREWON_INSTALLED_PLUGIN_PEER_TOKEN})+'\\n',{mode:0o600});
const acquire=PluginExecutionRegistry.prototype.acquire;
PluginExecutionRegistry.prototype.acquire=function(...args){const factory=acquire.apply(this,args);record('factoryBorrow',{requiredServices:factory.requiredServices??[]});return factory};
const ready=InstalledPluginExecutionReadinessOwner.prototype.assertReady;
InstalledPluginExecutionReadinessOwner.prototype.assertReady=function(...args){const work=ready.apply(this,args);record('ioPreflight');return work};
const close=InstalledPluginExecutionReadinessOwner.prototype.close;
InstalledPluginExecutionReadinessOwner.prototype.close=function(...args){const work=close.apply(this,args);record('ioClosing');work.then(()=>record('ioClosed'),()=>record('ioCloseFailed'));return work};
`;
}
