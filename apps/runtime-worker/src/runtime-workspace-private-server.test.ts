import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  parseRuntimeWorkerWorkspaceDispatchError,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  parseRuntimeWorkerWorkspaceFreezeCommandError,
  parseRuntimeWorkerWorkspaceFreezeCommandResponse,
  type DeviceWorkspaceListCommand,
  type RuntimeWorkerFrozenWorkspaceCommand,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerWorkspaceFreezeCommandRequest,
} from "@crewon/contracts";

import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { RuntimeWorkspaceDispatchService } from "./runtime-workspace-dispatch-service.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";
import { RuntimeWorkspaceFreezeService } from "./runtime-workspace-freeze-service.ts";
import { startRuntimeWorkspacePrivateServer } from "./runtime-workspace-private-server.ts";

const TOKEN = "runtime-workspace-loopback-token-0001";
const ACTION_DIGEST = `sha256:${"1".repeat(64)}`;
const COMMAND_DIGEST = `sha256:${"2".repeat(64)}`;

test("serves strict Workspace responses only to the loopback bearer", async (context) => {
  let freezeCalls = 0;
  let dispatchCalls = 0;
  const server = await serverFixture(context, {
    freeze: async () => {
      freezeCalls += 1;
      return freezeResponse();
    },
    dispatch: async (input) => {
      dispatchCalls += 1;
      return completedDispatchResponse(input.phase);
    },
  });

  const unauthorized = await post(
    server.origin,
    RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
    freezeRequest(),
    "wrong-runtime-workspace-token-0000",
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(await unauthorized.text(), "");
  assert.deepEqual(
    { freezeCalls, dispatchCalls },
    { freezeCalls: 0, dispatchCalls: 0 },
  );

  const freezeHttp = await post(
    server.origin,
    RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
    freezeRequest(),
  );
  assert.equal(freezeHttp.status, 200);
  assert.deepEqual(
    parseRuntimeWorkerWorkspaceFreezeCommandResponse(
      await freezeHttp.json(),
      freezeRequest(),
    ),
    freezeResponse(),
  );

  const dispatchInput = dispatchRequest();
  const dispatchHttp = await post(
    server.origin,
    RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
    dispatchInput,
  );
  assert.equal(dispatchHttp.status, 200);
  assert.deepEqual(
    parseRuntimeWorkerWorkspaceDispatchResponse(
      await dispatchHttp.json(),
      dispatchInput,
    ),
    completedDispatchResponse("execute"),
  );
  assert.deepEqual(
    { freezeCalls, dispatchCalls },
    { freezeCalls: 1, dispatchCalls: 1 },
  );
});

test("projects unsafe internal dispatch errors through the strict safe wire", async (context) => {
  const server = await serverFixture(context, {
    dispatch: async () => {
      throw new RuntimeWorkspaceError("Unsafe secret\n".repeat(20), {
        retryable: true,
        certainty: "possiblySent",
      });
    },
  });
  const response = await post(
    server.origin,
    RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
    dispatchRequest(),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(
    parseRuntimeWorkerWorkspaceDispatchError(await response.json(), "execute"),
    {
      schemaVersion: "crewon.runtime-worker-workspace-dispatch-error.v0",
      apiVersion: 1,
      phase: "execute",
      code: "runtime_workspace_unavailable",
      retryable: true,
      certainty: "possiblySent",
    },
  );
});

test("preserves possiblySent when a malformed Gateway success fails post-send validation", async (context) => {
  const freeze = new RuntimeWorkspaceFreezeService({
    bindings: {
      resolve: async (query) => ({
        ...query,
        workspaceBindingId: "workspace-1",
        incarnationId: "incarnation-1",
        deviceBindingId: "device-binding-1",
        deviceId: "device-1",
        runtimeBindingId: "runtime-binding-1",
        policySnapshotId: "policy-1",
      }),
    },
    ids: { nextExecutionId: () => "workspace-execution-1" },
    digester: new NodeSha256ContentDigester(),
  });
  const command = (
    await freeze.freeze(freezeRequest(), new AbortController().signal)
  ).command;
  const dispatch = new RuntimeWorkspaceDispatchService({
    authority: { admit: async (expected) => expected },
    digester: new NodeSha256ContentDigester(),
    signer: {
      async sign({ command: unsigned }) {
        return {
          ...unsigned,
          authorization: {
            schemaVersion: "crewon.device-authorization.v0",
            scheme: "ed25519",
            keyId: "workspace-key-1",
            issuedAt: "2026-08-10T00:00:30.000Z",
            expiresAt: unsigned.expiresAt,
            approvalProof: null,
            signature: "A".repeat(86),
          },
        };
      },
    },
    gateway: {
      async execute(signed) {
        const completed = gatewayCompleted(signed);
        return {
          ...completed,
          terminal: {
            ...completed.terminal,
            actionDigest: `sha256:${"f".repeat(64)}`,
          },
        };
      },
      async reconcile() {
        return assert.fail("reconcile not expected");
      },
      async cancel() {
        return assert.fail("cancel not expected");
      },
      async close() {},
    },
    now: () => new Date("2026-08-10T00:00:30.000Z"),
  });
  context.after(() => dispatch.close());
  const server = await startRuntimeWorkspacePrivateServer({
    port: 0,
    authentication: { kind: "loopbackToken", token: TOKEN },
    freeze,
    dispatch,
  });
  context.after(() => server.close());

  const response = await post(
    server.origin,
    RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
    dispatchRequest(command),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(
    parseRuntimeWorkerWorkspaceDispatchError(await response.json(), "execute"),
    {
      schemaVersion: "crewon.runtime-worker-workspace-dispatch-error.v0",
      apiVersion: 1,
      phase: "execute",
      code: "runtime_workspace_gateway_response_invalid",
      retryable: false,
      certainty: "possiblySent",
    },
  );
});

test("aborts a private operation when the HTTP caller disconnects", async (context) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let observedAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    observedAbort = resolve;
  });
  const server = await serverFixture(context, {
    freeze: async (_input, signal) => {
      entered();
      if (signal.aborted) observedAbort();
      else signal.addEventListener("abort", observedAbort, { once: true });
      return new Promise(() => undefined);
    },
  });
  const controller = new AbortController();
  const pending = post(
    server.origin,
    RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
    freezeRequest(),
    TOKEN,
    controller.signal,
  );
  await started;
  controller.abort("caller disconnected");
  await assert.rejects(pending);
  await aborted;
});

test("rejects oversized bodies and keeps Team authentication unavailable without TLS", async (context) => {
  const server = await serverFixture(context);
  const oversized = await fetch(
    `${server.origin}${RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH}`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "x".repeat(2_049),
    },
  );
  assert.equal(oversized.status, 400);
  assert.equal(
    parseRuntimeWorkerWorkspaceFreezeCommandError(await oversized.json()).code,
    "runtime_workspace_request_too_large",
  );

  await assert.rejects(
    startRuntimeWorkspacePrivateServer({
      port: 0,
      authentication: { kind: "teamService" } as never,
      freeze: { freeze: async () => freezeResponse() },
      dispatch: {
        dispatch: async (input) => completedDispatchResponse(input.phase),
      },
    }),
    (error) =>
      error instanceof RuntimeWorkspaceError &&
      error.code === "runtime_workspace_authentication_unavailable",
  );
});

async function serverFixture(
  context: TestContext,
  overrides: Readonly<{
    freeze?: (
      input: RuntimeWorkerWorkspaceFreezeCommandRequest,
      signal: AbortSignal,
    ) => Promise<ReturnType<typeof freezeResponse>>;
    dispatch?: (
      input: RuntimeWorkerWorkspaceDispatchRequest,
      signal: AbortSignal,
    ) => Promise<ReturnType<typeof completedDispatchResponse>>;
  }> = {},
) {
  const server = await startRuntimeWorkspacePrivateServer({
    port: 0,
    authentication: { kind: "loopbackToken", token: TOKEN },
    freeze: {
      freeze: overrides.freeze ?? (async () => freezeResponse()),
    },
    dispatch: {
      dispatch:
        overrides.dispatch ??
        (async (input) => completedDispatchResponse(input.phase)),
    },
  });
  context.after(() => server.close());
  return server;
}

function post(
  origin: string,
  path: string,
  body: unknown,
  token = TOKEN,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
}

function freezeRequest(): RuntimeWorkerWorkspaceFreezeCommandRequest {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0",
    apiVersion: 1,
    tenantId: "tenant-1",
    spaceId: "space-1",
    actor: { principalId: "principal-1", actorId: "actor-1" },
    threadFence: { threadId: "thread-1", expectedRevision: 1 },
    idempotencyKey: "workspace-idempotency-1",
    maxEntries: 5,
  };
}

function frozenCommand(): RuntimeWorkerFrozenWorkspaceCommand {
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

function dispatchRequest(
  command: RuntimeWorkerFrozenWorkspaceCommand = frozenCommand(),
): RuntimeWorkerWorkspaceDispatchRequest {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0",
    apiVersion: 1,
    phase: "execute",
    operation: {
      schemaVersion: "crewon.workspace-operation.v0",
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      expectedThreadRevision: 1,
      principalId: "principal-1",
      actorId: "actor-1",
      idempotencyKey: "workspace-idempotency-1",
      executionId: command.executionId,
      revision: 1,
      status: "prepared",
      command,
      resolution: null,
    },
    deliveryLease: {
      schemaVersion: "crewon.workspace-delivery-lease.v0",
      executionId: command.executionId,
      attemptNumber: 1,
      phase: "execute",
      ownerId: "runtime-worker-1",
      leaseId: "delivery-execute",
      epoch: 1,
      leasedAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-10T00:01:00.000Z",
    },
  };
}

function gatewayCompleted(command: DeviceWorkspaceListCommand) {
  return {
    status: "completed" as const,
    executionId: command.executionId,
    receiptId: "gateway-receipt-1",
    terminal: {
      schemaVersion: "crewon.device-workspace-list-event.v0" as const,
      protocolVersion: 1 as const,
      commandKind: "workspaceList" as const,
      deviceId: command.deviceId,
      executionId: command.executionId,
      receiptId: "gateway-receipt-1",
      connectionEpoch: 1,
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.incarnationId,
      deviceBindingId: command.deviceBindingId,
      runtimeBindingId: command.runtimeBindingId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      sequence: 2,
      observedAt: "2026-08-10T00:00:31.000Z",
      type: "workspace_list.completed" as const,
      data: {
        result: {
          schemaVersion: "crewon.workspace-list-result.v0" as const,
          executionId: command.executionId,
          actionDigest: command.actionDigest,
          commandDigest: command.commandDigest,
          entries: [{ name: "README.md", kind: "file" as const }],
          truncated: false,
        },
      },
    },
  };
}

function completedDispatchResponse(
  phase: RuntimeWorkerWorkspaceDispatchRequest["phase"],
) {
  const command = frozenCommand();
  return {
    schemaVersion:
      "crewon.runtime-worker-workspace-dispatch-response.v0" as const,
    apiVersion: 1 as const,
    phase,
    resolution: {
      status: "completed" as const,
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      providerReceiptId: "gateway-receipt-1",
      entries: [{ name: "README.md", kind: "file" as const }],
      truncated: false,
    },
  };
}
