import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ThreadState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  emptyCounts,
  frozenCommand,
  mutation,
  pendingAttempt,
  preparation,
  receiptKey,
  resolution,
  settled,
  sha256,
  storeError,
  threadFixture,
} from "./workspace-list-fixture-builders.test-support.ts";
export * from "./workspace-list-fixture-builders.test-support.ts";
import type {
  ActorContext,
  AuthorizationAction,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ThreadSpaceLocator } from "./thread-store-port.ts";
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

export const actor: ActorContext = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
export function createFixture() {
  const store = new FakeStore();
  const fixture = {
    store,
    factoryCalls: 0,
    forgeFactoryDigest: false,
    factoryFailure: null as "unavailable" | "invalidAuthority" | null,
    dispatchFailures: {
      execute: "none",
      reconcile: "none",
      cancel: "none",
    } as Record<WorkspaceListOperationPhase, DispatchFailure>,
    dispatches: [] as string[],
    authorizations: [] as Array<{
      action: AuthorizationAction;
      threadId: string | null;
    }>,
    authorization: (
      _action: AuthorizationAction,
      _threadId: string | null,
    ): AuthorizationDecision => ({
      outcome: "allow",
    }),
    service: null as unknown as WorkspaceListApplicationService,
  };
  fixture.service = new WorkspaceListApplicationService({
    store: store as never,
    authorization: {
      authorize: async ({ action, resource }) => {
        assert.equal(resource.kind, "thread");
        const threadId = resource.kind === "thread" ? resource.threadId : null;
        fixture.authorizations.push({ action, threadId });
        return fixture.authorization(action, threadId);
      },
    },
    digester: { sha256 },
    commands: {
      create: async (input) => {
        fixture.factoryCalls += 1;
        if (fixture.factoryFailure !== null) {
          throw new WorkspaceListCommandFactoryError(fixture.factoryFailure);
        }
        const frozen = frozenCommand(input);
        return fixture.forgeFactoryDigest
          ? { ...frozen, actionDigest: `sha256:${"f".repeat(64)}` }
          : frozen;
      },
    },
    dispatcher: {
      execute: async (operation) => {
        fixture.dispatches.push("execute");
        throwDispatchFailure(fixture.dispatchFailures.execute);
        return resolution(operation, "unknownOutcome");
      },
      reconcile: async (operation) => {
        fixture.dispatches.push("reconcile");
        throwDispatchFailure(fixture.dispatchFailures.reconcile);
        return resolution(operation, "completed");
      },
      cancel: async (operation) => {
        fixture.dispatches.push("cancel");
        throwDispatchFailure(fixture.dispatchFailures.cancel);
        return resolution(operation, "canceled");
      },
    },
    deliveryOwnerId: "application-1",
    deliveryLeaseDurationMs: 40_000,
  });
  return fixture;
}

export type DispatchFailure =
  | "none"
  | "notSent"
  | "possiblySent"
  | "unexpected";

export function throwDispatchFailure(failure: DispatchFailure): void {
  switch (failure) {
    case "none":
      return;
    case "notSent":
    case "possiblySent":
      throw new WorkspaceListDispatchError(failure);
    case "unexpected":
      throw new Error("transport_lost");
  }
}

export class FakeStore {
  thread = threadFixture();
  operation: WorkspaceOperationRecord | null = null;
  readonly receipts = new Map<
    string,
    Readonly<{ fingerprint: string; executionId: string }>
  >();
  counts = emptyCounts();
  settlementOverride:
    | ((operation: WorkspaceOperationRecord) => WorkspaceListResolution)
    | null = null;
  attempt: WorkspaceDeliveryAttempt | null = null;
  forgeLeaseOwner = false;
  forgeLeaseEpoch = false;
  forgeClaimCreatedAt = false;
  forgeAbandonCreatedAt = false;
  forgeAbandonDigest = false;
  forgeReceiptAuthority = false;
  lostRace = false;
  settlementReplay = false;
  abandonThrows = false;
  settleThrows = false;
  claimThrowsOnce = false;

  resetCounters() {
    this.counts = emptyCounts();
  }

  async loadThread() {
    this.counts.threadReads += 1;
    return structuredClone(this.thread);
  }

  async loadThreadInSpace(locator: ThreadSpaceLocator) {
    this.counts.threadReads += 1;
    return locator.tenantId === this.thread.tenantId &&
      locator.spaceId === this.thread.spaceId &&
      locator.threadId === this.thread.threadId
      ? structuredClone(this.thread)
      : null;
  }

  async loadWorkspaceOperationReceipt(query: WorkspaceOperationReceiptQuery) {
    this.counts.receiptReads += 1;
    const receipt = this.receipts.get(receiptKey(query));
    if (receipt === undefined) return null;
    if (receipt.fingerprint !== query.idempotency.requestFingerprint) {
      throw storeError("workspace_operation_idempotency_conflict");
    }
    assert.equal(receipt.executionId, this.operation?.executionId);
    if (!this.forgeReceiptAuthority) {
      return mutation("replayed", this.operation!);
    }
    const command = {
      ...this.operation!.command,
      runtimeBindingId: "substituted-runtime",
    };
    const actionDigest = `sha256:${"f".repeat(64)}`;
    const commandDigest = `sha256:${"e".repeat(64)}`;
    return mutation("replayed", {
      ...this.operation!,
      command: { ...command, actionDigest, commandDigest },
      resolution:
        this.operation!.resolution === null
          ? null
          : { ...this.operation!.resolution, actionDigest, commandDigest },
    });
  }

  async prepareWorkspaceOperation(input: {
    idempotency: WorkspaceOperationReceiptQuery["idempotency"];
    operation: WorkspaceOperationRecord;
  }) {
    this.counts.prepares += 1;
    this.operation = validateWorkspaceOperationRecord(input.operation);
    this.receipts.set(
      receiptKey({
        tenantId: this.operation.tenantId,
        spaceId: this.operation.spaceId,
        phase: "execute",
        idempotency: input.idempotency,
      }),
      {
        fingerprint: input.idempotency.requestFingerprint,
        executionId: this.operation.executionId,
      },
    );
    this.attempt = pendingAttempt(this.operation, "execute", 1);
    return preparation("committed", this.operation, this.attempt);
  }

  async loadWorkspaceOperation() {
    this.counts.operationReads += 1;
    return this.operation === null ? null : structuredClone(this.operation);
  }

  async prepareWorkspaceOperationAction(input: {
    phase: "reconcile" | "cancel";
    idempotency: WorkspaceOperationReceiptQuery["idempotency"];
  }) {
    this.counts.actions += 1;
    this.attempt = pendingAttempt(
      this.operation!,
      input.phase,
      (this.attempt?.attemptNumber ?? 0) + 1,
    );
    this.receipts.set(
      receiptKey({
        tenantId: this.operation!.tenantId,
        spaceId: this.operation!.spaceId,
        phase: input.phase,
        idempotency: input.idempotency,
      }),
      {
        fingerprint: input.idempotency.requestFingerprint,
        executionId: this.operation!.executionId,
      },
    );
    return preparation("committed", this.operation!, this.attempt);
  }

  async claimWorkspaceOperationDelivery(input: { ownerId: string }) {
    this.counts.claims += 1;
    if (this.claimThrowsOnce) {
      this.claimThrowsOnce = false;
      throw new Error("claim_store_failed");
    }
    this.attempt = validateWorkspaceDeliveryAttempt({
      ...this.attempt!,
      createdAt: this.forgeClaimCreatedAt
        ? "2026-08-09T00:00:00.000Z"
        : this.attempt!.createdAt,
      status: "leased",
      lease: {
        schemaVersion: "crewon.workspace-delivery-lease.v0",
        executionId: this.attempt!.executionId,
        attemptNumber: this.attempt!.attemptNumber,
        phase: this.attempt!.phase,
        ownerId: this.forgeLeaseOwner ? "forged-owner" : input.ownerId,
        leaseId: `lease-${this.attempt!.attemptNumber}`,
        epoch: this.forgeLeaseEpoch ? 2 : 1,
        leasedAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2026-08-10T00:01:00.000Z",
      },
    });
    return structuredClone(this.attempt);
  }

  async listWorkspaceOperationDeliveryAttempts() {
    return this.attempt === null ? [] : [structuredClone(this.attempt)];
  }

  async abandonWorkspaceOperationDelivery() {
    if (this.abandonThrows) throw new Error("abandon_store_failed");
    this.attempt = validateWorkspaceDeliveryAttempt({
      ...this.attempt!,
      createdAt: this.forgeAbandonCreatedAt
        ? "2026-08-09T00:00:00.000Z"
        : this.attempt!.createdAt,
      status: "settled",
      settlement: {
        kind: "abandoned",
        resolutionStatus: null,
        resultRevision: this.operation!.revision,
        resultDigest: this.forgeAbandonDigest
          ? `sha256:${"f".repeat(64)}`
          : sha256(canonicalWorkspaceOperationResult(this.operation!)),
        settledAt: "2026-08-10T00:00:01.000Z",
      },
    });
    return structuredClone(this.attempt);
  }

  async settleWorkspaceOperationDelivery(input: {
    resolution: WorkspaceListResolution;
  }) {
    this.counts.settlements += 1;
    if (this.settleThrows) throw new Error("settle_store_failed");
    this.operation = settled(
      this.operation!,
      this.lostRace
        ? resolution(this.operation!, "canceled")
        : (this.settlementOverride?.(this.operation!) ?? input.resolution),
    );
    this.attempt = validateWorkspaceDeliveryAttempt({
      ...this.attempt!,
      status: "settled",
      settlement: {
        kind: this.lostRace ? "superseded" : "resolution",
        resolutionStatus: this.lostRace ? null : this.operation.status,
        resultRevision: this.operation.revision,
        resultDigest: sha256(canonicalWorkspaceOperationResult(this.operation)),
        settledAt: "2026-08-10T00:00:01.000Z",
      },
    });
    return {
      outcome: this.lostRace
        ? ("lostRace" as const)
        : this.settlementReplay
          ? ("replayed" as const)
          : ("committed" as const),
      operation: this.operation,
      deliveryAttempt: this.attempt,
    };
  }
}
