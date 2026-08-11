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

import {
  authority,
  binding,
  completedGatewayResolution,
  dispatchAuthority,
  dispatchAuthorityFromBinding,
  dispatchRequest,
  dispatchService,
  freezeRequest,
  freezeService,
  frozenCommand,
  gatewayFixture,
  hasRuntimeError,
  now,
  preparedOperation,
  reference,
  resolver,
  scope,
  signedCommand,
  signer,
  unknownOperation,
} from "./runtime-workspace-services.test-support.ts";
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
