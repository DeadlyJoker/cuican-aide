import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("SQLite rejects corrupted workspace-read route JSON on load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-read-corrupt-"));
  const path = join(directory, "gateway.sqlite");
  try {
    const store = new SqliteWorkspaceReadDispatchStore(path, {
      now: () => new Date("2026-08-08T00:00:02Z"),
      currentRoute: () => route,
    });
    await store.prepare(command, route, "2026-08-08T00:00:02Z");
    await store.close();
    const database = new DatabaseSync(path);
    const row = database
      .prepare("SELECT record_json FROM workspace_read_dispatch_records")
      .get() as { record_json: string };
    const record = JSON.parse(row.record_json);
    record.route.connectionEpoch = 0;
    database
      .prepare("UPDATE workspace_read_dispatch_records SET record_json = ?")
      .run(JSON.stringify(record));
    database.close();
    const reopened = new SqliteWorkspaceReadDispatchStore(path, {
      now: () => new Date("2026-08-08T00:00:02Z"),
      currentRoute: () => route,
    });
    await assert.rejects(
      reopened.load(command.executionId),
      /workspace_read_route_invalid/,
    );
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite write failure rolls back without phantom accepted authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-read-rollback-"));
  const path = join(directory, "gateway.sqlite");
  let now = new Date("2026-08-08T00:00:02Z");
  try {
    const store = new SqliteWorkspaceReadDispatchStore(path, {
      now: () => now,
      currentRoute: () => route,
    });
    await store.prepare(command, route, now.toISOString());
    const database = new DatabaseSync(path);
    database.exec(`CREATE TRIGGER reject_workspace_read_update
      BEFORE UPDATE ON workspace_read_dispatch_records
      BEGIN SELECT RAISE(ABORT, 'deterministic_write_failure'); END`);
    now = new Date("2026-08-08T00:00:03Z");
    await assert.rejects(
      store.commit({ command, route, event: events[0]! }),
      /deterministic_write_failure/,
    );
    database.exec("DROP TRIGGER reject_workspace_read_update");
    assert.equal((await store.load(command.executionId))?.acceptedEvent, null);
    await store.commit({ command, route, event: events[0]! });
    assert.equal(
      (await store.load(command.executionId))?.acceptedEvent?.receiptId,
      "receipt-read-1",
    );
    database.close();
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite close rejects late enqueue and drains the accepted queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-read-close-"));
  const path = join(directory, "gateway.sqlite");
  try {
    const store = new SqliteWorkspaceReadDispatchStore(path, {
      now: () => new Date("2026-08-08T00:00:02Z"),
      currentRoute: () => route,
    });
    await store.prepare(command, route, "2026-08-08T00:00:02Z");
    const accepted = Array.from({ length: 32 }, () =>
      store.load(command.executionId),
    );
    const closing = store.close();
    await assert.rejects(
      async () => store.load(command.executionId),
      /workspace_read_store_closed/,
    );
    assert.equal(
      (await Promise.all(accepted)).every(
        (record) => record?.executionId === command.executionId,
      ),
      true,
    );
    await closing;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
