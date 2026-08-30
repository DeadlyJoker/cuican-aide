import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceWorkspaceListEvent } from "@crewon/contracts";

import { DeviceGatewayWorkspaceSession } from "./device-gateway-workspace-session.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
  route,
} from "./workspace-dispatch-store-conformance.test-support.ts";
import { InMemoryWorkspaceDispatchStore } from "./workspace-dispatch-store.ts";

test("holds accepted and terminal ACKs until each durable commit", async () => {
  const sent: object[] = [];
  const store = storeFixture();
  const acceptedGate = deferred<void>();
  const terminalGate = deferred<void>();
  const channel = channelFixture({ sent });
  const resolution = channel.execute(
    command(),
    route().connectionEpoch,
    { kind: "fresh" },
    new AbortController().signal,
    async (event) => {
      if (event.type === "workspace_list.accepted") {
        await acceptedGate.promise;
        return store.acceptEvent({ command: command(), route: route(), event });
      }
      if (event.type !== "workspace_list.completed") {
        return assert.fail("completed event expected");
      }
      await terminalGate.promise;
      return store.settleEvent({
        command: command(),
        route: route(),
        event,
        resolution: { ...completedResolution(), terminal: event },
      });
    },
  );
  await turn();
  assert.equal(sent.length, 1);

  const accepting = channel.handleFrame(acceptedEvent());
  await turn();
  assert.equal(sent.length, 1);
  acceptedGate.resolve();
  await accepting;
  assert.equal(sent.length, 2);

  let resolved = false;
  void resolution.then(() => {
    resolved = true;
  });
  const completing = channel.handleFrame(completedEvent());
  await turn();
  assert.equal(sent.length, 2);
  assert.equal(resolved, false);
  terminalGate.resolve();
  await completing;
  assert.equal(sent.length, 3);
  assert.deepEqual(await resolution, completedResolution());
  await store.close();
});

test("keeps terminal authority when ACK fails and exact replay finishes", async () => {
  const store = storeFixture();
  const first = channelFixture({
    sent: [],
    failAckSequence: 2,
  });
  const firstResolution = first.execute(
    command(),
    route().connectionEpoch,
    { kind: "fresh" },
    new AbortController().signal,
    committer(store),
  );
  await turn();
  await first.handleFrame(acceptedEvent());
  await assert.rejects(first.handleFrame(completedEvent()));
  assert.deepEqual(await firstResolution, completedResolution());
  assert.deepEqual(
    (await store.load(command().executionId))?.resolution,
    completedResolution(),
  );
  first.close();

  const replaySent: object[] = [];
  const replay = channelFixture({ sent: replaySent });
  const replayResolution = replay.execute(
    command(),
    route().connectionEpoch,
    { kind: "durableReplay", acceptedConnectionEpoch: 3 },
    new AbortController().signal,
    committer(store),
  );
  await turn();
  await replay.handleFrame(acceptedEvent());
  await replay.handleFrame(completedEvent());
  assert.deepEqual(await replayResolution, completedResolution());
  assert.equal(replaySent.length, 3);
  await store.close();
});

test("replays an accepted journal on a newer connection while preserving the accepted epoch", async () => {
  const store = storeFixture();
  await store.acceptEvent({
    command: command(),
    route: route(),
    event: acceptedEvent(),
  });
  const sent: object[] = [];
  const replay = channelFixture({ sent });
  const resolution = replay.execute(
    command(),
    9,
    { kind: "durableReplay", acceptedConnectionEpoch: 3 },
    new AbortController().signal,
    committer(store),
  );
  await turn();
  await replay.handleFrame(acceptedEvent());
  await replay.handleFrame(completedEvent());
  assert.deepEqual(await resolution, completedResolution());
  assert.equal(sent.length, 3);
  await store.close();
});

test("distinguishes synchronous not-sent from asynchronous possibly-sent", async () => {
  const synchronous = new DeviceGatewayWorkspaceSession({
    deviceId: "device-1",
    lastAcknowledged: [],
    now,
    send() {
      throw new Error("closed before transport");
    },
  });
  await assert.rejects(
    synchronous.execute(
      command(),
      route().connectionEpoch,
      { kind: "fresh" },
      new AbortController().signal,
      async () => assert.fail("commit not expected"),
    ),
    hasCode("workspace_dispatch_not_sent"),
  );
  const asynchronous = new DeviceGatewayWorkspaceSession({
    deviceId: "device-1",
    lastAcknowledged: [],
    now,
    send: async () => Promise.reject(new Error("socket outcome unknown")),
  });
  await assert.rejects(
    asynchronous.execute(
      command(),
      route().connectionEpoch,
      { kind: "fresh" },
      new AbortController().signal,
      async () => assert.fail("commit not expected"),
    ),
    hasCode("workspace_dispatch_possibly_sent"),
  );
});

test("bounds a hung Device through the injected deadline scheduler", async () => {
  let deadline: (() => void) | null = null;
  const sent: object[] = [];
  const channel = new DeviceGatewayWorkspaceSession({
    deviceId: "device-1",
    lastAcknowledged: [],
    now,
    send: async (value) => {
      sent.push(value);
    },
    schedule(_delayMs, callback) {
      deadline = callback;
      return () => {
        deadline = null;
      };
    },
  });
  const resolution = channel.execute(
    command(),
    route().connectionEpoch,
    { kind: "fresh" },
    new AbortController().signal,
    async () => assert.fail("commit not expected"),
  );
  await turn();
  assert.notEqual(deadline, null);
  const fire = deadline as unknown as () => void;
  fire();
  assert.deepEqual(await resolution, {
    status: "unknownOutcome",
    executionId: command().executionId,
    receiptId: null,
    terminal: null,
  });
  assert.equal(
    sent.some(
      (value) =>
        (value as { schemaVersion?: unknown }).schemaVersion ===
        "crewon.device-cancel.v0",
    ),
    true,
  );
});

test("commits and ACKs durable orphan terminal replay after session restart", async () => {
  const store = storeFixture();
  await store.acceptEvent({
    command: command(),
    route: route(),
    event: acceptedEvent(),
  });
  const sent: object[] = [];
  const commit = committer(store);
  const channel = new DeviceGatewayWorkspaceSession({
    deviceId: "device-1",
    lastAcknowledged: [],
    now,
    send: async (value) => {
      sent.push(value);
    },
    orphanCommitter: async (event) => {
      if ((await store.load(event.executionId)) === null) {
        throw new DeviceGatewayError("device_execution_unknown");
      }
      return commit(event);
    },
  });
  await channel.handleFrame(completedEvent());
  assert.deepEqual(
    (await store.load(command().executionId))?.resolution,
    completedResolution(),
  );
  await channel.handleFrame(completedEvent());
  assert.equal(sent.length, 2);
  await assert.rejects(
    channel.handleFrame(
      completedEvent({
        data: {
          result: {
            ...completedEvent().data.result,
            entries: [{ name: "changed.txt", kind: "file" }],
          },
        },
      }),
    ),
    hasCode("workspace_dispatch_terminal_conflict"),
  );
  const unknownTerminal = completedEvent({
    executionId: "workspace-execution-unknown",
    data: {
      result: {
        ...completedEvent().data.result,
        executionId: "workspace-execution-unknown",
      },
    },
  });
  await assert.rejects(
    channel.handleFrame(unknownTerminal),
    hasCode("device_execution_unknown"),
  );
  await store.close();
});

function channelFixture(config: {
  sent: object[];
  failAckSequence?: number;
}): DeviceGatewayWorkspaceSession {
  return new DeviceGatewayWorkspaceSession({
    deviceId: "device-1",
    lastAcknowledged: [],
    now,
    send: async (value) => {
      if (
        config.failAckSequence !== undefined &&
        (value as { throughSequence?: unknown }).throughSequence ===
          config.failAckSequence
      ) {
        throw new Error("ack failed");
      }
      config.sent.push(value);
    },
  });
}

function storeFixture(): InMemoryWorkspaceDispatchStore {
  const store = new InMemoryWorkspaceDispatchStore({
    routeAuthority: { currentRoute: route },
    now,
  });
  void store.prepare(command(), "2026-08-09T00:00:00.000Z");
  return store;
}

function committer(store: InMemoryWorkspaceDispatchStore) {
  return (event: DeviceWorkspaceListEvent) => {
    if (event.type === "workspace_list.accepted") {
      return store.acceptEvent({ command: command(), route: route(), event });
    }
    if (event.type !== "workspace_list.completed") {
      return assert.fail("completed event expected");
    }
    return store.settleEvent({
      command: command(),
      route: route(),
      event,
      resolution: { ...completedResolution(), terminal: event },
    });
  };
}

function now(): Date {
  return new Date("2026-08-09T00:00:01.000Z");
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
