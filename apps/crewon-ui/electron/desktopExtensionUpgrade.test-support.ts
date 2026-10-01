import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentVersionAsset,
  parseAgentVersionAsset,
} from "@crewon/agent-version";
import type {
  ExtensionConfiguration,
  ExtensionRunBinding,
} from "@crewon/domain";
import { compileComfyAgentVersion } from "../../runtime-worker/src/extensions/comfyui-agent-version.ts";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  DESKTOP_EXTENSION_CONFIGURATION_FILE,
  DESKTOP_RUNTIME_OWNER,
} from "./desktopExtensionRuntime.ts";
import type { ControlRuntimeSession } from "./runtimeSupervisor.ts";

export const upgradeDigester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
export const upgradeDefaultText = "Native current default is available.";
export const upgradeSubmitText =
  "Native operation accepted; query its existing operation.";
export const upgradeQueryText = "Native historical operation observed.";
const submit = "crewon_comfyui_krea2__submit",
  observe = "crewon_comfyui_krea2__observe";

/** Local external API fixtures, not production Comfy/DNS or model compatibility evidence. */
export async function upgradeProviderFixtures(
  options: {
    modelResponseDelayMs?: number;
    currentTurnOutputsOnly?: boolean;
  } = {},
) {
  assert.ok(
    options.modelResponseDelayMs === undefined ||
      (Number.isSafeInteger(options.modelResponseDelayMs) &&
        options.modelResponseDelayMs >= 0 &&
        options.modelResponseDelayMs <= 2_000),
  );
  const modelRequests: Record<string, unknown>[] = [];
  const authorizations: (string | undefined)[] = [];
  const comfyRequests: string[] = [];
  const prompts = new Set<string>();
  const model = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/responses");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.ok(Buffer.concat(chunks).byteLength <= 128 * 1024);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    modelRequests.push(body);
    authorizations.push(request.headers.authorization);
    const items = body.input as {
      type?: string;
      role?: string;
      content?: string | { text?: string }[];
      call_id?: string;
      output?: string;
    }[];
    const latestUserIndex = items.findLastIndex((item) => item.role === "user");
    const last = items
      .filter(
        (item, index) =>
          item.type === "function_call_output" &&
          (!options.currentTurnOutputsOnly || index > latestUserIndex),
      )
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
    const plugin = (body.tools as { name?: string }[]).some(
      (tool) => tool.name === submit,
    );
    const calls =
      plugin && last === undefined
        ? [
            {
              type: "function_call",
              id: randomUUID(),
              call_id: query ? "observe" : "submit",
              name: query ? observe : submit,
              arguments: JSON.stringify(
                query
                  ? { operationId: query.operationId }
                  : { prompt: "A local fixture ceramic teapot" },
              ),
            },
          ]
        : [];
    const text = !plugin
      ? upgradeDefaultText
      : last === undefined
        ? null
        : query
          ? upgradeQueryText
          : upgradeSubmitText;
    const id = randomUUID();
    const message = {
      id: `${id}-message`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const events: Record<string, unknown>[] = [
      {
        type: "response.created",
        response: { id, status: "in_progress", output: [] },
      },
    ];
    calls.forEach((item) =>
      events.push({ type: "response.output_item.done", output_index: 0, item }),
    );
    if (text !== null) {
      events.push({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
      events.push({
        type: "response.output_item.done",
        output_index: 0,
        item: message,
      });
    }
    events.push({
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: text === null ? calls : [message],
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    });
    if (options.modelResponseDelayMs) await delay(options.modelResponseDelayMs);
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
  const comfy = createTlsServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    async (request, response) => {
      comfyRequests.push(`${request.method} ${request.url}`);
      assert.equal(
        (request.socket as import("node:tls").TLSSocket).getProtocol(),
        "TLSv1.3",
      );
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/prompt") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        assert.ok(Buffer.concat(chunks).byteLength <= 128 * 1024);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(body.prompt["51"].inputs.text.includes("teapot"));
        prompts.add(body.prompt_id);
        response.end(JSON.stringify({ prompt_id: body.prompt_id }));
      } else if (
        request.method === "GET" &&
        request.url?.startsWith("/history/")
      ) {
        const id = request.url.slice("/history/".length);
        assert.ok(
          prompts.has(id),
          "Query must use a genuinely submitted provider operation",
        );
        response.end(
          JSON.stringify({
            [id]: {
              status: { completed: true, status_str: "success" },
              outputs: {
                "29": {
                  images: [
                    {
                      filename: "native-fixture.png",
                      subfolder: "",
                      type: "output",
                    },
                  ],
                },
              },
            },
          }),
        );
      } else {
        response.writeHead(404);
        response.end("{}");
      }
    },
  );
  await Promise.all(
    [model, comfy].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        }),
    ),
  );
  const modelAddress = model.address(),
    comfyAddress = comfy.address();
  assert.ok(
    modelAddress &&
      typeof modelAddress !== "string" &&
      comfyAddress &&
      typeof comfyAddress !== "string",
  );
  return {
    endpoint: `http://127.0.0.1:${modelAddress.port}/v1`,
    comfyEndpoint: `https://localhost:${comfyAddress.port}/`,
    modelRequests,
    authorizations,
    comfyRequests,
    close: async () => {
      await Promise.all(
        [model, comfy].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    },
  };
}

/** Copied sources only: an exact fixture destination with real TLS/CA and address pinning. */
export function instrumentUpgradeFixtureNetwork(
  root: string,
  endpoint: string,
): void {
  const egressPath = join(root, "apps/runtime-worker/src/network-egress.ts");
  let egress = readFileSync(egressPath, "utf8");
  const anchor = "  ): Promise<PinnedNetworkEndpoint> {\n    try {";
  assert.equal(egress.split(anchor).length, 2);
  const url = new URL(endpoint);
  egress = egress.replace(
    anchor,
    `  ): Promise<PinnedNetworkEndpoint> {\n    // TEST ONLY copied-workspace adapter; never written to product sources.\n    if (input.endpoint.origin === ${JSON.stringify(url.origin)}) {\n      signal.throwIfAborted();\n      return { endpoint: new URL(input.endpoint), address: "127.0.0.1", family: 4 };\n    }\n    try {`,
  );
  writeFileSync(egressPath, egress);
  const transportPath = join(
    root,
    "apps/runtime-worker/src/pinned-node-http.ts",
  );
  const transport = readFileSync(transportPath, "utf8");
  const ca = "this.#certificateAuthority = options.certificateAuthority;";
  assert.equal(transport.split(ca).length, 2);
  writeFileSync(
    transportPath,
    transport.replace(
      ca,
      `// TEST ONLY copied-workspace CA; TLS validation remains enabled.\n    this.#certificateAuthority = options.certificateAuthority ?? ${JSON.stringify(TEST_CA_CERT)};`,
    ),
  );
}

export function upgradeHeaders(session: ControlRuntimeSession, key?: string) {
  return {
    "authorization": `Bearer ${session.sessionToken}`,
    "origin": session.origin,
    "x-csrf-token": session.csrfToken,
    "content-type": "application/json",
    ...(key ? { "idempotency-key": key } : {}),
  };
}
export async function upgradeJson<T>(
  session: ControlRuntimeSession,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(new URL(path, session.baseUrl), {
    method,
    headers: upgradeHeaders(session, key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: (await response.json()) as T };
}
export async function upgradeStream(
  session: ControlRuntimeSession,
  runId: string,
  cursor?: string,
) {
  const response = await fetch(
    new URL(`/api/v1/runs/${runId}/events`, session.baseUrl),
    {
      headers: {
        ...upgradeHeaders(session),
        ...(cursor ? { "last-event-id": cursor } : {}),
      },
      signal: AbortSignal.timeout(25_000),
    },
  );
  assert.equal(response.status, 200);
  return response.text();
}
export async function eventually<T>(
  get: () => T | Promise<T>,
  accept: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 40_000;
  let value: T | undefined;
  while (Date.now() < deadline) {
    try {
      value = await get();
      if (accept(value)) return value;
    } catch {}
    await delay(25);
  }
  throw new Error(
    `native_upgrade_timeout: ${description}; last=${JSON.stringify(value)}`,
  );
}

export function upgradeRunBinding(
  dataRoot: string,
  runId: string,
): ExtensionRunBinding {
  const db = new DatabaseSync(join(dataRoot, "control.sqlite"));
  try {
    const row = db
      .prepare(
        "SELECT binding_json FROM extension_run_bindings WHERE tenant_id=? AND run_id=?",
      )
      .get(DESKTOP_RUNTIME_OWNER.tenantId, runId);
    assert.ok(row);
    return JSON.parse(String(row.binding_json));
  } finally {
    db.close();
  }
}

/** Read exact scoped authority rows; a new default release legitimately changes other DB state. */
export function upgradeAuthoritySnapshot(
  dataRoot: string,
  input: {
    configurationRevision: number;
    agentVersionId: string;
    runId: string;
  },
) {
  const db = new DatabaseSync(join(dataRoot, "control.sqlite"), {
    readOnly: true,
  });
  try {
    const configuration = db
      .prepare(
        "SELECT configuration_json FROM extension_configurations WHERE tenant_id=? AND space_id=? AND plugin_id=? AND revision=?",
      )
      .get(
        DESKTOP_RUNTIME_OWNER.tenantId,
        DESKTOP_RUNTIME_OWNER.spaceId,
        "crewon.comfyui-krea2",
        input.configurationRevision,
      );
    const activation = db
      .prepare(
        "SELECT activation_json FROM extension_activations WHERE tenant_id=? AND space_id=? AND plugin_id=?",
      )
      .get(
        DESKTOP_RUNTIME_OWNER.tenantId,
        DESKTOP_RUNTIME_OWNER.spaceId,
        "crewon.comfyui-krea2",
      );
    const deployment = db
      .prepare(
        "SELECT deployment_json FROM agent_version_deployments WHERE tenant_id=? AND agent_version_id=?",
      )
      .get(DESKTOP_RUNTIME_OWNER.tenantId, input.agentVersionId);
    const binding = db
      .prepare(
        "SELECT binding_json FROM extension_run_bindings WHERE tenant_id=? AND space_id=? AND plugin_id=? AND run_id=?",
      )
      .get(
        DESKTOP_RUNTIME_OWNER.tenantId,
        DESKTOP_RUNTIME_OWNER.spaceId,
        "crewon.comfyui-krea2",
        input.runId,
      );
    assert.ok(configuration && activation && deployment && binding);
    return Object.freeze({
      configurationJson: String(configuration.configuration_json),
      activationJson: String(activation.activation_json),
      deploymentJson: String(deployment.deployment_json),
      bindingJson: String(binding.binding_json),
    });
  } finally {
    db.close();
  }
}

export function writeUpgradePlugin(
  dataRoot: string,
  id: string,
  configuration: ExtensionConfiguration,
  endpoint: string,
) {
  const baseBindings = JSON.parse(
    readFileSync(join(dataRoot, "agent-version-runtime-bindings.json"), "utf8"),
  );
  const defaultId = baseBindings.bindings[0].agentVersionId;
  const db = new DatabaseSync(join(dataRoot, "control.sqlite"));
  let base;
  try {
    const row = db
      .prepare(
        "SELECT asset_json FROM agent_versions WHERE tenant_id=? AND agent_version_id=?",
      )
      .get(DESKTOP_RUNTIME_OWNER.tenantId, defaultId);
    assert.ok(row);
    base = parseAgentVersionAsset(
      JSON.parse(String(row.asset_json)),
      upgradeDigester,
    );
  } finally {
    db.close();
  }
  const version = compileComfyAgentVersion({
    base: { executionAuthority: "crewonKernel", version: base },
    agentVersionId: id,
    runtimeGeneration: base.runtimeGeneration,
    policySnapshotId: `${id}-policy`,
    digester: upgradeDigester,
  });
  const snapshotPath = join(dataRoot, `${id}-snapshot.json`),
    runtimeBindingsPath = join(dataRoot, `${id}-bindings.json`),
    agentVersionAssetsPath = join(dataRoot, `${id}-assets.json`);
  const write = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  write(snapshotPath, {
    schemaVersion: "crewon.extension-runtime-config.v0",
    configuration,
    approvalRequirement: "none",
  });
  write(runtimeBindingsPath, {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
    bindings: [
      {
        tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
        agentVersionId: id,
        contentDigest: version.contentDigest,
        authorityId: `${id}-authority`,
        workspaceBindingId: null,
        provider: {
          kind: "directResponses",
          endpoint: `${endpoint}/responses`,
          apiKeyEnvironment: "CREWON_MODEL_API_KEY",
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
  });
  write(agentVersionAssetsPath, {
    schemaVersion: "crewon.extension-agent-version-assets.v0",
    assets: [
      createAgentVersionAsset({
        tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
        version,
        createdAt: "2026-10-02T00:00:00.000Z",
      }),
    ],
  });
  writeFileSync(
    join(dataRoot, DESKTOP_EXTENSION_CONFIGURATION_FILE),
    JSON.stringify({
      schemaVersion: "crewon.desktop-extension-runtime.v0",
      enabled: true,
      runtimeBindingsPath,
      agentVersionAssetsPath,
    }),
  );
  return {
    version,
    defaultId,
    snapshotPath,
    runtimeBindingsPath,
    agentVersionAssetsPath,
    desktopConfigurationPath: join(
      dataRoot,
      DESKTOP_EXTENSION_CONFIGURATION_FILE,
    ),
  };
}
export function writeUpgradeMetadataConfig(dataRoot: string) {
  writeFileSync(
    join(dataRoot, DESKTOP_EXTENSION_CONFIGURATION_FILE),
    JSON.stringify({
      schemaVersion: "crewon.desktop-extension-runtime.v0",
      enabled: true,
      runtimeBindingsPath: null,
      agentVersionAssetsPath: null,
    }),
  );
}
