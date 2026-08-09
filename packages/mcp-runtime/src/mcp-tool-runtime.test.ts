import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolExecutionPolicy,
} from "@crewon/tool-broker";

import type {
  McpClientPort,
  McpToolCallResult,
  McpToolPage,
} from "./mcp-client-port.ts";
import { McpRuntimeError, McpToolRuntime } from "./mcp-tool-runtime.ts";
import { parseMcpStdioConfig } from "./mcp-stdio-config.ts";
import { StdioMcpClient } from "./stdio-mcp-client.ts";

type McpSchedulingProjection = Readonly<{
  admission: "available" | "unavailable";
  execution: "serial" | "parallel" | null;
  decision: string;
}>;

const mcpSchedulingReference = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/mcp-tool-scheduling.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  cases: readonly Readonly<{
    caseId: string;
    target: McpSchedulingProjection;
  }>[];
}>;

test("discovers and invokes a real out-of-process stdio MCP server", async () => {
  const runtime = new McpToolRuntime({
    serverId: "fixture",
    client: new StdioMcpClient({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url)),
      ],
      env: {},
    }),
    policies: new Map([["echo", readOnlyPolicy()]]),
  });
  const controller = new AbortController();
  await runtime.connect(controller.signal);

  assert.deepEqual(runtime.definitions(), [
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "mcp__fixture__echo",
      description: "Returns deterministic structured input.",
      execution: "parallel",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
  ]);
  assert.deepEqual(
    {
      admission: "available",
      execution: runtime.definitions()[0]?.execution ?? null,
      decision: "read-only",
    },
    targetMcpScheduling("AR-018-reviewed-read-only-tool"),
  );
  const command = executionCommand();
  const first = await runtime.execute(command, controller.signal);
  const replayed = await runtime.reconcile(command, controller.signal);
  assert.deepEqual(first, replayed);
  assert.equal(first.status, "completed");
  if (first.status === "completed") {
    assert.match(first.result.output, /"echo":"hello"/u);
    assert.match(first.result.output, /"invocations":1/u);
    assert.match(first.result.output, /\[structured\]/u);
  }
  await runtime.close();
});

test("fails closed on unreviewed and mutation MCP tools", async () => {
  const unreviewed = new McpToolRuntime({
    serverId: "unreviewed",
    client: new FakeMcpClient([
      {
        tools: [
          {
            name: "writer",
            description: "Unreviewed mutation fixture.",
            inputSchema: { type: "object" },
          },
        ],
      },
    ]),
    policies: new Map(),
  });
  await unreviewed.connect(new AbortController().signal);
  assert.deepEqual(
    {
      admission:
        unreviewed.definitions().length === 0 ? "unavailable" : "available",
      execution: unreviewed.definitions()[0]?.execution ?? null,
      decision: "unreviewed-tool-not-exposed",
    },
    targetMcpScheduling("AR-017-default-unknown-tool"),
  );
  await unreviewed.close();

  let mutationError: unknown;
  try {
    new McpToolRuntime({
      serverId: "unsafe",
      client: new FakeMcpClient([]),
      policies: new Map([
        [
          "writer",
          {
            ...readOnlyPolicy(),
            effect: "mutation",
            recovery: "reconcilable",
            approvalRequirement: "perAction",
          },
        ],
      ]),
    });
  } catch (error) {
    mutationError = error;
  }
  assert.ok(mutationError instanceof McpRuntimeError);
  assert.equal(mutationError.code, "mcp_mutation_reconciliation_unsupported");
  assert.deepEqual(
    {
      admission: "unavailable",
      execution: null,
      decision: mutationError.code,
    },
    targetMcpScheduling("AR-019-server-opt-in-mutation-tool"),
  );
});

test("fails closed on cyclic MCP pagination", async () => {
  const runtime = new McpToolRuntime({
    serverId: "cycle",
    client: new FakeMcpClient([
      { tools: [], nextCursor: "same" },
      { tools: [], nextCursor: "same" },
    ]),
    policies: new Map(),
  });
  await assert.rejects(
    runtime.connect(new AbortController().signal),
    hasCode("mcp_tool_cursor_cycle"),
  );
  await runtime.close();
});

test("parses strict explicit stdio configuration without ambient authority fields", () => {
  const config = parseMcpStdioConfig({
    schemaVersion: "crewon.mcp-stdio-config.v0",
    servers: [
      {
        serverId: "fixture",
        command: process.execPath,
        args: ["/absolute/server.mjs"],
        cwd: null,
        env: { FIXTURE_TOKEN: "opaque" },
        tools: { echo: readOnlyPolicy() },
      },
    ],
  });
  assert.equal(config.servers[0]?.command, process.execPath);
  assert.deepEqual(config.servers[0]?.env, { FIXTURE_TOKEN: "opaque" });
  assert.throws(
    () =>
      parseMcpStdioConfig({
        ...config,
        tenantId: "tenant-attacker",
      }),
    hasCode("mcp_config_fields_invalid"),
  );
  assert.throws(
    () =>
      parseMcpStdioConfig({
        ...config,
        servers: [
          {
            ...config.servers[0],
            env: { FIXTURE_TOKEN: 7 },
          },
        ],
      }),
    hasCode("mcp_environment_invalid"),
  );
});

function executionCommand(): ToolExecutionCommand {
  const input = '{"value":"hello"}';
  const policy = readOnlyPolicy();
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name: "mcp__fixture__echo",
      inputDigest: sha256(input),
    },
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
    executionId: "execution-1",
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
    idempotencyKey: "run-1/tool/call-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name: "mcp__fixture__echo",
    input,
  };
}

function readOnlyPolicy(): ToolExecutionPolicy {
  return {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: "mcp-server-fixture",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "mcp-runtime-fixture" },
    capability: "mcp.tool.read",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
  };
}

function sha256(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof McpRuntimeError && error.code === code;
}

function targetMcpScheduling(caseId: string): McpSchedulingProjection {
  const fixture = mcpSchedulingReference.cases.find(
    (candidate) => candidate.caseId === caseId,
  );
  assert.ok(fixture !== undefined, `missing MCP scheduling case ${caseId}`);
  return fixture.target;
}

class FakeMcpClient implements McpClientPort {
  readonly #pages: McpToolPage[];

  constructor(pages: readonly McpToolPage[]) {
    this.#pages = [...pages];
  }

  async connect(_signal: AbortSignal): Promise<void> {}

  async listTools(
    _cursor: string | undefined,
    _signal: AbortSignal,
  ): Promise<McpToolPage> {
    const page = this.#pages.shift();
    if (page === undefined) {
      throw new Error("unexpected_page");
    }
    return page;
  }

  async callTool(
    _name: string,
    _input: Readonly<Record<string, unknown>>,
    _options: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  ): Promise<McpToolCallResult> {
    throw new Error("unexpected_call");
  }

  async close(): Promise<void> {}
}
