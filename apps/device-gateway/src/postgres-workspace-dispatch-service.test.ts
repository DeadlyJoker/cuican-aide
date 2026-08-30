import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { DeviceWorkspaceListDispatchReference } from "@crewon/contracts";
import { Pool } from "pg";

import { DeviceGatewayWorkspaceDispatchService } from "./device-gateway-workspace-dispatch-service.ts";
import type { DeviceGatewaySession } from "./device-gateway-session.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";
import { PostgresWorkspaceDispatchStore } from "./postgres-workspace-dispatch-store.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
} from "./workspace-dispatch-store-conformance.test-support.ts";
import { WorkspaceWorkerRuntimeAuthorizer } from "./workspace-worker-runtime-authorizer.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

if (connectionString === undefined) {
  test.skip("Postgres Workspace service requires CREWON_TEST_POSTGRES_URL", () =>
    undefined);
} else {
  test("replays accepted authority through the Workspace service on real PostgreSQL", async (context) => {
    const schema = `crewon_workspace_service_${randomUUID().replaceAll("-", "")}`;
    const routes = new PostgresDeviceDispatchStore({
      connectionString,
      schema,
    });
    const store = new PostgresWorkspaceDispatchStore({
      connectionString,
      schema,
    });
    context.after(async () => {
      await Promise.all([routes.close(), store.close()]);
      const pool = new Pool({ connectionString });
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    await Promise.all([routes.ready(), store.ready()]);
    const claimed = await routes.claimConnection({
      deviceId: "device-1",
      gatewayId: "gateway-1",
      connectionId: "connection-1",
      leaseDurationMs: 30_000,
    });
    const route = {
      deviceId: claimed.deviceId,
      gatewayId: claimed.gatewayId,
      connectionId: claimed.connectionId,
      connectionEpoch: claimed.epoch,
      leaseExpiresAt: claimed.leaseExpiresAt,
    };
    await store.prepare(command(), "2026-08-09T00:00:00.000Z");
    await store.acceptEvent({
      command: command(),
      route,
      event: acceptedEvent({ connectionEpoch: route.connectionEpoch }),
    });
    const terminal = completedEvent({
      connectionEpoch: route.connectionEpoch,
    });
    const session = {
      supportsWorkspaceList: () => true,
      workspaceAcknowledgedSequence: () => null,
      requestWorkspaceCancel: () => undefined,
      async executeWorkspaceList(
        _command: unknown,
        _epoch: unknown,
        _mode: unknown,
        _signal: unknown,
        commit: Parameters<DeviceGatewaySession["executeWorkspaceList"]>[4],
      ) {
        const committed = await commit(terminal);
        return structuredClone(committed.record.resolution!);
      },
    } as unknown as DeviceGatewaySession;
    const service = new DeviceGatewayWorkspaceDispatchService({
      sessions: { workspaceSession: () => ({ session, route }) },
      authorizationVerifier: {
        verify: async () =>
          Promise.reject(
            new DeviceGatewayError("device_authorization_expired"),
          ),
      },
      workerAuthorizer: new WorkspaceWorkerRuntimeAuthorizer([
        {
          workerId: "worker-1",
          credentialId: "credential-1",
          fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
          allowedRuntimeBindingIds: ["runtime-binding-1"],
        },
      ]),
      store,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    context.after(() => service.close());
    assert.deepEqual(
      await service.reconcile(
        {
          workerId: "worker-1",
          credentialId: "credential-1",
          authenticationMethod: "mtls",
          authenticatedAt: "2099-01-01T00:00:00.000Z",
        },
        reference(),
      ),
      { ...completedResolution(), terminal },
    );
  });
}

function reference(): DeviceWorkspaceListDispatchReference {
  const value = command();
  return {
    deviceId: value.deviceId,
    executionId: value.executionId,
    workspaceBindingId: value.workspaceBindingId,
    incarnationId: value.incarnationId,
    deviceBindingId: value.deviceBindingId,
    runtimeBindingId: value.runtimeBindingId,
    actionDigest: value.actionDigest,
    commandDigest: value.commandDigest,
    receiptId: null,
  };
}
