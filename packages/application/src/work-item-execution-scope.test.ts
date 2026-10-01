import assert from "node:assert/strict";
import test from "node:test";
import { copyWorkItemExecutionScope } from "./work-item-execution-scope.ts";
import { RunStoreError } from "./run-store-port.ts";

const scope = {
  tenantId: "tenant-1",
  extensionImplementationDigest: `sha256:${"a".repeat(64)}`,
  unboundRuns: "exclude" as const,
};
const target = {
  executionAuthority: "crewonKernel" as const,
  agentVersionId: "agent-1",
  agentVersionContentDigest: `sha256:${"b".repeat(64)}`,
  materializationDigest: `sha256:${"c".repeat(64)}`,
  authorityId: "authority-1",
  runtimeGeneration: "runtime-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
};
test("execution scheduling scope is copied, frozen and bounded without granting authority", () => {
  const input = { ...scope };
  const result = copyWorkItemExecutionScope(input);
  input.tenantId = "other";
  assert.equal(result.tenantId, "tenant-1");
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, scope);
  assert.equal(
    copyWorkItemExecutionScope({ ...scope, tenantId: "界".repeat(170) })
      .tenantId.length,
    170,
  );
});

test("prepared target scheduling selectors copy and freeze complete deployments while preserving an explicit empty set", () => {
  const mutableTarget = { ...target };
  const input = { ...scope, extensionTargets: [mutableTarget] };
  const result = copyWorkItemExecutionScope(input);
  mutableTarget.materializationDigest = `sha256:${"f".repeat(64)}`;
  input.extensionTargets.length = 0;
  assert.deepEqual(result.extensionTargets, [target]);
  assert.ok(Object.isFrozen(result.extensionTargets));
  assert.ok(Object.isFrozen(result.extensionTargets![0]));
  assert.deepEqual(
    copyWorkItemExecutionScope({ ...scope, extensionTargets: [] })
      .extensionTargets,
    [],
  );
  const targets = Array.from({ length: 32 }, (_, index) => ({
    ...target,
    agentVersionId: `agent-${index}`,
  }));
  assert.deepEqual(
    copyWorkItemExecutionScope({ ...scope, extensionTargets: targets })
      .extensionTargets,
    targets,
  );
});

test("prepared target scope rejects incomplete, duplicate, excessive or accessor-owned values", () => {
  let reads = 0;
  const accessor = Object.defineProperty({ ...target }, "agentVersionId", {
    enumerable: true,
    get() {
      reads++;
      return target.agentVersionId;
    },
  });
  const arrayAccessor = Object.defineProperty([target], "0", {
    enumerable: true,
    get() {
      reads++;
      return target;
    },
  });
  const scopeAccessor = Object.defineProperty(
    { ...scope },
    "extensionTargets",
    {
      enumerable: true,
      get() {
        reads++;
        return [target];
      },
    },
  );
  const missing = { ...target } as Record<string, unknown>;
  delete missing.workspaceBindingId;
  const duplicateReordered = Object.fromEntries(
    Object.entries(target).reverse(),
  );
  for (const extensionTargets of [
    undefined,
    null,
    {},
    "[]",
    new Array(1),
    arrayAccessor,
    Object.assign([target], { extra: true }),
    [target, duplicateReordered],
    Array.from({ length: 33 }, (_, index) => ({
      ...target,
      agentVersionId: `agent-${index}`,
    })),
    [accessor],
    [missing],
    [{ ...target, extra: true }],
    [{ ...target, executionAuthority: "providerAgent" }],
    [{ ...target, agentVersionContentDigest: "bad" }],
    [{ ...target, materializationDigest: "bad" }],
    [{ ...target, workspaceBindingId: undefined }],
    [{ ...target, agentVersionId: "" }],
  ])
    assert.throws(
      () => copyWorkItemExecutionScope({ ...scope, extensionTargets }),
      (error) =>
        error instanceof RunStoreError &&
        error.code === "queue_execution_scope_invalid",
    );
  assert.throws(
    () => copyWorkItemExecutionScope(scopeAccessor),
    (error) =>
      error instanceof RunStoreError &&
      error.code === "queue_execution_scope_invalid",
  );
  assert.equal(reads, 0);
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
