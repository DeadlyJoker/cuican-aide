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
  test("PostgreSQL replicas converge and expose committed workspace-read authority", async (context) => {
    const schema = `crewon_read_${randomUUID().replaceAll("-", "")}`;
    let now = new Date("2026-08-08T00:00:02Z");
    const first = new PostgresWorkspaceReadDispatchStore({
      connectionString: url,
      schema,
      now: () => now,
      currentRoute: () => route,
    });
    const second = new PostgresWorkspaceReadDispatchStore({
      connectionString: url,
      schema,
      now: () => now,
      currentRoute: () => route,
    });
    context.after(async () => {
      await Promise.all([first.close(), second.close()]);
      const pool = new Pool({ connectionString: url });
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    await Promise.all([first.ready(), second.ready()]);
    const prepared = await Promise.all([
      first.prepare(command, route, now.toISOString()),
      second.prepare(command, route, now.toISOString()),
    ]);
    assert.deepEqual(prepared.map((value) => value.outcome).sort(), [
      "created",
      "existing",
    ]);
    assert.equal(
      (await second.load(command.executionId))?.fingerprint,
      prepared[0]!.record.fingerprint,
    );
    const drifted: DeviceFilesystemReadCommand = {
      ...command,
      arguments: {
        schemaVersion: "crewon.device-filesystem-read-arguments.v0",
        workspaceIncarnationId: command.arguments.workspaceIncarnationId,
        relativePathSegments: ["docs", "OTHER.md"],
        encoding: "utf8",
      },
    };
    await assert.rejects(
      second.prepare(drifted, route, now.toISOString()),
      /workspace_read_identity_conflict/,
    );
    now = new Date("2026-08-08T00:00:03Z");
    await first.commit({ command, route, event: events[0]! });
    assert.equal(
      (await second.load(command.executionId))?.acceptedEvent?.receiptId,
      "receipt-read-1",
    );
    now = new Date("2026-08-08T00:00:04Z");
    const terminal = await second.commit({
      command,
      route,
      event: events[1]!,
    });
    assert.equal(
      (await first.load(command.executionId))?.resolution?.status,
      "completed",
    );
    assert.equal(
      (await first.commit({ command, route, event: events[1]! })).outcome,
      "replayed",
    );
    const completed = events[1]!;
    assert.equal(completed.sequence, 2);
    const conflictingTerminal: DeviceFilesystemReadEvent = {
      schemaVersion: completed.schemaVersion,
      protocolVersion: completed.protocolVersion,
      commandKind: completed.commandKind,
      type: "workspace_read.failed" as const,
      deviceId: completed.deviceId,
      executionId: completed.executionId,
      receiptId: completed.receiptId,
      connectionEpoch: completed.connectionEpoch,
      workspaceBindingId: completed.workspaceBindingId,
      incarnationId: completed.incarnationId,
      commandDigest: completed.commandDigest,
      sequence: 2,
      observedAt: completed.observedAt,
      data: { code: "provider_failed", retryable: false },
    };
    await assert.rejects(
      first.commit({ command, route, event: conflictingTerminal }),
      /workspace_read_event_conflict/,
    );
    assert.deepEqual(
      (await second.load(command.executionId))?.resolution,
      terminal.record.resolution,
    );
  });
