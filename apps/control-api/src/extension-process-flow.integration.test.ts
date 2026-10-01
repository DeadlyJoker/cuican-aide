import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createAgentVersionAsset,
  parseAgentVersionAsset,
} from "@crewon/agent-version";
import type {
  ErrorEnvelope,
  ExtensionConfigurationMutationResponse,
  ExtensionActivationMutationResponse,
  ExtensionTaskMutationResponse,
  StartTurnResponse,
  ThreadMutationResponse,
} from "@crewon/contracts";
import { parseExtensionConfiguration } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { compileComfyAgentVersion } from "../../runtime-worker/src/extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "../../runtime-worker/src/extensions/comfyui-bundled-registration.ts";
import {
  completeExtensionProcess,
  extensionProcessFixture,
  extensionProcessHeaders,
  extensionProcessJson,
  EXTENSION_PROCESS_ACTOR,
  EXTENSION_PROCESS_DEFAULT_AGENT,
  EXTENSION_PROCESS_DEFAULT_TEXT,
  EXTENSION_PROCESS_PLUGIN_AGENT,
  EXTENSION_PROCESS_PLUGIN_TEXT,
  EXTENSION_PROCESS_TOKEN,
  freeExtensionProcessPort,
  waitForExtensionProcess,
} from "./extension-process-flow.test-support.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test(
  "real release, Worker and Control processes admit a separately published plugin and stream through the existing Run path",
  { timeout: 120_000 },
  async (context) => {
    const f = await extensionProcessFixture(context);
    const firstRelease = f.start("release");
    assert.equal(
      (await completeExtensionProcess(firstRelease)).code,
      0,
      firstRelease.stderr(),
    );
    const firstReleaseBody = JSON.parse(firstRelease.stdout()) as {
      agentVersionIds: string[];
    };
    assert.deepEqual(firstReleaseBody.agentVersionIds, [
      EXTENSION_PROCESS_DEFAULT_AGENT,
    ]);
    const store = new SqliteRunStore(f.databasePath);
    const defaultAsset = await store.loadAgentVersion({
      tenantId: EXTENSION_PROCESS_ACTOR.tenantId,
      agentVersionId: EXTENSION_PROCESS_DEFAULT_AGENT,
    });
    await store.close();
    assert.ok(defaultAsset);
    const baseVersion = parseAgentVersionAsset(defaultAsset, digester);
    const hostPort = await freeExtensionProcessPort();
    const hostOrigin = `http://127.0.0.1:${hostPort}`;
    const workerOptIn = {
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_EXTENSION_HOST_PORT: String(hostPort),
      CREWON_EXTENSION_HOST_TOKEN: EXTENSION_PROCESS_TOKEN,
    };
    const metadataWorker = f.start("worker", workerOptIn);
    await waitForExtensionProcess(
      metadataWorker,
      "CrewON Runtime Worker started",
    );
    const controlPort = await freeExtensionProcessPort();
    const controlOrigin = `http://127.0.0.1:${controlPort}`;
    const controlPeer = {
      CREWON_CONTROL_PORT: String(controlPort),
      CREWON_EXTENSION_HOST_ORIGIN: hostOrigin,
      CREWON_EXTENSION_HOST_TOKEN: EXTENSION_PROCESS_TOKEN,
    };
    const disabled = f.start("control", {
      ...controlPeer,
      CREWON_EXTENSIONS_ENABLED: "0",
    });
    await waitForExtensionProcess(disabled, "CrewON Control API listening");
    const registration = bundledComfyRegistration();
    const api = `/api/v1/extensions/${registration.manifest.pluginId}`;
    const unavailable = await extensionProcessJson<ErrorEnvelope>(
      controlOrigin,
      `${api}/configuration`,
    );
    assert.equal(unavailable.status, 404);
    assert.equal(unavailable.body.error.code, "route_not_found");
    assert.equal((await f.stop(disabled)).code, 0, disabled.stderr());
    const metadataControl = f.start("control", {
      ...controlPeer,
      CREWON_EXTENSIONS_ENABLED: "1",
    });
    await waitForExtensionProcess(
      metadataControl,
      "CrewON Control API listening",
    );
    const saved =
      await extensionProcessJson<ExtensionConfigurationMutationResponse>(
        controlOrigin,
        `${api}/configuration`,
        "PUT",
        {
          pluginVersion: registration.manifest.version,
          expectedRevision: 0,
          parameters: { baseUrl: "https://comfyui.example.com/" },
          credentialBindings: [],
        },
        "process-configuration-1",
      );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const configuration = parseExtensionConfiguration(
      saved.body.configuration,
      digester,
    );
    assert.equal(
      configuration.implementationDigest,
      registration.implementationDigest,
    );
    assert.equal(configuration.tenantId, EXTENSION_PROCESS_ACTOR.tenantId);
    assert.equal(configuration.spaceId, EXTENSION_PROCESS_ACTOR.spaceId);
    const premature = await extensionProcessJson<ErrorEnvelope>(
      controlOrigin,
      `${api}/activation`,
      "PUT",
      {
        state: "enabled",
        expectedRevision: 0,
        configurationRevision: configuration.revision,
        agentVersionId: EXTENSION_PROCESS_PLUGIN_AGENT,
      },
      "process-premature-activation",
    );
    assert.equal(premature.status, 409, JSON.stringify(premature.body));
    assert.equal(premature.body.error.code, "extension_runtime_unavailable");
    assert.equal(
      (await f.stop(metadataControl)).code,
      0,
      metadataControl.stderr(),
    );
    assert.equal(
      (await f.stop(metadataWorker)).code,
      0,
      metadataWorker.stderr(),
    );
    assert.equal(
      f.requests.length,
      0,
      "Catalog/configuration/readiness must not call the model or Comfy provider.",
    );

    const pluginVersion = compileComfyAgentVersion({
      base: { executionAuthority: "crewonKernel", version: baseVersion },
      agentVersionId: EXTENSION_PROCESS_PLUGIN_AGENT,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "extension-process-comfy-policy",
      digester,
    });
    const snapshotPath = join(f.root, "comfy-runtime.json");
    const pluginBindingsPath = join(f.root, "plugin-bindings.json");
    const assetsPath = join(f.root, "plugin-assets.json");
    const legacyBindingsPath = join(f.root, "base-bindings.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        schemaVersion: "crewon.extension-runtime-config.v0",
        configuration,
        approvalRequirement: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      pluginBindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [
          {
            tenantId: EXTENSION_PROCESS_ACTOR.tenantId,
            agentVersionId: pluginVersion.agentVersionId,
            contentDigest: pluginVersion.contentDigest,
            authorityId: "extension-process-comfy-authority",
            workspaceBindingId: null,
            provider: {
              kind: "directResponses",
              endpoint: f.endpoint,
              apiKeyEnvironment: null,
              storeResponses: false,
              requestProfile: "responsesLite",
              idleTimeoutMs: 5000,
              sequencePolicy: "whenPresent",
            },
            mcpStdioConfigPath: null,
            deviceToolConfigPath: null,
            remoteMcpConfigPath: null,
            extensionConfigPath: snapshotPath,
          },
        ],
      }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      assetsPath,
      JSON.stringify({
        schemaVersion: "crewon.extension-agent-version-assets.v0",
        assets: [
          createAgentVersionAsset({
            tenantId: EXTENSION_PROCESS_ACTOR.tenantId,
            version: pluginVersion,
            createdAt: "2026-10-01T00:00:00.000Z",
          }),
        ],
      }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      legacyBindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [],
      }),
      { flag: "wx", mode: 0o600 },
    );
    const immutableInputs = [snapshotPath, pluginBindingsPath, assetsPath].map(
      (path) => ({ path, bytes: readFileSync(path) }),
    );
    const releaseEnvironment = {
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: pluginBindingsPath,
      CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: assetsPath,
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: legacyBindingsPath,
      CREWON_MODEL_CATALOG_JSON: JSON.stringify([baseVersion.model.modelId]),
    };
    const pluginRelease = f.start("release", releaseEnvironment);
    assert.equal(
      (await completeExtensionProcess(pluginRelease)).code,
      0,
      pluginRelease.stderr(),
    );
    const published = JSON.parse(pluginRelease.stdout()) as {
      agentVersionIds: string[];
    };
    assert.deepEqual(
      new Set(published.agentVersionIds),
      new Set([
        EXTENSION_PROCESS_DEFAULT_AGENT,
        EXTENSION_PROCESS_PLUGIN_AGENT,
      ]),
    );
    for (const { path, bytes } of immutableInputs)
      assert.deepEqual(
        readFileSync(path),
        bytes,
        "Release CLI must preserve operator-owned plugin files.",
      );
    const publishedStore = new SqliteRunStore(f.databasePath);
    const unchanged = await publishedStore.loadAgentVersion({
      tenantId: EXTENSION_PROCESS_ACTOR.tenantId,
      agentVersionId: EXTENSION_PROCESS_DEFAULT_AGENT,
    });
    assert.deepEqual(unchanged, defaultAsset);
    await publishedStore.close();

    const worker = f.start("worker", {
      ...releaseEnvironment,
      CREWON_MODEL_CATALOG_JSON: undefined,
      ...workerOptIn,
    });
    await waitForExtensionProcess(worker, "CrewON Runtime Worker started");
    const control = f.start("control", {
      ...controlPeer,
      CREWON_EXTENSIONS_ENABLED: "1",
    });
    await waitForExtensionProcess(control, "CrewON Control API listening");
    const activation =
      await extensionProcessJson<ExtensionActivationMutationResponse>(
        controlOrigin,
        `${api}/activation`,
        "PUT",
        {
          state: "enabled",
          expectedRevision: 0,
          configurationRevision: configuration.revision,
          agentVersionId: pluginVersion.agentVersionId,
        },
        "process-activation-1",
      );
    assert.equal(activation.status, 200, JSON.stringify(activation.body));
    assert.equal(
      activation.body.activation.target?.agentVersionId,
      pluginVersion.agentVersionId,
    );
    const thread = await extensionProcessJson<ThreadMutationResponse>(
      controlOrigin,
      "/api/v1/threads",
      "POST",
      { title: "Plugin process task" },
      "process-thread-1",
    );
    assert.equal(thread.status, 201, JSON.stringify(thread.body));
    const task = await extensionProcessJson<ExtensionTaskMutationResponse>(
      controlOrigin,
      `${api}/tasks`,
      "POST",
      {
        threadId: thread.body.thread.threadId,
        expectedThreadRevision: thread.body.thread.revision,
        intent: {
          kind: "generate",
          input: { prompt: "Verify process admission only." },
        },
      },
      "process-task-1",
    );
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const stream = await fetch(
      `${controlOrigin}/api/v1/runs/${task.body.runId}/events`,
      {
        headers: extensionProcessHeaders(),
        signal: AbortSignal.timeout(20_000),
      },
    );
    assert.equal(stream.status, 200);
    const frames = await stream.text();
    assert.match(frames, /event: run\.completed/u);
    assert.ok(frames.includes(EXTENSION_PROCESS_PLUGIN_TEXT));
    assert.equal(frames.includes("event: tool."), false);
    const resumed = await fetch(
      `${controlOrigin}/api/v1/runs/${task.body.runId}/events`,
      {
        headers: { ...extensionProcessHeaders(), "last-event-id": "1" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    assert.equal(resumed.status, 200);
    const resumedFrames = await resumed.text();
    assert.ok(resumedFrames.includes(EXTENSION_PROCESS_PLUGIN_TEXT));
    assert.equal(resumedFrames.includes("event: run.created\n"), false);

    const normalThread = await extensionProcessJson<ThreadMutationResponse>(
      controlOrigin,
      "/api/v1/threads",
      "POST",
      { title: "Default process task" },
      "process-default-thread",
    );
    assert.equal(normalThread.status, 201);
    const normalTurn = await extensionProcessJson<StartTurnResponse>(
      controlOrigin,
      `/api/v1/threads/${normalThread.body.thread.threadId}/turns`,
      "POST",
      {
        expectedRevision: normalThread.body.thread.revision,
        content: "Use the existing default Agent.",
        agentVersionId: null,
        executionIntent: "none",
      },
      "process-default-turn",
    );
    assert.equal(normalTurn.status, 201, JSON.stringify(normalTurn.body));
    const normalStream = await fetch(
      `${controlOrigin}/api/v1/runs/${normalTurn.body.run.runId}/events`,
      {
        headers: extensionProcessHeaders(),
        signal: AbortSignal.timeout(20_000),
      },
    );
    assert.equal(normalStream.status, 200);
    assert.ok(
      (await normalStream.text()).includes(EXTENSION_PROCESS_DEFAULT_TEXT),
    );
    assert.equal(f.requests.length, 2);
    const pluginRequest = f.requests[0]!;
    assert.ok(
      JSON.stringify(pluginRequest.input).includes(
        "Verify process admission only.",
      ),
    );
    const defaultToolNames = (
      (f.requests[1]!.tools ?? []) as { name: string }[]
    )
      .map(({ name }) => name)
      .sort();
    assert.equal(
      defaultToolNames.some((name) => name.startsWith("crewon_comfyui_")),
      false,
    );
    assert.deepEqual(
      (pluginRequest.tools as { name: string }[])
        .map(({ name }) => name)
        .sort(),
      [
        ...defaultToolNames,
        "crewon_comfyui_krea2__observe",
        "crewon_comfyui_krea2__submit",
      ].sort(),
    );
    assert.equal((await f.stop(control)).code, 0, control.stderr());
    assert.equal((await f.stop(worker)).code, 0, worker.stderr());
    const finalStore = new SqliteRunStore(f.databasePath);
    try {
      const defaultRun = await finalStore.loadRun({
        tenantId: EXTENSION_PROCESS_ACTOR.tenantId,
        runId: normalTurn.body.run.runId,
      });
      assert.equal(defaultRun?.agentVersionId, EXTENSION_PROCESS_DEFAULT_AGENT);
      const pluginRun = await finalStore.loadRun({
        tenantId: EXTENSION_PROCESS_ACTOR.tenantId,
        runId: task.body.runId,
      });
      assert.equal(pluginRun?.agentVersionId, pluginVersion.agentVersionId);
    } finally {
      await finalStore.close();
    }
    const database = new DatabaseSync(f.databasePath);
    try {
      assert.equal(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM extension_external_operations",
            )
            .get() as { count: number }
        ).count,
        0,
      );
      const rows = database
        .prepare("SELECT binding_json FROM extension_run_bindings")
        .all() as { binding_json: string }[];
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(rows[0]!.binding_json).runId, task.body.runId);
    } finally {
      database.close();
    }
  },
);

test(
  "all production entrypoints fail closed when standalone plugin opt-in is requested",
  { timeout: 60_000 },
  async (context) => {
    const f = await extensionProcessFixture(context);
    const hostPort = await freeExtensionProcessPort();
    for (const entry of ["control", "worker", "release"] as const) {
      const child = f.start(entry, {
        CREWON_CONTROL_SECURITY_MODE: "production",
        CREWON_EXTENSIONS_ENABLED: "1",
        CREWON_EXTENSION_HOST_PORT: String(hostPort),
        CREWON_EXTENSION_HOST_ORIGIN: `http://127.0.0.1:${hostPort}`,
        CREWON_EXTENSION_HOST_TOKEN: EXTENSION_PROCESS_TOKEN,
        ...(entry === "release"
          ? {
              CREWON_MODEL_ID: undefined,
              CREWON_MCP_STDIO_CONFIG_PATH: join(
                f.root,
                "must-not-be-read-mcp.json",
              ),
            }
          : {}),
      });
      const result = await completeExtensionProcess(child);
      assert.equal(result.code, 1, child.stderr());
      assert.equal(result.signal, null);
      const expectedCode = {
        control: "CREWON_EXTENSION_HOST_CONFIGURATION_forbidden",
        worker: "CREWON_EXTENSION_CONFIGURATION_forbidden",
        release: "extension_release_security_mode_forbidden",
      }[entry];
      assert.ok(child.stderr().includes(expectedCode), child.stderr());
      assert.equal(child.stderr().includes(EXTENSION_PROCESS_TOKEN), false);
      assert.equal(child.stdout().includes("started"), false);
      assert.equal(child.stdout().includes("listening"), false);
    }
    assert.equal(f.requests.length, 0);
  },
);
