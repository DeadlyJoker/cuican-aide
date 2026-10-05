import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItemClaim } from "@crewon/application";
import {
  dispatchToolExecutionReceipt,
  prepareToolExecutionReceipt,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import {
  assertWorkerToolDispatch,
  assertWorkerToolDispatchEvidence,
  assertWorkerToolDispatchIdentity,
  withWorkerToolDispatch,
} from "./plugins/worker-tool-dispatch-authority.ts";
import {
  adapt,
  command,
  deferred,
  policy,
  rawRuntime,
  result,
} from "./plugin-tool-runtime-adapter.test-support.ts";

function fixture(value = command()) {
  const prepared = prepareToolExecutionReceipt({
    receiptId: "receipt-1",
    tenantId: "tenant-1",
    runId: value.runId,
    stepId: value.executionLease.stepId,
    attemptId: value.executionLease.attemptId,
    workItemId: value.executionLease.workItemId,
    executionId: value.executionId,
    idempotencyKey: value.idempotencyKey,
    actionDigest: value.actionDigest,
    actionIntent: value.actionIntent,
    call: {
      segmentId: value.segmentId,
      callId: value.callId,
      kind: value.kind,
      name: value.name,
      inputDigest: value.actionIntent.tool.inputDigest,
    },
    effect: value.actionIntent.effect,
    recovery: value.actionIntent.recovery,
    preparedAt: "2026-10-03T00:00:00.000Z",
  });
  const receipt = dispatchToolExecutionReceipt(
    prepared,
    "2026-10-03T00:00:01.000Z",
  );
  let current: WorkItemClaim = {
    workItem: {
      workItemId: value.executionLease.workItemId,
      tenantId: "tenant-1",
      runId: value.runId,
      kind: "run.execute",
      payload: {},
      createdAt: prepared.preparedAt,
    },
    lease: {
      ownerId: "worker-1",
      leaseId: value.executionLease.leaseId,
      epoch: value.executionLease.leaseEpoch,
      expiresAt: value.executionLease.expiresAt,
    },
  };
  const signal = new AbortController();
  const invocation = {
    command: value,
    method: "execute" as const,
    signal: signal.signal,
  };
  return {
    prepared,
    receipt,
    signal,
    invocation,
    setCurrent: (claim: WorkItemClaim) => {
      current = claim;
    },
    current: () => current,
    grant: <T>(
      delegate: () => Promise<T>,
      method = invocation.method as "execute" | "reconcile" | "cancel",
      saved: ToolExecutionReceiptState = receipt,
    ) =>
      withWorkerToolDispatch(
        {
          ...invocation,
          method,
          receipt: saved,
          assertCurrent: () => current,
        },
        delegate,
      ),
  };
}

test("valid command/lease DTO and capacity preflight never authorize plugin I/O", async () => {
  let called = 0,
    released = 0,
    callback = 0;
  const f = fixture();
  const runtime = adapt(
    rawRuntime({
      reserveExecution: (checked, signal) => {
        assert.throws(
          () =>
            assertWorkerToolDispatch({
              command: checked,
              signal,
              method: "execute",
            }),
          /dispatch_authority_denied/,
        );
        return {
          release: () => {
            released++;
          },
          execute: async () => {
            called++;
            return result(checked);
          },
        };
      },
      execute: async (checked) => {
        called++;
        return result(checked);
      },
    }),
    {
      dispatchAuthority: async (_, delegate) => {
        callback++;
        return delegate();
      },
    },
  );
  await assert.rejects(
    runtime.execute(f.invocation.command, f.invocation.signal),
    /dispatch_authority_denied/,
  );
  const reserved = runtime.reserveExecution!(
    f.invocation.command,
    f.invocation.signal,
  )!;
  await assert.rejects(reserved.execute(), /dispatch_authority_denied/);
  assert.equal(called, 0);
  assert.equal(callback, 0);
  assert.equal(released, 1);
  await assert.rejects(
    f.grant(async () => {}, "execute", f.prepared),
    /dispatch_authority_denied/,
  );
});

test("checked command shares a live real grant until physical callback drain; copies and late references fail", async () => {
  const f = fixture();
  const physical = deferred();
  const entered = deferred();
  let checked: ToolExecutionCommand | undefined;
  const runtime = adapt(
    rawRuntime({
      execute: async (value, signal) => {
        checked = value;
        assert.equal(
          assertWorkerToolDispatch({
            command: value,
            method: "execute",
            signal,
          }).receiptId,
          f.receipt.receiptId,
        );
        assert.throws(
          () =>
            assertWorkerToolDispatch({
              command: structuredClone(value),
              method: "execute",
              signal,
            }),
          /dispatch_authority_denied/,
        );
        return result(value);
      },
    }),
    {
      dispatchAuthority: async (input, delegate) => {
        const resolved = await delegate();
        entered.resolve();
        await physical.promise;
        assertWorkerToolDispatch(input);
        return resolved;
      },
    },
  );
  const running = f.grant(() =>
    runtime.execute(f.invocation.command, f.invocation.signal),
  );
  await entered.promise;
  assert.ok(checked);
  assert.notEqual(checked, f.invocation.command);
  assertWorkerToolDispatch({ ...f.invocation, command: checked });
  physical.resolve();
  await running;
  assert.throws(
    () => assertWorkerToolDispatch({ ...f.invocation, command: checked! }),
    /dispatch_authority_denied/,
  );
  assert.throws(
    () => assertWorkerToolDispatch(f.invocation),
    /dispatch_authority_denied/,
  );
});

test("lease/abort revocation blocks new I/O while accepted evidence retains only live identity", async () => {
  const f = fixture();
  await f.grant(async () => {
    assertWorkerToolDispatch(f.invocation);
    f.setCurrent({ ...f.current(), lease: { ...f.current().lease, epoch: 2 } });
    assert.throws(
      () => assertWorkerToolDispatch(f.invocation),
      /dispatch_authority_denied/,
    );
    assert.equal(
      assertWorkerToolDispatchIdentity(f.invocation).executionId,
      f.receipt.executionId,
    );
    f.signal.abort(new Error("lease_revoked"));
    assert.throws(
      () => assertWorkerToolDispatch(f.invocation),
      /lease_revoked/,
    );
    assertWorkerToolDispatchIdentity(f.invocation);
    assert.throws(
      () =>
        assertWorkerToolDispatchIdentity({
          ...f.invocation,
          signal: new AbortController().signal,
        }),
      /dispatch_authority_denied/,
    );
    assert.throws(
      () =>
        assertWorkerToolDispatchIdentity({ ...f.invocation, method: "cancel" }),
      /dispatch_authority_denied/,
    );
  });
  assert.throws(
    () => assertWorkerToolDispatchIdentity(f.invocation),
    /dispatch_authority_denied/,
  );
});

test("receipt identity and claim scope mismatches cannot issue a dispatch grant", async () => {
  for (const change of [
    { tenantId: "other" },
    { runId: "other" },
    { workItemId: "other" },
    { executionId: "other" },
    { actionDigest: `sha256:${"f".repeat(64)}` },
    { status: "completed" as const },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.grant(async () => {}, "execute", { ...f.receipt, ...change }),
      /dispatch_authority_denied/,
    );
  }
  const f = fixture();
  f.setCurrent({
    ...f.current(),
    lease: { ...f.current().lease, leaseId: "other" },
  });
  await assert.rejects(
    f.grant(async () => {}),
    /dispatch_authority_denied/,
  );
});

test("changing a granted command to an accessor revokes identity without executing its hook", async () => {
  const f = fixture();
  let getters = 0;
  await f.grant(async () => {
    Object.defineProperty(f.invocation.command, "input", {
      enumerable: true,
      get() {
        getters++;
        return "{}";
      },
    });
    assert.throws(
      () => assertWorkerToolDispatchIdentity(f.invocation),
      /dispatch_authority_denied/,
    );
    assert.equal(getters, 0);
  });
});

test("real readOnly replaySafe reconciliation may use a reserved execute; mutation cannot borrow this exception", async () => {
  const f = fixture();
  const runtime = adapt(
    rawRuntime({
      reserveExecution: (value) => ({
        execute: async () => result(value),
        release() {},
      }),
    }),
    {
      dispatchAuthority: async (input, delegate) => {
        assertWorkerToolDispatch(input);
        return delegate();
      },
    },
  );
  const reserved = runtime.reserveExecution!(
    f.invocation.command,
    f.invocation.signal,
  )!;
  await f.grant(() => reserved.execute(), "reconcile");
  const mutation = fixture(command({}, policy("mutation", "reconcilable")));
  await mutation.grant(async () => {
    assert.throws(
      () =>
        assertWorkerToolDispatch({ ...mutation.invocation, method: "execute" }),
      /dispatch_authority_denied/,
    );
    assertWorkerToolDispatch({ ...mutation.invocation, method: "reconcile" });
  }, "reconcile");
});

test("an async host callback cannot start the plugin after authority or adapter close", async () => {
  for (const reason of ["lease", "close"] as const) {
    const f = fixture();
    const waiting = deferred();
    const entered = deferred();
    let calls = 0;
    const runtime = adapt(
      rawRuntime({
        execute: async (value) => {
          calls++;
          return result(value);
        },
        close: async () => {},
      }),
      {
        dispatchAuthority: async (_, delegate) => {
          entered.resolve();
          await waiting.promise;
          return delegate();
        },
      },
    );
    const running = f.grant(() =>
      runtime.execute(f.invocation.command, f.invocation.signal),
    );
    await entered.promise;
    const closing = reason === "close" ? runtime.close!() : undefined;
    if (reason === "lease")
      f.setCurrent({
        ...f.current(),
        lease: { ...f.current().lease, epoch: 2 },
      });
    waiting.resolve();
    await assert.rejects(
      running,
      reason === "lease" ? /dispatch_authority_denied/ : /runtime_closed/,
    );
    await closing;
    assert.equal(calls, 0);
  }
});

test("host evidence comes only from exact live issuer and refreshes the actual lease", async () => {
  const f = fixture();
  assert.throws(
    () => assertWorkerToolDispatchEvidence(f.invocation),
    /dispatch_authority_denied/,
  );
  await f.grant(async () => {
    const evidence = assertWorkerToolDispatchEvidence(f.invocation);
    assert.equal(evidence.receipt, f.receipt);
    assert.equal(evidence.claim, f.current());
    assert.throws(
      () =>
        assertWorkerToolDispatchEvidence({
          ...f.invocation,
          command: structuredClone(f.invocation.command),
        }),
      /dispatch_authority_denied/,
    );
    f.setCurrent({ ...f.current(), lease: { ...f.current().lease, epoch: 2 } });
    assert.throws(
      () => assertWorkerToolDispatchEvidence(f.invocation),
      /dispatch_authority_denied/,
    );
  });
  assert.throws(
    () => assertWorkerToolDispatchEvidence(f.invocation),
    /dispatch_authority_denied/,
  );
});
