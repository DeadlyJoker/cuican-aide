import assert from "node:assert/strict";
import test from "node:test";

import { parseRemoteMcpRuntimeConfig } from "./remote-mcp-runtime-config.ts";

test("parses and canonically normalizes a secret-free immutable catalog", () => {
  const parsed = parseRemoteMcpRuntimeConfig(validConfig());
  assert.deepEqual(parsed, validConfig());
});

test("accepts only explicit production HTTPS and raw loopback HTTP endpoints", () => {
  for (const endpoint of [
    "http://mcp.example:8443/mcp",
    "https://mcp.example/mcp",
    "https://user@mcp.example:8443/mcp",
    "https://mcp.example:8443/mcp?q=1",
    "https://mcp.example:8443/mcp#fragment",
    "https://mcp.example:0/mcp",
    "https://mcp.example:65536/mcp",
  ]) {
    assert.throws(
      () => parseRemoteMcpRuntimeConfig(withServer({ endpoint })),
      hasMessage("remote_mcp_endpoint_invalid"),
    );
  }
  assert.deepEqual(
    parseRemoteMcpRuntimeConfig(
      withServer({
        mode: "standaloneLoopback",
        endpoint: "http://127.0.0.2:4318/mcp",
      }),
    ).servers[0]?.endpoint,
    "http://127.0.0.2:4318/mcp",
  );
  assert.equal(
    parseRemoteMcpRuntimeConfig(
      withServer({ endpoint: "https://mcp.example:443/mcp" }),
    ).servers[0]?.endpoint,
    "https://mcp.example:443/mcp",
  );
  for (const endpoint of [
    "https://127.0.0.1:4318/mcp",
    "http://localhost:4318/mcp",
    "http://127.1:4318/mcp",
    "http://128.0.0.1:4318/mcp",
  ]) {
    assert.throws(() =>
      parseRemoteMcpRuntimeConfig(
        withServer({ mode: "standaloneLoopback", endpoint }),
      ),
    );
  }
});

test("requires unique server identities and server-local tool names", () => {
  const config = validConfig();
  const duplicateServer = structuredClone(config.servers[0]);
  duplicateServer.tools[0]!.descriptor.name = "other_tool";
  assert.throws(
    () =>
      parseRemoteMcpRuntimeConfig({
        ...config,
        servers: [config.servers[0], duplicateServer],
      }),
    hasMessage("remote_mcp_server_duplicate"),
  );
  const second = structuredClone(config.servers[0]);
  second.serverId = "second";
  second.serverBindingId = "remote-2";
  second.credentialBindingId = "credential-2";
  second.tools[0]!.policy.executionTarget.bindingId = "remote-2";
  second.tools[0]!.policy.credentialBindingId = "credential-2";
  assert.doesNotThrow(() =>
    parseRemoteMcpRuntimeConfig({
      ...config,
      servers: [config.servers[0], second],
    }),
  );
  const duplicateTool = structuredClone(config.servers[0]!.tools[0]!);
  assert.throws(
    () =>
      parseRemoteMcpRuntimeConfig({
        ...config,
        servers: [
          {
            ...config.servers[0]!,
            tools: [config.servers[0]!.tools[0]!, duplicateTool],
          },
        ],
      }),
    hasMessage("remote_mcp_tool_duplicate"),
  );
});

test("requires exact mutation, reconciliation, target, credential, and limits", () => {
  const variants: unknown[] = [
    { effect: "readOnly" },
    { recovery: "replaySafe" },
    { credentialBindingId: "other" },
    { executionTarget: { kind: "control", bindingId: "remote-1" } },
    { executionTarget: { kind: "remote", bindingId: "other" } },
    { limits: { timeoutMs: 0, maxOutputBytes: 1, maxArtifactBytes: 1 } },
  ];
  for (const variant of variants) {
    const config = validConfig();
    config.servers[0]!.tools[0]!.policy = {
      ...config.servers[0]!.tools[0]!.policy,
      ...(variant as object),
    };
    assert.throws(
      () => parseRemoteMcpRuntimeConfig(config),
      hasMessage("remote_mcp_tool_policy_invalid"),
    );
  }
  const noApproval = validConfig();
  (
    noApproval.servers[0]!.tools[0]!.policy as { approvalRequirement: string }
  ).approvalRequirement = "none";
  assert.doesNotThrow(() => parseRemoteMcpRuntimeConfig(noApproval));
});

test("enforces UTF-8 byte bounds and finite acyclic JSON schemas", () => {
  assert.throws(() =>
    parseRemoteMcpRuntimeConfig(withServer({ serverId: "界".repeat(22) })),
  );
  for (const invalid of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    const config = validConfig();
    (
      config.servers[0]!.tools[0]!.descriptor as {
        inputSchema: Record<string, unknown>;
      }
    ).inputSchema = { type: "object", invalid };
    assert.throws(
      () => parseRemoteMcpRuntimeConfig(config),
      hasMessage("remote_mcp_tool_schema_invalid"),
    );
  }
  const config = validConfig();
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.self = cyclic;
  (
    config.servers[0]!.tools[0]!.descriptor as {
      inputSchema: Record<string, unknown>;
    }
  ).inputSchema = cyclic;
  assert.throws(
    () => parseRemoteMcpRuntimeConfig(config),
    hasMessage("remote_mcp_tool_schema_invalid"),
  );
});

test("aligns descriptor byte bounds with McpToolRuntime", () => {
  const descriptionBoundary = validConfig();
  descriptionBoundary.servers[0]!.tools[0]!.descriptor.description = "a".repeat(
    2 * 1024,
  );
  assert.doesNotThrow(() => parseRemoteMcpRuntimeConfig(descriptionBoundary));
  descriptionBoundary.servers[0]!.tools[0]!.descriptor.description += "a";
  assert.throws(() => parseRemoteMcpRuntimeConfig(descriptionBoundary));

  const schemaBoundary = validConfig();
  (
    schemaBoundary.servers[0]!.tools[0]!.descriptor as {
      inputSchema: Record<string, unknown>;
    }
  ).inputSchema = schemaWithBytes(32 * 1024);
  assert.doesNotThrow(() => parseRemoteMcpRuntimeConfig(schemaBoundary));
  (
    schemaBoundary.servers[0]!.tools[0]!.descriptor as {
      inputSchema: Record<string, unknown>;
    }
  ).inputSchema = schemaWithBytes(32 * 1024 + 1);
  assert.throws(
    () => parseRemoteMcpRuntimeConfig(schemaBoundary),
    hasMessage("remote_mcp_tool_schema_invalid"),
  );
});

test("requires object input schemas and materializable exposed names", () => {
  const invalidSchema = validConfig();
  (
    invalidSchema.servers[0]!.tools[0]!.descriptor as {
      inputSchema: Record<string, unknown>;
    }
  ).inputSchema = {};
  assert.throws(
    () => parseRemoteMcpRuntimeConfig(invalidSchema),
    hasMessage("remote_mcp_tool_invalid"),
  );

  const exposedNameBoundary = validConfig();
  exposedNameBoundary.servers[0]!.serverId = "s";
  exposedNameBoundary.servers[0]!.tools[0]!.descriptor.name = "a".repeat(120);
  assert.doesNotThrow(() => parseRemoteMcpRuntimeConfig(exposedNameBoundary));
  exposedNameBoundary.servers[0]!.tools[0]!.descriptor.name += "a";
  assert.throws(
    () => parseRemoteMcpRuntimeConfig(exposedNameBoundary),
    hasMessage("remote_mcp_exposed_tool_name_invalid"),
  );
});

test("caps the complete remote catalog at 128 tools", () => {
  const config = validConfig();
  const first = serverWithTools(config.servers[0]!, "first", "remote-1", 64);
  const second = serverWithTools(config.servers[0]!, "second", "remote-2", 64);
  assert.doesNotThrow(() =>
    parseRemoteMcpRuntimeConfig({ ...config, servers: [first, second] }),
  );
  second.tools.push(structuredClone(second.tools[0]!));
  second.tools[64]!.descriptor.name = "tool-64";
  assert.throws(
    () => parseRemoteMcpRuntimeConfig({ ...config, servers: [first, second] }),
    hasMessage("remote_mcp_tool_catalog_invalid"),
  );
});

test("fails closed on extra and secret-bearing fields", () => {
  const config = validConfig();
  for (const extra of [
    { bearer: "secret" },
    { env: { TOKEN: "secret" } },
    { apiKey: "secret" },
  ]) {
    assert.throws(
      () => parseRemoteMcpRuntimeConfig({ ...config, ...extra }),
      hasMessage("remote_mcp_runtime_config_invalid"),
    );
  }
  assert.throws(() =>
    parseRemoteMcpRuntimeConfig(withServer({ bearerToken: "secret" })),
  );
  const tool = structuredClone(config.servers[0]!.tools[0]!);
  assert.throws(() =>
    parseRemoteMcpRuntimeConfig({
      ...config,
      servers: [
        { ...config.servers[0]!, tools: [{ ...tool, apiKey: "secret" }] },
      ],
    }),
  );
});

function withServer(overrides: Record<string, unknown>) {
  const config = validConfig();
  return { ...config, servers: [{ ...config.servers[0], ...overrides }] };
}

function validConfig() {
  return {
    schemaVersion: "crewon.remote-mcp-runtime.v0" as const,
    servers: [
      {
        serverId: "reviewed-mcp",
        serverBindingId: "remote-1",
        mode: "production" as const,
        endpoint: "https://mcp.example:8443/mcp",
        credentialBindingId: "credential-1",
        tools: [
          {
            descriptor: {
              name: "create_record",
              description: "Creates a reviewed record.",
              inputSchema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
                additionalProperties: false,
              },
            },
            policy: {
              effect: "mutation" as const,
              recovery: "reconcilable" as const,
              resourceBindingId: null,
              credentialBindingId: "credential-1",
              executionTarget: {
                kind: "remote" as const,
                bindingId: "remote-1",
              },
              capability: "records.create",
              approvalRequirement: "perAction" as const,
              limits: {
                timeoutMs: 30_000,
                maxOutputBytes: 64_000,
                maxArtifactBytes: 1_000_000,
              },
            },
          },
        ],
      },
    ],
  };
}

function schemaWithBytes(bytes: number): Record<string, unknown> {
  const empty = JSON.stringify({ type: "object", padding: "" });
  return {
    type: "object",
    padding: "a".repeat(bytes - Buffer.byteLength(empty, "utf8")),
  };
}

function serverWithTools(
  template: ReturnType<typeof validConfig>["servers"][number],
  serverId: string,
  serverBindingId: string,
  count: number,
) {
  const server = structuredClone(template);
  server.serverId = serverId;
  server.serverBindingId = serverBindingId;
  server.tools = Array.from({ length: count }, (_, index) => {
    const tool = structuredClone(template.tools[0]!);
    tool.descriptor.name = `tool-${index}`;
    tool.policy.executionTarget.bindingId = serverBindingId;
    return tool;
  });
  return server;
}

function hasMessage(message: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message === message;
}
