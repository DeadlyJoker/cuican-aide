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
  type ExecuteWorkspaceListCommand,
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
  resolution,
  sha256,
  signal,
} from "./workspace-list-application-service.test-support.ts";
test("freezes the provider-neutral action and dispatch digest vector", () => {
  const draft: FrozenWorkspaceListCommand = {
    executionId: "workspace-execution-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    actionDigest: `sha256:${"0".repeat(64)}`,
    commandDigest: `sha256:${"0".repeat(64)}`,
    limits: {
      depth: 0,
      maxEntries: 5,
      maxNameBytes: 255,
      maxOutputBytes: 65_536,
      maxScannedEntries: 10,
      maxScannedNameBytes: 8_000,
      timeoutMs: 30_000,
    },
  };
  const actionDigest = sha256(
    canonicalWorkspaceListAction({
      idempotencyKey: "workspace-idempotency-1",
      command: draft,
    }),
  );
  const commandDigest = sha256(
    canonicalWorkspaceListDispatchCommand({
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      expectedThreadRevision: 1,
      principalId: "principal-1",
      actorId: "actor-1",
      idempotencyKey: "workspace-idempotency-1",
      command: { ...draft, actionDigest },
    }),
  );
  const operation = validateWorkspaceOperationRecord({
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: "workspace-idempotency-1",
    executionId: draft.executionId,
    revision: 1,
    status: "prepared",
    command: { ...draft, actionDigest, commandDigest },
    resolution: null,
  });
  const resultDigest = sha256(canonicalWorkspaceOperationResult(operation));
  assert.deepEqual(
    { actionDigest, commandDigest, resultDigest },
    {
      actionDigest:
        "sha256:2ef3685e485de632d6495d314af9aa708ba33afb858e763bd00043285b8d35b0",
      commandDigest:
        "sha256:951a827df67bea6c4203b00c4f756f36179e2220c5531bbd61c7ef728a90bbad",
      resultDigest:
        "sha256:6bc0275912c28ccbf458efd31948068ff775672471e98199f08f87f854976fb1",
    },
  );
});

test("persists unknown outcome and reconciles without blind execute replay", async () => {
  const fixture = createFixture();
  const first = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.equal(first.operation.status, "unknownOutcome");
  assert.deepEqual(fixture.dispatches, ["execute"]);

  fixture.store.thread = { ...fixture.store.thread, revision: 2 };
  fixture.store.resetCounters();
  fixture.dispatches.length = 0;
  const replay = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.operation.status, "unknownOutcome");
  assert.deepEqual(fixture.dispatches, []);
  assert.deepEqual(fixture.store.counts, {
    receiptReads: 1,
    threadReads: 0,
    operationReads: 0,
    prepares: 0,
    actions: 0,
    claims: 0,
    settlements: 0,
  });

  const reconciled = await fixture.service.reconcileWorkspaceList(
    actor,
    {
      kind: "workspaceList.reconcile",
      threadId: "thread-1",
      executionId: replay.operation.executionId,
      expectedOperationRevision: replay.operation.revision,
      idempotencyKey: "reconcile-key-1",
    },
    signal(),
  );
  assert.equal(reconciled.operation.status, "completed");
  assert.deepEqual(fixture.dispatches, ["reconcile"]);
});

test("returns the durable unknown outcome for an unexpected execute failure", async () => {
  const fixture = createFixture();
  fixture.dispatchFailures.execute = "unexpected";
  const first = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.equal(first.disposition, "committed");
  assert.equal(first.operation.status, "unknownOutcome");

  fixture.dispatches.length = 0;
  const replay = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.deepEqual(replay, {
    disposition: "replayed",
    operation: first.operation,
  });
  assert.deepEqual(fixture.dispatches, []);
});

test("returns the durable prepared operation after an exact notSent abandon", async () => {
  const fixture = createFixture();
  fixture.dispatchFailures.execute = "notSent";
  const first = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.equal(first.disposition, "committed");
  assert.equal(first.operation.status, "prepared");
  assert.equal(fixture.store.attempt?.status, "settled");
  assert.equal(fixture.store.attempt?.settlement?.kind, "abandoned");

  fixture.dispatches.length = 0;
  const replay = await fixture.service.executeWorkspaceList(
    actor,
    executeCommand(),
    signal(),
  );
  assert.deepEqual(replay, {
    disposition: "replayed",
    operation: first.operation,
  });
  assert.deepEqual(fixture.dispatches, []);
});

test("returns durable unknown outcomes for reconcile possiblySent and cancel exceptions", async () => {
  for (const phase of ["reconcile", "cancel"] as const) {
    const fixture = createFixture();
    const initial = await fixture.service.executeWorkspaceList(
      actor,
      executeCommand(),
      signal(),
    );
    fixture.dispatchFailures[phase] =
      phase === "reconcile" ? "possiblySent" : "unexpected";
    fixture.dispatches.length = 0;
    const invoke = () =>
      phase === "reconcile"
        ? fixture.service.reconcileWorkspaceList(
            actor,
            {
              kind: "workspaceList.reconcile",
              idempotencyKey: "reconcile-failure-key",
              threadId: "thread-1",
              executionId: initial.operation.executionId,
              expectedOperationRevision: initial.operation.revision,
            },
            signal(),
          )
        : fixture.service.cancelWorkspaceList(
            actor,
            {
              kind: "workspaceList.cancel",
              idempotencyKey: "cancel-failure-key",
              threadId: "thread-1",
              executionId: initial.operation.executionId,
              expectedOperationRevision: initial.operation.revision,
            },
            signal(),
          );
    const first = await invoke();
    assert.equal(first.disposition, "committed");
    assert.equal(first.operation.status, "unknownOutcome");

    fixture.dispatches.length = 0;
    const replay = await invoke();
    assert.deepEqual(replay, {
      disposition: "replayed",
      operation: first.operation,
    });
    assert.deepEqual(fixture.dispatches, []);
  }
});
