import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolExecutionPolicy,
} from "@crewon/tool-broker";

import { ConfiguredRemoteMcpClient } from "./configured-remote-mcp-client.ts";
import type {
  McpMutationExecution,
  McpMutationProviderPort,
  McpToolDescriptor,
} from "./mcp-client-port.ts";
import { McpRuntimeGroup } from "./mcp-runtime-group.ts";
import { McpRuntimeError, McpToolRuntime } from "./mcp-tool-runtime.ts";

test("isolates two static mutation catalogs through real runtimes", async () => {
  const operations: string[] = [];
  const provider = recordingProvider(operations);
  const source = [descriptor("write", "Original description")];
  const alpha = configuredRuntime("alpha", source, provider);
  const beta = configuredRuntime("beta", [descriptor("write")], provider);
  const group = new McpRuntimeGroup([alpha, beta]);
  source[0]!.description = "mutated input";

  await group.connect(new AbortController().signal);
  assert.deepEqual(group.definitions(), [
    definition("mcp__alpha__write", "Original description"),
    definition("mcp__beta__write", "Configured mutation"),
  ]);
  assert.equal(group.definitions()[0]?.execution, "serial");

  const returned = group.definitions() as unknown as {
    description: string;
  }[];
  returned[0]!.description = "mutated result";
  await group.refresh(new AbortController().signal);
  assert.equal(group.definitions()[0]?.description, "Original description");

  const command = executionCommand("alpha", "execution-alpha");
  assert.equal(
    (await group.execute(command, new AbortController().signal)).status,
    "completed",
  );
  assert.equal(
    (await group.reconcile(command, new AbortController().signal)).status,
    "completed",
  );
  assert.equal(
    (await group.cancel(command, new AbortController().signal)).status,
    "canceled",
  );
  assert.deepEqual(operations, [
    "execute:write:execution-alpha",
    "reconcile:write:execution-alpha",
    "cancel:write:execution-alpha",
  ]);
  await group.close();
});

test("serves one clone-only page and closes permanently", async () => {
  class Provider implements McpMutationProviderPort {
    async execute(execution: McpMutationExecution) {
      return recordingProvider([]).execute(
        execution,
        new AbortController().signal,
      );
    }
    async reconcile(execution: McpMutationExecution) {
      return recordingProvider([]).reconcile(
        execution,
        new AbortController().signal,
      );
    }
    async cancel(execution: McpMutationExecution) {
      return recordingProvider([]).cancel(
        execution,
        new AbortController().signal,
      );
    }
  }
  const client = new ConfiguredRemoteMcpClient({
    descriptors: [descriptor("write")],
    mutationProvider: new Provider(),
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    client.listTools(undefined, signal),
    hasCode("mcp_static_catalog_not_connected"),
  );
  await client.connect(signal);
  const page = await client.listTools(undefined, signal);
  (page.tools[0]!.inputSchema as { type: string }).type = "changed";
  assert.equal(
    (await client.listTools(undefined, signal)).tools[0]?.inputSchema.type,
    "object",
  );
  await assert.rejects(
    client.listTools("cursor", signal),
    hasCode("mcp_static_catalog_cursor_invalid"),
  );
  await client.close();
  await client.close();
  await assert.rejects(
    client.connect(signal),
    hasCode("mcp_static_catalog_closed"),
  );
  await assert.rejects(
    client.listTools(undefined, signal),
    hasCode("mcp_static_catalog_closed"),
  );
  await assert.rejects(
    client.callTool("write", {}, { signal, timeoutMs: 1 }),
    hasCode("mcp_static_catalog_closed"),
  );
});

test("rejects malformed static descriptors at construction", () => {
  const provider = recordingProvider([]);
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient({
        descriptors: [descriptor("write")],
        mutationProvider: provider,
        endpoint: "https://authority.invalid",
      } as ConstructorParameters<typeof ConfiguredRemoteMcpClient>[0]),
    hasCode("mcp_static_catalog_config_invalid"),
  );
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient({
        descriptors: [],
        mutationProvider: provider,
      }),
    hasCode("mcp_static_catalog_count_invalid"),
  );
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient({
        descriptors: [descriptor("same"), descriptor("same")],
        mutationProvider: provider,
      }),
    hasCode("mcp_tool_duplicate"),
  );
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient({
        descriptors: [
          {
            ...descriptor("write"),
            endpoint: "https://authority.invalid",
          } as McpToolDescriptor,
        ],
        mutationProvider: provider,
      }),
    hasCode("mcp_tool_descriptor_invalid"),
  );
  const symbolDescriptor = descriptor("symbol") as McpToolDescriptor &
    Record<symbol, unknown>;
  symbolDescriptor[Symbol("credential")] = "authority";
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient({
        descriptors: [symbolDescriptor],
        mutationProvider: provider,
      }),
    hasCode("mcp_tool_descriptor_invalid"),
  );
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.self = cyclic;
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient({
        descriptors: [{ name: "cycle", inputSchema: cyclic }],
        mutationProvider: provider,
      }),
    hasCode("mcp_tool_descriptor_invalid"),
  );
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient({
        descriptors: [
          {
            name: "large",
            inputSchema: { type: "object", value: "x".repeat(32 * 1024) },
          },
        ],
        mutationProvider: provider,
      }),
    hasCode("mcp_tool_descriptor_invalid"),
  );
  const getterFailure = Object.defineProperty({}, "descriptors", {
    enumerable: true,
    get() {
      throw new Error("secret getter detail");
    },
  });
  Object.defineProperty(getterFailure, "mutationProvider", {
    enumerable: true,
    value: provider,
  });
  assert.throws(
    () =>
      new ConfiguredRemoteMcpClient(
        getterFailure as ConstructorParameters<
          typeof ConfiguredRemoteMcpClient
        >[0],
      ),
    (error: unknown) =>
      hasCode("mcp_static_catalog_config_invalid")(error) &&
      error instanceof Error &&
      error.cause === undefined,
  );
});

test("never opens the generic read-only call path", async () => {
  const operations: string[] = [];
  const client = new ConfiguredRemoteMcpClient({
    descriptors: [descriptor("read")],
    mutationProvider: recordingProvider(operations),
  });
  const runtime = new McpToolRuntime({
    serverId: "remote",
    client,
    policies: new Map([["read", readOnlyPolicy()]]),
  });
  const signal = new AbortController().signal;
  await runtime.connect(signal);
  const resolution = await runtime.execute(
    executionCommand("remote", "execution-read", "read", readOnlyPolicy()),
    signal,
  );
  assert.equal(resolution.status, "completed");
  if (resolution.status === "completed") {
    assert.equal(resolution.result.isError, true);
    assert.equal(
      resolution.result.output,
      "tool call failed: mcp__remote__read",
    );
  }
  assert.deepEqual(operations, []);
  await runtime.close();
});

function configuredRuntime(
  serverId: string,
  descriptors: readonly McpToolDescriptor[],
  mutationProvider: McpMutationProviderPort,
): McpToolRuntime {
  return new McpToolRuntime({
    serverId,
    client: new ConfiguredRemoteMcpClient({ descriptors, mutationProvider }),
    policies: new Map([["write", mutationPolicy()]]),
  });
}

function recordingProvider(operations: string[]): McpMutationProviderPort {
  const record = (operation: string, execution: McpMutationExecution) => {
    operations.push(
      `${operation}:${execution.toolName}:${execution.providerExecutionId}`,
    );
  };
  return {
    async execute(execution) {
      record("execute", execution);
      return {
        status: "completed",
        providerReceiptId: "receipt",
        result: { content: [] },
      };
    },
    async reconcile(execution) {
      record("reconcile", execution);
      return {
        status: "completed",
        providerReceiptId: "receipt",
        result: { content: [] },
      };
    },
    async cancel(execution) {
      record("cancel", execution);
      return { status: "canceled", providerReceiptId: "receipt" };
    },
  };
}

function descriptor(
  name: string,
  description = "Configured mutation",
): McpToolDescriptor & { description: string } {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false },
  };
}

function definition(name: string, description: string) {
  return {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name,
    description,
    execution: "serial",
    inputSchema: { type: "object", additionalProperties: false },
  };
}

function mutationPolicy(): ToolExecutionPolicy {
  return {
    ...readOnlyPolicy(),
    effect: "mutation",
    recovery: "reconcilable",
    capability: "mcp.tool.mutate",
  };
}

function readOnlyPolicy(): ToolExecutionPolicy {
  return {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: "mcp-server",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "mcp-runtime" },
    capability: "mcp.tool.read",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
  };
}

function executionCommand(
  serverId: string,
  executionId: string,
  originalName = "write",
  policy = mutationPolicy(),
): ToolExecutionCommand {
  const input = "{}";
  const name = `mcp__${serverId}__${originalName}`;
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: `call-${serverId}`,
    tool: { kind: "function" as const, name, inputDigest: sha256(input) },
    effect: policy.effect,
    recovery: policy.recovery,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: policy.resourceBindingId,
    credentialBindingId: policy.credentialBindingId,
    executionTarget: policy.executionTarget,
    capability: policy.capability,
    approvalRequirement: policy.approvalRequirement,
    limits: policy.limits,
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId,
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-08-09T00:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
    idempotencyKey: `run-1/tool/${serverId}`,
    runId: "run-1",
    segmentId: "segment-1",
    callId: `call-${serverId}`,
    kind: "function",
    name,
    input,
  };
}

function sha256(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof McpRuntimeError && error.code === code;
}
