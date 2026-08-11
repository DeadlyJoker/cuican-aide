import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeviceDispatchStoreFromEnvironment,
  createWorkspaceDispatchStoreFromEnvironment,
} from "./device-dispatch-store-config.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";
import { SqliteWorkspaceDispatchStore } from "./sqlite-workspace-dispatch-store.ts";

test("selects an explicit Standalone dispatch authority", async () => {
  const sqlite = createDeviceDispatchStoreFromEnvironment({
    CREWON_DEVICE_GATEWAY_DATABASE_PATH: ":memory:",
  });
  assert.ok(sqlite instanceof SqliteDeviceDispatchStore);
  const workspace = createWorkspaceDispatchStoreFromEnvironment({
    CREWON_DEVICE_GATEWAY_DATABASE_PATH: ":memory:",
  });
  assert.ok(workspace instanceof SqliteWorkspaceDispatchStore);
  await Promise.all([sqlite.close(), workspace.close()]);
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
