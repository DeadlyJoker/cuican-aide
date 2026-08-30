import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import { DeviceGatewayWorkspaceReadSession } from "./device-gateway-workspace-read-session.ts";
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

test("workspace read ACK is emitted only after durable commit", async () => {
  const sent: object[] = [];
  let release!: () => void;
  const committed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new InMemoryWorkspaceReadDispatchStore({
    now: () => new Date("2026-08-08T00:00:03Z"),
    currentRoute: () => route,
  });
  await store.prepare(command, route, "2026-08-08T00:00:02Z");
  const session = new DeviceGatewayWorkspaceReadSession({
    deviceId: "device-1",
    now: () => new Date("2026-08-08T00:00:05Z"),
    send: async (value) => {
      sent.push(value);
    },
  });
  void session.execute(
    command,
    7,
    false,
    new AbortController().signal,
    async (event) => {
      await committed;
      return store.commit({ command, route, event });
    },
  );
  await new Promise(setImmediate);
  const handling = session.handleFrame(events[0]);
  await new Promise(setImmediate);
  assert.equal(sent.length, 1);
  release();
  await handling;
  assert.equal((sent[1] as { throughSequence: number }).throughSequence, 1);
});

test("durable replay is allowed after signed command expiry", async () => {
  const store = new InMemoryWorkspaceReadDispatchStore({
    now: () => new Date("2026-08-09T00:00:00Z"),
    currentRoute: () => route,
  });
  await store.prepare(command, route, "2026-08-08T00:00:02Z");
  const session = new DeviceGatewayWorkspaceReadSession({
    deviceId: "device-1",
    now: () => new Date("2026-08-09T00:00:00Z"),
    send: async () => {},
  });
  assert.doesNotThrow(() =>
    session.execute(command, 7, true, new AbortController().signal, (event) =>
      store.commit({ command, route, event }),
    ),
  );
  assert.throws(
    () =>
      session.execute(
        { ...command, executionId: "fresh-expired" },
        7,
        false,
        new AbortController().signal,
        async () => {
          throw new Error();
        },
      ),
    /device_authorization_expired/,
  );
  session.close();
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
