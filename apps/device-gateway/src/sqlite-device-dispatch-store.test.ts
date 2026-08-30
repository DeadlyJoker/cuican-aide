import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  DeviceExecutionCommand,
  DeviceExecutionEvent,
  DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";

test("persists prepared identity and terminal receipt across Gateway restart", async (context) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "crewon-device-dispatch-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "dispatch.sqlite");
  const first = new SqliteDeviceDispatchStore(databasePath);
  assert.equal(
    (await first.prepare(command(), timestamp(0))).outcome,
    "created",
  );
  await first.close();

  const second = new SqliteDeviceDispatchStore(databasePath);
  const renewed = command({ leaseId: "lease-2", leaseEpoch: 2 });
  const replay = await second.prepare(renewed, timestamp(1));
  assert.equal(replay.outcome, "existing");
  assert.equal(replay.record.resolution, null);
  assert.equal(replay.record.command.leaseId, "lease-1");
  assert.deepEqual(
    (await second.complete(renewed, completed(), timestamp(2))).resolution,
    completed(),
  );
  await second.close();

  const third = new SqliteDeviceDispatchStore(databasePath);
  assert.deepEqual((await third.load("execution-1"))?.resolution, completed());
  assert.equal(
    (
      await third.prepare(
        command({ leaseId: "lease-3", leaseEpoch: 3 }),
        timestamp(3),
      )
    ).outcome,
    "existing",
  );
  await third.close();
});

test("rejects execution identity and terminal drift without changing authority", async () => {
  const store = new SqliteDeviceDispatchStore(":memory:");
  await store.prepare(command(), timestamp(0));
  await assert.rejects(
    store.prepare(
      command({ actionDigest: `sha256:${"b".repeat(64)}` }),
      timestamp(1),
    ),
    hasCode("device_dispatch_identity_conflict"),
  );
  await store.complete(command(), completed(), timestamp(2));
  const changedTerminal: DeviceGatewayDispatchResolution = {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: completedEvent({
      data: { ...completedEvent().data, output: "changed" },
    }),
    output: [],
  };
  await assert.rejects(
    store.complete(command(), changedTerminal, timestamp(3)),
    hasCode("device_dispatch_terminal_conflict"),
  );
  assert.deepEqual((await store.load("execution-1"))?.resolution, completed());
  await store.close();
});

function command(
  overrides: Partial<DeviceExecutionCommand> = {},
): DeviceExecutionCommand {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2099-08-09T00:00:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: `sha256:${"a".repeat(64)}`,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: `device:${"a".repeat(64)}`,
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:05:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
    ...overrides,
  };
}

function completed(): DeviceGatewayDispatchResolution {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: completedEvent(),
    output: [],
  };
}

function completedEvent(
  overrides: Partial<
    Extract<DeviceExecutionEvent, { type: "execution.completed" }>
  > = {},
): Extract<DeviceExecutionEvent, { type: "execution.completed" }> {
  return {
    schemaVersion: "crewon.device-event.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    executionId: "execution-1",
    receiptId: "receipt-1",
    sequence: 2,
    observedAt: "2026-08-09T00:00:01.000Z",
    type: "execution.completed",
    data: {
      output: "done",
      artifactRef: null,
      outputDigest: `sha256:${"c".repeat(64)}`,
      stdoutDigest: `sha256:${"d".repeat(64)}`,
      stderrDigest: `sha256:${"e".repeat(64)}`,
      exitCode: 0,
      exitSignal: null,
    },
    ...overrides,
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 9, 0, 0, offsetSeconds)).toISOString();
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
