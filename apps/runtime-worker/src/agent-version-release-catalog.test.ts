import assert from "node:assert/strict";
import test from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  CompositeToolRuntime,
  InMemoryToolBroker,
  type ToolDefinition,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";

import { compileRuntimeAgentVersion } from "./agent-version-release.ts";
import {
  type DurableWorkspaceReadPort,
  WorkspaceReadToolRuntime,
} from "./runtime-workspace-read-tool-runtime.ts";

const transport: ModelTransportPort = {
  adapterName: "fake-adapter",
  adapterVersion: "1",
  modelId: "fake-model",
  async *stream() {
    throw new Error("unused");
  },
};

test("selected native Workspace release matches the execution-side catalog", () => {
  const existing = new InMemoryToolBroker([
    definition("aaa_before_read"),
    definition("zzz_after_read"),
  ]);
  const runtime = new CompositeToolRuntime([existing, workspaceReadRuntime()]);
  const version = compileRuntimeAgentVersion({
    ...releaseConfig(),
    toolRuntime: existing,
    nativeWorkspaceReadCatalog: "enabled",
  });

  assert.equal(version.agentVersionId, "selected-workspace-agent-version");
  assert.equal(version.runtimeGeneration, "workspace-runtime-binding-1");
  assert.equal(version.resources.workspaceRequired, true);
  assert.deepEqual(version.tools, runtime.definitions());
});

test("standalone release omits native Workspace read without changing defaults", () => {
  const version = compileRuntimeAgentVersion({
    ...releaseConfig(),
    route: {
      authorityId: "standalone-authority",
      runtimeGeneration: "ts-v0",
      agentVersionId: "default-agent-v0",
      policySnapshotId: "standalone-policy-v0",
      workspaceBindingId: null,
    },
  });

  assert.equal(version.agentVersionId, "default-agent-v0");
  assert.equal(version.resources.workspaceRequired, false);
  assert.deepEqual(version.tools, []);
});

test("native Workspace read collision fails closed deterministically", () => {
  const collision = new InMemoryToolBroker(
    workspaceReadRuntime().definitions(),
  );

  assert.throws(
    () =>
      compileRuntimeAgentVersion({
        ...releaseConfig(),
        toolRuntime: collision,
        nativeWorkspaceReadCatalog: "enabled",
      }),
    new Error("runtime_release_workspace_read_tool_collision"),
  );
});

test("native Workspace read cannot be enabled on a standalone route", () => {
  assert.throws(
    () =>
      compileRuntimeAgentVersion({
        ...releaseConfig(),
        route: { ...releaseConfig().route, workspaceBindingId: null },
        nativeWorkspaceReadCatalog: "enabled",
      }),
    new Error("runtime_release_workspace_read_authority_missing"),
  );
});

function releaseConfig() {
  return {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "desktop-workspace-authority",
      runtimeGeneration: "workspace-runtime-binding-1",
      agentVersionId: "selected-workspace-agent-version",
      policySnapshotId: "standalone-policy-v0",
      workspaceBindingId: "workspace-binding-1",
    },
    transport,
  };
}

function workspaceReadRuntime(): WorkspaceReadToolRuntime {
  const unused = async (_command: ToolExecutionCommand) => {
    throw new Error("unused");
  };
  const port: DurableWorkspaceReadPort = {
    execute: unused,
    reconcile: unused,
    cancel: unused,
  };
  return new WorkspaceReadToolRuntime({
    binding: {
      deviceBindingId: "device-binding-1",
      workspaceBindingId: "workspace-binding-1",
      policySnapshotId: "standalone-policy-v0",
    },
    port,
  });
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
