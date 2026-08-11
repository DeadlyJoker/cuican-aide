import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  DeviceExecutionCommand,
  DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import { deviceDispatchFingerprint } from "./device-dispatch-identity.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";
import { SqliteWorkspaceDispatchStore } from "./sqlite-workspace-dispatch-store.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
} from "./workspace-dispatch-store-conformance.test-support.ts";

test("migrates v1 Tool authority to v2 kinds without changing its receipt", async (context) => {
  const fixture = await databaseFixture(context);
  createVersionOneFixture(fixture.path);
  const tool = new SqliteDeviceDispatchStore(fixture.path);
  assert.deepEqual((await tool.load("workspace-execution-1"))?.resolution, {
    ...toolResolution(),
    executionId: "workspace-execution-1",
    terminal: {
      ...toolResolution().terminal,
      executionId: "workspace-execution-1",
    },
  });
  await tool.close();

  const workspace = new SqliteWorkspaceDispatchStore(fixture.path);
  await assert.rejects(
    workspace.prepare(command(), timestamp(0)),
    hasCode("device_dispatch_kind_conflict"),
  );
  await workspace.close();

  const database = new DatabaseSync(fixture.path);
  assert.equal(
    (database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    2,
  );
  assert.deepEqual(
    database
      .prepare(`SELECT execution_id, command_kind FROM device_execution_kinds`)
      .all()
      .map((row) => ({ ...row })),
    [{ execution_id: "workspace-execution-1", command_kind: "tool" }],
  );
  database.close();
});

test("persists accepted and terminal authority across restart without terminal route dependency", async (context) => {
  const fixture = await databaseFixture(context);
  const first = new SqliteWorkspaceDispatchStore(fixture.path);
  const current = await claimEpochThree(first);
  await first.prepare(command(), timestamp(0));
  const accepted = acceptedEvent({ connectionEpoch: current.connectionEpoch });
  assert.equal(
    (
      await first.acceptEvent({
        command: command(),
        route: current,
        event: accepted,
      })
    ).outcome,
    "committed",
  );
  assert.equal(
    (
      await first.acceptEvent({
        command: command(),
        route: current,
        event: accepted,
      })
    ).outcome,
    "replayed",
  );
  assert.equal(
    await first.releaseConnection({
      deviceId: current.deviceId,
      gatewayId: current.gatewayId,
      connectionId: current.connectionId,
      epoch: current.connectionEpoch,
    }),
    true,
  );
  const renewedLease = {
    ...current,
    leaseExpiresAt: "2099-01-01T00:05:00.000Z",
  };
  const terminal = completedEvent({ connectionEpoch: current.connectionEpoch });
  const resolution = { ...completedResolution(), terminal };
  assert.equal(
    (
      await first.settleEvent({
        command: command(),
        route: renewedLease,
        event: terminal,
        resolution,
      })
    ).outcome,
    "committed",
  );
  const frozen = await first.load(command().executionId);
  await first.close();

  const restarted = new SqliteWorkspaceDispatchStore(fixture.path);
  assert.deepEqual(await restarted.load(command().executionId), frozen);
  assert.equal(
    (
      await restarted.settleEvent({
        command: command(),
        route: renewedLease,
        event: terminal,
        resolution,
      })
    ).outcome,
    "replayed",
  );
  await restarted.close();
});

test("preserves the connection epoch high-water mark after release and restart", async (context) => {
  const fixture = await databaseFixture(context);
  const first = new SqliteWorkspaceDispatchStore(fixture.path);
  const released = await first.claimConnection({
    deviceId: "device-1",
    gatewayId: "gateway-1",
    connectionId: "connection-1",
    leaseDurationMs: 30_000,
  });
  assert.equal(await first.releaseConnection(released), true);
  assert.equal(await first.loadConnection("device-1"), null);
  await first.close();

  const restarted = new SqliteWorkspaceDispatchStore(fixture.path);
  const claimed = await restarted.claimConnection({
    deviceId: "device-1",
    gatewayId: "gateway-2",
    connectionId: "connection-2",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed.epoch, 2);
  await restarted.close();
});

test("fresh accepted reads the current route and orphan kinds fail closed", async (context) => {
  const fixture = await databaseFixture(context);
  const store = new SqliteWorkspaceDispatchStore(fixture.path);
  const oldRoute = await claimEpochThree(store);
  await store.prepare(command(), timestamp(0));
  const currentRoute = workspaceRoute(
    await store.claimConnection({
      deviceId: "device-1",
      gatewayId: "gateway-2",
      connectionId: "connection-2",
      leaseDurationMs: 30_000,
    }),
  );
  await assert.rejects(
    store.acceptEvent({
      command: command(),
      route: oldRoute,
      event: acceptedEvent({ connectionEpoch: oldRoute.connectionEpoch }),
    }),
    hasCode("workspace_dispatch_route_stale"),
  );
  const renewed = await store.renewConnection({
    deviceId: currentRoute.deviceId,
    gatewayId: currentRoute.gatewayId,
    connectionId: currentRoute.connectionId,
    epoch: currentRoute.connectionEpoch,
    leaseDurationMs: 60_000,
  });
  assert.notEqual(renewed, null);
  const accepted = await store.acceptEvent({
    command: command(),
    route: currentRoute,
    event: acceptedEvent({
      connectionEpoch: currentRoute.connectionEpoch,
    }),
  });
  assert.equal(accepted.outcome, "committed");
  assert.deepEqual(accepted.record.route, workspaceRoute(renewed!));

  const raw = new DatabaseSync(fixture.path);
  raw
    .prepare(
      `INSERT INTO device_execution_kinds (execution_id, command_kind)
       VALUES (?, 'workspaceList')`,
    )
    .run("workspace-orphan-1");
  raw.close();
  await assert.rejects(
    store.prepare(command({ executionId: "workspace-orphan-1" }), timestamp(0)),
    hasCode("workspace_dispatch_stored_state_invalid"),
  );
  await store.close();
});

test("Workspace detail claims the global execution id against later Tool prepare", async (context) => {
  const fixture = await databaseFixture(context);
  const workspace = new SqliteWorkspaceDispatchStore(fixture.path);
  await workspace.prepare(command(), timestamp(0));
  await workspace.close();
  const tool = new SqliteDeviceDispatchStore(fixture.path);
  await assert.rejects(
    tool.prepare(toolCommand(), timestamp(0)),
    hasCode("device_dispatch_kind_conflict"),
  );
  await tool.close();
});

test("rejects forged v2 schema and cross-kind detail corruption", async (context) => {
  const malformed = await databaseFixture(context);
  createMalformedVersionTwoFixture(malformed.path);
  assert.throws(
    () => new SqliteWorkspaceDispatchStore(malformed.path),
    hasCode("device_dispatch_schema_invalid"),
  );

  const corrupted = await databaseFixture(context);
  const workspace = new SqliteWorkspaceDispatchStore(corrupted.path);
  await workspace.prepare(command(), timestamp(0));
  await workspace.close();
  const raw = new DatabaseSync(corrupted.path);
  raw.exec("PRAGMA foreign_keys = OFF");
  const tool = toolCommand();
  raw
    .prepare(
      `INSERT INTO device_dispatch_records (
         execution_id, fingerprint, command_json, resolution_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      tool.executionId,
      deviceDispatchFingerprint(tool),
      JSON.stringify(tool),
      timestamp(0),
      timestamp(0),
    );
  raw.close();
  const workspaceReader = new SqliteWorkspaceDispatchStore(corrupted.path);
  const toolReader = new SqliteDeviceDispatchStore(corrupted.path);
  await assert.rejects(
    workspaceReader.load(command().executionId),
    hasCode("workspace_dispatch_stored_state_invalid"),
  );
  await assert.rejects(
    toolReader.load(command().executionId),
    hasCode("device_dispatch_stored_state_invalid"),
  );
  await Promise.all([workspaceReader.close(), toolReader.close()]);
});

async function claimEpochThree(store: SqliteWorkspaceDispatchStore) {
  let claimed = await store.claimConnection({
    deviceId: "device-1",
    gatewayId: "gateway-1",
    connectionId: "connection-1",
    leaseDurationMs: 30_000,
  });
  for (let index = 0; index < 2; index += 1) {
    claimed = await store.claimConnection({
      deviceId: "device-1",
      gatewayId: "gateway-1",
      connectionId: "connection-1",
      leaseDurationMs: 30_000,
    });
  }
  return workspaceRoute(claimed);
}

function workspaceRoute(route: {
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  epoch: number;
  leaseExpiresAt: string;
}) {
  return {
    deviceId: route.deviceId,
    gatewayId: route.gatewayId,
    connectionId: route.connectionId,
    connectionEpoch: route.epoch,
    leaseExpiresAt: route.leaseExpiresAt,
  };
}

function createVersionOneFixture(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE device_dispatch_records (
      execution_id TEXT PRIMARY KEY NOT NULL,
      fingerprint TEXT NOT NULL,
      command_json TEXT NOT NULL,
      resolution_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  const tool = toolCommand();
  const resolution = {
    ...toolResolution(),
    executionId: tool.executionId,
    terminal: { ...toolResolution().terminal, executionId: tool.executionId },
  };
  database
    .prepare(
      `INSERT INTO device_dispatch_records (
         execution_id, fingerprint, command_json, resolution_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tool.executionId,
      deviceDispatchFingerprint(tool),
      JSON.stringify(tool),
      JSON.stringify(resolution),
      timestamp(0),
      timestamp(1),
    );
  database.close();
}

function createMalformedVersionTwoFixture(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE device_execution_kinds (
      execution_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL
    ) STRICT;
    CREATE TABLE device_dispatch_records (
      execution_id TEXT PRIMARY KEY NOT NULL,
      fingerprint TEXT NOT NULL,
      command_json TEXT NOT NULL,
      resolution_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workspace_dispatch_records (
      execution_id TEXT PRIMARY KEY NOT NULL,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE device_connection_routes (
      device_id TEXT PRIMARY KEY NOT NULL,
      gateway_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX device_connection_routes_gateway_idx
      ON device_connection_routes (gateway_id, lease_expires_at);
    PRAGMA user_version = 2;
  `);
  database.close();
}

function toolCommand(): DeviceExecutionCommand {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "tool-lease-1",
    leaseEpoch: 1,
    expiresAt: "2099-08-09T01:00:00.000Z",
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

function toolResolution(): DeviceGatewayDispatchResolution {
  return {
    status: "completed",
    executionId: "workspace-execution-1",
    providerReceiptId: "tool-receipt-1",
    terminal: {
      schemaVersion: "crewon.device-event.v0",
      protocolVersion: 1,
      deviceId: "device-1",
      executionId: "workspace-execution-1",
      receiptId: "tool-receipt-1",
      sequence: 2,
      observedAt: timestamp(1),
      type: "execution.completed",
      data: {
        output: "done",
        artifactRef: null,
        outputDigest: `sha256:${"d".repeat(64)}`,
        stdoutDigest: `sha256:${"e".repeat(64)}`,
        stderrDigest: `sha256:${"f".repeat(64)}`,
        exitCode: 0,
        exitSignal: null,
      },
    },
    output: [],
  };
}

async function databaseFixture(context: test.TestContext) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "crewon-workspace-dispatch-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { path: path.join(directory, "gateway.sqlite") };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 9, 0, 0, offsetSeconds)).toISOString();
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
