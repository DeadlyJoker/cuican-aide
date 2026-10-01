import assert from "node:assert/strict";
import test from "node:test";
import { copyWorkItemExecutionScope } from "./work-item-execution-scope.ts";
import { RunStoreError } from "./run-store-port.ts";

const scope = {
  tenantId: "tenant-1",
  extensionImplementationDigest: `sha256:${"a".repeat(64)}`,
  unboundRuns: "exclude" as const,
};
test("execution scheduling scope is copied, frozen and bounded without granting authority", () => {
  const input = { ...scope };
  const result = copyWorkItemExecutionScope(input);
  input.tenantId = "other";
  assert.equal(result.tenantId, "tenant-1");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    copyWorkItemExecutionScope({ ...scope, tenantId: "界".repeat(170) })
      .tenantId.length,
    170,
  );
});
test("execution scheduling scope rejects ambiguous fields and never invokes accessors", () => {
  let reads = 0;
  const getter = Object.defineProperty({ ...scope }, "tenantId", {
    enumerable: true,
    get() {
      reads += 1;
      return "tenant-1";
    },
  });
  for (const input of [
    null,
    [],
    "scope",
    { ...scope, extra: true },
    { ...scope, [Symbol("extra")]: true },
    { ...scope, tenantId: " " },
    { ...scope, tenantId: " x" },
    { ...scope, tenantId: "界".repeat(171) },
    { ...scope, tenantId: "x\u0000" },
    { ...scope, extensionImplementationDigest: "sha256:bad" },
    { ...scope, extensionImplementationDigest: `sha256:${"A".repeat(64)}` },
    { ...scope, unboundRuns: "all" },
    Object.create(scope),
    getter,
  ]) {
    assert.throws(
      () => copyWorkItemExecutionScope(input),
      (error) =>
        error instanceof RunStoreError &&
        error.code === "queue_execution_scope_invalid",
    );
  }
  assert.equal(reads, 0);
});
