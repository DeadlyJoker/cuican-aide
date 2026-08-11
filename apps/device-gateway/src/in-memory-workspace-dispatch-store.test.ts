import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceExecutionCommand } from "@crewon/contracts";

import { InMemoryDeviceDispatchStore } from "./device-dispatch-store.ts";
import { InMemoryDeviceExecutionKindAuthority } from "./device-execution-kind-authority.ts";
import { InMemoryWorkspaceDispatchStore } from "./workspace-dispatch-store.ts";
import {
  command,
  route,
  runWorkspaceDispatchStoreConformance,
} from "./workspace-dispatch-store-conformance.test-support.ts";

runWorkspaceDispatchStoreConformance(
  "InMemoryWorkspaceDispatchStore",
  (options = {}) =>
    new InMemoryWorkspaceDispatchStore({
      initialRecords: options.initialRecords,
      routeAuthority: {
        currentRoute: () =>
          options.currentRoute === undefined ? route() : options.currentRoute,
      },
      now: () => new Date(options.now ?? "2026-08-09T00:00:01.000Z"),
    }),
);

test("Tool and Workspace commands conflict in both orders for one global execution id", async () => {
  const firstKinds = new InMemoryDeviceExecutionKindAuthority();
  const firstTool = new InMemoryDeviceDispatchStore(firstKinds);
  const firstWorkspace = new InMemoryWorkspaceDispatchStore({
    executionKinds: firstKinds,
    routeAuthority: { currentRoute: route },
    now: () => new Date("2026-08-09T00:00:01.000Z"),
  });
  await firstTool.prepare(toolCommand(), "2026-08-09T00:00:00.000Z");
  await assert.rejects(
    firstWorkspace.prepare(command(), "2026-08-09T00:00:00.000Z"),
    hasCode("device_dispatch_kind_conflict"),
  );

  const secondKinds = new InMemoryDeviceExecutionKindAuthority();
  const secondTool = new InMemoryDeviceDispatchStore(secondKinds);
  const secondWorkspace = new InMemoryWorkspaceDispatchStore({
    executionKinds: secondKinds,
    routeAuthority: { currentRoute: route },
    now: () => new Date("2026-08-09T00:00:01.000Z"),
  });
  await secondWorkspace.prepare(command(), "2026-08-09T00:00:00.000Z");
  await assert.rejects(
    secondTool.prepare(toolCommand(), "2026-08-09T00:00:00.000Z"),
    hasCode("device_dispatch_kind_conflict"),
  );
  assert.equal(firstKinds.kind(command().executionId), "tool");
  assert.equal(secondKinds.kind(command().executionId), "workspaceList");
});

test("same-kind claims without detail records fail closed instead of healing authority", async () => {
  const workspaceKinds = new InMemoryDeviceExecutionKindAuthority();
  workspaceKinds.claim(command().executionId, "workspaceList");
  const workspace = new InMemoryWorkspaceDispatchStore({
    executionKinds: workspaceKinds,
    routeAuthority: { currentRoute: route },
    now: () => new Date("2026-08-09T00:00:01.000Z"),
  });
  await assert.rejects(
    workspace.prepare(command(), "2026-08-09T00:00:00.000Z"),
    hasCode("workspace_dispatch_stored_state_invalid"),
  );
  assert.equal(await workspace.load(command().executionId), null);

  const toolKinds = new InMemoryDeviceExecutionKindAuthority();
  toolKinds.claim(command().executionId, "tool");
  const tool = new InMemoryDeviceDispatchStore(toolKinds);
  await assert.rejects(
    tool.prepare(toolCommand(), "2026-08-09T00:00:00.000Z"),
    hasCode("device_dispatch_stored_state_invalid"),
  );
  assert.equal(await tool.load(command().executionId), null);
});

function toolCommand(): DeviceExecutionCommand {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "tool-lease-1",
    leaseEpoch: 1,
    expiresAt: "2026-08-09T01:00:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "workspace-execution-1",
    workspaceBindingId: "workspace-binding-1",
    capability: "workspace.read",
    actionDigest: `sha256:${"c".repeat(64)}`,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: "tool-key-1",
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:30:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
