import assert from "node:assert/strict";
import { test } from "node:test";

import { ApplicationError } from "./application-error.ts";
import type { DomainStore } from "./domain-store-port.ts";
import { RunExecutionService } from "./run-execution-service.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";

test("rejects an invalid replacement approval expiry before Store access", async () => {
  let storeCalls = 0;
  const store = new Proxy(
    {},
    {
      get() {
        storeCalls += 1;
        throw new Error("Store must not be accessed");
      },
    },
  ) as DomainStore;
  const service = new RunExecutionService({
    store,
    clock: { now: () => "2026-08-11T00:00:00Z" },
    ids: { nextId: (kind) => `${kind}-1` },
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
  });

  for (const expiresAfterMs of [Number.NaN, -1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      service.replaceToolApproval(claim(), null as never, null as never, {
        expiresAfterMs,
        retryAfterMs: 1,
      }),
      (error) =>
        error instanceof ApplicationError &&
        error.category === "validation" &&
        error.code === "approval_expiry_invalid",
    );
  }
  assert.equal(storeCalls, 0);
});

function claim(): WorkItemClaim {
  return {
    workItem: {
      workItemId: "work-item-1",
      tenantId: "tenant-1",
      runId: "run-1",
      kind: "run.execute",
      payload: { throughSequence: 1 },
      createdAt: "2026-08-11T00:00:00Z",
    },
    lease: {
      ownerId: "worker-1",
      leaseId: "lease-1",
      epoch: 1,
      expiresAt: "2026-08-11T00:01:00Z",
    },
  };
}
