import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadEvent,
} from "@crewon/contracts";
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
const command = fixture.valid
  .filesystemReadCommand as DeviceFilesystemReadCommand;
const events = fixture.valid
  .filesystemReadEvents as DeviceFilesystemReadEvent[];
const route = {
  deviceId: "device-1",
  gatewayId: "gateway-1",
  connectionId: "connection-1",
  connectionEpoch: 7,
  deviceBindingId: "binding-1",
  runtimeBindingId: "runtime-1",
  capability: "workspace.read_file.v0" as const,
  leaseExpiresAt: "2026-08-08T01:00:00Z",
};

test("SQLite preserves workspace-read accepted and terminal authority across reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-read-"));
  const path = join(directory, "gateway.sqlite");
  let now = new Date("2026-08-08T00:00:02Z");
  try {
    let store = new SqliteWorkspaceReadDispatchStore(path, {
      now: () => now,
      currentRoute: () => route,
    });
    await store.prepare(command, route, now.toISOString());
    now = new Date("2026-08-08T00:00:03Z");
    await store.commit({ command, route, event: events[0]! });
    await store.close();
    store = new SqliteWorkspaceReadDispatchStore(path, {
      now: () => now,
      currentRoute: () => ({
        ...route,
        connectionId: "connection-2",
        connectionEpoch: 8,
      }),
    });
    assert.equal(
      (await store.load(command.executionId))?.acceptedEvent?.receiptId,
      "receipt-read-1",
    );
    now = new Date("2026-08-08T00:00:04Z");
    await store.commit({ command, route, event: events[1]! });
    await store.close();
    store = new SqliteWorkspaceReadDispatchStore(path, {
      now: () => now,
      currentRoute: () => null,
    });
    assert.equal(
      (await store.load(command.executionId))?.resolution?.status,
      "completed",
    );
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
