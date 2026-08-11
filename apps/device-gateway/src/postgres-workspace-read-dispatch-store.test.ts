import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import { PostgresWorkspaceReadDispatchStore } from "./postgres-workspace-read-dispatch-store.ts";

const url = process.env.CREWON_TEST_POSTGRES_URL;
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

if (url === undefined)
  test.skip("PostgresWorkspaceReadDispatchStore requires CREWON_TEST_POSTGRES_URL", () =>
    undefined);
else
  test("PostgreSQL persists workspace-read terminal receipt", async (context) => {
    const schema = `crewon_read_${randomUUID().replaceAll("-", "")}`;
    let now = new Date("2026-08-08T00:00:02Z");
    const store = new PostgresWorkspaceReadDispatchStore({
      connectionString: url,
      schema,
      now: () => now,
      currentRoute: () => route,
    });
    context.after(async () => {
      await store.close();
      const pool = new Pool({ connectionString: url });
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    await store.ready();
    await store.prepare(command, route, now.toISOString());
    now = new Date("2026-08-08T00:00:03Z");
    await store.commit({ command, route, event: events[0]! });
    now = new Date("2026-08-08T00:00:04Z");
    await store.commit({ command, route, event: events[1]! });
    assert.equal(
      (await store.load(command.executionId))?.resolution?.status,
      "completed",
    );
  });
