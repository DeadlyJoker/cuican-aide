import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceWorkspaceListCommand,
  DeviceWorkspaceListDispatchReference,
  DeviceWorkspaceListDispatchResolution,
  RuntimeWorkerFrozenWorkspaceCommand,
  RuntimeWorkerWorkspaceDispatchRequest,
} from "@crewon/contracts";

import type {
  DeviceWorkspaceListCommandSignerPort,
  DeviceWorkspaceListDispatchClientPort,
} from "@crewon/device-dispatch";

import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import type {
  RuntimeWorkspaceDispatchAuthority,
  RuntimeWorkspaceDispatchAuthorityPort,
  RuntimeWorkspaceBindingQuery,
  RuntimeWorkspaceBindingResolverPort,
  RuntimeWorkspaceBindingSnapshot,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceDispatchService } from "./runtime-workspace-dispatch-service.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";
import { RuntimeWorkspaceFreezeService } from "./runtime-workspace-freeze-service.ts";

const now = () => new Date("2026-08-10T00:00:30.000Z");

test("freezes server-owned bindings with canonical Application digests and exact caps", async () => {
  const freeze = freezeService();
  const first = await freeze.freeze(
    freezeRequest(),
    new AbortController().signal,
  );
  const second = await freeze.freeze(
    freezeRequest(),
    new AbortController().signal,
  );
  assert.deepEqual(first.command, {
    executionId: "workspace-execution-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    actionDigest: first.command.actionDigest,
    commandDigest: first.command.commandDigest,
    limits: {
      depth: 0,
      maxEntries: 5,
      maxNameBytes: 255,
      maxOutputBytes: 65_536,
      maxScannedEntries: 10_000,
      maxScannedNameBytes: 1_048_576,
      timeoutMs: 30_000,
    },
  });
  assert.match(first.command.actionDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(first.command.commandDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(second.command.executionId, "workspace-execution-2");
});

test("rejects a resolver result from the wrong tenant before freezing", async () => {
  const freeze = new RuntimeWorkspaceFreezeService({
    bindings: resolver([{ ...binding(), tenantId: "tenant-wrong" }]),
    ids: { nextExecutionId: () => "workspace-execution-never" },
    digester: new NodeSha256ContentDigester(),
  });
  await assert.rejects(
    freeze.freeze(freezeRequest(), new AbortController().signal),
    hasRuntimeError("runtime_workspace_binding_scope_mismatch", "notSent"),
  );
});

test("signs one exact delivery command and projects completed Gateway authority", async () => {
  const frozen = await frozenCommand();
  const signed: DeviceWorkspaceListCommand[] = [];
  const gateway = gatewayFixture({
    async execute(command) {
      signed.push(command);
      return completedGatewayResolution(command);
    },
  });
  const service = dispatchService({ gateway });
  const request = dispatchRequest("execute", frozen);
  const response = await service.dispatch(
    request,
    new AbortController().signal,
  );
  assert.deepEqual(response.resolution, {
    status: "completed",
    executionId: frozen.executionId,
    actionDigest: frozen.actionDigest,
    commandDigest: frozen.commandDigest,
    providerReceiptId: "gateway-receipt-1",
    entries: [{ name: "README.md", kind: "file" }],
    truncated: false,
  });
  assert.deepEqual(signed, [signedCommand(request, frozen)]);
});

test("reconcile and cancel use the frozen reference without resigning and accept the terminal winner", async () => {
  const frozen = await frozenCommand();
  let signs = 0;
  const references: Array<{
    phase: "reconcile" | "cancel";
    value: DeviceWorkspaceListDispatchReference;
  }> = [];
  const gateway = gatewayFixture({
    async reconcile(reference) {
      references.push({ phase: "reconcile", value: reference });
      return completedGatewayResolution(
        signedCommand(dispatchRequest("execute", frozen), frozen),
      );
    },
    async cancel(reference) {
      references.push({ phase: "cancel", value: reference });
      return completedGatewayResolution(
        signedCommand(dispatchRequest("execute", frozen), frozen),
      );
    },
  });
  const service = dispatchService({
    gateway,
    signer: {
      async sign() {
        signs += 1;
        return assert.fail("sign not expected");
      },
    },
  });
  const operation = unknownOperation(frozen, "gateway-receipt-1");
  for (const phase of ["reconcile", "cancel"] as const) {
    const request = dispatchRequest(phase, frozen, operation);
    const response = await service.dispatch(
      request,
      new AbortController().signal,
    );
    assert.equal(response.resolution.status, "completed");
  }
  assert.equal(signs, 0);
  assert.deepEqual(references, [
    { phase: "reconcile", value: reference(frozen, "gateway-receipt-1") },
    { phase: "cancel", value: reference(frozen, "gateway-receipt-1") },
  ]);
});

test("durable reconcile ignores current Thread routing and terminal survives later binding deletion", async () => {
  const frozen = await frozenCommand();
  const currentThreadRevision = 99;
  let deleted = false;
  let admissions = 0;
  const service = dispatchService({
    authority: {
      async admit(expected) {
        admissions += 1;
        assert.equal(currentThreadRevision, 99);
        assert.equal("threadId" in expected, false);
        assert.equal("expectedThreadRevision" in expected, false);
        return deleted ? null : expected;
      },
    },
    gateway: gatewayFixture({
      async reconcile() {
        deleted = true;
        return completedGatewayResolution(
          signedCommand(dispatchRequest("execute", frozen), frozen),
        );
      },
    }),
  });
  const request = dispatchRequest(
    "reconcile",
    frozen,
    unknownOperation(frozen, "gateway-receipt-1"),
  );
  assert.equal(
    (await service.dispatch(request, new AbortController().signal)).resolution
      .status,
    "completed",
  );
  assert.equal(admissions, 2);
});

test("rejects wrong frozen authority before Gateway and lease expiry after admission", async () => {
  const frozen = await frozenCommand();
  let calls = 0;
  const wrongScope = dispatchService({
    authority: authority([
      { ...dispatchAuthority(frozen), tenantId: "tenant-wrong" },
    ]),
    gateway: gatewayFixture({
      async execute() {
        calls += 1;
        return assert.fail("Gateway not expected");
      },
    }),
  });
  await assert.rejects(
    wrongScope.dispatch(
      dispatchRequest("execute", frozen),
      new AbortController().signal,
    ),
    hasRuntimeError("runtime_workspace_binding_invalid", "notSent"),
  );
  assert.equal(calls, 0);

  let clock = new Date("2026-08-10T00:00:30.000Z");
  const expiring = new RuntimeWorkspaceDispatchService({
    authority: authority(
      [dispatchAuthority(frozen), dispatchAuthority(frozen)],
      () => {
        clock = new Date("2026-08-10T00:01:00.000Z");
      },
    ),
    digester: new NodeSha256ContentDigester(),
    signer: signer(),
    gateway: gatewayFixture({
      async execute() {
        calls += 1;
        return assert.fail("Gateway not expected");
      },
    }),
    now: () => clock,
  });
  await assert.rejects(
    expiring.dispatch(
      dispatchRequest("execute", frozen),
      new AbortController().signal,
    ),
    hasRuntimeError("runtime_workspace_delivery_lease_expired", "notSent"),
  );
  assert.equal(calls, 0);
});

test("aborts a hung binding resolution before any signing or Gateway send", async () => {
  const frozen = await frozenCommand();
  let calls = 0;
  const service = dispatchService({
    authority: { admit: async () => new Promise(() => undefined) },
    signer: {
      async sign() {
        calls += 1;
        return assert.fail("sign not expected");
      },
    },
    gateway: gatewayFixture({
      async execute() {
        calls += 1;
        return assert.fail("Gateway not expected");
      },
    }),
  });
  const controller = new AbortController();
  const pending = service.dispatch(
    dispatchRequest("execute", frozen),
    controller.signal,
  );
  controller.abort("caller_disconnected");
  await assert.rejects(
    pending,
    hasRuntimeError("runtime_workspace_aborted", "notSent"),
  );
  assert.equal(calls, 0);
});

test("aborts a hung signer as notSent and never reaches the Gateway", async () => {
  const frozen = await frozenCommand();
  let gatewayCalls = 0;
  let signingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signingStarted = resolve;
  });
  const service = dispatchService({
    signer: {
      async sign() {
        signingStarted();
        return new Promise(() => undefined);
      },
    },
    gateway: gatewayFixture({
      async execute() {
        gatewayCalls += 1;
        return assert.fail("Gateway not expected");
      },
    }),
  });
  const controller = new AbortController();
  const pending = service.dispatch(
    dispatchRequest("execute", frozen),
    controller.signal,
  );
  await started;
  controller.abort("deadline");
  await assert.rejects(
    pending,
    hasRuntimeError("runtime_workspace_aborted", "notSent"),
  );
  assert.equal(gatewayCalls, 0);
});

test("fails closed when the Gateway returns a malformed success", async () => {
  const frozen = await frozenCommand();
  const service = dispatchService({
    gateway: gatewayFixture({
      async execute(command) {
        const completed = completedGatewayResolution(command);
        return {
          ...completed,
          terminal: {
            ...completed.terminal,
            actionDigest: `sha256:${"0".repeat(64)}`,
          },
        };
      },
    }),
  });
  await assert.rejects(
    service.dispatch(
      dispatchRequest("execute", frozen),
      new AbortController().signal,
    ),
    hasRuntimeError(
      "runtime_workspace_gateway_response_invalid",
      "possiblySent",
    ),
  );
});

function freezeService(): RuntimeWorkspaceFreezeService {
  let sequence = 0;
  return new RuntimeWorkspaceFreezeService({
    bindings: resolver([binding(), binding()]),
    ids: { nextExecutionId: () => `workspace-execution-${(sequence += 1)}` },
    digester: new NodeSha256ContentDigester(),
  });
}

async function frozenCommand(): Promise<RuntimeWorkerFrozenWorkspaceCommand> {
  return (
    await freezeService().freeze(freezeRequest(), new AbortController().signal)
  ).command;
}

function dispatchService(
  overrides: Partial<{
    authority: RuntimeWorkspaceDispatchAuthorityPort;
    signer: DeviceWorkspaceListCommandSignerPort;
    gateway: DeviceWorkspaceListDispatchClientPort;
  }> = {},
): RuntimeWorkspaceDispatchService {
  return new RuntimeWorkspaceDispatchService({
    authority:
      overrides.authority ??
      authority([
        dispatchAuthorityFromBinding(binding()),
        dispatchAuthorityFromBinding(binding()),
      ]),
    digester: new NodeSha256ContentDigester(),
    signer: overrides.signer ?? signer(),
    gateway: overrides.gateway ?? gatewayFixture({}),
    now,
  });
}

function resolver(
  values: readonly RuntimeWorkspaceBindingSnapshot[],
): RuntimeWorkspaceBindingResolverPort {
  let index = 0;
  return {
    async resolve(query: RuntimeWorkspaceBindingQuery) {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      void query;
      return value;
    },
  };
}

function authority(
  values: readonly RuntimeWorkspaceDispatchAuthority[],
  afterAdmit?: () => void,
): RuntimeWorkspaceDispatchAuthorityPort {
  let index = 0;
  return {
    async admit() {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      afterAdmit?.();
      return value;
    },
  };
}

function dispatchAuthorityFromBinding(
  value: RuntimeWorkspaceBindingSnapshot,
): RuntimeWorkspaceDispatchAuthority {
  return {
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    workspaceBindingId: value.workspaceBindingId,
    incarnationId: value.incarnationId,
    deviceBindingId: value.deviceBindingId,
    deviceId: value.deviceId,
    runtimeBindingId: value.runtimeBindingId,
    policySnapshotId: value.policySnapshotId,
  };
}

function dispatchAuthority(
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
): RuntimeWorkspaceDispatchAuthority {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: frozen.workspaceBindingId,
    incarnationId: frozen.incarnationId,
    deviceBindingId: frozen.deviceBindingId,
    deviceId: frozen.deviceId,
    runtimeBindingId: frozen.runtimeBindingId,
    policySnapshotId: frozen.policySnapshotId,
  };
}

function binding(): RuntimeWorkspaceBindingSnapshot {
  return {
    ...scope(),
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
  };
}

function scope(
  overrides: Partial<RuntimeWorkspaceBindingQuery> = {},
): RuntimeWorkspaceBindingQuery {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    ...overrides,
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

function dispatchRequest(
  phase: "execute" | "reconcile" | "cancel",
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
  operation: RuntimeWorkerWorkspaceDispatchRequest["operation"] = preparedOperation(
    frozen,
  ),
): RuntimeWorkerWorkspaceDispatchRequest {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0",
    apiVersion: 1,
    phase,
    operation,
    deliveryLease: {
      schemaVersion: "crewon.workspace-delivery-lease.v0",
      executionId: frozen.executionId,
      attemptNumber: phase === "execute" ? 1 : 2,
      phase,
      ownerId: "runtime-worker-1",
      leaseId: `delivery-${phase}`,
      epoch: 1,
      leasedAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-10T00:01:00.000Z",
    },
  };
}

function preparedOperation(frozen: RuntimeWorkerFrozenWorkspaceCommand) {
  return {
    schemaVersion: "crewon.workspace-operation.v0" as const,
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: "workspace-idempotency-1",
    executionId: frozen.executionId,
    revision: 1,
    status: "prepared" as const,
    command: frozen,
    resolution: null,
  };
}

function unknownOperation(
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
  providerReceiptId: string | null,
) {
  return {
    ...preparedOperation(frozen),
    revision: 2,
    status: "unknownOutcome" as const,
    resolution: {
      status: "unknownOutcome" as const,
      executionId: frozen.executionId,
      actionDigest: frozen.actionDigest,
      commandDigest: frozen.commandDigest,
      providerReceiptId,
    },
  };
}

function signer(): DeviceWorkspaceListCommandSignerPort {
  return {
    async sign({ command }) {
      return {
        ...command,
        authorization: {
          schemaVersion: "crewon.device-authorization.v0",
          scheme: "ed25519",
          keyId: "workspace-key-1",
          issuedAt: "2026-08-10T00:00:30.000Z",
          expiresAt: command.expiresAt,
          approvalProof: null,
          signature: "A".repeat(86),
        },
      };
    },
  };
}

function gatewayFixture(
  overrides: Partial<DeviceWorkspaceListDispatchClientPort>,
): DeviceWorkspaceListDispatchClientPort {
  return {
    execute:
      overrides.execute ??
      (async (command) => completedGatewayResolution(command)),
    reconcile:
      overrides.reconcile ??
      (async () => assert.fail("reconcile not expected")),
    cancel:
      overrides.cancel ?? (async () => assert.fail("cancel not expected")),
    close: overrides.close ?? (async () => undefined),
  };
}

function signedCommand(
  request: RuntimeWorkerWorkspaceDispatchRequest,
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
): DeviceWorkspaceListCommand {
  return {
    schemaVersion: "crewon.device-workspace-list-command.v0",
    protocolVersion: 1,
    commandKind: "workspaceList",
    deviceId: frozen.deviceId,
    executionId: frozen.executionId,
    leaseId: request.deliveryLease.leaseId,
    leaseEpoch: request.deliveryLease.epoch,
    expiresAt: request.deliveryLease.expiresAt,
    workspaceBindingId: frozen.workspaceBindingId,
    incarnationId: frozen.incarnationId,
    deviceBindingId: frozen.deviceBindingId,
    runtimeBindingId: frozen.runtimeBindingId,
    policySnapshotId: frozen.policySnapshotId,
    operation: "listTopLevel",
    limits: frozen.limits,
    actionDigest: frozen.actionDigest,
    commandDigest: frozen.commandDigest,
    idempotencyKey: "workspace-idempotency-1",
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "workspace-key-1",
      issuedAt: "2026-08-10T00:00:30.000Z",
      expiresAt: request.deliveryLease.expiresAt,
      approvalProof: null,
      signature: "A".repeat(86),
    },
  };
}

function completedGatewayResolution(
  command: DeviceWorkspaceListCommand,
): Extract<DeviceWorkspaceListDispatchResolution, { status: "completed" }> {
  return {
    status: "completed",
    executionId: command.executionId,
    receiptId: "gateway-receipt-1",
    terminal: {
      schemaVersion: "crewon.device-workspace-list-event.v0",
      protocolVersion: 1,
      commandKind: "workspaceList",
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
      type: "workspace_list.completed",
      data: {
        result: {
          schemaVersion: "crewon.workspace-list-result.v0",
          executionId: command.executionId,
          actionDigest: command.actionDigest,
          commandDigest: command.commandDigest,
          entries: [{ name: "README.md", kind: "file" }],
          truncated: false,
        },
      },
    },
  };
}

function reference(
  frozen: RuntimeWorkerFrozenWorkspaceCommand,
  receiptId: string | null,
): DeviceWorkspaceListDispatchReference {
  return {
    deviceId: frozen.deviceId,
    executionId: frozen.executionId,
    workspaceBindingId: frozen.workspaceBindingId,
    incarnationId: frozen.incarnationId,
    deviceBindingId: frozen.deviceBindingId,
    runtimeBindingId: frozen.runtimeBindingId,
    actionDigest: frozen.actionDigest,
    commandDigest: frozen.commandDigest,
    receiptId,
  };
}

function hasRuntimeError(
  code: string,
  certainty: "notSent" | "possiblySent",
): (error: unknown) => boolean {
  return (error) =>
    error instanceof RuntimeWorkspaceError &&
    error.code === code &&
    error.certainty === certainty;
}
