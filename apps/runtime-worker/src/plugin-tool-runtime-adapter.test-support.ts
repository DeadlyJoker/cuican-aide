import { createHash } from "node:crypto";
import { canonicalActionIntent } from "@crewon/contracts";
import { adaptPluginToolRuntime } from "./plugins/plugin-tool-runtime-adapter.ts";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import {
  InMemoryToolBroker,
  ToolResultCapacity,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolRuntimePort,
  type ToolHandler,
} from "@crewon/tool-broker";
import {
  command,
  committedResult,
  definition,
  policy,
} from "../../../packages/tool-broker/src/tool-execution.test-support.ts";
export { command, committedResult, definition, policy };

export function context(): PluginToolRuntimeContext {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    identity: {
      pluginId: "example.runtime",
      version: "1.0.0",
      packageDigest: digest,
    },
    scope: { tenantId: "tenant-1", spaceId: "space-1", profileId: "profile-1" },
    run: {
      runId: "run-1",
      threadId: "thread-1",
      bindingDigest: digest,
      inputDigest: digest,
      source: null,
    },
    configuration: {
      revision: 1,
      contentDigest: digest,
      parameters: {},
      credentialBindings: [],
    },
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "agent-version-1",
      agentVersionContentDigest: digest,
      materializationDigest: digest,
      authorityId: "authority-1",
      runtimeGeneration: "generation-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  };
}

export function result(
  execution: ToolExecutionCommand,
  output = "ok",
): ToolExecutionResolution {
  return {
    status: "completed",
    executionId: execution.executionId,
    providerReceiptId: `receipt/${execution.executionId}`,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: execution.callId,
      output,
      isError: false,
      artifactRef: "artifacts/test",
    },
  };
}
export function rawRuntime(
  overrides: Partial<ToolRuntimePort> = {},
): ToolRuntimePort {
  return {
    definitions: () => [definition("tool")],
    executionPolicy: () => policy("readOnly", "replaySafe"),
    execute: async (value) => result(value),
    reconcile: async (value) => result(value),
    cancel: async (value) => result(value),
    ...overrides,
  };
}
export function broker(
  handler: ToolHandler,
  executionPolicy: ToolExecutionPolicy = policy("readOnly", "replaySafe"),
) {
  return new InMemoryToolBroker(
    [definition("tool")],
    new Map([["function:tool", handler]]),
    new Map([["function:tool", executionPolicy]]),
    { resultCapacity: new ToolResultCapacity() },
  );
}
export function lookup(value: ToolExecutionCommand) {
  return {
    executionId: value.executionId,
    idempotencyKey: value.idempotencyKey,
    actionDigest: value.actionDigest,
    actionIntent: value.actionIntent,
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function adapt(
  runtime: ToolRuntimePort,
  overrides: Partial<Parameters<typeof adaptPluginToolRuntime>[0]> = {},
) {
  return adaptPluginToolRuntime({
    runtime,
    context: context(),
    definitions: [definition("tool")],
    authorize: async () => {},
    ...overrides,
  });
}
export function rebind(
  execution: ToolExecutionCommand,
  changes: Partial<ToolExecutionCommand["actionIntent"]>,
): ToolExecutionCommand {
  const actionIntent = { ...execution.actionIntent, ...changes };
  return {
    ...execution,
    actionIntent,
    actionDigest: `sha256:${createHash("sha256").update(canonicalActionIntent(actionIntent)).digest("hex")}`,
  };
}
