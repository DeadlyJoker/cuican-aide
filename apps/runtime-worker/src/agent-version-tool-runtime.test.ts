import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolBrokerError,
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
  assert.throws(
    () => scoped.execute(command("read_file"), signal()),
    (error) =>
      error instanceof ToolBrokerError &&
      error.code === "agent_version_tool_not_configured",
  );
  assert.deepEqual(calls, ["existing_tool"]);
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
    async reconcile(command) {
      return this.execute(command, signal());
    },
    async cancel(command) {
      return this.execute(command, signal());
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
  } as ToolExecutionCommand;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
