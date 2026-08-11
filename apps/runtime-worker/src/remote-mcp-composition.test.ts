import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import { McpToolRuntime } from "@crewon/mcp-runtime";
import type { ToolExecutionCommand } from "@crewon/tool-broker";

import { composeRemoteMcpRuntime } from "./remote-mcp-composition.ts";
import { parseRemoteMcpRuntimeConfig } from "./remote-mcp-runtime-config.ts";

test("composes a real standalone 127/8 server with a static bearer", async (t) => {
  const requests: Array<{ authorization: string | undefined; body: unknown }> =
    [];
  const endpoint = await loopbackServer(t, requests);
  const identities: unknown[] = [];
  const runtime = await composeRemoteMcpRuntime(
    remoteConfig("standaloneLoopback", endpoint),
    release(),
    {
      mode: "standaloneLoopback",
      staticBearerResolver: (identity) => {
        identities.push(identity);
        return "standalone-secret";
      },
    },
  );
  t.after(() => runtime.close());

  assert.deepEqual(runtime.definitions(), [definition()]);
  assert.deepEqual(await runtime.execute(command(), signal()), completed());
  assert.deepEqual(identities, [
    identity("standaloneLoopback", endpoint),
  ]);
  assert.deepEqual(
    requests.map(({ authorization }) => authorization),
    ["Bearer standalone-secret"],
  );
});

test("production binds dynamic credentials and tenant egress to immutable identity", async (t) => {
  const observed: Array<{ kind: string; identity?: unknown; value?: unknown }> =
    [];
  let releases = 0;
  const runtime = await composeRemoteMcpRuntime(
    remoteConfig("production", "https://mcp.example:8443/mutations"),
    release(),
    {
      mode: "production",
      credentialLeaseFactory: (boundIdentity) => {
        observed.push({ kind: "credential", identity: boundIdentity });
        assert.equal(Object.isFrozen(boundIdentity), true);
        return {
          acquire: (input) => ({
            apply: (sink) => sink.applyBearer(`lease-${input.phase}`),
            release: () => {
              releases += 1;
            },
          }),
        };
      },
      tenantEgressFactory: (boundIdentity) => {
        observed.push({ kind: "egress", identity: boundIdentity });
        return {
          dns: {
            resolveAll: async () => [{ address: "8.8.8.8", family: 4 }],
          },
          policy: {
            authorize: (input) => {
              observed.push({ kind: "authorize", value: input });
              return { approvedAddresses: ["8.8.8.8"] };
            },
          },
          transport: {
            request: async (input) => {
              observed.push({
                kind: "transport",
                value: {
                  authorization: input.headers?.authorization,
                  target: input.target,
                },
              });
              return response(JSON.parse(new TextDecoder().decode(input.body)));
            },
          },
        };
      },
    },
  );
  t.after(() => runtime.close());

  assert.deepEqual(await runtime.execute(command(), signal()), completed());
  assert.deepEqual(observed.slice(0, 2), [
    { kind: "credential", identity: identity() },
    { kind: "egress", identity: identity() },
  ]);
  assert.deepEqual(observed.slice(2), [
    {
      kind: "authorize",
      value: {
        tenantId: "tenant-1",
        scopeId: "server-binding-1",
        endpoint: new URL("https://mcp.example:8443/mutations"),
        addresses: [{ address: "8.8.8.8", family: 4 }],
      },
    },
    {
      kind: "transport",
      value: {
        authorization: "Bearer lease-execute",
        target: {
          endpoint: new URL("https://mcp.example:8443/mutations"),
          address: "8.8.8.8",
          family: 4,
        },
      },
    },
  ]);
  assert.equal(releases, 1);
});

test("rejects cross-mode composition and invalid immutable release bindings", async () => {
  const standalone = remoteConfig(
    "standaloneLoopback",
    "http://127.0.0.1:1234/mutations",
  );
  await assert.rejects(
    composeRemoteMcpRuntime(standalone, release(), productionDependencies()),
    /remote_mcp_composition_mode_mismatch/u,
  );
  await assert.rejects(
    composeRemoteMcpRuntime(
      standalone,
      { ...release(), materializationDigest: "drifted" },
      { mode: "standaloneLoopback", staticBearerResolver: () => "secret" },
    ),
    /remote_mcp_release_binding_invalid/u,
  );
});

test("closes constructed runtimes when a later server factory fails", async (t) => {
  const originalClose = McpToolRuntime.prototype.close;
  let closeCount = 0;
  McpToolRuntime.prototype.close = async function () {
    closeCount += 1;
    return originalClose.call(this);
  };
  t.after(() => {
    McpToolRuntime.prototype.close = originalClose;
  });
  const original = remoteConfig(
    "production",
    "https://mcp.example:8443/mutations",
  );
  const config = {
    ...structuredClone(original),
    servers: [...original.servers],
  };
  config.servers.push({
    ...structuredClone(config.servers[0]!),
    serverId: "second",
    serverBindingId: "server-binding-2",
    credentialBindingId: "credential-binding-2",
    tools: [
      {
        ...structuredClone(config.servers[0]!.tools[0]!),
        policy: {
          ...structuredClone(config.servers[0]!.tools[0]!.policy),
          credentialBindingId: "credential-binding-2",
          executionTarget: { kind: "remote", bindingId: "server-binding-2" },
        },
      },
    ],
  });
  const parsed = parseRemoteMcpRuntimeConfig(config);
  await assert.rejects(
    composeRemoteMcpRuntime(parsed, release(), {
      mode: "production",
      credentialLeaseFactory: () => ({
        acquire: () => ({
          apply: () => undefined,
          release: () => undefined,
        }),
      }),
      tenantEgressFactory: ({ serverBindingId }) => {
        if (serverBindingId === "server-binding-2") {
          throw new Error("fixture_composition_failure");
        }
        return {
          policy: { authorize: () => ({ approvedAddresses: [] }) },
        };
      },
    }),
    /fixture_composition_failure/u,
  );
  assert.equal(closeCount, 1);
});

test("close is idempotent and leaves no routable catalog", async () => {
  const active = await composeRemoteMcpRuntime(
    remoteConfig("standaloneLoopback", "http://127.0.0.1:1234/mutations"),
    release(),
    {
      mode: "standaloneLoopback",
      staticBearerResolver: () => "secret",
      fetch: async () => {
        throw new Error("unused");
      },
    },
  );
  await active.close();
  await active.close();
  assert.throws(() => active.definitions(), /mcp_runtime_group_closed/u);
});

test("rejects malformed production dependency results", async () => {
  const config = remoteConfig(
    "production",
    "https://mcp.example:8443/mutations",
  );
  for (const dependencies of [
    {
      mode: "production",
      credentialLeaseFactory: () => null,
      tenantEgressFactory: () => ({
        policy: { authorize: () => ({ approvedAddresses: [] }) },
      }),
    },
    {
      mode: "production",
      credentialLeaseFactory: () => ({ acquire: () => null }),
      tenantEgressFactory: () => null,
    },
  ]) {
    await assert.rejects(
      composeRemoteMcpRuntime(config, release(), dependencies as never),
      /remote_mcp_composition_dependencies_invalid/u,
    );
  }
  await assert.rejects(
    composeRemoteMcpRuntime(
      remoteConfig("standaloneLoopback", "http://127.0.0.1:1234/mutations"),
      release(),
      {
        mode: "standaloneLoopback",
        staticBearerResolver: () => null,
      } as never,
    ),
    /remote_mcp_mutation_credential_invalid/u,
  );
});

function remoteConfig(
  mode: "production" | "standaloneLoopback",
  endpoint: string,
) {
  return parseRemoteMcpRuntimeConfig({
    schemaVersion: "crewon.remote-mcp-runtime.v0",
    servers: [
      {
        serverId: "remote",
        serverBindingId: "server-binding-1",
        mode,
        endpoint,
        credentialBindingId: "credential-binding-1",
        tools: [
          {
            descriptor: {
              name: "create_record",
              description: "Creates one record.",
              inputSchema: { type: "object", additionalProperties: false },
            },
            policy: policy(),
          },
        ],
      },
    ],
  });
}

function policy() {
  return {
    effect: "mutation" as const,
    recovery: "reconcilable" as const,
    resourceBindingId: null,
    credentialBindingId: "credential-binding-1",
    executionTarget: { kind: "remote" as const, bindingId: "server-binding-1" },
    capability: "records.create",
    approvalRequirement: "none" as const,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
      maxArtifactBytes: 1_000_000,
    },
  };
}

function release() {
  return {
    tenantId: "tenant-1",
    agentVersionId: "agent-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    materializationDigest: `sha256:${"b".repeat(64)}`,
  };
}

function identity(
  mode: "production" | "standaloneLoopback" = "production",
  endpoint = "https://mcp.example:8443/mutations",
) {
  return {
    ...release(),
    mode,
    serverBindingId: "server-binding-1",
    credentialBindingId: "credential-binding-1",
    endpoint,
  };
}

function definition() {
  return {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "mcp__remote__create_record",
    description: "Creates one record.",
    execution: "serial",
    inputSchema: { type: "object", additionalProperties: false },
  };
}

function completed() {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output: '[structured]\n{"created":true}',
      isError: false,
      artifactRef: null,
    },
  };
}

function command(): ToolExecutionCommand {
  const input = "{}";
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name: "mcp__remote__create_record",
      inputDigest: sha256(input),
    },
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    ...policy(),
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
    idempotencyKey: "run-1/tool/call-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name: "mcp__remote__create_record",
    input,
  };
}

async function loopbackServer(
  t: TestContext,
  requests: Array<{ authorization: string | undefined; body: unknown }>,
) {
  const server = createServer(async (request, responseStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ authorization: request.headers.authorization, body });
    const fixture = response(body);
    responseStream.writeHead(fixture.status, fixture.headers);
    responseStream.end(fixture.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}/mutations`;
}

function response(body: {
  phase: string;
  providerExecutionId: string;
  toolName: string;
}) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({
        schemaVersion: "crewon.remote-mcp-mutation.v1",
        phase: body.phase,
        providerExecutionId: body.providerExecutionId,
        toolName: body.toolName,
        resolution: {
          status: "completed",
          providerReceiptId: "receipt-1",
          result: { structuredContent: { created: true } },
        },
      }),
    ),
  };
}

function productionDependencies() {
  return {
    mode: "production" as const,
    credentialLeaseFactory: () => ({
      acquire: () => ({ apply: () => undefined, release: () => undefined }),
    }),
    tenantEgressFactory: () => ({
      policy: { authorize: () => ({ approvedAddresses: [] }) },
    }),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
