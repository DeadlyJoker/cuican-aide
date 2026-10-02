import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import {
  ioFixture,
  command,
  deferred,
  policy,
  response,
  submission,
} from "./plugin-execution-io.test-support.ts";

test("SQLite IO owner requires actual private grant/checked identity; copied and late commands perform zero IO", async (t) => {
  const f = await ioFixture(t);
  const owner = f.owner();
  let checked!: ToolExecutionCommand;
  await assert.rejects(
    owner.withInvocation(
      {
        command: f.original,
        method: "execute",
        signal: new AbortController().signal,
      },
      async () => assert.fail("must not delegate"),
    ),
    /dispatch_authority_denied/,
  );
  await f.invoke(owner, async (value) => {
    checked = value;
    const copy = structuredClone(value);
    await assert.rejects(
      async () =>
        owner.services.externalOperations!.reserve({
          command: copy,
          operationId: f.operationId,
          request: submission,
        }),
      /invocation_invalid/,
    );
    await assert.rejects(
      async () =>
        owner.services.externalOperations!.load({
          command: copy,
          operationId: f.operationId,
        }),
      /invocation_invalid/,
    );
    await assert.rejects(
      async () =>
        owner.services.jsonHttp!.request({
          command: copy,
          operationId: f.operationId,
          method: "GET",
          path: "/queue",
        }),
      /invocation_invalid/,
    );
    await assert.rejects(
      async () =>
        owner.services.externalOperations!.reserve({
          command: value,
          operationId: "11111111-1111-1111-1111-111111111111",
          request: submission,
        }),
      /operation_id_mismatch/,
    );
  });
  await assert.rejects(
    async () =>
      owner.services.externalOperations!.load({
        command: checked,
        operationId: f.operationId,
      }),
    /invocation_invalid/,
  );
  assert.equal(f.controls.loads, 0);
  assert.equal(f.controls.reserves, 0);
  assert.equal(f.controls.advances, 0);
  assert.equal(f.controls.dns, 0);
  assert.equal(f.controls.sends, 0);
});

test("SQLite operation gets one exact POST token; payload drift and token reuse never dispatch", async (t) => {
  const f = await ioFixture(t);
  const owner = f.owner();
  await f.invoke(owner, async (checked) => {
    const saved = await owner.services.externalOperations!.reserve({
      command: checked,
      operationId: f.operationId,
      request: submission,
    });
    assert.equal(saved.disposition, "created");
    assert.ok(saved.dispatchRef);
    await assert.rejects(
      async () =>
        owner.services.externalOperations!.advance({
          command: checked,
          operationId: f.operationId,
          expectedRevision: 1,
          providerOperationId: "fabricated",
          status: "submitted",
          resultJson: null,
        }),
      /provider_evidence_missing/,
    );
    assert.equal(f.controls.advances, 0);
    await assert.rejects(
      async () =>
        owner.services.jsonHttp!.request({
          command: checked,
          operationId: f.operationId,
          dispatchRef: saved.dispatchRef!,
          ...submission,
          body: { prompt: "changed" },
        }),
      /dispatch_capability_invalid/,
    );
    assert.equal(f.controls.sends, 0);
    assert.equal(f.controls.dns, 0);
    assert.deepEqual(
      await owner.services.jsonHttp!.request({
        command: checked,
        operationId: f.operationId,
        dispatchRef: saved.dispatchRef!,
        ...submission,
      }),
      { prompt_id: "provider-1" },
    );
    await assert.rejects(
      async () =>
        owner.services.jsonHttp!.request({
          command: checked,
          operationId: f.operationId,
          dispatchRef: saved.dispatchRef!,
          ...submission,
        }),
      /dispatch_capability_invalid/,
    );
    const advanced = await owner.services.externalOperations!.advance({
      command: checked,
      operationId: f.operationId,
      expectedRevision: saved.operation.revision,
      providerOperationId: "provider-1",
      status: "submitted",
      resultJson: null,
    });
    assert.equal(advanced.disposition, "updated");
  });
  assert.equal(f.controls.sends, 1);
  assert.equal(f.controls.reserves, 1);
  assert.equal((await f.stored())?.providerOperationId, "provider-1");
});

test("SQLite reopen preserves an uncertain operation: existing evidence receives no POST token and can only observe", async (t) => {
  const f = await ioFixture(t);
  const first = f.owner();
  await f.invoke(first, async (checked) => {
    await first.services.externalOperations!.reserve({
      command: checked,
      operationId: f.operationId,
      request: submission,
    });
  });
  await first.close();
  await f.reopen();
  const recovered = f.owner();
  await f.invoke(
    recovered,
    async (checked) => {
      const saved = await recovered.services.externalOperations!.reserve({
        command: checked,
        operationId: f.operationId,
        request: submission,
      });
      assert.equal(saved.disposition, "existing");
      assert.equal(saved.dispatchRef, null);
      assert.equal(saved.operation.status, "submitting");
      await assert.rejects(
        async () =>
          recovered.services.jsonHttp!.request({
            command: checked,
            operationId: f.operationId,
            dispatchRef: "fabricated",
            ...submission,
          }),
        /dispatch_capability_invalid/,
      );
      await recovered.services.jsonHttp!.request({
        command: checked,
        operationId: f.operationId,
        method: "GET",
        path: `/history/${saved.operation.correlationId}`,
      });
    },
    { method: "reconcile" },
  );
  assert.equal(f.controls.reserves, 1);
  assert.equal(f.controls.sends, 1);
  assert.equal(f.controls.purposes.at(-1), "observe");
});

test("SQLite source query is limited to its exact saved operation and cannot reserve/POST a new submission", async (t) => {
  const f = await ioFixture(t);
  const original = f.owner();
  await f.invoke(original, async (checked) => {
    await original.services.externalOperations!.reserve({
      command: checked,
      operationId: f.operationId,
      request: submission,
    });
  });
  const query = command(
    {
      runId: "query-run",
      idempotencyKey: "query-key",
      executionId: "query-execution",
    },
    policy("readOnly", "replaySafe"),
  );
  const owner = f.owner({
    context: {
      ...f.context,
      run: {
        ...f.context.run,
        runId: query.runId,
        source: {
          runId: f.locator.runId,
          bindingDigest: f.locator.bindingDigest,
          operationId: f.operationId,
        },
      },
    },
  });
  await f.invoke(
    owner,
    async (checked) => {
      const saved = await owner.services.externalOperations!.load({
        command: checked,
        operationId: f.operationId,
      });
      assert.ok(saved);
      assert.equal(saved.runId, f.original.runId);
      const before = f.controls.loads;
      await assert.rejects(
        async () =>
          owner.services.externalOperations!.load({
            command: checked,
            operationId: "11111111-1111-1111-1111-111111111111",
          }),
        /operation_scope_mismatch/,
      );
      assert.equal(f.controls.loads, before);
      await assert.rejects(
        async () =>
          owner.services.externalOperations!.reserve({
            command: checked,
            operationId: f.operationId,
            request: submission,
          }),
        /submission_forbidden/,
      );
      await assert.rejects(
        async () =>
          owner.services.jsonHttp!.request({
            command: checked,
            operationId: f.operationId,
            ...submission,
            dispatchRef: "forged",
          }),
        /dispatch_capability_invalid/,
      );
      await assert.rejects(
        async () =>
          owner.services.jsonHttp!.request({
            command: checked,
            operationId: f.operationId,
            method: "GET",
            path: "/history/foreign-operation",
          }),
        /request_not_approved/,
      );
      await owner.services.jsonHttp!.request({
        command: checked,
        operationId: f.operationId,
        method: "GET",
        path: `/history/${saved.correlationId}`,
      });
    },
    { command: query },
  );
  assert.equal(f.controls.reserves, 1);
  assert.equal(f.controls.sends, 1);
});

for (const reason of ["revoke", "abort", "claim", "storeEcho"] as const)
  test(`SQLite ${reason} while DNS is pending denies actual dispatch and permanently consumes the POST token`, async (t) => {
    const f = await ioFixture(t);
    const entered = deferred();
    const dns = deferred<readonly { address: string; family: 4 }[]>();
    const controller = new AbortController();
    f.releaseOnCleanup(() => dns.resolve([{ address: "8.8.8.8", family: 4 }]));
    const owner = f.owner({
      dns: {
        resolveAll: async () => {
          f.controls.dns++;
          entered.resolve();
          return dns.promise;
        },
      },
    });
    await f.invoke(
      owner,
      async (checked) => {
        const saved = await owner.services.externalOperations!.reserve({
          command: checked,
          operationId: f.operationId,
          request: submission,
        });
        const pending = owner.services.jsonHttp!.request({
          command: checked,
          operationId: f.operationId,
          ...submission,
          dispatchRef: saved.dispatchRef!,
        });
        await entered.promise;
        if (reason === "revoke") f.controls.authorized = false;
        if (reason === "abort") controller.abort(new Error("fixture_abort"));
        if (reason === "claim")
          f.controls.claim = {
            ...f.controls.claim!,
            lease: { ...f.controls.claim!.lease, epoch: 2 },
          };
        if (reason === "storeEcho") f.controls.echo = { runId: "foreign-run" };
        dns.resolve([{ address: "8.8.8.8", family: 4 }]);
        await assert.rejects(
          pending,
          /(?:current_authority_revoked|fixture_abort|dispatch_authority_denied|operation_evidence_invalid)/,
        );
        f.controls.authorized = true;
        f.controls.echo = null;
        if (reason === "claim")
          f.controls.claim = {
            ...f.controls.claim!,
            lease: { ...f.controls.claim!.lease, epoch: 1 },
          };
        if (reason !== "abort")
          await assert.rejects(
            async () =>
              owner.services.jsonHttp!.request({
                command: checked,
                operationId: f.operationId,
                ...submission,
                dispatchRef: saved.dispatchRef!,
              }),
            /dispatch_capability_invalid/,
          );
        assert.equal(f.controls.sends, 0);
      },
      { controller },
    );
    assert.equal((await f.stored())?.status, "submitting");
  });

for (const reason of ["abort", "revoke", "claim"] as const)
  test(`SQLite accepted response survives late ${reason} for local provider-ID CAS, while new IO is withdrawn`, async (t) => {
    const f = await ioFixture(t);
    const controller = new AbortController();
    const owner = f.owner({
      transport: {
        request: async () => {
          f.controls.sends++;
          if (reason === "abort")
            controller.abort(new Error("fixture_late_abort"));
          if (reason === "revoke") f.controls.authorized = false;
          if (reason === "claim")
            f.controls.claim = {
              ...f.controls.claim!,
              lease: { ...f.controls.claim!.lease, epoch: 2 },
            };
          return response;
        },
      },
    });
    await f.invoke(
      owner,
      async (checked) => {
        const saved = await owner.services.externalOperations!.reserve({
          command: checked,
          operationId: f.operationId,
          request: submission,
        });
        await owner.services.jsonHttp!.request({
          command: checked,
          operationId: f.operationId,
          ...submission,
          dispatchRef: saved.dispatchRef!,
        });
        const changed = await owner.services.externalOperations!.advance({
          command: checked,
          operationId: f.operationId,
          expectedRevision: saved.operation.revision,
          providerOperationId: "provider-1",
          status: "submitted",
          resultJson: null,
        });
        assert.equal(changed.disposition, "updated");
        await assert.rejects(async () =>
          owner.services.externalOperations!.load({
            command: checked,
            operationId: f.operationId,
          }),
        );
        await assert.rejects(async () =>
          owner.services.jsonHttp!.request({
            command: checked,
            operationId: f.operationId,
            method: "GET",
            path: "/history/provider-1",
          }),
        );
      },
      { controller },
    );
    const stored = await f.stored();
    assert.equal(stored?.providerOperationId, "provider-1");
    assert.equal(stored?.status, "submitted");
    assert.equal(stored?.revision, 2);
    assert.equal(f.controls.sends, 1);
  });

test("SQLite close awaits active delegate, physical response and accepted-evidence CAS before retiring exact invocation", async (t) => {
  const f = await ioFixture(t);
  const sending = deferred();
  const physical = deferred<typeof response>();
  const advanceEntered = deferred();
  const commit = deferred();
  const delegateEntered = deferred();
  const delegateFinish = deferred();
  f.releaseOnCleanup(() => {
    physical.resolve(response);
    commit.resolve();
    delegateFinish.resolve();
  });
  f.controls.beforeAdvance = async () => {
    advanceEntered.resolve();
    await commit.promise;
  };
  const owner = f.owner({
    transport: {
      request: async () => {
        f.controls.sends++;
        sending.resolve();
        return physical.promise;
      },
    },
  });
  let late!: ToolExecutionCommand;
  const running = f.invoke(owner, async (checked) => {
    late = checked;
    const saved = await owner.services.externalOperations!.reserve({
      command: checked,
      operationId: f.operationId,
      request: submission,
    });
    await owner.services.jsonHttp!.request({
      command: checked,
      operationId: f.operationId,
      ...submission,
      dispatchRef: saved.dispatchRef!,
    });
    await owner.services.externalOperations!.advance({
      command: checked,
      operationId: f.operationId,
      expectedRevision: saved.operation.revision,
      providerOperationId: "provider-1",
      status: "submitted",
      resultJson: null,
    });
    delegateEntered.resolve();
    await delegateFinish.promise;
  });
  await sending.promise;
  assert.equal(owner.canRetire(), false);
  let closed = false;
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  physical.resolve(response);
  await advanceEntered.promise;
  assert.equal(closed, false);
  assert.equal((await f.stored())?.providerOperationId, null);
  commit.resolve();
  await delegateEntered.promise;
  assert.equal(closed, false);
  assert.equal((await f.stored())?.providerOperationId, "provider-1");
  delegateFinish.resolve();
  await running;
  await closing;
  assert.equal(closed, true);
  await assert.rejects(
    async () =>
      owner.services.externalOperations!.advance({
        command: late,
        operationId: f.operationId,
        expectedRevision: 2,
        providerOperationId: "provider-1",
        status: "submitted",
        resultJson: null,
      }),
    /invocation_invalid/,
  );
  await f.reopen();
  assert.equal((await f.stored())?.providerOperationId, "provider-1");
});

test("SQLite early-returning delegate still holds invocation and close through detached physical HTTP and acceptance CAS", async (t) => {
  const f = await ioFixture(t);
  const sending = deferred();
  const physical = deferred<typeof response>();
  const advancing = deferred();
  const commit = deferred();
  f.releaseOnCleanup(() => {
    physical.resolve(response);
    commit.resolve();
  });
  f.controls.beforeAdvance = async () => {
    advancing.resolve();
    await commit.promise;
  };
  const owner = f.owner({
    transport: {
      request: async () => {
        f.controls.sends++;
        sending.resolve();
        return physical.promise;
      },
    },
  });
  let detached: Promise<unknown> | undefined;
  const running = f.invoke(owner, async (checked) => {
    const saved = await owner.services.externalOperations!.reserve({
      command: checked,
      operationId: f.operationId,
      request: submission,
    });
    detached = owner.services
      .jsonHttp!.request({
        command: checked,
        operationId: f.operationId,
        ...submission,
        dispatchRef: saved.dispatchRef!,
      })
      .then(() =>
        owner.services.externalOperations!.advance({
          command: checked,
          operationId: f.operationId,
          expectedRevision: 1,
          providerOperationId: "provider-1",
          status: "submitted",
          resultJson: null,
        }),
      );
    // Deliberately return before owned IO; the owner must retain its checked-command capability.
  });
  await sending.promise;
  let closed = false,
    delegated = false;
  void running.then(() => {
    delegated = true;
  });
  const closing = owner.close();
  void closing.then(() => {
    closed = true;
  });
  physical.resolve(response);
  await advancing.promise;
  assert.equal(closed, false);
  assert.equal(delegated, false);
  assert.equal((await f.stored())?.providerOperationId, null);
  commit.resolve();
  await detached;
  await running;
  await closing;
  assert.equal(closed, true);
  assert.equal(delegated, true);
  assert.equal((await f.stored())?.providerOperationId, "provider-1");
});
