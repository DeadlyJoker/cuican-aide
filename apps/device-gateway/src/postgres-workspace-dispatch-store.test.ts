import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  DeviceExecutionCommand,
  DeviceGatewayDispatchResolution,
} from "@crewon/contracts";
import { Pool } from "pg";

import { deviceDispatchFingerprint } from "./device-dispatch-identity.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";
import { PostgresWorkspaceDispatchStore } from "./postgres-workspace-dispatch-store.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
} from "./workspace-dispatch-store-conformance.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

if (connectionString === undefined) {
  test.skip("PostgresWorkspaceDispatchStore requires CREWON_TEST_POSTGRES_URL", () =>
    undefined);
} else {
  test("migrates v2 Tool authority to v3 global kinds", async (context) => {
    const schema = testSchema();
    await createVersionTwoFixture(connectionString, schema);
    const tool = new PostgresDeviceDispatchStore({ connectionString, schema });
    const workspace = new PostgresWorkspaceDispatchStore({
      connectionString,
      schema,
    });
    context.after(async () => {
      await Promise.all([tool.close(), workspace.close()]);
      await dropSchema(connectionString, schema);
    });
    await Promise.all([tool.ready(), workspace.ready()]);
    assert.deepEqual(
      (await tool.load("workspace-execution-1"))?.resolution,
      toolResolution(),
    );
    await assert.rejects(
      workspace.prepare(command(), timestamp(0)),
      hasCode("device_dispatch_kind_conflict"),
    );
    const pool = new Pool({ connectionString });
    const rows = await pool.query(
      `SELECT execution_id, command_kind
         FROM ${schema}.device_execution_kinds`,
    );
    const version = await pool.query<{ version: number }>(
      `SELECT version FROM ${schema}.device_dispatch_schema
        WHERE component = 'dispatch-authority'`,
    );
    await pool.end();
    assert.deepEqual(rows.rows, [
      { execution_id: "workspace-execution-1", command_kind: "tool" },
    ]);
    assert.equal(version.rows[0]?.version, 4);
  });

  test("commits Workspace authority and rejects kind orphans across pools", async (context) => {
    const schema = testSchema();
    const routes = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    const workspace = new PostgresWorkspaceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    const tool = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    context.after(async () => {
      await Promise.all([routes.close(), workspace.close(), tool.close()]);
      await dropSchema(connectionString, schema);
    });
    await Promise.all([routes.ready(), workspace.ready(), tool.ready()]);
    const current = await claimEpochThree(routes);
    await workspace.prepare(command(), timestamp(0));
    const renewed = await routes.renewConnection({
      deviceId: current.deviceId,
      gatewayId: current.gatewayId,
      connectionId: current.connectionId,
      epoch: current.connectionEpoch,
      leaseDurationMs: 60_000,
    });
    assert.notEqual(renewed, null);
    const accepted = acceptedEvent({
      connectionEpoch: current.connectionEpoch,
    });
    const acceptedResult = await workspace.acceptEvent({
      command: command(),
      route: current,
      event: accepted,
    });
    assert.equal(acceptedResult.outcome, "committed");
    assert.deepEqual(acceptedResult.record.route, workspaceRoute(renewed!));
    assert.equal(
      await routes.releaseConnection({
        deviceId: current.deviceId,
        gatewayId: current.gatewayId,
        connectionId: current.connectionId,
        epoch: current.connectionEpoch,
      }),
      true,
    );
    const terminal = completedEvent({
      connectionEpoch: current.connectionEpoch,
    });
    assert.equal(
      (
        await workspace.settleEvent({
          command: command(),
          route: {
            ...current,
            leaseExpiresAt: "2099-01-01T00:05:00.000Z",
          },
          event: terminal,
          resolution: { ...completedResolution(), terminal },
        })
      ).outcome,
      "committed",
    );
    await assert.rejects(
      tool.prepare(toolCommand(), timestamp(0)),
      hasCode("device_dispatch_kind_conflict"),
    );

    const pool = new Pool({ connectionString });
    await pool.query(
      `INSERT INTO ${schema}.device_execution_kinds (
         execution_id, command_kind
       ) VALUES ('workspace-orphan-1', 'workspaceList')`,
    );
    await pool.end();
    await assert.rejects(
      workspace.prepare(
        command({ executionId: "workspace-orphan-1" }),
        timestamp(0),
      ),
      hasCode("workspace_dispatch_stored_state_invalid"),
    );
  });

  test("v3 schema and both readers fail closed on cross-kind detail corruption", async (context) => {
    const schema = testSchema();
    const pool = new Pool({ connectionString, max: 4 });
    const workspace = new PostgresWorkspaceDispatchStore({ pool, schema });
    const tool = new PostgresDeviceDispatchStore({ pool, schema });
    context.after(async () => {
      await Promise.all([workspace.close(), tool.close()]);
      await dropSchema(connectionString, schema);
      await pool.end();
    });
    await Promise.all([workspace.ready(), tool.ready()]);
    await workspace.prepare(command(), timestamp(0));
    await pool.query(
      `ALTER TABLE ${schema}.device_dispatch_records
         DROP CONSTRAINT device_dispatch_records_execution_kind_fk`,
    );
    const forgedTool = toolCommand();
    await pool.query(
      `INSERT INTO ${schema}.device_dispatch_records (
         execution_id, fingerprint, command_json, resolution_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, NULL, $4, $4)`,
      [
        forgedTool.executionId,
        deviceDispatchFingerprint(forgedTool),
        JSON.stringify(forgedTool),
        timestamp(0),
      ],
    );
    await assert.rejects(
      workspace.load(command().executionId),
      hasCode("workspace_dispatch_stored_state_invalid"),
    );
    await assert.rejects(
      tool.load(command().executionId),
      hasCode("device_dispatch_stored_state_invalid"),
    );
    const schemaReader = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
    });
    await assert.rejects(
      schemaReader.ready(),
      hasCode("device_dispatch_schema_invalid"),
    );
    await assert.rejects(
      schemaReader.close(),
      hasCode("device_dispatch_schema_invalid"),
    );
  });

  test("schema validation requires every legacy and read execution kind", async (context) => {
    const schema = testSchema();
    const pool = new Pool({ connectionString });
    const authority = new PostgresDeviceDispatchStore({ pool, schema });
    context.after(async () => {
      await authority.close();
      await dropSchema(connectionString, schema);
      await pool.end();
    });
    await authority.ready();
    await pool.query(`
      ALTER TABLE ${schema}.device_execution_kinds
        DROP CONSTRAINT device_execution_kinds_command_kind_check,
        ADD CONSTRAINT device_execution_kinds_command_kind_check
          CHECK (command_kind IN ('workspaceList', 'workspaceRead'))
    `);
    const reader = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
    });
    await assert.rejects(
      reader.ready(),
      hasCode("device_dispatch_schema_invalid"),
    );
    await assert.rejects(
      reader.close(),
      hasCode("device_dispatch_schema_invalid"),
    );
  });

  test("takes execution lock before route and terminal receipt never waits on route", async (context) => {
    const schema = testSchema();
    const pool = new Pool({ connectionString, max: 6 });
    const routes = new PostgresDeviceDispatchStore({ pool, schema });
    const workspace = new PostgresWorkspaceDispatchStore({ pool, schema });
    context.after(async () => {
      await Promise.all([routes.close(), workspace.close()]);
      await dropSchema(connectionString, schema);
      await pool.end();
    });
    await Promise.all([routes.ready(), workspace.ready()]);
    const current = await claimEpochThree(routes);
    await workspace.prepare(command(), timestamp(0));

    const lockKey = `device-dispatch:${schema}:${command().executionId}`;
    const executionHolder = await pool.connect();
    await executionHolder.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [lockKey],
    );
    const pendingAccepted = workspace.acceptEvent({
      command: command(),
      route: current,
      event: acceptedEvent({ connectionEpoch: current.connectionEpoch }),
    });
    await waitForAdvisoryWaiter(pool, lockKey);
    const routeProbe = await pool.connect();
    await routeProbe.query("BEGIN");
    await routeProbe.query(
      `SELECT device_id
         FROM ${schema}.device_connection_routes
        WHERE device_id = $1
        FOR UPDATE NOWAIT`,
      [current.deviceId],
    );
    await routeProbe.query("ROLLBACK");
    routeProbe.release();
    await executionHolder.query(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      [lockKey],
    );
    executionHolder.release();
    assert.equal((await pendingAccepted).outcome, "committed");

    const routeHolder = await pool.connect();
    await routeHolder.query("BEGIN");
    await routeHolder.query(
      `SELECT device_id
         FROM ${schema}.device_connection_routes
        WHERE device_id = $1
        FOR UPDATE`,
      [current.deviceId],
    );
    const replay = workspace.acceptEvent({
      command: command(),
      route: current,
      event: acceptedEvent({ connectionEpoch: current.connectionEpoch }),
    });
    const terminal = completedEvent({
      connectionEpoch: current.connectionEpoch,
    });
    const settled = workspace.settleEvent({
      command: command(),
      route: current,
      event: terminal,
      resolution: { ...completedResolution(), terminal },
    });
    assert.deepEqual(
      (await Promise.all([replay, settled])).map(({ outcome }) => outcome),
      ["replayed", "committed"],
    );
    await routeHolder.query("ROLLBACK");
    routeHolder.release();
  });
}

async function waitForAdvisoryWaiter(pool: Pool, key: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ waiters: string }>(
      `WITH key AS (SELECT hashtextextended($1, 0) AS value)
       SELECT count(*)::text AS waiters
         FROM pg_locks, key
        WHERE locktype = 'advisory'
          AND NOT granted
          AND classid = (((value >> 32) & 4294967295)::oid)
          AND objid = ((value & 4294967295)::oid)`,
      [key],
    );
    if (Number(result.rows[0]?.waiters) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("expected exact execution advisory waiter");
}

async function claimEpochThree(store: PostgresDeviceDispatchStore) {
  let route = await store.claimConnection({
    deviceId: "device-1",
    gatewayId: "gateway-1",
    connectionId: "connection-1",
    leaseDurationMs: 30_000,
  });
  for (let index = 0; index < 2; index += 1) {
    route = await store.claimConnection({
      deviceId: "device-1",
      gatewayId: "gateway-1",
      connectionId: "connection-1",
      leaseDurationMs: 30_000,
    });
  }
  return {
    deviceId: route.deviceId,
    gatewayId: route.gatewayId,
    connectionId: route.connectionId,
    connectionEpoch: route.epoch,
    leaseExpiresAt: route.leaseExpiresAt,
  };
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

async function createVersionTwoFixture(
  url: string,
  schema: string,
): Promise<void> {
  const pool = new Pool({ connectionString: url });
  const tool = toolCommand();
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE ${schema}.device_dispatch_schema (
      component TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
    INSERT INTO ${schema}.device_dispatch_schema VALUES ('dispatch-authority', 2);
    CREATE TABLE ${schema}.device_dispatch_records (
      execution_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      command_json JSONB NOT NULL,
      resolution_json JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE ${schema}.device_connection_routes (
      device_id TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      epoch BIGINT NOT NULL,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(
    `INSERT INTO ${schema}.device_dispatch_records (
       execution_id, fingerprint, command_json, resolution_json,
       created_at, updated_at
     ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
    [
      tool.executionId,
      deviceDispatchFingerprint(tool),
      JSON.stringify(tool),
      JSON.stringify(toolResolution()),
      timestamp(0),
      timestamp(1),
    ],
  );
  await pool.end();
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

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 9, 0, 0, offsetSeconds)).toISOString();
}

function testSchema(): string {
  return `crewon_workspace_${randomUUID().replaceAll("-", "")}`;
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: url });
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
