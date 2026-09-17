import {
  command as scopedCommand,
  policy as scopedPolicy,
  committedResult,
} from "../../../packages/tool-broker/src/tool-execution.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolBrokerError,
  InMemoryToolBroker,
  ToolResultCapacity,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import { AgentVersionRuntimeError } from "./agent-version-runtime.ts";
import { scopeToolRuntimeToAgentVersion } from "./agent-version-tool-runtime.ts";

test("scopes an additive runtime to the exact historical Tool catalog", async () => {
  const calls: string[] = [];
  const runtime = runtimeOf(
    [definition("existing_tool"), definition("read_file")],
    calls,
  );
  const scoped = scopeToolRuntimeToAgentVersion(runtime, [
    definition("existing_tool"),
  ]);

  assert.deepEqual(scoped.definitions(), [definition("existing_tool")]);
  assert.deepEqual(scoped.executionPolicy("function", "existing_tool"), {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "control-runtime-1" },
    capability: "existing_tool.v0",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      maxArtifactBytes: 1_024,
    },
  });
  assert.equal(scoped.executionPolicy("function", "read_file"), null);
  await scoped.execute(command("existing_tool"), signal());
  const reservation = scoped.reserveExecution?.(
    command("existing_tool"),
    signal(),
  );
  assert.ok(reservation !== undefined);
  reservation.release();
  assert.equal(
    scoped.readRetainedExecutionResult?.(command("existing_tool")),
    null,
  );
  assert.throws(
    () => scoped.readRetainedExecutionResult?.(command("read_file")),
    ToolBrokerError,
  );
  assert.throws(
    () => scoped.cancelRetainedExecution?.(command("read_file")),
    ToolBrokerError,
  );
  assert.throws(
    () => scoped.reserveExecution?.(command("read_file"), signal()),
    ToolBrokerError,
  );
  scoped.acknowledgeExecutionResult?.({
    ...command("existing_tool"),
    status: "canceled",
    providerReceiptId: null,
  });
  assert.throws(
    () => scoped.execute(command("read_file"), signal()),
    (error) =>
      error instanceof ToolBrokerError &&
      error.code === "agent_version_tool_not_configured",
  );
  assert.throws(
    () =>
      scoped.acknowledgeExecutionResult?.({
        ...command("read_file"),
        status: "canceled",
        providerReceiptId: null,
      }),
    (error) =>
      error instanceof ToolBrokerError &&
      error.code === "agent_version_tool_not_configured",
  );
  assert.deepEqual(calls, [
    "existing_tool",
    "reserve:existing_tool",
    "release:existing_tool",
    "read:existing_tool",
    "acknowledge:existing_tool",
  ]);
});

test("historical catalogs forward host ownership while filtering other Tools from maintenance", async () => {
  const capacity = new ToolResultCapacity();
  const base = new InMemoryToolBroker(
    [definition("existing_tool"), definition("read_file")],
    new Map(
      ["existing_tool", "read_file"].map((name) => [
        `function:${name}`,
        async () => ({ output: "result" }),
      ]),
    ),
    new Map(
      ["existing_tool", "read_file"].map((name) => [
        `function:${name}`,
        scopedPolicy("readOnly", "replaySafe"),
      ]),
    ),
    { resultCapacity: capacity },
  );
  const scoped = scopeToolRuntimeToAgentVersion(base, [
    definition("existing_tool"),
  ]);
  const visible = scopedCommand({ name: "existing_tool" });
  const hidden = scopedCommand({
    name: "read_file",
    executionId: "execution-hidden",
    idempotencyKey: "key-hidden",
    callId: "call-hidden",
  });
  const options = { resultOwner: { tenantId: "tenant-1" } };
  await base.reserveExecution(hidden, signal(), options).execute();
  await scoped.reserveExecution!(visible, signal(), options)!.execute();
  assert.deepEqual(scoped.scanRetainedExecutionResults!({ limit: 1 }), []);
  const metadata = scoped.scanRetainedExecutionResults!({ limit: 1 });
  assert.equal(metadata[0]?.name, "existing_tool");
  assert.equal(metadata[0]?.tenantId, "tenant-1");
  scoped.acknowledgeExecutionResult!(
    committedResult(visible, `in-memory:${visible.executionId}`),
  );
  base.acknowledgeExecutionResult(
    committedResult(hidden, `in-memory:${hidden.executionId}`),
  );
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
});

test("fails closed when a historical Tool implementation is absent or drifts", () => {
  const runtime = runtimeOf([definition("existing_tool")], []);

  for (const definitions of [
    [definition("removed_tool")],
    [{ ...definition("existing_tool"), description: "drifted" }],
  ]) {
    assert.throws(
      () => scopeToolRuntimeToAgentVersion(runtime, definitions),
      (error) =>
        error instanceof AgentVersionRuntimeError &&
        error.code === "agent_version_tool_runtime_unavailable",
    );
  }
});

function runtimeOf(
  definitions: readonly ToolDefinition[],
  calls: string[],
): ToolRuntimePort {
  return {
    definitions: () => structuredClone(definitions),
    executionPolicy: (_kind, name) =>
      definitions.some((definition) => definition.name === name)
        ? {
            effect: "readOnly",
            recovery: "replaySafe",
            resourceBindingId: null,
            credentialBindingId: null,
            executionTarget: {
              kind: "control",
              bindingId: "control-runtime-1",
            },
            capability: `${name}.v0`,
            approvalRequirement: "none",
            limits: {
              timeoutMs: 1_000,
              maxOutputBytes: 1_024,
              maxArtifactBytes: 1_024,
            },
          }
        : null,
    async execute(command) {
      calls.push(command.name);
      return {
        status: "canceled",
        executionId: command.executionId,
        providerReceiptId: null,
      };
    },
    reserveExecution(command) {
      calls.push(`reserve:${command.name}`);
      return {
        execute: async () => ({
          status: "canceled" as const,
          executionId: command.executionId,
          providerReceiptId: null,
        }),
        release: () => {
          calls.push(`release:${command.name}`);
        },
      };
    },
    async reconcile(command) {
      return this.execute(command, signal());
    },
    async cancel(command) {
      return this.execute(command, signal());
    },
    acknowledgeExecutionResult(acknowledgement) {
      calls.push(`acknowledge:${acknowledgement.actionIntent.tool.name}`);
    },
    readRetainedExecutionResult(lookup) {
      calls.push(`read:${lookup.actionIntent.tool.name}`);
      return null;
    },
  };
}

function definition(name: string): ToolDefinition {
  return {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name,
    description: name,
    execution: "serial",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  };
}

function command(name: string): ToolExecutionCommand {
  return {
    kind: "function",
    name,
    executionId: `execution-${name}`,
    actionIntent: { tool: { kind: "function", name } },
  } as ToolExecutionCommand;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
