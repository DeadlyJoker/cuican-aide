import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DeviceFilesystemReadCommand } from "@crewon/contracts";

import {
  createDeviceGatewayDispatchStoresFromEnvironment,
  createDeviceDispatchStoreFromEnvironment,
  createWorkspaceDispatchStoreFromEnvironment,
  createWorkspaceReadDispatchStoreFromEnvironment,
} from "./device-dispatch-store-config.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";
import { SqliteWorkspaceDispatchStore } from "./sqlite-workspace-dispatch-store.ts";
import { SqliteWorkspaceReadDispatchStore } from "./sqlite-workspace-read-dispatch-store.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const readCommand = fixture.valid
  .filesystemReadCommand as DeviceFilesystemReadCommand;

test("selects an explicit Standalone dispatch authority", async () => {
  const sqlite = createDeviceDispatchStoreFromEnvironment({
    CREWON_DEVICE_GATEWAY_DATABASE_PATH: ":memory:",
  });
  assert.ok(sqlite instanceof SqliteDeviceDispatchStore);
  const workspace = createWorkspaceDispatchStoreFromEnvironment({
    CREWON_DEVICE_GATEWAY_DATABASE_PATH: ":memory:",
  });
  assert.ok(workspace instanceof SqliteWorkspaceDispatchStore);
  const read = createWorkspaceReadDispatchStoreFromEnvironment(
    { CREWON_DEVICE_GATEWAY_DATABASE_PATH: ":memory:" },
    () => null,
  );
  assert.ok(read instanceof SqliteWorkspaceReadDispatchStore);
  await Promise.all([sqlite.close(), workspace.close(), read.close()]);
});

test("builds the complete production stores with a durable read-route fence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-gateway-stores-"));
  const path = join(directory, "gateway.sqlite");
  const stores = createDeviceGatewayDispatchStoresFromEnvironment({
    CREWON_DEVICE_GATEWAY_DATABASE_PATH: path,
  });
  try {
    const connection = await stores.connectionRouteStore.claimConnection({
      deviceId: readCommand.deviceId,
      gatewayId: "gateway-production-1",
      connectionId: "connection-production-1",
      leaseDurationMs: 30_000,
    });
    const route = {
      deviceId: connection.deviceId,
      gatewayId: connection.gatewayId,
      connectionId: connection.connectionId,
      connectionEpoch: connection.epoch,
      deviceBindingId: "device-binding-production-1",
      runtimeBindingId: "runtime-binding-production-1",
      capability: "workspace.read_file.v0" as const,
      leaseExpiresAt: connection.leaseExpiresAt,
    };
    assert.equal(
      (
        await stores.workspaceReadDispatchStore.prepare(
          readCommand,
          route,
          connection.updatedAt,
        )
      ).outcome,
      "created",
    );

    await stores.connectionRouteStore.claimConnection({
      deviceId: readCommand.deviceId,
      gatewayId: connection.gatewayId,
      connectionId: "connection-production-2",
      leaseDurationMs: 30_000,
    });
    await assert.rejects(
      stores.workspaceReadDispatchStore.prepare(
        { ...readCommand, executionId: "workspace-read-stale-production-1" },
        route,
        new Date().toISOString(),
      ),
      /workspace_read_route_stale/,
    );
  } finally {
    await Promise.allSettled([
      stores.dispatchStore.close(),
      stores.workspaceDispatchStore.close(),
      stores.workspaceReadDispatchStore.close(),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing or dual dispatch authority without fallback", () => {
  assert.throws(
    () => createDeviceDispatchStoreFromEnvironment({}),
    hasCode("device_dispatch_database_config_invalid"),
  );
  assert.throws(
    () => createWorkspaceDispatchStoreFromEnvironment({}),
    hasCode("device_dispatch_database_config_invalid"),
  );
  assert.throws(
    () => createWorkspaceReadDispatchStoreFromEnvironment({}, () => null),
    hasCode("device_dispatch_database_config_invalid"),
  );
  assert.throws(
    () =>
      createDeviceDispatchStoreFromEnvironment({
        CREWON_DEVICE_GATEWAY_DATABASE_PATH: "gateway.sqlite",
        CREWON_DEVICE_GATEWAY_DATABASE_URL: "postgresql://db/crewon",
      }),
    hasCode("device_dispatch_database_config_invalid"),
  );
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
