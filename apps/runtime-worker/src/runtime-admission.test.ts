import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  AgentRuntimeCapacity,
  AgentRuntimeCapacityError,
} from "./agent-runtime-capacity.ts";
import { capacityHttpFixture } from "./runtime-admission.test-support.ts";
import { retirementFixture } from "./idle-agent-runtime-retirement.test-support.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const testOptions = {
    timeout: 30000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  for (const stored of [false, true])
    test(
      `${backend}: capacity waits and retained recovery add no model calls and preserve HTTP prefixes, stored=${stored}`,
      testOptions,
      async (t) => {
        const normalHeaders: unknown[] = [];
        const normal = await createFixture(t, {
          backend,
          storeResponses: stored,
          crashAfterCommit: false,
          modelResponseHeaders: {
            "x-codex-turn-state": "stable-admission-state",
          },
          observeModelHeaders: ({ headers }) =>
            normalHeaders.push(headers["x-codex-turn-state"]),
        });
        assert.equal((await normal.worker().wake()).kind, "completed");
        await normal.nextUserTurn();
        await normal.reopen();
        assert.equal((await normal.worker().wake()).kind, "completed");
        const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
        const blocker = await retirementFixture({ count: 1, capacity });
        let held = await blocker.acquire(0);
        t.after(async () => {
          held.release();
          await blocker.close();
        });
        const f = await capacityHttpFixture(t, {
          backend,
          stored,
          capacity,
          crashAfterResolved: true,
        });
        const originalEvents = await f.events();
        let runId = (await f.run())!.runId;
        const expectCapacity = async () => {
          const result = await f.worker().wake();
          assert.equal(result.kind, "retried");
          assert.equal(
            "code" in result ? result.code : undefined,
            "agent_runtime_capacity_exhausted",
          );
          await f.makeDue({ runId });
        };
        await expectCapacity();
        assert.deepEqual(await f.events(), originalEvents);
        assert.equal(f.requests.length, 0);
        assert.equal(f.executions(), 0);
        assert.equal(f.counts().created, 0);
        held.release();
        await expectCapacity();
        await nextTurn();
        assert.equal((await f.worker().wake()).kind, "retried");
        assert.equal(f.executions(), 1);
        const original = f.registry.peekResident(f.locator);
        assert.ok(original);
        await assert.rejects(blocker.acquire(0), AgentRuntimeCapacityError);
        assert.equal(f.registry.peekResident(f.locator), original);
        assert.equal(f.counts().closed, 0);
        await f.reopen();
        assert.equal((await f.worker().wake()).kind, "completed");
        assert.equal(f.executions(), 1);
        assert.equal(f.counts().created, 1);
        await assert.rejects(blocker.acquire(0), AgentRuntimeCapacityError);
        await nextTurn();
        held = await blocker.acquire(0);
        assert.equal(f.counts().closed, 1);
        runId = (await f.nextUserTurn()).state.runId;
        await f.reopen();
        await expectCapacity();
        assert.equal(f.requests.length, 2);
        held.release();
        await expectCapacity();
        await nextTurn();
        assert.equal((await f.worker().wake()).kind, "completed");
        assert.equal(f.counts().created, 2);
        assert.equal(f.executions(), 1);
        assert.deepEqual(f.requests, normal.requests);
        assert.deepEqual(f.headers, normalHeaders);
        assert.equal(f.requests.length, 3);
        assert.ok(f.retryDelays.includes(5000));
        assert.equal(capacity.snapshot().creating, 0);
      },
    );

  test(
    `${backend}: started cancellation waits for runtime capacity without repeating the model or tool`,
    testOptions,
    async (t) => {
      const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
      const blocker = await retirementFixture({ count: 1, capacity });
      const f = await capacityHttpFixture(t, {
        backend,
        stored: true,
        capacity,
        crashAfterCommit: true,
      });
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.equal((await f.run())!.status, "running");
      assert.equal(f.executions(), 0);
      await assert.rejects(blocker.acquire(0), AgentRuntimeCapacityError);
      await nextTurn();
      const held = await blocker.acquire(0);
      t.after(async () => {
        held.release();
        await blocker.close();
      });
      await f.cancel();
      await f.makeDue();
      const pending = await f.worker().wake();
      assert.equal(pending.kind, "retried");
      assert.equal(
        "code" in pending ? pending.code : undefined,
        "agent_runtime_capacity_exhausted",
      );
      assert.equal(f.retryDelays.at(-1), 5000);
      assert.equal((await f.run())!.cancelRequested, true);
      assert.equal((await f.run())!.status, "running");
      held.release();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "retried");
      await nextTurn();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "canceled");
      assert.equal(f.requests.length, 1);
      assert.equal(f.executions(), 0);
      assert.equal((await f.run())!.status, "canceled");
    },
  );

  test(
    `${backend}: canceling an unstarted Run completes while runtime capacity is held elsewhere`,
    testOptions,
    async (t) => {
      const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
      const blocker = await retirementFixture({ count: 1, capacity });
      const held = await blocker.acquire(0);
      t.after(async () => {
        held.release();
        await blocker.close();
      });
      const f = await capacityHttpFixture(t, {
        backend,
        stored: true,
        capacity,
      });
      await f.cancel();
      assert.equal((await f.worker().wake()).kind, "canceled");
      assert.equal((await f.run())!.status, "canceled");
      assert.equal(f.counts().created, 0);
      assert.equal(f.executions(), 0);
      assert.equal(f.requests.length, 0);
      assert.equal(blocker.closed.length, 0);
    },
  );
}
