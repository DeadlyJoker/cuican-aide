import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { SqliteRunStore } from "@crewon/store";
import type { AuthorizationPort } from "@crewon/application";
import type { ExtensionConfiguration } from "@crewon/domain";
import {
  activateStandaloneRuntimeAgentVersionRelease,
  compileComfyAgentVersion,
  compileRuntimeAgentVersion,
  createStandaloneRuntimeWorker,
  extensionCompositionDeployments,
  type StandaloneRuntimeWorker,
} from "@crewon/runtime-worker";
import { RuntimeExtensionHostService } from "../../runtime-worker/src/extensions/extension-host-service.ts";
import { startRuntimeExtensionHostServer } from "../../runtime-worker/src/extensions/extension-host-server.ts";
import {
  COMFY_OBSERVE_TOOL,
  COMFY_SUBMIT_TOOL,
} from "../../runtime-worker/src/extensions/comfyui-tool-catalog.ts";
import { NodeSha256ContentDigester } from "../../runtime-worker/src/standalone-adapters.ts";
import { createStandaloneControlApiWithExtensions } from "./standalone-composition.ts";
import type { ExtensionWorkerPeerConfig } from "./extension-host-router.ts";

export const queryActor = {
  principalId: "query-owner",
  actorId: "query-actor",
  tenantId: "query-tenant",
  spaceId: "query-space",
};
export const queryHeaders = {
  "authorization": `Bearer ${"query-session-".repeat(3)}`,
  "x-csrf-token": "query-csrf-".repeat(4),
  "origin": "http://127.0.0.1:5173",
};
export const queryPluginPath = "/api/v1/extensions/crewon.comfyui-krea2";
export const queryDefaultText = "Default Agent behavior is unchanged.";

/** Actual composition, private HTTP and SQLite. Only the external model/DNS/Comfy are fixtures. */
export async function queryRoutingFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crewon-query-routing-"));
  const databasePath = join(root, "control.sqlite");
  const inspection = new SqliteRunStore(databasePath);
  const models: Record<string, unknown>[] = [];
  const externalRequests: string[] = [];
  const controls: Awaited<
    ReturnType<typeof createStandaloneControlApiWithExtensions>
  >[] = [];
  const runtimes: StandaloneRuntimeWorker[] = [];
  const authorization: AuthorizationPort = {
    authorize: async () => ({ outcome: "allow" }),
  };
  const modelServer = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/responses");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    models.push(body);
    const items = body.input as {
      type?: string;
      role?: string;
      content?: string | { text?: string }[];
      call_id?: string;
      output?: string;
    }[];
    const last = items
      .filter((item) => item.type === "function_call_output")
      .at(-1);
    const query = items
      .filter((item) => item.role === "user")
      .flatMap((item) =>
        typeof item.content === "string"
          ? [item.content]
          : (item.content ?? []).map((part) => part.text ?? ""),
      )
      .map((text) => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })
      .find((value) => value?.kind === "query");
    const output =
      last === undefined
        ? [
            {
              type: "function_call",
              id: "fc-start",
              call_id: query ? "observe" : "submit",
              name: query ? COMFY_OBSERVE_TOOL : COMFY_SUBMIT_TOOL,
              arguments: JSON.stringify(
                query
                  ? { operationId: query.operationId }
                  : { prompt: "A ceramic teapot" },
              ),
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
    const id = randomUUID();
    const text =
      output.length === 0
        ? `图片已生成：${JSON.parse(last!.output!).images[0].url}`
        : null;
    const events: Record<string, unknown>[] = [
      { type: "response.created", response: { id, status: "in_progress" } },
    ];
    for (const item of output)
      events.push({ type: "response.output_item.done", item });
    if (text !== null)
      events.push({ type: "response.output_text.delta", delta: text });
    events.push({
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output:
          text === null
            ? output
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text }],
                },
              ],
      },
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events
        .map(
          (event, sequence_number) =>
            `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise<void>((resolve) =>
    modelServer.listen(0, "127.0.0.1", resolve),
  );
  const address = modelServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/responses`;
  const token = "query-private-host-".repeat(3);
  const metadata = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    service: new RuntimeExtensionHostService({
      authorization,
      resolveActor: async () => queryActor,
      deployments: inspection,
      runtimeResolver: { acquire: async () => null },
    }),
  });
  t.after(async () => {
    await Promise.allSettled(controls.map((control) => control.app.close()));
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    await metadata.close();
    await inspection.close();
    await new Promise<void>((resolve) => {
      modelServer.close(() => resolve());
      modelServer.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  });
  const bootstrap = {
    runtimeTenantId: queryActor.tenantId,
    route: {
      authorityId: "default-authority",
      runtimeGeneration: "default-generation",
      agentVersionId: "default-agent",
      policySnapshotId: "default-policy",
      workspaceBindingId: null,
    },
    transport: {
      adapterName: "direct-responses",
      adapterVersion: "1+responses-lite",
      modelId: "query-fixture-model",
      async *stream() {
        yield { type: "output.delta" as const, delta: queryDefaultText };
        yield { type: "completed" as const, checkpoint: null };
      },
    },
    agentInstructions: "Default chat instructions",
    scanIntervalMs: null,
  };
  const defaultVersion = compileRuntimeAgentVersion(bootstrap);
  const openControl = async (
    current: ExtensionWorkerPeerConfig,
    historicalPeers: readonly ExtensionWorkerPeerConfig[] = [],
  ) => {
    const control = await createStandaloneControlApiWithExtensions({
      databasePath,
      actor: queryActor,
      defaultAgentVersionId: bootstrap.route.agentVersionId,
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
      sessionToken: "query-session-".repeat(3),
      csrfToken: queryHeaders["x-csrf-token"],
      allowedOrigins: [queryHeaders.origin],
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      automationScanIntervalMs: null,
      extensionWorker: { ...current, historicalPeers },
    });
    controls.push(control);
    return control;
  };
  const prepareWorker = async (
    id: string,
    configuration: ExtensionConfiguration,
  ) => {
    const version = compileComfyAgentVersion({
      base: { executionAuthority: "crewonKernel", version: defaultVersion },
      agentVersionId: `comfy-${id}`,
      runtimeGeneration: `generation-${id}`,
      policySnapshotId: `policy-${id}`,
      digester: new NodeSha256ContentDigester(),
    });
    const snapshotPath = join(root, `${id}-extension.json`);
    const bindingsPath = join(root, `${id}-bindings.json`);
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
            tenantId: queryActor.tenantId,
            agentVersionId: version.agentVersionId,
            contentDigest: version.contentDigest,
            authorityId: `authority-${id}`,
            workspaceBindingId: null,
            provider: {
              kind: "directResponses",
              endpoint,
              apiKeyEnvironment: null,
              storeResponses: false,
              requestProfile: "responsesLite",
              idleTimeoutMs: 5000,
              sequencePolicy: "required",
            },
            mcpStdioConfigPath: null,
            deviceToolConfigPath: null,
            remoteMcpConfigPath: null,
            extensionConfigPath: snapshotPath,
          },
        ],
      }),
    );
    const extensionRuntime = {
      runtimeBindingsPath: bindingsPath,
      authorization,
      resolveActor: async () => queryActor,
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
          externalRequests.push(`${input.method} ${path}`);
          const operationId =
            input.method === "POST"
              ? JSON.parse(Buffer.from(input.body!).toString()).prompt_id
              : path.split("/").at(-1)!;
          const value =
            input.method === "POST"
              ? { prompt_id: operationId }
              : {
                  [operationId]: {
                    status: { completed: true, status_str: "success" },
                    outputs: {
                      "29": {
                        images: [
                          {
                            filename: `${operationId}.png`,
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
            body: Buffer.from(JSON.stringify(value)),
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
        tenantId: queryActor.tenantId,
        defaultAgentVersionId: bootstrap.route.agentVersionId,
      }),
      actor: queryActor,
      authorization,
      clock: { now: () => new Date().toISOString() },
      activationId: `release-${id}`,
    });
    const open = async (mode: "current" | "historical") => {
      const runtime = await createStandaloneRuntimeWorker({
        ...bootstrap,
        databasePath,
        additionalAgentVersions: [version],
        extensionRuntime,
        extensionExecutionMode: mode,
      });
      runtimes.push(runtime);
      assert.deepEqual(runtime.agentVersion, defaultVersion);
      assert.ok(runtime.extensionHostOrigin);
      return {
        runtime,
        version,
        peer: { origin: runtime.extensionHostOrigin, token },
      };
    };
    return {
      ...(await open("current")),
      reopenHistorical: () => open("historical"),
    };
  };
  return {
    root,
    databasePath,
    inspection,
    bootstrap,
    defaultVersion,
    models,
    externalRequests,
    token,
    metadataPeer: { origin: metadata.origin, token },
    prepareWorker,
    openControl,
  };
}
