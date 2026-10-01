import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { SqliteRunStore } from "@crewon/store";
import type { ActorContext, AuthorizationPort } from "@crewon/application";
import type { ExtensionConfiguration } from "@crewon/domain";
import {
  activateStandaloneRuntimeAgentVersionRelease,
  compileRuntimeAgentVersion,
  compileComfyAgentVersion,
  createStandaloneRuntimeWorker,
  extensionCompositionDeployments,
  type StandaloneRuntimeWorker,
} from "@crewon/runtime-worker";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { RuntimeExtensionHostService } from "../../runtime-worker/src/extensions/extension-host-service.ts";
import { startRuntimeExtensionHostServer } from "../../runtime-worker/src/extensions/extension-host-server.ts";
import {
  COMFY_SUBMIT_TOOL,
  COMFY_OBSERVE_TOOL,
} from "../../runtime-worker/src/extensions/comfyui-tool-catalog.ts";
import { NodeSha256ContentDigester } from "../../runtime-worker/src/standalone-adapters.ts";
import { createStandaloneControlApiWithExtensions } from "./standalone-composition.ts";

const actor: ActorContext = {
  principalId: "owner",
  actorId: "actor",
  tenantId: "tenant",
  spaceId: "space",
};
const authorization: AuthorizationPort = {
  authorize: async () => ({ outcome: "allow" }),
};
const token = "private-host-token-".repeat(3);
const headers = {
  "authorization": `Bearer ${"control-session-".repeat(3)}`,
  "x-csrf-token": "csrf-token-".repeat(4),
  "origin": "http://127.0.0.1:5173",
};

test("actual Control and Worker composition admits, crashes after acceptance and resumes one Comfy operation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-extension-flow-"));
  const databasePath = join(root, "control.sqlite");
  const snapshotPath = join(root, "extension.json");
  const bindingsPath = join(root, "bindings.json");
  const models: Record<string, unknown>[] = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
    models.push(body);
    const input = body.input as {
      type: string;
      call_id?: string;
      output?: string;
    }[];
    const last = input
      .filter((item) => item.type === "function_call_output")
      .at(-1);
    const output =
      last === undefined
        ? [
            {
              type: "function_call",
              id: "fc-submit",
              call_id: "submit",
              name: COMFY_SUBMIT_TOOL,
              arguments: JSON.stringify({
                prompt: "A ceramic teapot on a sunlit table",
              }),
            },
          ]
        : last.call_id === "submit"
          ? [
              {
                type: "function_call",
                id: "fc-observe",
                call_id: "observe",
                name: COMFY_OBSERVE_TOOL,
                arguments: JSON.stringify({
                  operationId: JSON.parse(last.output!).operationId,
                }),
              },
            ]
          : [];
    const id = `response-${models.length}`;
    const events: unknown[] = [
      { type: "response.created", response: { id, status: "in_progress" } },
    ];
    for (const item of output)
      events.push({ type: "response.output_item.done", item });
    if (output.length === 0)
      events.push({
        type: "response.output_text.delta",
        delta: `图片已生成：${JSON.parse(last!.output!).images[0].url}`,
      });
    events.push({
      type: "response.completed",
      response: { id, status: "completed", output },
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  await new Promise<void>((resolve) =>
    modelServer.listen(0, "127.0.0.1", resolve),
  );
  const address = modelServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/responses`;
  let control: Awaited<
    ReturnType<typeof createStandaloneControlApiWithExtensions>
  > | null = null;
  let runtime: StandaloneRuntimeWorker | null = null;
  const inspection = new SqliteRunStore(databasePath);
  const metadata = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    service: new RuntimeExtensionHostService({
      authorization,
      resolveActor: async () => actor,
      deployments: inspection,
      runtimeResolver: { acquire: async () => null },
    }),
  });
  t.after(async () => {
    await control?.app.close();
    await runtime?.close();
    await metadata.close();
    await inspection.close();
    await new Promise<void>((resolve) => {
      modelServer.close(() => resolve());
      modelServer.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  });
  const openControl = async (origin: string) =>
    createStandaloneControlApiWithExtensions({
      databasePath,
      actor,
      defaultAgentVersionId: "default-agent",
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
      sessionToken: "control-session-".repeat(3),
      csrfToken: headers["x-csrf-token"],
      allowedOrigins: [headers.origin],
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      automationScanIntervalMs: null,
      extensionWorker: { origin, token },
    });
  control = await openControl(metadata.origin);
  const base = "/api/v1/extensions/crewon.comfyui-krea2";
  const saved = await control.app.inject({
    method: "PUT",
    url: `${base}/configuration`,
    headers: { ...headers, "idempotency-key": "configuration" },
    payload: {
      pluginVersion: "0.1.0",
      expectedRevision: 0,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const configuration = saved.json().configuration as ExtensionConfiguration;
  const activation = {
    configurationRevision: 1,
    expectedRevision: 0,
    state: "enabled",
    agentVersionId: "comfy-agent",
  };
  const absent = await control.app.inject({
    method: "PUT",
    url: `${base}/activation`,
    headers: { ...headers, "idempotency-key": "not-ready" },
    payload: activation,
  });
  assert.ok(absent.statusCode >= 400, absent.body);
  assert.equal(
    await inspection.extensionStore().loadExtensionActivation(configuration),
    null,
  );
  await control.app.close();
  control = null;
  await metadata.close();

  // Fixture bootstrap transport is never called. The explicit plugin is materialized
  // by the real Direct Responses factory and talks to the local HTTP model fixture.
  const bootstrap = {
    runtimeTenantId: actor.tenantId,
    route: {
      authorityId: "authority",
      runtimeGeneration: "generation",
      agentVersionId: "default-agent",
      policySnapshotId: "policy",
      workspaceBindingId: null,
    },
    transport: {
      adapterName: "direct-responses",
      adapterVersion: "1+responses-lite",
      modelId: "model",
      async *stream(): AsyncGenerator<never> {
        throw new Error("default_model_called");
      },
    },
    agentInstructions: "Default chat instructions",
    scanIntervalMs: null,
  };
  const defaultVersion = compileRuntimeAgentVersion(bootstrap);
  const version = compileComfyAgentVersion({
    base: { executionAuthority: "crewonKernel", version: defaultVersion },
    agentVersionId: "comfy-agent",
    runtimeGeneration: "comfy-generation",
    policySnapshotId: "comfy-policy",
    digester: new NodeSha256ContentDigester(),
  });
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      schemaVersion: "crewon.extension-runtime-config.v0",
      configuration,
      approvalRequirement: "none",
    }),
  );
  writeFileSync(
    bindingsPath,
    JSON.stringify({
      schemaVersion: "crewon.agent-version-runtime-bindings.v0",
      bindings: [
        {
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
          contentDigest: version.contentDigest,
          authorityId: "comfy-authority",
          workspaceBindingId: null,
          provider: {
            kind: "directResponses",
            endpoint,
            apiKeyEnvironment: null,
            storeResponses: false,
            requestProfile: "responsesLite",
            idleTimeoutMs: 1000,
            sequencePolicy: "whenPresent",
          },
          mcpStdioConfigPath: null,
          deviceToolConfigPath: null,
          remoteMcpConfigPath: null,
          extensionConfigPath: snapshotPath,
        },
      ],
    }),
  );
  const requests: string[] = [];
  const extensionRuntime = {
    runtimeBindingsPath: bindingsPath,
    authorization,
    resolveActor: async () => actor,
    environment: {},
    privateHost: { port: 0, token },
    dns: {
      resolveAll: async () => [{ address: "8.8.8.8", family: 4 as const }],
    },
    transport: {
      request: async (input: {
        method: string;
        body?: Uint8Array;
        target: { endpoint: URL };
      }) => {
        const path = input.target.endpoint.pathname;
        requests.push(`${input.method} ${path}`);
        const id =
          input.method === "POST"
            ? (JSON.parse(Buffer.from(input.body!).toString())
                .prompt_id as string)
            : path.split("/").at(-1)!;
        const result =
          input.method === "POST"
            ? { prompt_id: id }
            : {
                [id]: {
                  status: { completed: true, status_str: "success" },
                  outputs: {
                    "29": {
                      images: [
                        {
                          filename: `${id}.png`,
                          subfolder: "",
                          type: "output",
                        },
                      ],
                    },
                  },
                },
              };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(result)),
        };
      },
    },
  };
  await activateStandaloneRuntimeAgentVersionRelease({
    ...bootstrap,
    databasePath,
    additionalAgentVersions: [version],
    agentVersionDeployments: extensionCompositionDeployments({
      config: extensionRuntime,
      tenantId: actor.tenantId,
      defaultAgentVersionId: bootstrap.route.agentVersionId,
    }),
    actor,
    authorization,
    clock: { now: () => new Date().toISOString() },
    activationId: "release",
  });
  const openWorker = (crash: boolean) =>
    createStandaloneRuntimeWorker({
      ...bootstrap,
      databasePath,
      additionalAgentVersions: [version],
      extensionRuntime,
      retryAfterMs: 0,
      afterToolProviderResolved: async () => {
        if (crash) throw new Error("lost_after_acceptance");
      },
    });
  runtime = await openWorker(true);
  assert.equal(
    runtime.agentVersion.contentDigest,
    defaultVersion.contentDigest,
  );
  assert.deepEqual(runtime.agentVersion.tools, []);
  assert.equal(runtime.agentVersion.instructions, "Default chat instructions");
  assert.ok(runtime.extensionHostOrigin !== null);
  control = await openControl(runtime.extensionHostOrigin);
  const enabled = await control.app.inject({
    method: "PUT",
    url: `${base}/activation`,
    headers: { ...headers, "idempotency-key": "activation" },
    payload: activation,
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(
    enabled.json().activation.target.agentVersionId,
    version.agentVersionId,
  );
  await seedThread(inspection, { ...actor, threadId: "image-thread" });
  const request = {
    method: "POST" as const,
    url: `${base}/tasks`,
    headers: { ...headers, "idempotency-key": "generation" },
    payload: {
      threadId: "image-thread",
      expectedThreadRevision: 1,
      intent: { kind: "generate", input: { prompt: "生成一张茶壶照片" } },
    },
  };
  const created = await control.app.inject(request);
  assert.equal(created.statusCode, 200, created.body);
  const runId = created.json().runId as string;
  assert.equal((await control.app.inject(request)).json().runId, runId);
  assert.deepEqual(await runtime.worker.wake(), {
    kind: "retried",
    runId,
    code: "lost_after_acceptance",
  });
  const locator = { ...actor, runId };
  const cursor = (await inspection.listRunEvents(locator, 0, 200)).at(
    -1,
  )!.sequence;
  const disabled = await control.app.inject({
    method: "PUT",
    url: `${base}/activation`,
    headers: { ...headers, "idempotency-key": "disable" },
    payload: {
      configurationRevision: 1,
      expectedRevision: 1,
      state: "disabled",
      agentVersionId: null,
    },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  await control.app.close();
  control = null;
  await runtime.close();
  runtime = null;
  runtime = await openWorker(false);
  control = await openControl(runtime.extensionHostOrigin!);
  assert.deepEqual(await runtime.worker.wake(), { kind: "completed", runId });
  assert.equal(requests.filter((item) => item === "POST /prompt").length, 1);
  const events = await inspection.listRunEvents(locator, cursor, 200);
  assert.ok(events.every((event) => event.sequence > cursor));
  assert.equal(
    events.filter((event) => event.type === "tool.completed").length,
    2,
  );
  assert.match(
    events
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.data.delta)
      .join(""),
    /图片已生成：https:\/\/comfy.example\/view/u,
  );
  assert.equal((await inspection.loadRun(locator))?.status, "completed");
  assert.equal(
    (await inspection.extensionStore().loadExtensionRunBinding(locator))?.target
      .agentVersionId,
    version.agentVersionId,
  );
  await control.app.listen({ host: "127.0.0.1", port: 0 });
  const controlAddress = control.app.server.address();
  assert.ok(controlAddress !== null && typeof controlAddress !== "string");
  const readEvents = async () => {
    const response = await fetch(
      `http://127.0.0.1:${controlAddress.port}/api/v1/runs/${runId}/events`,
      {
        headers: { ...headers, "last-event-id": String(cursor) },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/event-stream/u);
    return response.text();
  };
  const stream = await readEvents();
  assert.match(stream, /event: model.output.delta/u);
  assert.match(stream, /comfy.example\/view/u);
  assert.match(stream, /event: run.completed/u);
  const sequences = [...stream.matchAll(/^id: (\d+)$/gmu)].map((match) =>
    Number(match[1]),
  );
  assert.ok(
    sequences.length > 0 && sequences.every((sequence) => sequence > cursor),
  );
  assert.equal(await readEvents(), stream);
  assert.ok(
    models.every(
      (body) =>
        JSON.stringify(body).includes(COMFY_SUBMIT_TOOL) &&
        JSON.stringify(body).includes("生成一张茶壶照片"),
    ),
  );
  const replay = await control.app.inject(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().runId, runId);
  assert.equal(requests.filter((item) => item === "POST /prompt").length, 1);
});
