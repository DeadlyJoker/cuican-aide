import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  WorkspaceListDispatchError,
  WorkspaceListCommandFactoryError,
  type FrozenWorkspaceListCommand,
  type WorkspaceDeliveryLease,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import {
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  parseRuntimeWorkerWorkspaceDispatchRequest,
  parseRuntimeWorkerWorkspaceFreezeCommandRequest,
  type RuntimeWorkerWorkspacePhase,
} from "@crewon/contracts";
import { startRuntimeWorkspacePrivateServer } from "@crewon/runtime-worker";

import {
  LoopbackRuntimeWorkspaceWorkerClient,
  RuntimeWorkspaceWorkerClientError,
} from "./workspace-runtime-worker-client.ts";

const TOKEN = "control-runtime-workspace-token-0001";
const ACTION_DIGEST = `sha256:${"1".repeat(64)}`;
const COMMAND_DIGEST = `sha256:${"2".repeat(64)}`;

test("accepts only an explicit raw IPv4 loopback origin and bounded token", () => {
  const client = new LoopbackRuntimeWorkspaceWorkerClient({
    origin: "http://127.0.0.1:3211",
    token: TOKEN,
  });
  void client.close();
  for (const origin of [
    "http://localhost:3211",
    "http://[::1]:3211",
    "https://127.0.0.1:3211",
    "http://user@127.0.0.1:3211",
    "http://127.0.0.1:3211/",
    "http://127.0.0.1:3211/path",
    "http://127.0.0.1:3211?route=x",
    "http://127.0.0.1:3211#route",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
  ]) {
    assert.throws(
      () => new LoopbackRuntimeWorkspaceWorkerClient({ origin, token: TOKEN }),
      hasClientError("runtime_workspace_worker_origin_invalid", "notSent"),
    );
  }
  assert.throws(
    () =>
      new LoopbackRuntimeWorkspaceWorkerClient({
        origin: "http://127.0.0.1:3211",
        token: "unsafe\ntoken".repeat(4),
      }),
    hasClientError("runtime_workspace_worker_token_invalid", "notSent"),
  );
});

test("sends the exact typed freeze request and deterministically returns the same command", async () => {
  const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
  const client = clientFixture({
    fetch: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse(freezeResponse());
    },
  });
  const input = factoryInput();
  assert.deepEqual(
    await client.create(input, new AbortController().signal),
    frozenCommand(),
  );
  assert.deepEqual(
    await client.create(input, new AbortController().signal),
    frozenCommand(),
  );
  assert.deepEqual(
    requests.map(({ url, init }) => ({
      url,
      body: parseRuntimeWorkerWorkspaceFreezeCommandRequest(
        JSON.parse(String(init.body)),
      ),
      authorization: new Headers(init.headers).get("authorization"),
      redirect: init.redirect,
    })),
    [0, 1].map(() => ({
      url: `http://127.0.0.1:3211${RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH}`,
      body: freezeRequest(),
      authorization: `Bearer ${TOKEN}`,
      redirect: "error",
    })),
  );
});

test("sends the entire frozen operation and exact lease for every phase", async () => {
  const requests: unknown[] = [];
  const client = clientFixture({
    fetch: async (_input, init = {}) => {
      const request = parseRuntimeWorkerWorkspaceDispatchRequest(
        JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")),
      );
      requests.push(request);
      return jsonResponse(dispatchResponse(request.phase));
    },
  });
  for (const phase of ["execute", "reconcile", "cancel"] as const) {
    assert.deepEqual(
      await client[phase](
        operation(phase === "execute" ? "prepared" : "unknownOutcome"),
        lease(phase),
        new AbortController().signal,
      ),
      completedResolution(),
    );
  }
  assert.deepEqual(
    requests,
    ["execute", "reconcile", "cancel"].map((phase) => ({
      schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0",
      apiVersion: 1,
      phase,
      operation: operation(phase === "execute" ? "prepared" : "unknownOutcome"),
      deliveryLease: lease(phase as RuntimeWorkerWorkspacePhase),
    })),
  );
});

test("honors authoritative remote certainty and upgrades malformed post-send data", async () => {
  for (const certainty of ["notSent", "possiblySent"] as const) {
    const client = clientFixture({
      fetch: async () =>
        jsonResponse(
          {
            schemaVersion: "crewon.runtime-worker-workspace-dispatch-error.v0",
            apiVersion: 1,
            phase: "execute",
            code: "runtime_workspace_binding_unavailable",
            retryable: true,
            certainty,
          },
          503,
        ),
    });
    await assert.rejects(
      client.execute(
        operation("prepared"),
        lease("execute"),
        new AbortController().signal,
      ),
      hasDispatchCertainty(certainty),
    );
  }

  for (const response of [
    jsonResponse({ ...dispatchResponse("execute"), unexpected: true }),
    new Response("x".repeat(70_000), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const client = clientFixture({ fetch: async () => response });
    await assert.rejects(
      client.execute(
        operation("prepared"),
        lease("execute"),
        new AbortController().signal,
      ),
      hasDispatchCertainty("possiblySent"),
    );
  }
});

test("keeps freeze failures notSent and rejects wrong-scope responses", async () => {
  for (const [response, kind] of [
    [
      jsonResponse(
        {
          schemaVersion: "crewon.runtime-worker-workspace-freeze-error.v0",
          apiVersion: 1,
          code: "runtime_workspace_binding_scope_mismatch",
          retryable: false,
          certainty: "notSent",
        },
        503,
      ),
      "unavailable",
    ],
    [
      jsonResponse({
        ...freezeResponse(),
        command: {
          ...frozenCommand(),
          limits: { ...frozenCommand().limits, maxEntries: 6 },
        },
      }),
      "invalidAuthority",
    ],
    [
      new Response("x".repeat(4_000), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "invalidAuthority",
    ],
  ] as const) {
    const client = clientFixture({ fetch: async () => response });
    await assert.rejects(
      client.create(factoryInput(), new AbortController().signal),
      (error) =>
        error instanceof WorkspaceListCommandFactoryError &&
        error.kind === kind,
    );
  }
});

test("distinguishes pre-send abort from post-boundary abort and deadline", async () => {
  let calls = 0;
  const before = clientFixture({
    fetch: async () => {
      calls += 1;
      return assert.fail("fetch not expected");
    },
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("caller canceled"));
  await assert.rejects(
    before.execute(
      operation("prepared"),
      lease("execute"),
      alreadyAborted.signal,
    ),
    hasDispatchCertainty("notSent"),
  );
  await assert.rejects(
    before.create(factoryInput(), alreadyAborted.signal),
    hasFactoryKind("unavailable"),
  );
  assert.equal(calls, 0);

  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const after = clientFixture({
    fetch: async (_input, init) => {
      entered();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    },
  });
  const caller = new AbortController();
  const pending = after.execute(
    operation("prepared"),
    lease("execute"),
    caller.signal,
  );
  await started;
  caller.abort(new Error("caller canceled"));
  await assert.rejects(pending, hasDispatchCertainty("possiblySent"));

  let expire: () => void = () => undefined;
  const deadline = clientFixture({
    fetch: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
    scheduler: {
      schedule(_delayMs, callback) {
        expire = callback;
        return () => undefined;
      },
    },
  });
  const timed = deadline.execute(
    operation("prepared"),
    lease("execute"),
    new AbortController().signal,
  );
  expire();
  await assert.rejects(timed, hasDispatchCertainty("possiblySent"));

  const timedFreeze = deadline.create(
    factoryInput(),
    new AbortController().signal,
  );
  expire();
  await assert.rejects(timedFreeze, hasFactoryKind("unavailable"));
});

test("close aborts an in-flight dispatch and future calls fail before send", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const client = clientFixture({
    fetch: async (_input, init) => {
      calls += 1;
      entered();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    },
  });
  const pending = client.execute(
    operation("prepared"),
    lease("execute"),
    new AbortController().signal,
  );
  await started;
  await client.close();
  await assert.rejects(pending, hasDispatchCertainty("possiblySent"));
  await assert.rejects(
    client.execute(
      operation("prepared"),
      lease("execute"),
      new AbortController().signal,
    ),
    hasDispatchCertainty("notSent"),
  );
  assert.equal(calls, 1);
});

test("runs freeze and dispatch through the real Runtime Worker loopback server", async (context) => {
  const server = await startRuntimeWorkspacePrivateServer({
    port: 0,
    authentication: { kind: "loopbackToken", token: TOKEN },
    freeze: { freeze: async () => freezeResponse() },
    dispatch: {
      dispatch: async (request) => dispatchResponse(request.phase),
    },
  });
  context.after(() => server.close());
  const client = new LoopbackRuntimeWorkspaceWorkerClient({
    origin: server.origin,
    token: TOKEN,
  });
  context.after(() => client.close());

  assert.deepEqual(
    await client.create(factoryInput(), new AbortController().signal),
    frozenCommand(),
  );
  assert.deepEqual(
    await client.execute(
      operation("prepared"),
      lease("execute"),
      new AbortController().signal,
    ),
    completedResolution(),
  );
});

function clientFixture(
  dependencies: ConstructorParameters<
    typeof LoopbackRuntimeWorkspaceWorkerClient
  >[1] = {},
): LoopbackRuntimeWorkspaceWorkerClient {
  return new LoopbackRuntimeWorkspaceWorkerClient(
    { origin: "http://127.0.0.1:3211", token: TOKEN },
    dependencies,
  );
}

function factoryInput() {
  return {
    actor: {
      principalId: "principal-1",
      actorId: "actor-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
    },
    threadId: "thread-1",
    expectedThreadRevision: 1,
    idempotencyKey: "workspace-idempotency-1",
    maxEntries: 5,
  };
}

function freezeRequest() {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0" as const,
    apiVersion: 1 as const,
    tenantId: "tenant-1",
    spaceId: "space-1",
    actor: { principalId: "principal-1", actorId: "actor-1" },
    threadFence: { threadId: "thread-1", expectedRevision: 1 },
    idempotencyKey: "workspace-idempotency-1",
    maxEntries: 5,
  };
}

function frozenCommand(): FrozenWorkspaceListCommand {
  return {
    executionId: "workspace-execution-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    actionDigest: ACTION_DIGEST,
    commandDigest: COMMAND_DIGEST,
    limits: {
      depth: 0,
      maxEntries: 5,
      maxNameBytes: 255,
      maxOutputBytes: 65_536,
      maxScannedEntries: 10_000,
      maxScannedNameBytes: 1_048_576,
      timeoutMs: 30_000,
    },
  };
}

function freezeResponse() {
  return {
    schemaVersion:
      "crewon.runtime-worker-workspace-freeze-response.v0" as const,
    apiVersion: 1 as const,
    command: frozenCommand(),
  };
}

function operation(
  status: "prepared" | "unknownOutcome",
): WorkspaceOperationRecord {
  const command = frozenCommand();
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: "workspace-idempotency-1",
    executionId: command.executionId,
    revision: status === "prepared" ? 1 : 2,
    status,
    command,
    resolution:
      status === "prepared"
        ? null
        : {
            status: "unknownOutcome",
            executionId: command.executionId,
            actionDigest: command.actionDigest,
            commandDigest: command.commandDigest,
            providerReceiptId: "gateway-receipt-1",
          },
  };
}

function lease(phase: RuntimeWorkerWorkspacePhase): WorkspaceDeliveryLease {
  return {
    schemaVersion: "crewon.workspace-delivery-lease.v0",
    executionId: "workspace-execution-1",
    attemptNumber: phase === "execute" ? 1 : 2,
    phase,
    ownerId: "control-api-workspace-1",
    leaseId: `delivery-${phase}`,
    epoch: 1,
    leasedAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-10T00:01:00.000Z",
  };
}

function completedResolution() {
  return {
    status: "completed" as const,
    executionId: "workspace-execution-1",
    actionDigest: ACTION_DIGEST,
    commandDigest: COMMAND_DIGEST,
    providerReceiptId: "gateway-receipt-1",
    entries: [{ name: "README.md", kind: "file" as const }],
    truncated: false,
  };
}

function dispatchResponse(phase: RuntimeWorkerWorkspacePhase) {
  return {
    schemaVersion:
      "crewon.runtime-worker-workspace-dispatch-response.v0" as const,
    apiVersion: 1 as const,
    phase,
    resolution: completedResolution(),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function hasDispatchCertainty(certainty: "notSent" | "possiblySent") {
  return (error: unknown) =>
    error instanceof WorkspaceListDispatchError &&
    error.certainty === certainty;
}

function hasClientError(code: string, certainty: "notSent" | "possiblySent") {
  return (error: unknown) =>
    error instanceof RuntimeWorkspaceWorkerClientError &&
    error.code === code &&
    error.certainty === certainty;
}

function hasFactoryKind(kind: "unavailable" | "invalidAuthority") {
  return (error: unknown) =>
    error instanceof WorkspaceListCommandFactoryError && error.kind === kind;
}
