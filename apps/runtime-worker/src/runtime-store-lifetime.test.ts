import { waitForWorkerQueries } from "./runtime-background-query.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { DomainStore } from "@crewon/application";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import {
  deferred,
  storeAccessClock,
  until,
} from "./runtime-store-access.test-support.ts";

function blockedOperation(
  method: keyof DomainStore,
  phase: "before" | "after",
) {
  const entered = deferred();
  const held = deferred();
  const settled = deferred();
  let blocked = false;
  let calls = 0;
  return {
    entered: entered.promise,
    settled: settled.promise,
    release: () => held.resolve(),
    calls: () => calls,
    decorateStore: (store: DomainStore) =>
      new Proxy(store, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          if (key !== method) return value.bind(target);
          return async (...args: unknown[]) => {
            calls++;
            if (blocked) return Reflect.apply(value, target, args);
            blocked = true;
            try {
              if (phase === "before") {
                entered.resolve();
                await held.promise;
              }
              const result: unknown = await Reflect.apply(value, target, args);
              if (phase === "after") {
                entered.resolve();
                await held.promise;
              }
              return result;
            } finally {
              settled.resolve();
            }
          };
        },
      }),
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 30000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: a late Tool commit cannot write through a newer lease epoch`,
    options,
    async (t) => {
      const block = blockedOperation("commitToolExecutionCompletion", "before"),
        clock = storeAccessClock();
      t.after(block.release);
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        decorateStore: block.decorateStore,
        storeAccessTime: clock.time,
      });
      const wake = f.worker().wake();
      await block.entered;
      clock.advance(10000);
      assert.equal((await wake).kind, "leaseLost");
      const events = await f.events(),
        history = await f.history();
      await f.expireLease();
      const newer = await f.store().claimNextWorkItem({
        ownerId: "new-owner",
        leaseId: "new-lease",
        leaseDurationMs: 10000,
      });
      assert.ok(newer !== null);
      assert.ok(newer.lease.epoch > 1);
      block.release();
      await block.settled;
      await until(() => f.worker().storeAccessSnapshot().pendingRequests === 0);
      assert.equal(f.sampleCommits.length, 1);
      assert.equal(f.executions(), 1);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await f.events(), events);
      assert.deepEqual(await f.history(), history);
      await f.worker().close();
      await f.expireLease();
      await f.reopen();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.executions(), 1);
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(f.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
      ]);
    },
  );
  test(
    `${backend}: shutdown has one bounded wait when a completion callback ignores cancellation, and late return cannot execute`,
    options,
    async (t) => {
      const clock = storeAccessClock(),
        entered = deferred(),
        held = deferred();
      t.after(() => held.resolve());
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        storeAccessTime: clock.time,
        afterToolProviderResolved: async () => {
          entered.resolve();
          await held.promise;
        },
      });
      const wake = f.worker().wake();
      await entered.promise;
      const state = await f.run(),
        events = await f.events(),
        history = await f.history();
      const close = f.worker().close();
      for (let i = 0; i < 20000; i++) assert.equal(f.worker().close(), close);
      clock.advance(10000);
      await close;
      assert.equal(f.worker().storeAccessSnapshot().wakePending, true);
      assert.equal(f.worker().storeAccessSnapshot().closed, true);
      assert.equal((await f.worker().wake()).kind, "idle");
      held.resolve();
      assert.equal((await wake).kind, "leaseLost");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await f.run(), state);
      assert.deepEqual(await f.events(), events);
      assert.deepEqual(await f.history(), history);
      await f.expireLease();
      await f.reopen();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.executions(), 1);
    },
  );
  for (const phase of ["before", "after"] as const) {
    for (const method of ["claimNextWorkItem", "loadRun"] as const) {
      test(
        `${backend}: ${method} ${phase} acknowledgement timeout stops new work and closes without releasing physical ownership`,
        options,
        async (t) => {
          const block = blockedOperation(method, phase),
            clock = storeAccessClock();
          t.after(block.release);
          const f = await createFixture(t, {
            backend,
            storeResponses: true,
            crashAfterCommit: false,
            decorateStore: block.decorateStore,
            storeAccessTime: clock.time,
          });
          const before = {
            run: await f.run(),
            events: await f.events(),
            history: await f.history(),
          };
          const wake = f.worker().wake();
          await block.entered;
          clock.advance(10000);
          const result = await wake;
          assert.equal(
            result.kind,
            method === "claimNextWorkItem" ? "idle" : "leaseLost",
          );
          assert.equal(f.worker().storeAccessSnapshot().pendingRequests, 1);
          assert.equal(
            f.worker().storeAccessSnapshot().failureCode,
            "runtime_store_access_timeout",
          );
          const calls = block.calls(),
            claims = f.claimQueries();
          for (let i = 0; i < 20000; i++)
            assert.equal((await f.worker().wake()).kind, "idle");
          assert.equal(block.calls(), calls);
          assert.equal(f.claimQueries(), claims);
          assert.equal(f.requests.length, 0);
          assert.deepEqual(
            {
              run: await f.run(),
              events: await f.events(),
              history: await f.history(),
            },
            before,
          );
          await f.worker().close();
          assert.equal(f.worker().storeAccessSnapshot().pendingRequests, 1);
          assert.equal(clock.timers.size, 0);
          block.release();
          await block.settled;
          await until(
            () => f.worker().storeAccessSnapshot().pendingRequests === 0,
          );
          assert.equal(f.requests.length, 0);
          await f.expireLease();
          await f.reopen();
          assert.equal((await f.worker().wake()).kind, "completed");
          assert.equal(f.executions(), 1);
          assert.equal(f.requests.length, 2);
          assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
          assert.deepEqual(f.requests[1]?.input, [
            {
              type: "function_call_output",
              call_id: "call-1",
              output: "tool-result",
            },
          ]);
        },
      );
    }

    for (const method of [
      "commitToolSample",
      "commitToolExecutionCompletion",
      "commitTextRunCompletion",
      "commitLeasedRunTerminal",
    ] as const) {
      for (const storeResponses of method === "commitToolExecutionCompletion"
        ? [false, true]
        : [true])
        test(
          `${backend}: ${method} ${phase} acknowledgement survives timeout and resume without replaying a committed effect, stored=${storeResponses}`,
          options,
          async (t) => {
            const block = blockedOperation(method, phase),
              clock = storeAccessClock();
            t.after(block.release);
            const f = await createFixture(t, {
              backend,
              storeResponses,
              crashAfterCommit: false,
              decorateStore: block.decorateStore,
              storeAccessTime: clock.time,
            });
            if (method === "commitLeasedRunTerminal") await f.cancel();
            const initialHistory = await f.history();
            const wake = f.worker().wake();
            await block.entered;
            const requests = structuredClone(f.requests),
              calls = block.calls();
            await waitForWorkerQueries(f.worker(), { pendingRequests: 1 });
            clock.advance(10000);
            assert.equal((await wake).kind, "leaseLost");
            assert.equal(f.worker().storeAccessSnapshot().pendingRequests, 1);
            await f.worker().close();
            assert.equal(
              f.worker().watcherResourceSnapshot().confirmationListeners,
              0,
            );
            assert.equal(f.worker().storeAccessSnapshot().pendingRequests, 1);
            assert.deepEqual(f.requests, requests);
            assert.equal(block.calls(), calls);
            block.release();
            await block.settled;
            await until(
              () => f.worker().storeAccessSnapshot().pendingRequests === 0,
            );
            const committedHistory = await f.history(),
              committedEvents = await f.events();
            assert.deepEqual(
              committedHistory.slice(0, initialHistory.length),
              initialHistory,
            );
            await f.expireLease();
            await f.reopen();
            const resumed = await f.worker().wake();
            if (
              method === "commitToolSample" ||
              method === "commitToolExecutionCompletion"
            ) {
              assert.equal(resumed.kind, "completed");
              assert.equal(f.executions(), 1);
              assert.equal(f.requests.length, 2);
              if (storeResponses) {
                assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
                assert.deepEqual(f.requests[1]?.input, [
                  {
                    type: "function_call_output",
                    call_id: "call-1",
                    output: "tool-result",
                  },
                ]);
              } else {
                assert.equal(f.requests[1]?.previous_response_id, undefined);
                const original = f.requests[0]?.input as unknown[];
                const input = f.requests[1]?.input as unknown[];
                assert.deepEqual(input.slice(0, original.length), original);
                assert.deepEqual(input.at(-1), {
                  type: "function_call_output",
                  call_id: "call-1",
                  output: "tool-result",
                });
              }
              for (const field of ["model", "tools", "instructions"])
                assert.deepEqual(
                  f.requests[1]?.[field],
                  f.requests[0]?.[field],
                );
              assert.deepEqual(
                (await f.history()).slice(0, committedHistory.length),
                committedHistory,
              );
              assert.deepEqual(
                (await f.events()).slice(0, committedEvents.length),
                committedEvents,
              );
            } else {
              assert.ok(
                resumed.kind === "idle" ||
                  resumed.kind === "completed" ||
                  resumed.kind === "canceled",
                JSON.stringify(resumed),
              );
              assert.equal(
                (await f.run())?.status,
                method === "commitTextRunCompletion" ? "completed" : "canceled",
              );
              assert.deepEqual(await f.history(), committedHistory);
              assert.deepEqual(await f.events(), committedEvents);
              assert.deepEqual(f.requests, requests);
              assert.equal(
                f.executions(),
                method === "commitTextRunCompletion" ? 1 : 0,
              );
            }
          },
        );
    }
  }

  test(
    `${backend}: close interrupts a pending queue claim immediately and its late claim cannot launch a model`,
    options,
    async (t) => {
      const block = blockedOperation("claimNextWorkItem", "after");
      t.after(block.release);
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        decorateStore: block.decorateStore,
      });
      const wake = f.worker().wake();
      await block.entered;
      await f.worker().close();
      assert.equal((await wake).kind, "idle");
      assert.equal(f.worker().storeAccessSnapshot().pendingRequests, 1);
      block.release();
      await block.settled;
      await until(() => f.worker().storeAccessSnapshot().pendingRequests === 0);
      assert.equal(f.requests.length, 0);
      assert.equal((await f.run())?.status, "queued");
      await f.expireLease();
      await f.reopen();
      assert.equal((await f.worker().wake()).kind, "completed");
    },
  );
}
