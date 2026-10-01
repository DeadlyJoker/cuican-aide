import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { parseExtensionConfiguration } from "@crewon/domain";
import type {
  GetExtensionActivationResponse,
  GetExtensionConfigurationResponse,
} from "@crewon/contracts";
import {
  command,
  installAndVerifyWorkspace,
  snapshotSources,
  stagedIdentity,
} from "../../../scripts/extension-build-upgrade.test-support.mts";
import { loadDesktopExtensionRuntimeConfiguration } from "./desktopExtensionRuntime.ts";
import type { RuntimeSupervisor } from "./runtimeSupervisor.ts";
import {
  instrumentUpgradeFixtureNetwork,
  upgradeDigester,
  upgradeProviderFixtures,
  upgradeRunBinding,
  writeUpgradeMetadataConfig,
  writeUpgradePlugin,
} from "./desktopExtensionUpgrade.test-support.ts";

/** Node-only fixture. No production runtime or provider outcomes are replaced. */
export async function startBusinessExtensionFlowHost() {
  assert.match(process.version, /^v24\./u);
  const evidencePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../output/extensions/business-extension-real-ui-evidence.json",
  );
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-ui-extension-flow-")),
  );
  const copy = join(root, "workspace"),
    dataRoot = join(root, "native-data");
  const children: { child: ChildProcess; closed: boolean }[] = [];
  const nativeChildProcess = createRequire(import.meta.url)(
    "node:child_process",
  ) as { spawn: typeof import("node:child_process").spawn };
  const originalSpawn = nativeChildProcess.spawn;
  // This dynamic Node helper uses native ESM, outside Vitest's mock graph.
  // Observe the builtin and synchronize its live ESM binding without changing arguments.
  const observeSpawn = ((...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args);
    const options = args[2] as SpawnOptions | undefined;
    if (
      options?.env?.CREWON_CONTROL_DB_PATH === join(dataRoot, "control.sqlite")
    ) {
      const record = { child, closed: false };
      children.push(record);
      child.once("close", () => {
        record.closed = true;
      });
    }
    return child;
  }) as typeof originalSpawn;
  mkdirSync(dataRoot, { mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  const providers = await upgradeProviderFixtures({
    modelResponseDelayMs: 1_000,
    currentTurnOutputsOnly: true,
  });
  let supervisor: RuntimeSupervisor | null = null;
  let closed = false;
  const logs: string[] = [];
  const requests: { method: string; path: string; cursor: string | null }[] =
    [];
  const disconnections: { path: string; cursor: number }[] = [];
  let disconnectReserved = false;
  let evidence: Record<string, unknown> | null = null;
  const output = new Writable({
    write(chunk, _encoding, done) {
      logs.push(String(chunk));
      done();
    },
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    clearTimeout(timer);
    try {
      try {
        await supervisor?.stop();
      } finally {
        const terminated = await Promise.allSettled(
          children
            .filter((record) => !record.closed)
            .map(
              ({ child }) =>
                new Promise<void>((resolve, reject) => {
                  const deadline = setTimeout(
                    () => reject(new Error("ui_flow_child_cleanup_timeout")),
                    10_000,
                  );
                  child.once("close", () => {
                    clearTimeout(deadline);
                    resolve();
                  });
                  if (child.exitCode === null && child.signalCode === null)
                    child.kill("SIGKILL");
                }),
            ),
        );
        try {
          await providers.close();
        } finally {
          vi.unstubAllEnvs();
        }
        const failures = terminated.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failures.length > 0)
          throw new AggregateError(
            failures.map((result) => result.reason),
            `ui_flow_cleanup_failed: ${root}`,
          );
        assert.ok(
          children.every((record) => record.closed),
          "All registered actual runtime processes must exit before deleting the fixture root",
        );
        rmSync(root, { recursive: true, force: true });
        assert.equal(existsSync(root), false);
        if (evidence !== null)
          writeFileSync(
            evidencePath,
            JSON.stringify(
              {
                ...evidence,
                cleanup: {
                  registeredProcesses: children.length,
                  closedProcesses: children.filter((record) => record.closed)
                    .length,
                  liveProcesses: 0,
                  fixtureRootExists: false,
                },
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
      }
    } finally {
      if (nativeChildProcess.spawn === observeSpawn) {
        nativeChildProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
      }
    }
  };
  try {
    nativeChildProcess.spawn = observeSpawn;
    syncBuiltinESMExports();
    const supervisorModulePath = "./runtimeSupervisor.ts";
    const { RuntimeSupervisor, runtimePaths } = (await import(
      /* @vite-ignore */ supervisorModulePath
    )) as typeof import("./runtimeSupervisor.ts");
    vi.stubEnv("CREWON_MODEL_CREDENTIAL_REQUIRED", "1");
    vi.stubEnv("CREWON_RESPONSES_STREAM_MAX_RETRIES", "0");
    vi.stubEnv("CREWON_WORKER_SCAN_INTERVAL_MS", "25");
    vi.stubEnv("CREWON_WORKER_RETRY_AFTER_MS", "0");
    vi.stubEnv("CREWON_OUTBOX_SCAN_INTERVAL_MS", "25");
    vi.stubEnv("CREWON_OUTBOX_RETENTION_MS", "off");
    vi.stubEnv("CREWON_ARTIFACT_RETENTION", "off");
    snapshotSources(copy);
    instrumentUpgradeFixtureNetwork(copy, providers.comfyEndpoint);
    const digest = await installAndVerifyWorkspace(copy, controller.signal);
    await command(
      process.execPath,
      [join(copy, "scripts/stage-desktop-runtime.ts")],
      copy,
      controller.signal,
    );
    const build = stagedIdentity(copy);
    assert.equal(build.identity.implementationDigest, digest);
    writeUpgradeMetadataConfig(dataRoot);
    const provider = {
      providerId: "ui-flow-provider",
      endpoint: providers.endpoint,
      modelId: "ui-flow-model",
      apiKey: "ui-flow-deterministic-fixture-key",
    };
    supervisor = new RuntimeSupervisor({
      dataDirectory: dataRoot,
      repositoryRoot: copy,
      paths: runtimePaths({
        packaged: true,
        repositoryRoot: copy,
        resourcesPath: join(copy, "apps/crewon-ui/desktop-resources"),
      }),
      provider: () => provider,
      providerModelCatalog: async () => [provider.modelId],
      agentPlatformApiKeyForOrigin: () => null,
      workspaceRoot: () => null,
      extensionRuntime: {
        configuration: () => loadDesktopExtensionRuntimeConfiguration(dataRoot),
        resolveProviderCredential: (input) =>
          input.providerId === provider.providerId &&
          input.endpoint === provider.endpoint &&
          input.responsesEndpoint === `${provider.endpoint}/responses`
            ? { availability: "available", apiKey: provider.apiKey }
            : {
                availability: "unavailable",
                reason: "provider_endpoint_mismatch",
              },
      },
      logOutputs: { stdout: output, stderr: output },
    });
    await supervisor.start();
    assert.ok(
      children.length >= 3,
      "Register the real release, Worker and Control processes",
    );
    const session = supervisor.session();
    const originalFetch = globalThis.fetch.bind(globalThis);
    const client = new ControlApiClient({
      baseUrl: session.baseUrl,
      accessToken: session.sessionToken,
      csrfToken: session.csrfToken,
      origin: session.origin,
      fetch: async (input, init) => {
        const path = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        ).pathname;
        requests.push({
          method: init?.method ?? "GET",
          path,
          cursor: new Headers(init?.headers).get("last-event-id"),
        });
        const response = await originalFetch(input, init);
        if (
          disconnectReserved ||
          !/^\/api\/v1\/runs\/[^/]+\/events$/u.test(path) ||
          response.status !== 200 ||
          response.body === null
        )
          return response;
        disconnectReserved = true;
        const reader = response.body.getReader();
        // Cut one actual server stream after its first complete identified frame.
        // The bytes/events, status and response headers all come from Control.
        let bytes = Buffer.alloc(0);
        const body = new ReadableStream<Uint8Array>({
          async start(stream) {
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) {
                  stream.enqueue(bytes);
                  stream.close();
                  return;
                }
                bytes = Buffer.concat([bytes, Buffer.from(chunk.value)]);
                assert.ok(bytes.byteLength <= 128 * 1024);
                let boundary = bytes.indexOf("\n\n");
                while (boundary >= 0) {
                  const prefix = bytes.subarray(0, boundary + 2);
                  const id = /^id: ?([1-9][0-9]*)$/mu.exec(
                    prefix.toString("utf8"),
                  );
                  if (id) {
                    disconnections.push({ path, cursor: Number(id[1]) });
                    stream.enqueue(prefix);
                    stream.close();
                    await reader.cancel();
                    return;
                  }
                  boundary = bytes.indexOf("\n\n", boundary + 2);
                }
              }
            } catch (error) {
              stream.error(error);
            }
          },
          cancel: () => reader.cancel(),
        });
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    return {
      client,
      endpoint: providers.comfyEndpoint,
      requests,
      disconnections,
      recordEvidence(input: {
        configuration: NonNullable<
          GetExtensionConfigurationResponse["configuration"]
        >;
        target: NonNullable<
          GetExtensionActivationResponse["activation"]
        >["target"];
        threadId: string;
        generationRunId: string;
        queryRunId: string;
      }) {
        mkdirSync(dirname(evidencePath), { recursive: true });
        evidence = {
          ...input,
          buildIdentity: build.identity,
          disconnections,
          externalCalls: {
            modelPost: providers.modelRequests.length,
            comfyPost: providers.comfyRequests.filter(
              (request) => request === "POST /prompt",
            ).length,
            historyGet: providers.comfyRequests.filter((request) =>
              request.startsWith("GET /history/"),
            ).length,
          },
          cleanup: null,
        };
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), {
          mode: 0o600,
        });
      },
      modelRequests: providers.modelRequests,
      comfyRequests: providers.comfyRequests,
      async prepareSavedPlugin(
        configuration: NonNullable<
          GetExtensionConfigurationResponse["configuration"]
        >,
      ) {
        assert.equal(configuration.parameters.baseUrl, providers.comfyEndpoint);
        const parsed = parseExtensionConfiguration(
          configuration,
          upgradeDigester,
        );
        const inputs = writeUpgradePlugin(
          dataRoot,
          "ui-flow-image-agent",
          parsed,
          providers.endpoint,
        );
        await supervisor!.restart();
        assert.ok(
          children.length >= 6,
          "Register both actual release/Worker/Control lifetimes",
        );
        assert.deepEqual(supervisor!.session(), session);
        return inputs.version.agentVersionId;
      },
      runBinding: (runId: string) => upgradeRunBinding(dataRoot, runId),
      logTail: () => logs.join("").slice(-12_000),
      close,
    };
  } catch (error) {
    console.error(logs.join("").slice(-12_000));
    await close();
    throw error;
  }
}
