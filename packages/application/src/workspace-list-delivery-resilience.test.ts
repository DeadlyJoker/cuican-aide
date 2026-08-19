import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ThreadState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import type {
  ActorContext,
  AuthorizationAction,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import {
  validateWorkspaceDeliveryAttempt,
  WorkspaceListDispatchError,
  type WorkspaceDeliveryAttempt,
} from "./workspace-delivery-store-port.ts";
import {
  WorkspaceListApplicationService,
  type CancelWorkspaceListCommand,
  type ExecuteWorkspaceListCommand,
  type ReconcileWorkspaceListCommand,
} from "./workspace-list-application-service.ts";
import {
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  canonicalWorkspaceOperationResult,
  validateWorkspaceOperationRecord,
  WorkspaceListCommandFactoryError,
  type FrozenWorkspaceListCommand,
  type WorkspaceListOperationPhase,
  type WorkspaceListResolution,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationReceiptQuery,
  type WorkspaceOperationRecord,
} from "./workspace-operation-store-port.ts";

import {
  actor,
  applicationError,
  createFixture,
  executeCommand,
  frozenCommand,
  resolution,
  settled,
  signal,
  storeError,
} from "./workspace-list-application-service.test-support.ts";
test("rejects a forged claimed lease before dispatch", async () => {
  const fixture = createFixture();
  fixture.store.forgeLeaseOwner = true;
  await assert.rejects(
    fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_delivery_lease_invalid"),
  );
  assert.deepEqual(fixture.dispatches, []);
});

test("rejects claimed delivery seed drift and a noninitial lease epoch", async () => {
  const drifted = createFixture();
  drifted.store.forgeClaimCreatedAt = true;
  await assert.rejects(
    drifted.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_delivery_lease_invalid"),
  );
  assert.deepEqual(drifted.dispatches, []);

  const reclaimed = createFixture();
  reclaimed.store.forgeLeaseEpoch = true;
  await assert.rejects(
    reclaimed.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_delivery_lease_invalid"),
  );
  assert.deepEqual(reclaimed.dispatches, []);
});

test("rejects abandon seed drift and result authority drift", async () => {
  const drifted = createFixture();
  drifted.dispatchFailures.execute = "notSent";
  drifted.store.forgeAbandonCreatedAt = true;
  await assert.rejects(
    drifted.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_delivery_abandon_invalid"),
  );

  const wrongResult = createFixture();
  wrongResult.dispatchFailures.execute = "notSent";
  wrongResult.store.forgeAbandonDigest = true;
  await assert.rejects(
    wrongResult.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_delivery_abandon_invalid"),
  );
});

test("does not synthesize a result when abandon or settle Store writes fail", async () => {
  const abandon = createFixture();
  abandon.dispatchFailures.execute = "notSent";
  abandon.store.abandonThrows = true;
  await assert.rejects(
    abandon.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_operation_store_failed"),
  );

  const settle = createFixture();
  settle.dispatchFailures.execute = "possiblySent";
  settle.store.settleThrows = true;
  await assert.rejects(
    settle.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_operation_store_failed"),
  );
});

test("resumes the exact pending initial execute attempt after receipt commit", async () => {
  const fixture = await preparedExecuteCrashFixture();

  const recovered = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );

  assert.equal(recovered.operation.status, "unknownOutcome");
  assert.deepEqual(fixture.dispatches, ["execute"]);
  assert.equal(fixture.store.counts.prepares, 1);
  assert.equal(fixture.store.counts.claims, 2);
  assert.equal(fixture.store.counts.settlements, 1);
});

test("fails closed when pending execute replay authority drifts", async () => {
  for (const drift of [
    { tenantId: "tenant-substituted" },
    { spaceId: "space-substituted" },
    { threadId: "thread-substituted" },
    { executionId: "execution-substituted" },
    { attemptNumber: 2 },
    { operationRevision: 2 },
    { phase: "reconcile" as const },
  ]) {
    const fixture = await preparedExecuteCrashFixture();
    fixture.store.attempt = validateWorkspaceDeliveryAttempt({
      ...fixture.store.attempt!,
      ...drift,
    });
    await assert.rejects(
      fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "internal",
    );
    assert.deepEqual(fixture.dispatches, []);
  }
});

test("never redispatches a leased initial execute receipt", async () => {
  const fixture = await preparedExecuteCrashFixture();
  await fixture.store.claimWorkspaceOperationDelivery({ ownerId: "owner-1" });

  const replay = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );

  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.operation.status, "prepared");
  assert.deepEqual(fixture.dispatches, []);
});

test("resumes only the receipt-linked pending reconcile and cancel attempt", async () => {
  for (const phase of ["reconcile", "cancel"] as const) {
    const fixture = createFixture();
    const initial = await fixture.service.executeWorkspaceList(
      actor,
      executeCommand(),
      signal(),
    );
    const command: ReconcileWorkspaceListCommand | CancelWorkspaceListCommand =
      {
        kind:
          phase === "reconcile"
            ? ("workspaceList.reconcile" as const)
            : ("workspaceList.cancel" as const),
        idempotencyKey: `${phase}-crash-key`,
        threadId: initial.operation.threadId,
        executionId: initial.operation.executionId,
        expectedOperationRevision: initial.operation.revision,
      } as const;
    const invoke = () => invokeAction(fixture, command);
    fixture.store.claimThrowsOnce = true;
    await assert.rejects(
      invoke(),
      applicationError("internal", "workspace_operation_store_failed"),
    );
    assert.equal(fixture.store.attempt?.phase, phase);
    assert.equal(fixture.store.attempt?.status, "pending");

    fixture.dispatches.length = 0;
    const recovered = await invoke();
    assert.equal(
      recovered.operation.status,
      phase === "reconcile" ? "completed" : "canceled",
    );
    assert.deepEqual(fixture.dispatches, [phase]);

    fixture.dispatches.length = 0;
    assert.equal((await invoke()).disposition, "replayed");
    assert.deepEqual(fixture.dispatches, []);
  }
});

test("never redispatches leased or possibly-sent action receipts", async () => {
  for (const phase of ["reconcile", "cancel"] as const) {
    const fixture = createFixture();
    const initial = await fixture.service.executeWorkspaceList(
      actor,
      executeCommand(),
      signal(),
    );
    const command: ReconcileWorkspaceListCommand | CancelWorkspaceListCommand =
      {
        kind:
          phase === "reconcile"
            ? ("workspaceList.reconcile" as const)
            : ("workspaceList.cancel" as const),
        idempotencyKey: `${phase}-leased-key`,
        threadId: initial.operation.threadId,
        executionId: initial.operation.executionId,
        expectedOperationRevision: initial.operation.revision,
      } as const;
    const invoke = () => invokeAction(fixture, command);
    fixture.store.claimThrowsOnce = true;
    await assert.rejects(invoke());
    await fixture.store.claimWorkspaceOperationDelivery({ ownerId: "owner-1" });

    fixture.dispatches.length = 0;
    assert.equal((await invoke()).disposition, "replayed");
    assert.deepEqual(fixture.dispatches, []);

    const possiblySent = createFixture();
    const possiblySentInitial = await possiblySent.service.executeWorkspaceList(
      actor,
      executeCommand(),
      signal(),
    );
    const possiblySentCommand = {
      ...command,
      executionId: possiblySentInitial.operation.executionId,
      expectedOperationRevision: possiblySentInitial.operation.revision,
      idempotencyKey: `${phase}-possibly-sent-key`,
    };
    const invokePossiblySent = () =>
      invokeAction(possiblySent, possiblySentCommand);
    possiblySent.dispatchFailures[phase] = "possiblySent";
    possiblySent.store.settleThrows = true;
    await assert.rejects(invokePossiblySent());
    possiblySent.dispatches.length = 0;
    possiblySent.store.settleThrows = false;
    assert.equal((await invokePossiblySent()).disposition, "replayed");
    assert.deepEqual(possiblySent.dispatches, []);
  }
});

test("receipt replay reauthorizes exact frozen thread without current reads", async () => {
  const fixture = createFixture();
  await fixture.service.executeWorkspaceList(actor, executeCommand(), signal());
  fixture.store.resetCounters();
  fixture.factoryCalls = 0;
  fixture.dispatches.length = 0;
  fixture.authorization = (_action, threadId) =>
    threadId === null
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "revoked" };

  await assert.rejects(
    fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("authorization", "authorization_denied"),
  );
  assert.deepEqual(fixture.store.counts, {
    receiptReads: 1,
    threadReads: 0,
    operationReads: 0,
    prepares: 0,
    actions: 0,
    claims: 0,
    settlements: 0,
  });
  assert.equal(fixture.factoryCalls, 0);
  assert.deepEqual(fixture.dispatches, []);
});

test("rejects replay with substituted binding and synchronized forged digest fields", async () => {
  const fixture = createFixture();
  await fixture.service.executeWorkspaceList(actor, executeCommand(), signal());
  fixture.store.forgeReceiptAuthority = true;
  fixture.dispatches.length = 0;
  await assert.rejects(
    fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_operation_result_invalid"),
  );
  assert.deepEqual(fixture.dispatches, []);
});

test("rejects a forged factory digest before Store prepare or dispatch", async () => {
  const fixture = createFixture();
  fixture.forgeFactoryDigest = true;

  await assert.rejects(
    fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_command_factory_invalid"),
  );
  assert.equal(fixture.store.counts.prepares, 0);
  assert.deepEqual(fixture.dispatches, []);
});

test("distinguishes an unavailable factory from invalid authority", async () => {
  for (const [kind, code] of [
    ["unavailable", "workspace_command_factory_unavailable"],
    ["invalidAuthority", "workspace_command_factory_invalid"],
  ] as const) {
    const fixture = createFixture();
    fixture.factoryFailure = kind;
    await assert.rejects(
      fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
      applicationError("internal", code),
    );
    assert.equal(fixture.store.counts.prepares, 0);
    assert.deepEqual(fixture.dispatches, []);
  }
});

test("rejects a Store race result that differs from the fresh dispatch result", async () => {
  const fixture = createFixture();
  fixture.dispatchFailures.execute = "unexpected";
  fixture.store.settlementOverride = (operation) =>
    resolution(operation, "completed");

  await assert.rejects(
    fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_operation_result_invalid"),
  );
  assert.deepEqual(fixture.dispatches, ["execute"]);
});

test("accepts a deeply validated lost race and returns the winner authority", async () => {
  const fixture = createFixture();
  fixture.dispatchFailures.execute = "possiblySent";
  fixture.store.lostRace = true;
  const result = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.equal(result.disposition, "replayed");
  assert.equal(result.operation.status, "canceled");
});

test("accepts an exact settlement replay as the frozen successful result", async () => {
  const fixture = createFixture();
  fixture.store.settlementReplay = true;
  const result = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.equal(result.disposition, "replayed");
  assert.equal(result.operation.status, "unknownOutcome");
});

test("validates before authorization and scopes receipt fingerprints to actor and payload", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.service.executeWorkspaceList(
      actor,
      { ...executeCommand(), maxEntries: 201 },
      signal(),
    ),
    applicationError("validation", "workspace_list_command_invalid"),
  );
  assert.deepEqual(fixture.authorizations, []);

  await fixture.service.executeWorkspaceList(actor, executeCommand(), signal());
  await assert.rejects(
    fixture.service.executeWorkspaceList(
      actor,
      { ...executeCommand(), maxEntries: 4 },
      signal(),
    ),
    applicationError("conflict", "workspace_operation_idempotency_conflict"),
  );
});

test("requires Workspace write authorization for coarse and exact mutation scope", async () => {
  const fixture = createFixture();
  fixture.authorization = (action) =>
    action === "thread:workspace:read"
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "write_denied" };

  await assert.rejects(
    fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("authorization", "authorization_denied"),
  );
  assert.deepEqual(fixture.authorizations, [
    { action: "thread:workspace:write", threadId: null },
  ]);
  assert.equal(fixture.store.counts.receiptReads, 0);
  assert.equal(fixture.store.counts.prepares, 0);
  assert.deepEqual(fixture.dispatches, []);
});

test("uses the caller operation revision as the fresh action CAS", async () => {
  const fixture = createFixture();
  const initial = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.equal(initial.operation.revision, 2);
  const before = structuredClone(fixture.store.counts);
  await assert.rejects(
    fixture.service.reconcileWorkspaceList(
      actor,
      {
        kind: "workspaceList.reconcile",
        idempotencyKey: "stale-reconcile-key",
        threadId: "thread-1",
        executionId: initial.operation.executionId,
        expectedOperationRevision: 1,
      },
      signal(),
    ),
    applicationError("conflict", "workspace_operation_revision_conflict"),
  );
  assert.equal(fixture.store.counts.actions, before.actions);
  assert.deepEqual(fixture.dispatches, ["execute"]);
});

async function preparedExecuteCrashFixture() {
  const fixture = createFixture();
  fixture.store.claimThrowsOnce = true;
  await assert.rejects(
    fixture.service.executeWorkspaceList(actor, executeCommand(), signal()),
    applicationError("internal", "workspace_operation_store_failed"),
  );
  assert.equal(fixture.store.operation?.status, "prepared");
  assert.equal(fixture.store.attempt?.status, "pending");
  assert.deepEqual(fixture.dispatches, []);
  return fixture;
}

function invokeAction(
  fixture: ReturnType<typeof createFixture>,
  command: ReconcileWorkspaceListCommand | CancelWorkspaceListCommand,
) {
  return command.kind === "workspaceList.reconcile"
    ? fixture.service.reconcileWorkspaceList(actor, command, signal())
    : fixture.service.cancelWorkspaceList(actor, command, signal());
}
