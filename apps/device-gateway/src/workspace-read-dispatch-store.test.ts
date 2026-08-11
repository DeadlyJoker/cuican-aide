import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import { InMemoryWorkspaceReadDispatchStore } from "./workspace-read-dispatch-store.ts";

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

test("workspace read authority commits accepted and terminal before exact replay", async () => {
  let now = new Date("2026-08-08T00:00:02Z");
  const store = new InMemoryWorkspaceReadDispatchStore({
    now: () => now,
    currentRoute: () => route,
  });
  assert.equal(
    (await store.prepare(command, now.toISOString())).outcome,
    "created",
  );
  now = new Date("2026-08-08T00:00:03Z");
  const accepted = await store.commit({ command, route, event: events[0]! });
  assert.equal(
    (accepted.acknowledgement as { throughSequence: number }).throughSequence,
    1,
  );
  now = new Date("2026-08-08T00:00:04Z");
  const terminal = await store.commit({ command, route, event: events[1]! });
  assert.equal(terminal.record.resolution?.status, "completed");
  assert.deepEqual(
    (await store.prepare(command, "2026-08-09T00:00:00Z")).record.resolution,
    terminal.record.resolution,
  );
  assert.equal(
    (await store.commit({ command, route, event: events[1]! })).outcome,
    "replayed",
  );
});

test("workspace read authority rejects epoch drift and terminal-before-accepted", async () => {
  const store = new InMemoryWorkspaceReadDispatchStore({
    now: () => new Date("2026-08-08T00:00:03Z"),
    currentRoute: () => route,
  });
  await store.prepare(command, "2026-08-08T00:00:02Z");
  await assert.rejects(
    store.commit({
      command,
      route: { ...route, connectionEpoch: 8 },
      event: events[0]!,
    }),
    /workspace_read_event_identity_mismatch/,
  );
  await assert.rejects(
    store.commit({ command, route, event: events[1]! }),
    /workspace_read_accepted_missing/,
  );
});

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
