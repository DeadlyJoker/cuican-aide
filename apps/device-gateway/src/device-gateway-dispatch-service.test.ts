import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceExecutionCommand,
  DeviceExecutionEvent,
  DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import { DeviceGatewayDispatchService } from "./device-gateway-dispatch-service.ts";
import {
  InMemoryDeviceDispatchStore,
  type DeviceDispatchStorePort,
} from "./device-dispatch-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

test("single-flights one execution across renewed Worker request leases", async () => {
  const execution = deferred<DeviceGatewayDispatchResolution>();
  const started = deferred<void>();
  let executions = 0;
  let verifications = 0;
  const service = new DeviceGatewayDispatchService({
    sessions: {
      session: () => ({
        acknowledgedSequence: () => null,
        execute: async () => {
          executions += 1;
          started.resolve();
          return execution.promise;
        },
        requestCancel: () => assert.fail("cancel not expected"),
      }),
    },
    authorizationVerifier: {
      async verify() {
        verifications += 1;
      },
    },
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });

  const first = service.execute(command());
  await started.promise;
  const second = service.execute(
    command({
      leaseId: "lease-2",
      leaseEpoch: 2,
      authorization: {
        ...command().authorization,
        issuedAt: "2026-08-09T00:00:01.000Z",
        signature: "B".repeat(86),
      },
    }),
  );
  execution.resolve(completed());

  assert.deepEqual(await Promise.all([first, second]), [
    completed(),
    completed(),
  ]);
  assert.equal(executions, 1);
  assert.equal(verifications, 2);
  assert.deepEqual(await service.reconcile(command()), completed());
  assert.equal(verifications, 3);
  await service.close();
});

test("rejects execution identity drift and never dispatches an unavailable Device", async () => {
  let executions = 0;
  const service = new DeviceGatewayDispatchService({
    sessions: {
      session: () => ({
        acknowledgedSequence: () => null,
        execute: async () => {
          executions += 1;
          return completed();
        },
        requestCancel: () => undefined,
      }),
    },
    authorizationVerifier: { verify: async () => undefined },
  });
  await service.execute(command());
  await assert.rejects(
    service.execute(
      command({
        actionDigest: `sha256:${"b".repeat(64)}`,
      }),
    ),
    hasCode("device_dispatch_identity_conflict"),
  );
  assert.equal(executions, 1);

  const unavailable = new DeviceGatewayDispatchService({
    sessions: { session: () => null },
    authorizationVerifier: { verify: async () => undefined },
  });
  await assert.rejects(
    unavailable.execute(command()),
    hasCode("device_unavailable"),
  );
});

test("forwards cancel to the active session and reconciles unknown after restart", async () => {
  const execution = deferred<DeviceGatewayDispatchResolution>();
  const started = deferred<void>();
  const cancelReasons: string[] = [];
  const service = new DeviceGatewayDispatchService({
    sessions: {
      session: () => ({
        acknowledgedSequence: () => null,
        execute: async () => {
          started.resolve();
          return execution.promise;
        },
        requestCancel: (_executionId, reason) => {
          cancelReasons.push(reason);
          execution.resolve(canceled());
        },
      }),
    },
    authorizationVerifier: { verify: async () => undefined },
  });
  const active = service.execute(command());
  await started.promise;

  assert.deepEqual(await service.cancel(command()), canceled());
  assert.deepEqual(await active, canceled());
  assert.deepEqual(cancelReasons, ["worker_cancel_requested"]);

  const restarted = new DeviceGatewayDispatchService({
    sessions: { session: () => null },
    authorizationVerifier: { verify: async () => undefined },
  });
  assert.deepEqual(await restarted.reconcile(command()), {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
    terminal: null,
  });
});

test("never redispatches a prepared action after Gateway process loss", async () => {
  const store = new InMemoryDeviceDispatchStore();
  await store.prepare(command(), "2026-08-09T00:00:00.000Z");
  let executions = 0;
  const restarted = new DeviceGatewayDispatchService({
    sessions: {
      session: () => ({
        acknowledgedSequence: () => null,
        execute: async () => {
          executions += 1;
          return completed();
        },
        requestCancel: () => undefined,
      }),
    },
    authorizationVerifier: { verify: async () => undefined },
    store,
  });

  assert.deepEqual(await restarted.execute(command()), {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
    terminal: null,
  });
  assert.equal(executions, 0);
});

test("replays a durable terminal receipt after dispatch service restart", async () => {
  const store = new InMemoryDeviceDispatchStore();
  const first = new DeviceGatewayDispatchService({
    sessions: {
      session: () => ({
        acknowledgedSequence: () => null,
        execute: async () => completed(),
        requestCancel: () => undefined,
      }),
    },
    authorizationVerifier: { verify: async () => undefined },
    store,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.deepEqual(await first.execute(command()), completed());

  const restarted = new DeviceGatewayDispatchService({
    sessions: { session: () => null },
    authorizationVerifier: { verify: async () => undefined },
    store,
  });
  assert.deepEqual(await restarted.reconcile(command()), completed());
});

test("does not retain a poisoned in-memory flight after terminal persistence fails", async () => {
  const authority = new InMemoryDeviceDispatchStore();
  let failCompletion = true;
  const store: DeviceDispatchStorePort = {
    ready: () => authority.ready(),
    prepare: (input, preparedAt) => authority.prepare(input, preparedAt),
    load: (executionId) => authority.load(executionId),
    close: () => authority.close(),
    async complete(input, resolution, completedAt) {
      if (failCompletion) {
        failCompletion = false;
        throw new DeviceGatewayError("device_dispatch_store_busy");
      }
      return authority.complete(input, resolution, completedAt);
    },
  };
  let executions = 0;
  const service = new DeviceGatewayDispatchService({
    sessions: {
      session: () => ({
        acknowledgedSequence: () => 1,
        execute: async () => {
          executions += 1;
          return completed();
        },
        requestCancel: () => undefined,
      }),
    },
    authorizationVerifier: { verify: async () => undefined },
    store,
    now: () => new Date("2026-08-09T00:00:02.000Z"),
  });

  await assert.rejects(
    service.execute(command()),
    hasCode("device_dispatch_store_busy"),
  );
  assert.equal((await authority.load("execution-1"))?.resolution, null);
  assert.deepEqual(await service.reconcile(command()), completed());
  assert.equal(executions, 2);
});

test("keeps transport unknown non-terminal and resumes only from an explicit Device Hello acknowledgement", async () => {
  const store = new InMemoryDeviceDispatchStore();
  let acknowledged: number | null = null;
  let executions = 0;
  const commands: DeviceExecutionCommand[] = [];
  const firstSession = {
    acknowledgedSequence: () => null,
    execute: async () => {
      executions += 1;
      return unknown();
    },
    requestCancel: () => undefined,
  };
  const resumedSession = {
    acknowledgedSequence: (executionId: string) =>
      executionId === "execution-1" ? acknowledged : null,
    execute: async (input: DeviceExecutionCommand) => {
      executions += 1;
      commands.push(structuredClone(input));
      return completed();
    },
    requestCancel: () => undefined,
  };
  let currentSession: {
    acknowledgedSequence(executionId: string): number | null;
    execute(
      input: DeviceExecutionCommand,
      signal: AbortSignal,
    ): Promise<DeviceGatewayDispatchResolution>;
    requestCancel(executionId: string, reasonCode: string): void;
  } = firstSession;
  const service = new DeviceGatewayDispatchService({
    sessions: { session: () => currentSession },
    authorizationVerifier: { verify: async () => undefined },
    store,
    now: () => new Date("2026-08-09T00:00:02.000Z"),
  });

  assert.deepEqual(await service.execute(command()), unknown());
  assert.equal((await store.load("execution-1"))?.resolution, null);
  currentSession = resumedSession;
  assert.deepEqual(await service.reconcile(command()), unknownResolution());
  assert.equal(executions, 1);

  acknowledged = 1;
  assert.deepEqual(await service.reconcile(command()), completed());
  assert.equal(executions, 2);
  assert.deepEqual(commands, [command()]);
  assert.deepEqual((await store.load("execution-1"))?.resolution, completed());
});

test("does not resume an advertised execution after its original authorization expires", async () => {
  const store = new InMemoryDeviceDispatchStore();
  await store.prepare(command(), "2026-08-09T00:00:00.000Z");
  let executions = 0;
  const service = new DeviceGatewayDispatchService({
    sessions: {
      session: () => ({
        acknowledgedSequence: () => 1,
        execute: async () => {
          executions += 1;
          return completed();
        },
        requestCancel: () => undefined,
      }),
    },
    authorizationVerifier: { verify: async () => undefined },
    store,
    now: () => new Date("2026-08-09T00:06:00.000Z"),
  });

  assert.deepEqual(await service.reconcile(command()), unknownResolution());
  assert.equal(executions, 0);
});

function command(
  overrides: Partial<DeviceExecutionCommand> = {},
): DeviceExecutionCommand {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2099-08-09T00:00:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: `sha256:${"a".repeat(64)}`,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: `device:${"a".repeat(64)}`,
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:05:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
    ...overrides,
  };
}

function completed(): DeviceGatewayDispatchResolution {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: event("execution.completed"),
    output: [],
  };
}

function canceled(): DeviceGatewayDispatchResolution {
  return {
    status: "canceled",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: event("execution.canceled"),
  };
}

function unknown(): DeviceGatewayDispatchResolution {
  return {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: null,
  };
}

function unknownResolution(): DeviceGatewayDispatchResolution {
  return {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
    terminal: null,
  };
}

function event(
  type: "execution.completed",
): Extract<DeviceExecutionEvent, { type: "execution.completed" }>;
function event(
  type: "execution.canceled",
): Extract<DeviceExecutionEvent, { type: "execution.canceled" }>;
function event(
  type: "execution.completed" | "execution.canceled",
): DeviceExecutionEvent {
  const envelope = {
    schemaVersion: "crewon.device-event.v0" as const,
    protocolVersion: 1 as const,
    deviceId: "device-1",
    executionId: "execution-1",
    receiptId: "receipt-1",
    sequence: 2,
    observedAt: "2026-08-09T00:00:01.000Z",
  };
  return type === "execution.completed"
    ? {
        ...envelope,
        type,
        data: {
          output: "done",
          artifactRef: null,
          outputDigest: `sha256:${"c".repeat(64)}`,
          stdoutDigest: `sha256:${"d".repeat(64)}`,
          stderrDigest: `sha256:${"e".repeat(64)}`,
          exitCode: 0,
          exitSignal: null,
        },
      }
    : {
        ...envelope,
        type,
        data: { reasonCode: "run_canceled" },
      };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
