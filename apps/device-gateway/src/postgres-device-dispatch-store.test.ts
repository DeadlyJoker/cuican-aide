import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  DeviceExecutionCommand,
  DeviceExecutionEvent,
  DeviceGatewayDispatchResolution,
} from "@crewon/contracts";
import { Pool } from "pg";

import { createDeviceDispatchStoreFromEnvironment } from "./device-dispatch-store-config.ts";
import { DeviceGatewayDispatchService } from "./device-gateway-dispatch-service.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

if (connectionString === undefined) {
  test.skip("PostgresDeviceDispatchStore requires CREWON_TEST_POSTGRES_URL", () =>
    undefined);
} else {
  test("shares one prepared and terminal authority across independent Gateway pools", async (context) => {
    const schema = testSchema();
    const first = createDeviceDispatchStoreFromEnvironment({
      CREWON_DEVICE_GATEWAY_DATABASE_URL: connectionString,
      CREWON_DEVICE_GATEWAY_DATABASE_SCHEMA: schema,
    });
    assert.ok(first instanceof PostgresDeviceDispatchStore);
    const second = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    context.after(async () => {
      await Promise.all([first.close(), second.close()]);
      await dropSchema(connectionString, schema);
    });

    const prepared = await Promise.all([
      first.prepare(command(), timestamp(0)),
      second.prepare(
        command({ leaseId: "lease-2", leaseEpoch: 2 }),
        timestamp(1),
      ),
    ]);
    assert.deepEqual(prepared.map(({ outcome }) => outcome).sort(), [
      "created",
      "existing",
    ]);
    assert.equal(
      new Set(prepared.map(({ record }) => record.command.leaseId)).size,
      1,
    );

    const terminals = await Promise.allSettled([
      first.complete(command(), completed(), timestamp(2)),
      second.complete(command(), failed(), timestamp(3)),
    ]);
    assert.equal(
      terminals.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    const rejected = terminals.find(({ status }) => status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.equal(
      errorCode(rejected.reason),
      "device_dispatch_terminal_conflict",
    );
    const committed = terminals.find(({ status }) => status === "fulfilled");
    assert.ok(committed?.status === "fulfilled");
    assert.deepEqual(
      (await second.load("execution-1"))?.resolution,
      committed.value.resolution,
    );
  });

  test("single-flights the initial Device send across two Gateway processes", async (context) => {
    const schema = testSchema();
    const firstStore = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    const secondStore = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    context.after(async () => {
      await Promise.all([firstStore.close(), secondStore.close()]);
      await dropSchema(connectionString, schema);
    });
    const execution = deferred<DeviceGatewayDispatchResolution>();
    const started = deferred<void>();
    let sends = 0;
    const service = (store: PostgresDeviceDispatchStore) =>
      new DeviceGatewayDispatchService({
        sessions: {
          session: () => ({
            acknowledgedSequence: () => null,
            execute: async () => {
              sends += 1;
              started.resolve();
              return execution.promise;
            },
            requestCancel: () => undefined,
          }),
        },
        authorizationVerifier: { verify: async () => undefined },
        store,
        now: () => new Date("2026-08-09T00:00:02.000Z"),
      });
    const first = service(firstStore);
    const second = service(secondStore);
    context.after(async () => {
      await Promise.all([first.close(), second.close()]);
    });

    const firstSettled = deferred<DeviceGatewayDispatchResolution>();
    const outcomes = [first.execute(command()), second.execute(command())];
    for (const outcome of outcomes) {
      void outcome.then(firstSettled.resolve);
    }
    await started.promise;
    assert.equal((await firstSettled.promise).status, "unknownOutcome");
    execution.resolve(completed());
    assert.deepEqual(
      (await Promise.all(outcomes)).map(({ status }) => status).sort(),
      ["completed", "unknownOutcome"],
    );
    assert.equal(sends, 1);
    assert.deepEqual(await second.reconcile(command()), completed());
  });

  test("fences stale Gateway connection epochs across independent pools", async (context) => {
    const schema = testSchema();
    const first = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    const second = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    context.after(async () => {
      await Promise.all([first.close(), second.close()]);
      await dropSchema(connectionString, schema);
    });

    const firstRoute = await first.claimConnection({
      deviceId: "device-1",
      gatewayId: "gateway-1",
      connectionId: "connection-1",
      leaseDurationMs: 30_000,
    });
    assert.equal(firstRoute.epoch, 1);
    const secondRoute = await second.claimConnection({
      deviceId: "device-1",
      gatewayId: "gateway-2",
      connectionId: "connection-2",
      leaseDurationMs: 30_000,
    });
    assert.deepEqual(
      {
        gatewayId: secondRoute.gatewayId,
        connectionId: secondRoute.connectionId,
        epoch: secondRoute.epoch,
      },
      {
        gatewayId: "gateway-2",
        connectionId: "connection-2",
        epoch: 2,
      },
    );
    assert.equal(
      await first.renewConnection({
        ...firstRoute,
        leaseDurationMs: 30_000,
      }),
      null,
    );
    assert.equal(await first.releaseConnection(firstRoute), false);
    assert.deepEqual(await first.loadConnection("device-1"), secondRoute);

    await expireRoute(connectionString, schema, "device-1");
    assert.equal(await second.loadConnection("device-1"), null);
    assert.equal(
      await second.renewConnection({
        ...secondRoute,
        leaseDurationMs: 30_000,
      }),
      null,
    );
    assert.equal(await second.releaseConnection(secondRoute), true);
  });

  test("rejects a newer Team authority schema before opening the listener", async (context) => {
    const schema = testSchema();
    context.after(() => dropSchema(connectionString, schema));
    const initial = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
    });
    await initial.ready();
    await initial.close();
    await setSchemaVersion(connectionString, schema, 99);

    const newer = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
    });
    await assert.rejects(
      newer.ready(),
      hasCode("device_dispatch_schema_newer"),
    );
    await assert.rejects(
      newer.close(),
      hasCode("device_dispatch_schema_newer"),
    );
  });
}

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

function failed(): DeviceGatewayDispatchResolution {
  return {
    status: "failed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: {
      schemaVersion: "crewon.device-event.v0",
      protocolVersion: 1,
      deviceId: "device-1",
      executionId: "execution-1",
      receiptId: "receipt-1",
      sequence: 2,
      observedAt: "2026-08-09T00:00:01.000Z",
      type: "execution.failed",
      data: { code: "fixture_failed", retryable: false },
    },
  };
}

function completedEvent(): Extract<
  DeviceExecutionEvent,
  { type: "execution.completed" }
> {
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
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 9, 0, 0, offsetSeconds)).toISOString();
}

function testSchema(): string {
  return `device_gateway_${randomUUID().replaceAll("-", "")}`;
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

async function expireRoute(
  url: string,
  schema: string,
  deviceId: string,
): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      `UPDATE ${schema}.device_connection_routes
          SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE device_id = $1`,
      [deviceId],
    );
  } finally {
    await pool.end();
  }
}

async function setSchemaVersion(
  url: string,
  schema: string,
  version: number,
): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      `UPDATE ${schema}.device_dispatch_schema
          SET version = $1
        WHERE component = 'dispatch-authority'`,
      [version],
    );
  } finally {
    await pool.end();
  }
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error ? String(error.code) : null;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => errorCode(error) === code;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
