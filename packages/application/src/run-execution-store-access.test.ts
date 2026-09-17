import assert from "node:assert/strict";
import test from "node:test";
import type { DomainStore } from "./domain-store-port.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import { RunExecutionService } from "./run-execution-service.ts";
import { StorageAdmissionError } from "./storage-admission-port.ts";
import { ApplicationError } from "./application-error.ts";

const claim: WorkItemClaim = {
  workItem: {
    workItemId: "work",
    tenantId: "tenant",
    runId: "run",
    kind: "run.execute",
    payload: {},
    createdAt: "2026-09-15T00:00:00Z",
  },
  lease: {
    ownerId: "worker",
    leaseId: "lease",
    epoch: 4,
    expiresAt: "2026-09-15T00:00:30Z",
  },
};

test("scoped Store access preserves admission, clock, identifiers and the original service", async () => {
  let allow = false,
    admissionCalls = 0,
    reads = 0,
    decoratedReads = 0;
  const writes: unknown[] = [];
  const result = { committed: true };
  const state = {
    tenantId: "tenant",
    runId: "run",
    status: "running",
    cancelRequested: false,
  };
  const store = {
    loadRun: async () => {
      reads++;
      return state;
    },
    beginRunAttempt: async (input: unknown) => {
      writes.push(input);
      return result;
    },
  } as unknown as DomainStore;
  const service = new RunExecutionService({
    store,
    clock: { now: () => "2026-09-15T01:02:03Z" },
    ids: { nextId: (kind) => `shared-${kind}` },
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
    storageAdmission: {
      assertNewWorkAllowed: async () => {
        admissionCalls++;
        if (!allow) throw new StorageAdmissionError("storage_capacity_low");
      },
    },
  });
  const scoped = service.withStoreAccess((original) => {
    assert.equal(original, store);
    return {
      ...store,
      loadRun: async (...args) => {
        decoratedReads++;
        return store.loadRun(...args);
      },
    };
  });
  await assert.rejects(scoped.beginModelAttempt(claim), {
    code: "storage_capacity_low",
  });
  assert.equal(writes.length, 0);
  allow = true;
  assert.equal(await scoped.beginModelAttempt(claim), result);
  assert.deepEqual(writes, [
    {
      tenantId: "tenant",
      runId: "run",
      stepId: "work",
      kind: "model",
      attemptId: "shared-attempt",
      startedAt: "2026-09-15T01:02:03Z",
      lease: {
        workItemId: "work",
        ownerId: "worker",
        leaseId: "lease",
        leaseEpoch: 4,
      },
    },
  ]);
  assert.equal(admissionCalls, 2);
  assert.equal(decoratedReads, 2);
  assert.equal(await service.loadRun(claim), state);
  assert.equal(reads, 3);
  assert.equal(decoratedReads, 2);
});

test("a scoped authority failure retains its identity and prevents a following write", async () => {
  const error = new ApplicationError("conflict", "scope_closed");
  let writes = 0;
  const service = new RunExecutionService({
    store: {
      beginRunAttempt: async () => {
        writes++;
      },
    } as unknown as DomainStore,
    clock: { now: () => "2026-09-15T00:00:00Z" },
    ids: { nextId: (kind) => kind },
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
  });
  const scoped = service.withStoreAccess((store) => ({
    ...store,
    loadRun: async () => {
      throw error;
    },
  }));
  await assert.rejects(scoped.beginModelAttempt(claim), (e) => e === error);
  assert.equal(writes, 0);
});
