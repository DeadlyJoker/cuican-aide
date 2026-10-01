import assert from "node:assert/strict";
import test from "node:test";
import type { QueueClaimInput } from "@crewon/application";
import { RuntimeWorkItemClaims } from "./runtime-work-item-claims.ts";

const lease = { ownerId: "worker", leaseId: "lease", leaseDurationMs: 1000 };
const scope = {
  tenantId: "tenant",
  extensionImplementationDigest: `sha256:${"a".repeat(64)}`,
  unboundRuns: "exclude" as const,
};

test("ordinary Worker claims preserve the original queue request shape", async () => {
  const requests: QueueClaimInput[] = [];
  const claims = new RuntimeWorkItemClaims({
    store: {
      claimNextWorkItem: async (input) => {
        requests.push(input);
        return null;
      },
    },
  });
  assert.equal(await claims.claim(lease), null);
  assert.deepEqual(requests, [lease]);
  assert.equal(Object.hasOwn(requests[0]!, "executionScope"), false);
});

test("a Worker copies its scheduling affinity once and callers cannot broaden a later claim", async () => {
  const requests: QueueClaimInput[] = [];
  const mutable = { ...scope };
  const claims = new RuntimeWorkItemClaims({
    store: {
      claimNextWorkItem: async (input) => {
        requests.push(input);
        return null;
      },
    },
    executionScope: mutable,
  });
  mutable.tenantId = "foreign";
  mutable.extensionImplementationDigest = `sha256:${"b".repeat(64)}`;
  await claims.claim({
    ...lease,
    executionScope: { ...scope, unboundRuns: "include" },
  });
  assert.deepEqual(requests[0]?.executionScope, scope);
  assert.ok(Object.isFrozen(requests[0]?.executionScope));
});

test("invalid scheduling affinity cannot contact or mutate the queue", () => {
  let claims = 0;
  const accessor = Object.defineProperty({ ...scope }, "tenantId", {
    enumerable: true,
    get() {
      throw new Error("accessor must not run");
    },
  });
  for (const input of [
    { ...scope, tenantId: "" },
    { ...scope, unboundRuns: "all" },
    { ...scope, extensionImplementationDigest: "unverified" },
    { ...scope, arbitrary: "ignored" },
    accessor,
  ]) {
    assert.throws(
      () =>
        new RuntimeWorkItemClaims({
          store: {
            claimNextWorkItem: async () => {
              claims += 1;
              return null;
            },
          },
          executionScope: input as typeof scope,
        }),
      /queue_execution_scope_invalid/u,
    );
  }
  assert.equal(claims, 0);
});
