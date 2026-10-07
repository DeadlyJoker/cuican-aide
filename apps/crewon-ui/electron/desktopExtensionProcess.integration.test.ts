import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type {
  ExtensionActivationMutationResponse,
  ExtensionCatalogResponse,
  ExtensionConfigurationMutationResponse,
  ExtensionRuntimeResponse,
  ExtensionTaskMutationResponse,
  GetExtensionTaskResponse,
  StartTurnResponse,
  ThreadMutationResponse,
} from "@crewon/contracts";
import { parseExtensionConfiguration } from "@crewon/domain";
import {
  createScopedExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  getComfyImplementationDigest,
  resolveRetainedExtensionBuild,
} from "@crewon/agent-version/extension-build";
import {
  EXTENSION_RECOVERY_STARTUP_FILE,
  parseExtensionRecoveryStartupReport,
  resolveExtensionRecoveryCapsule,
  type ResolvedExtensionRecoveryCapsule,
} from "@crewon/agent-version/extension-recovery";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  parseAgentVersionAsset,
} from "../../../packages/agent-version/src/index.ts";
import { compileComfyAgentVersion } from "../../runtime-worker/src/extensions/comfyui-agent-version.ts";
import {
  DESKTOP_EXTENSION_CONFIGURATION_FILE,
  DESKTOP_RUNTIME_OWNER,
  loadDesktopExtensionRuntimeConfiguration,
} from "./desktopExtensionRuntime.ts";
import {
  RuntimeSupervisor,
  runtimePaths,
  type ControlRuntimeSession,
} from "./runtimeSupervisor.ts";

const pluginAgent = "native-extension-plugin-fixture";
const pluginText = "Native plugin task streamed. No image was generated.";
const defaultText = "Native default Agent is unchanged.";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

async function modelFixture() {
  const requests: Record<string, unknown>[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 128 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    requests.push(input);
    authorizations.push(request.headers.authorization);
    const text = (input.tools as { name?: string }[] | undefined)?.some(
      (t) => t.name === "crewon_comfyui_krea2__submit",
    )
      ? pluginText
      : defaultText;
    const id = `native-fixture-response-${requests.length}`;
    const item = {
      id: `${id}-message`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const events = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id, status: "in_progress", output: [] },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 0,
        item,
      },
      {
        type: "response.completed",
        sequence_number: 3,
        response: {
          id,
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    authorizations,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function headers(session: ControlRuntimeSession, key?: string) {
  return {
    "authorization": `Bearer ${session.sessionToken}`,
    "origin": session.origin,
    "x-csrf-token": session.csrfToken,
    "content-type": "application/json",
    ...(key ? { "idempotency-key": key } : {}),
  };
}
async function json<T>(
  session: ControlRuntimeSession,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  const response = await fetch(new URL(path, session.baseUrl), {
    method,
    headers: headers(session, key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: (await response.json()) as T };
}
async function stream(
  session: ControlRuntimeSession,
  runId: string,
  cursor?: string,
) {
  const response = await fetch(
    new URL(`/api/v1/runs/${runId}/events`, session.baseUrl),
    {
      headers: {
        ...headers(session),
        ...(cursor ? { "last-event-id": cursor } : {}),
      },
      signal: AbortSignal.timeout(20000),
    },
  );
  expect(response.status).toBe(200);
  return response.text();
}

/** Actual Node 24 release/Worker/Control entrypoints, with a local text-only model fixture. */
async function runNativeFlow(mode: "source" | "packaged") {
  expect(process.version).toMatch(/^v24\./u);
  vi.stubEnv("CREWON_MODEL_CREDENTIAL_REQUIRED", "0");
  vi.stubEnv("CREWON_RESPONSES_STREAM_MAX_RETRIES", "0");
  vi.stubEnv("CREWON_WORKER_SCAN_INTERVAL_MS", "25");
  vi.stubEnv("CREWON_WORKER_RETRY_AFTER_MS", "0");
  vi.stubEnv("CREWON_OUTBOX_SCAN_INTERVAL_MS", "25");
  vi.stubEnv("CREWON_OUTBOX_RETENTION_MS", "off");
  vi.stubEnv("CREWON_ARTIFACT_RETENTION", "off");
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-native-extension-process-")),
  );
  const configPath = join(directory, DESKTOP_EXTENSION_CONFIGURATION_FILE);
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-extension-runtime.v0",
      enabled: true,
      runtimeBindingsPath: null,
      agentVersionAssetsPath: null,
    }),
  );
  const model = await modelFixture();
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const resourcesPath = join(directory, "installed");
  let modelCatalog = ["native-fixture-model"];
  const originalProvider = {
    providerId: "native-fixture",
    endpoint: model.endpoint,
    modelId: "native-fixture-model",
    apiKey: "native-fixture-local-key-for-probe-0001",
  };
  let selectedProvider = originalProvider;
  let workspaceRoot: string | null = null;
  const logs: string[] = [];
  const output = () =>
    new Writable({
      write(chunk, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
  const stdout = output(),
    stderr = output();
  const supervisor = new RuntimeSupervisor({
    dataDirectory: directory,
    repositoryRoot,
    paths: runtimePaths({
      packaged: mode === "packaged",
      repositoryRoot,
      resourcesPath,
    }),
    provider: () => selectedProvider,
    providerModelCatalog: async () => modelCatalog,
    agentPlatformApiKeyForOrigin: () => null,
    workspaceRoot: () => workspaceRoot,
    logOutputs: { stdout, stderr },
    extensionRuntime: {
      configuration: () => loadDesktopExtensionRuntimeConfiguration(directory),
    },
  });
  try {
    if (mode === "packaged") {
      const destination = join(resourcesPath, "runtime");
      mkdirSync(destination, { recursive: true });
      const digest = getComfyImplementationDigest();
      const stage = await import(
        new URL("../../../scripts/stage-desktop-runtime.ts", import.meta.url)
          .href
      );
      const specs = stage.runtimeBundleSpecs(
        repositoryRoot,
        destination,
      ) as readonly { entry: string; output: string }[];
      for (const spec of specs) stage.bundleRuntime(spec, digest);
      writeFileSync(
        join(destination, EXTENSION_BUILD_IDENTITY_FILE),
        JSON.stringify(
          createScopedExtensionBuildIdentity({
            implementationDigest: digest,
            bundlePaths: specs.map((spec) => spec.output),
          }),
        ),
      );
    }
    await supervisor.start();
    const session = supervisor.session();
    const catalog = await json<ExtensionCatalogResponse>(
      session,
      "/api/v1/extensions",
    );
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    expect(catalog.body.extensions).toHaveLength(1);
    const entry = catalog.body.extensions[0]!;
    const api = `/api/v1/extensions/${entry.pluginId}`;
    const saved = await json<ExtensionConfigurationMutationResponse>(
      session,
      `${api}/configuration`,
      "PUT",
      {
        pluginVersion: entry.pluginVersion,
        expectedRevision: 0,
        parameters: { baseUrl: "https://comfyui.example.com/" },
        credentialBindings: [],
      },
      "native-config-1",
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const configuration = parseExtensionConfiguration(
      saved.body.configuration,
      digester,
    );
    expect(configuration.tenantId).toBe(DESKTOP_RUNTIME_OWNER.tenantId);
    expect(configuration.spaceId).toBe(DESKTOP_RUNTIME_OWNER.spaceId);
    const premature = await json<{ error: { code: string } }>(
      session,
      `${api}/activation`,
      "PUT",
      {
        state: "enabled",
        expectedRevision: 0,
        configurationRevision: configuration.revision,
        agentVersionId: pluginAgent,
      },
      "native-premature-activation",
    );
    expect(premature.status, JSON.stringify(premature.body)).toBe(409);
    expect(premature.body.error.code).toBe("extension_runtime_unavailable");
    expect(model.requests).toHaveLength(0);
    const databasePath = join(directory, "control.sqlite");
    const database = new DatabaseSync(databasePath);
    const baseRow = database
      .prepare(
        "SELECT agent_version_id,asset_json FROM agent_versions WHERE tenant_id=? ORDER BY agent_version_id",
      )
      .all(DESKTOP_RUNTIME_OWNER.tenantId)
      .find((row) =>
        /^local-desktop-[a-f0-9]{24}$/u.test(String(row.agent_version_id)),
      );
    database.close();
    expect(baseRow).toBeDefined();
    const defaultAsset = JSON.parse(String(baseRow!.asset_json));
    const baseVersion = parseAgentVersionAsset(defaultAsset, digester);
    // This fixture binds only Comfy tools. The default Agent now also owns
    // workspace commands; copying its catalog without their runtime is invalid.
    const pluginBase = compileAgentVersion(
      {
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: "native-extension-plugin-base-fixture",
        runtimeGeneration: baseVersion.runtimeGeneration,
        policySnapshotId: baseVersion.policySnapshotId,
        instructions: baseVersion.instructions,
        model: baseVersion.model,
        execution: baseVersion.execution,
        resources: baseVersion.resources,
        tools: [],
      },
      digester,
    );
    const version = compileComfyAgentVersion({
      base: { executionAuthority: "crewonKernel", version: pluginBase },
      agentVersionId: pluginAgent,
      runtimeGeneration: baseVersion.runtimeGeneration,
      policySnapshotId: "native-extension-policy",
      digester,
    });
    const snapshotPath = join(directory, "prepared-comfy-runtime.json"),
      runtimeBindingsPath = join(directory, "prepared-plugin-bindings.json"),
      agentVersionAssetsPath = join(directory, "prepared-plugin-assets.json");
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
      runtimeBindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [
          {
            tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
            agentVersionId: version.agentVersionId,
            contentDigest: version.contentDigest,
            authorityId: "native-extension-authority",
            workspaceBindingId: null,
            provider: {
              kind: "directResponses",
              endpoint: `${model.endpoint}/responses`,
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
      agentVersionAssetsPath,
      JSON.stringify({
        schemaVersion: "crewon.extension-agent-version-assets.v0",
        assets: [
          createAgentVersionAsset({
            tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
            version,
            createdAt: "2026-10-02T00:00:00.000Z",
          }),
        ],
      }),
      { flag: "wx", mode: 0o600 },
    );
    const immutable = [
      snapshotPath,
      runtimeBindingsPath,
      agentVersionAssetsPath,
    ].map((path) => ({ path, bytes: readFileSync(path) }));
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: "crewon.desktop-extension-runtime.v0",
        enabled: true,
        runtimeBindingsPath,
        agentVersionAssetsPath,
      }),
    );
    await supervisor.restart();
    expect(supervisor.session()).toEqual(session);
    let capsule: ResolvedExtensionRecoveryCapsule | null = null;
    let capsuleBytes: { path: string; bytes: Buffer }[] = [];
    if (mode === "packaged") {
      const report = parseExtensionRecoveryStartupReport(
        JSON.parse(
          readFileSync(
            join(directory, EXTENSION_RECOVERY_STARTUP_FILE),
            "utf8",
          ),
        ),
      );
      expect(report.outcome, JSON.stringify(report)).toBe("prepared");
      if (report.outcome !== "prepared")
        throw new Error("native_recovery_candidate_missing");
      capsule = await resolveExtensionRecoveryCapsule({
        dataRoot: directory,
        capsuleId: report.manifest.capsuleId,
      });
      expect(capsule.manifest.targets).toHaveLength(1);
      expect(capsule.manifest.targets[0]!.agentVersionId).toBe(pluginAgent);
      capsuleBytes = [
        ...capsule.files,
        { path: join(capsule.directory, "manifest.json") },
      ].map(({ path }) => ({ path, bytes: readFileSync(path) }));
      for (const file of capsuleBytes)
        expect(file.bytes.toString("utf8")).not.toContain(
          "native-fixture-local-key-for-probe-0001",
        );
    }
    for (const input of immutable)
      expect(readFileSync(input.path)).toEqual(input.bytes);
    const ready = await json<ExtensionRuntimeResponse>(
      session,
      `${api}/runtime?agentVersionId=${pluginAgent}&configurationRevision=${configuration.revision}`,
    );
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body.readiness.outcome, JSON.stringify(ready.body)).toBe(
      "ready",
    );
    const activation = await json<ExtensionActivationMutationResponse>(
      session,
      `${api}/activation`,
      "PUT",
      {
        state: "enabled",
        expectedRevision: 0,
        configurationRevision: configuration.revision,
        agentVersionId: pluginAgent,
      },
      "native-activate-1",
    );
    expect(activation.status, JSON.stringify(activation.body)).toBe(200);
    expect(activation.body.activation.target?.agentVersionId).toBe(pluginAgent);
    expect(model.requests).toHaveLength(0);
    const thread = await json<ThreadMutationResponse>(
      session,
      "/api/v1/threads",
      "POST",
      { title: "Native plugin task" },
      "native-thread-1",
    );
    expect(thread.status).toBe(201);
    const task = await json<ExtensionTaskMutationResponse>(
      session,
      `${api}/tasks`,
      "POST",
      {
        threadId: thread.body.thread.threadId,
        expectedThreadRevision: thread.body.thread.revision,
        intent: {
          kind: "generate",
          input: { prompt: "Verify native task admission only." },
        },
      },
      "native-task-1",
    );
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    const frames = await stream(session, task.body.runId);
    expect(frames).toContain("event: run.completed");
    expect(frames).toContain(pluginText);
    expect(frames).not.toContain("event: tool.");
    const resumed = await stream(session, task.body.runId, "1");
    expect(resumed).toContain(pluginText);
    expect(resumed).not.toContain("event: run.created\n");
    const projection = await json<GetExtensionTaskResponse>(
      session,
      `${api}/tasks/${task.body.runId}`,
    );
    expect(projection.status, JSON.stringify(projection.body)).toBe(200);
    expect(projection.body.task.runStatus).toBe("completed");
    const normalThread = await json<ThreadMutationResponse>(
      session,
      "/api/v1/threads",
      "POST",
      { title: "Default native task" },
      "native-default-thread",
    );
    expect(normalThread.status).toBe(201);
    const normalTurn = await json<StartTurnResponse>(
      session,
      `/api/v1/threads/${normalThread.body.thread.threadId}/turns`,
      "POST",
      {
        expectedRevision: normalThread.body.thread.revision,
        content: "Use the existing default Agent.",
        agentVersionId: null,
        executionIntent: "none",
      },
      "native-default-turn",
    );
    expect(normalTurn.status, JSON.stringify(normalTurn.body)).toBe(201);
    expect(await stream(session, normalTurn.body.run.runId)).toContain(
      defaultText,
    );
    expect(model.requests).toHaveLength(2);
    expect(
      (model.requests[0]!.tools as { name: string }[]).some((tool) =>
        tool.name.startsWith("crewon_comfyui_"),
      ),
    ).toBe(true);
    expect(
      (model.requests[1]!.tools as { name: string }[]).some((tool) =>
        tool.name.startsWith("crewon_comfyui_"),
      ),
    ).toBe(false);
    const originalToolNames = baseVersion.tools.map((tool) => tool.name);
    expect(originalToolNames.length).toBeGreaterThan(0);
    expect(
      (model.requests[1]!.tools as { name: string }[]).map((tool) => tool.name),
    ).toEqual(expect.arrayContaining(originalToolNames));
    expect(
      (model.requests[0]!.tools as { name: string }[]).some((tool) =>
        originalToolNames.includes(tool.name),
      ),
    ).toBe(false);
    await supervisor.stop();
    const finalDatabase = new DatabaseSync(databasePath);
    try {
      const finalAsset = finalDatabase
        .prepare(
          "SELECT asset_json FROM agent_versions WHERE tenant_id=? AND agent_version_id=?",
        )
        .get(DESKTOP_RUNTIME_OWNER.tenantId, baseVersion.agentVersionId);
      expect(JSON.parse(String(finalAsset!.asset_json))).toEqual(defaultAsset);
      expect(
        finalDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM extension_external_operations",
          )
          .get()!.count,
      ).toBe(0);
      const normalRun = finalDatabase
        .prepare(
          "SELECT state_json FROM run_snapshots WHERE tenant_id=? AND run_id=?",
        )
        .get(DESKTOP_RUNTIME_OWNER.tenantId, normalTurn.body.run.runId)!;
      expect(JSON.parse(String(normalRun.state_json)).agentVersionId).toBe(
        baseVersion.agentVersionId,
      );
    } finally {
      finalDatabase.close();
    }
    if (capsule !== null) {
      // Current default/catalog upgrades must preserve the first valid plugin capsule.
      modelCatalog = ["native-fixture-model", "native-other-model"];
      await supervisor.start();
      const reused = parseExtensionRecoveryStartupReport(
        JSON.parse(
          readFileSync(
            join(directory, EXTENSION_RECOVERY_STARTUP_FILE),
            "utf8",
          ),
        ),
      );
      expect(reused.outcome, logs.join("").slice(-16000)).toBe("prepared");
      if (reused.outcome !== "prepared")
        throw new Error("native_recovery_reuse_missing");
      expect(reused.manifest).toEqual(capsule.manifest);
      for (const file of capsuleBytes)
        expect(readFileSync(file.path)).toEqual(file.bytes);
      expect(model.requests).toHaveLength(2);
      const currentReady = await json<ExtensionRuntimeResponse>(
        session,
        `${api}/runtime?agentVersionId=${pluginAgent}&configurationRevision=${configuration.revision}`,
      );
      expect(currentReady.status, JSON.stringify(currentReady.body)).toBe(200);
      expect(currentReady.body.readiness.outcome).toBe("ready");
      expect(
        currentReady.body.readiness.outcome === "ready" &&
          currentReady.body.readiness.target,
      ).toEqual(capsule.manifest.targets[0]);
      selectedProvider = {
        ...originalProvider,
        providerId: "native-fixture-renamed",
      };
      await supervisor.restart();
      expect(supervisor.session()).toEqual(session);
      const renamed = parseExtensionRecoveryStartupReport(
        JSON.parse(
          readFileSync(
            join(directory, EXTENSION_RECOVERY_STARTUP_FILE),
            "utf8",
          ),
        ),
      );
      expect(renamed.outcome, logs.join("").slice(-16000)).toBe("unsupported");
      const renamedReady = await json<ExtensionRuntimeResponse>(
        session,
        `${api}/runtime?agentVersionId=${pluginAgent}&configurationRevision=${configuration.revision}`,
      );
      expect(renamedReady.status).toBe(200);
      expect(renamedReady.body.readiness.outcome).toBe("ready");
      workspaceRoot = join(directory, "workspace");
      mkdirSync(workspaceRoot);
      await supervisor.restart();
      expect(supervisor.session()).toEqual(session);
      const workspaceReady = await json<ExtensionRuntimeResponse>(
        session,
        `${api}/runtime?agentVersionId=${pluginAgent}&configurationRevision=${configuration.revision}`,
      );
      expect(workspaceReady.status).toBe(200);
      expect(workspaceReady.body.readiness.outcome).toBe("ready");
      for (const file of capsuleBytes)
        expect(readFileSync(file.path)).toEqual(file.bytes);
      workspaceRoot = null;
      const alternate = await modelFixture();
      try {
        selectedProvider = {
          ...originalProvider,
          providerId: "native-alternate",
          endpoint: alternate.endpoint,
          apiKey: "native-new-provider-key-for-probe-0002",
        };
        vi.stubEnv("CREWON_MODEL_CREDENTIAL_REQUIRED", "1");
        await supervisor.restart();
        const isolated = parseExtensionRecoveryStartupReport(
          JSON.parse(
            readFileSync(
              join(directory, EXTENSION_RECOVERY_STARTUP_FILE),
              "utf8",
            ),
          ),
        );
        expect(isolated.outcome, logs.join("").slice(-16000)).toBe(
          "pluginUnavailable",
        );
        const unavailableReady = await json<ExtensionRuntimeResponse>(
          session,
          `${api}/runtime?agentVersionId=${pluginAgent}&configurationRevision=${configuration.revision}`,
        );
        expect(unavailableReady.status).toBe(200);
        expect(unavailableReady.body.readiness.outcome).toBe("unavailable");
        const changedThread = await json<ThreadMutationResponse>(
          session,
          "/api/v1/threads",
          "POST",
          { title: "Changed provider default" },
          "native-changed-provider-thread",
        );
        expect(changedThread.status).toBe(201);
        const changedTurn = await json<StartTurnResponse>(
          session,
          `/api/v1/threads/${changedThread.body.thread.threadId}/turns`,
          "POST",
          {
            expectedRevision: changedThread.body.thread.revision,
            content: "Use current provider.",
            agentVersionId: null,
            executionIntent: "none",
          },
          "native-changed-provider-turn",
        );
        expect(changedTurn.status, JSON.stringify(changedTurn.body)).toBe(201);
        expect(await stream(session, changedTurn.body.run.runId)).toContain(
          defaultText,
        );
        expect(alternate.requests).toHaveLength(1);
        expect(alternate.authorizations).toEqual([
          "Bearer native-new-provider-key-for-probe-0002",
        ]);
        expect(model.requests).toHaveLength(2);
        for (const file of capsuleBytes)
          expect(readFileSync(file.path)).toEqual(file.bytes);
      } finally {
        await supervisor.stop();
        await alternate.close();
        selectedProvider = originalProvider;
        vi.stubEnv("CREWON_MODEL_CREDENTIAL_REQUIRED", "0");
      }
      await supervisor.stop();
      // Explicitly selecting the saved pair keeps current execution usable without operator source files.
      writeFileSync(
        configPath,
        JSON.stringify({
          schemaVersion: "crewon.desktop-extension-runtime.v0",
          enabled: true,
          runtimeBindingsPath: join(capsule.directory, "plugin-bindings.json"),
          agentVersionAssetsPath: join(capsule.directory, "plugin-assets.json"),
        }),
      );
      for (const input of immutable) unlinkSync(input.path);
      await supervisor.start();
      const savedReady = await json<ExtensionRuntimeResponse>(
        session,
        `${api}/runtime?agentVersionId=${pluginAgent}&configurationRevision=${configuration.revision}`,
      );
      expect(savedReady.status, JSON.stringify(savedReady.body)).toBe(200);
      expect(savedReady.body.readiness.outcome).toBe("ready");
      for (const file of capsuleBytes)
        expect(readFileSync(file.path)).toEqual(file.bytes);
      await supervisor.stop();
      // Archive verification remains possible after the installed source bundles are removed.
      rmSync(resourcesPath, { recursive: true });
      const archived = await resolveRetainedExtensionBuild({
        dataRoot: directory,
        implementationDigest: capsule.manifest.implementationDigest,
        expectedBuildIdentityDigest: capsule.manifest.buildIdentityDigest,
      });
      expect(archived.bundles).toHaveLength(7);
      for (const bundle of archived.bundles)
        expect(readFileSync(bundle.path).length).toBeGreaterThan(0);
      expect(model.requests).toHaveLength(2);
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${logs.join("").slice(-16000)}`,
      { cause: error },
    );
  } finally {
    await supervisor.stop();
    stdout.destroy();
    stderr.destroy();
    await model.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}

it.each(["source", "packaged"] as const)(
  "runs the native %s metadata → configuration → prepared supplement → restart → task/SSE/default path",
  runNativeFlow,
  120000,
);
