import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceWorkspaceListCommand,
  DeviceWorkspaceListDispatchReference,
  DeviceWorkspaceListDispatchResolution,
} from "@crewon/contracts";

import {
  DeviceGatewayWorkspaceDispatchService,
  type WorkspaceDeviceSessionTarget,
} from "./device-gateway-workspace-dispatch-service.ts";
import type { DeviceGatewaySession } from "./device-gateway-session.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
  route,
} from "./workspace-dispatch-store-conformance.test-support.ts";
import { InMemoryWorkspaceDispatchStore } from "./workspace-dispatch-store.ts";
import { WorkspaceWorkerRuntimeAuthorizer } from "./workspace-worker-runtime-authorizer.ts";

const worker = {
  workerId: "worker-1",
  credentialId: "credential-1",
  authenticationMethod: "mtls" as const,
  authenticatedAt: "2026-08-09T00:00:00.000Z",
};

test("terminal replay is receipt-first after expiry and accepts an unknown null receipt", async () => {
  const store = await terminalStore();
  let verifies = 0;
  let routeReads = 0;
  const service = serviceFixture({
    store,
    verifier: async () => {
      verifies += 1;
      throw new DeviceGatewayError("device_authorization_expired");
    },
    target: () => {
      routeReads += 1;
      return null;
    },
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(
    await service.reconcile(worker, reference(null)),
    completedResolution(),
  );
  assert.equal(verifies, 0);
  assert.equal(routeReads, 0);
  await service.close();
  await store.close();
});

test("accepted durable receipt with no Hello ACK resends exactly and settles replayed terminal", async () => {
  const store = storeFixture();
  await store.prepare(command(), "2026-08-09T00:00:00.000Z");
  await store.acceptEvent({
    command: command(),
    route: route(),
    event: acceptedEvent(),
  });
  let verifies = 0;
  const session = fakeSession({
    acknowledgedSequence: null,
    async execute(_command, _epoch, _mode, _signal, commit) {
      const committed = await commit(completedEvent());
      return structuredClone(committed.record.resolution!);
    },
  });
  const service = serviceFixture({
    store,
    verifier: async () => {
      verifies += 1;
      throw new DeviceGatewayError("device_authorization_expired");
    },
    target: () => ({ session, route: route() }),
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(
    await service.reconcile(worker, reference(null)),
    completedResolution(),
  );
  assert.equal(verifies, 0);
  await service.close();
  await store.close();
});

test("cancel resumes an accepted durable command, sends generic cancel, and trusts terminal authority", async () => {
  const store = storeFixture();
  await store.prepare(command(), "2026-08-09T00:00:00.000Z");
  await store.acceptEvent({
    command: command(),
    route: route(),
    event: acceptedEvent(),
  });
  let cancels = 0;
  const session = fakeSession({
    acknowledgedSequence: null,
    async execute(_command, _epoch, _mode, _signal, commit) {
      const committed = await commit(completedEvent());
      return structuredClone(committed.record.resolution!);
    },
    onCancel: () => {
      cancels += 1;
    },
  });
  const service = serviceFixture({
    store,
    verifier: async () =>
      Promise.reject(new DeviceGatewayError("device_authorization_expired")),
    target: () => ({ session, route: route() }),
  });
  assert.deepEqual(
    await service.cancel(worker, reference(null)),
    completedResolution(),
  );
  assert.equal(cancels, 1);
  await service.close();
  await store.close();
});

test("uses server time for prepare even when signed issuedAt is in the future", async () => {
  const store = storeFixture();
  const futureCommand = command({
    authorization: {
      ...command().authorization,
      issuedAt: "2026-08-09T00:04:00.000Z",
    },
  });
  const session = fakeSession({
    execute: async () => ({
      status: "unknownOutcome",
      executionId: futureCommand.executionId,
      receiptId: null,
      terminal: null,
    }),
  });
  const service = serviceFixture({
    store,
    verifier: async () => undefined,
    target: () => ({ session, route: route() }),
    now: () => new Date("2026-08-09T00:00:01.000Z"),
  });
  await service.execute(worker, futureCommand);
  assert.equal(
    (await store.load(futureCommand.executionId))?.createdAt,
    "2026-08-09T00:00:01.000Z",
  );
  await service.close();
  await store.close();
});

test("expired prepared-without-accepted authority re-verifies and sends nothing", async () => {
  const store = storeFixture();
  await store.prepare(command(), "2026-08-09T00:00:00.000Z");
  let sends = 0;
  const session = fakeSession({
    execute: async () => {
      sends += 1;
      return assert.fail("execute not expected");
    },
  });
  const service = serviceFixture({
    store,
    verifier: async () =>
      Promise.reject(new DeviceGatewayError("device_authorization_expired")),
    target: () => ({ session, route: route() }),
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });
  await assert.rejects(
    service.reconcile(worker, reference(null)),
    hasCode("device_authorization_expired"),
  );
  assert.equal(sends, 0);
  await service.close();
  await store.close();
});

test("missing Device capability performs zero sends and wrong Worker binding fails closed", async () => {
  const store = storeFixture();
  let sends = 0;
  const session = fakeSession({
    supports: false,
    execute: async () => {
      sends += 1;
      return assert.fail("execute not expected");
    },
  });
  const service = serviceFixture({
    store,
    verifier: async () => undefined,
    target: () => ({ session, route: route() }),
  });
  await assert.rejects(
    service.execute(worker, command()),
    hasCode("device_capability_unavailable"),
  );
  assert.equal(sends, 0);
  assert.equal(await store.load(command().executionId), null);
  for (const [identity, input] of [
    [{ ...worker, workerId: "worker-wrong" }, command()],
    [{ ...worker, credentialId: "credential-wrong" }, command()],
    [worker, command({ runtimeBindingId: "runtime-binding-wrong" })],
  ] as const) {
    await assert.rejects(
      service.execute(identity, input),
      hasCode("workspace_worker_runtime_unauthorized"),
    );
  }
  await service.close();
  await store.close();
});

test("caller abort releases a hung temporal verifier before any send", async () => {
  const store = storeFixture();
  let sends = 0;
  const service = serviceFixture({
    store,
    verifier: async () => new Promise<void>(() => undefined),
    target: () => ({
      session: fakeSession({
        execute: async () => {
          sends += 1;
          return assert.fail("execute not expected");
        },
      }),
      route: route(),
    }),
  });
  const controller = new AbortController();
  const executing = service.execute(worker, command(), controller.signal);
  await turn();
  controller.abort("worker_disconnected");
  await assert.rejects(executing, hasCode("workspace_dispatch_not_sent"));
  assert.equal(sends, 0);
  await service.close();
  await store.close();
});

test("caller disconnect after durable start does not cancel the shared Device execution", async () => {
  const store = storeFixture();
  const terminal = deferred<DeviceWorkspaceListDispatchResolution>();
  let executionSignal: AbortSignal | null = null;
  let cancels = 0;
  const service = serviceFixture({
    store,
    verifier: async () => undefined,
    target: () => ({
      session: fakeSession({
        async execute(_command, _epoch, _mode, signal) {
          executionSignal = signal;
          return terminal.promise;
        },
        onCancel: () => {
          cancels += 1;
        },
      }),
      route: route(),
    }),
  });
  const controller = new AbortController();
  const executing = service.execute(worker, command(), controller.signal);
  await turn();

  controller.abort("worker_disconnected");
  await turn();
  assert.notEqual(executionSignal, null);
  assert.equal((executionSignal as unknown as AbortSignal).aborted, false);
  assert.equal(cancels, 0);

  const reconciling = service.reconcile(worker, reference(null));
  terminal.resolve(completedResolution());
  assert.deepEqual(await executing, completedResolution());
  assert.deepEqual(await reconciling, completedResolution());
  assert.equal(cancels, 0);
  await service.close();
  await store.close();
});

function serviceFixture(config: {
  store: InMemoryWorkspaceDispatchStore;
  verifier: (command: DeviceWorkspaceListCommand) => Promise<void>;
  target: () => WorkspaceDeviceSessionTarget | null;
  now?: () => Date;
}): DeviceGatewayWorkspaceDispatchService {
  return new DeviceGatewayWorkspaceDispatchService({
    sessions: { workspaceSession: config.target },
    authorizationVerifier: { verify: config.verifier },
    workerAuthorizer: new WorkspaceWorkerRuntimeAuthorizer([
      {
        workerId: "worker-1",
        credentialId: "credential-1",
        fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
        allowedRuntimeBindingIds: ["runtime-binding-1"],
      },
    ]),
    store: config.store,
    now: config.now,
  });
}

function fakeSession(config: {
  supports?: boolean;
  acknowledgedSequence?: number | null;
  onCancel?: () => void;
  execute(
    command: DeviceWorkspaceListCommand,
    epoch: number,
    mode: Parameters<DeviceGatewaySession["executeWorkspaceList"]>[2],
    signal: AbortSignal,
    commit: Parameters<DeviceGatewaySession["executeWorkspaceList"]>[4],
  ): Promise<DeviceWorkspaceListDispatchResolution>;
}): DeviceGatewaySession {
  return {
    supportsWorkspaceList: () => config.supports ?? true,
    workspaceAcknowledgedSequence: () => config.acknowledgedSequence ?? null,
    executeWorkspaceList: config.execute,
    requestWorkspaceCancel: () => config.onCancel?.(),
  } as unknown as DeviceGatewaySession;
}

async function terminalStore(): Promise<InMemoryWorkspaceDispatchStore> {
  const store = storeFixture();
  await store.prepare(command(), "2026-08-09T00:00:00.000Z");
  await store.acceptEvent({
    command: command(),
    route: route(),
    event: acceptedEvent(),
  });
  await store.settleEvent({
    command: command(),
    route: route(),
    event: completedEvent(),
    resolution: completedResolution(),
  });
  return store;
}

function storeFixture(): InMemoryWorkspaceDispatchStore {
  return new InMemoryWorkspaceDispatchStore({
    routeAuthority: { currentRoute: route },
    now: () => new Date("2026-08-09T00:00:01.000Z"),
  });
}

function reference(
  receiptId: string | null,
): DeviceWorkspaceListDispatchReference {
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
    receiptId,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
