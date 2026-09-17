import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ToolResultCapacity } from "@crewon/tool-broker";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };
  for (const failure of [
    undefined,
    "beforeCommit",
    "afterCommit",
    "beforeAck",
  ] as const) {
    test(
      `${backend}: cancellation settles retained effects across ${failure ?? "normal commit"} without changing the model prefix`,
      options,
      async (context) => {
        const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
        const output = "x".repeat(256 * 1024);
        const fixture = await createFixture(context, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          crashAfterResolved: true,
          resultCapacity: capacity,
          settlementFailure: failure,
          output,
        });
        assert.equal((await fixture.worker().wake()).kind, "retried");
        assert.equal(fixture.executions(), 1);
        assert.equal(capacity.resourceSnapshot().executionCount, 1);
        const prefix = await fixture.history();
        await fixture.cancel();
        await fixture.reopen();
        if (failure !== undefined) {
          const stopped = await fixture.worker().wake();
          assert.equal(stopped.kind, "retried", JSON.stringify(stopped));
          assert.equal((await fixture.run())?.status, "running");
          assert.equal(capacity.resourceSnapshot().executionCount, 1);
          assert.equal(
            (await fixture.receipts())[0]?.status,
            failure === "beforeCommit" ? "dispatched" : "completed",
          );
          assert.deepEqual(await fixture.history(), prefix);
          await fixture.reopen();
        }
        const result = await fixture.worker().wake();
        assert.equal(result.kind, "canceled", JSON.stringify(result));
        assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
        assert.equal(capacity.resourceSnapshot().executionCount, 0);
        assert.equal(fixture.executions(), 1);
        assert.equal(fixture.requests.length, 1);
        const receipt = (await fixture.receipts())[0];
        assert.equal(receipt?.status, "completed");
        assert.deepEqual(receipt?.result, {
          output,
          outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
          isError: false,
          artifactRef: null,
        });
        const events = await fixture.events();
        assert.equal(
          events.filter((event) => event.type === "tool.completed").length,
          0,
        );
        assert.equal(
          events.filter((event) => event.type === "run.canceled").length,
          1,
        );
        const history = await fixture.history();
        assert.deepEqual(history.slice(0, prefix.length), prefix);
        const aborted = history.filter((item) => item.type === "tool_result");
        assert.equal(aborted.length, 1);
        assert.equal(aborted[0]?.status, "aborted");
        await fixture.reopen();
        assert.equal((await fixture.worker().wake()).kind, "idle");
        assert.deepEqual(await fixture.history(), history);
        await fixture.nextUserTurn();
        assert.equal((await fixture.worker().wake()).kind, "completed");
        assert.equal(fixture.executions(), 1);
        assert.equal(fixture.requests.length, 2);
        for (const key of ["model", "instructions", "tools"])
          assert.deepEqual(
            fixture.requests[1]?.[key],
            fixture.requests[0]?.[key],
          );
        assert.ok(!JSON.stringify(fixture.requests[1]).includes(output));
      },
    );
  }

  test(
    `${backend}: cancellation drains all completed parallel tools before retiring the claim`,
    { ...options, timeout: 30000 },
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 15 });
      let resolved = 0,
        crashBatch = true,
        allResolved!: () => void;
      const completedBatch = new Promise<void>((resolve) => {
        allResolved = resolve;
      });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        afterToolProviderResolved: async () => {
          if (!crashBatch) return;
          if (++resolved === 15) allResolved();
          await completedBatch;
          // All effects must exist before the simulated crash, with none committed yet.
          throw new Error("crash_after_parallel_results");
        },
        toolCount: 15,
        execution: "parallel",
        resultCapacity: capacity,
      });
      const stopped = await fixture.worker().wake();
      crashBatch = false;
      assert.equal(stopped.kind, "retried", JSON.stringify(stopped));
      assert.equal(resolved, 15, JSON.stringify(stopped));
      assert.equal(fixture.executions(), 15, JSON.stringify(stopped));
      assert.equal(capacity.resourceSnapshot().executionCount, 15);
      await fixture.cancel();
      await fixture.reopen();
      const outcome = await fixture.worker().wake();
      assert.equal(outcome.kind, "canceled", JSON.stringify(outcome));
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(
        (await fixture.receipts()).filter(
          (receipt) => receipt?.status === "completed",
        ).length,
        15,
      );
      assert.equal(
        (await fixture.history()).filter(
          (item) => item.type === "tool_result" && item.status === "aborted",
        ).length,
        15,
      );
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.executions(), 15);
    },
  );

  test(
    `${backend}: unknown mutation observed before cancel is persisted and reconciled without replay`,
    options,
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        crashAfterResolved: true,
        unknownOutcome: true,
        resultCapacity: capacity,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal((await fixture.receipts())[0]?.status, "dispatched");
      await fixture.cancel();
      await fixture.reopen();
      const outcome = await fixture.worker().wake();
      assert.equal(outcome.kind, "retried", JSON.stringify(outcome));
      assert.equal((await fixture.run())?.status, "reconciling");
      assert.equal((await fixture.run())?.cancelRequested, true);
      assert.equal((await fixture.receipts())[0]?.status, "unknownOutcome");
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      await fixture.reopen();
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(fixture.executions(), 1);
      assert.equal(fixture.requests.length, 1);
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "run.canceled",
        ).length,
        0,
      );
    },
  );

  test(
    `${backend}: cancel while the resolved result is awaiting commit keeps evidence and releases ownership`,
    options,
    async (context) => {
      let entered!: () => void;
      let finish!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      context.after(() => finish());
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        resultCapacity: capacity,
        holdResult: { entered, wait },
      });
      const running = fixture.worker().wake();
      await reached;
      await fixture.cancel();
      finish();
      const result = await running;
      assert.equal(result.kind, "canceled", JSON.stringify(result));
      assert.equal((await fixture.receipts())[0]?.status, "completed");
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(fixture.executions(), 1);
      assert.equal(fixture.requests.length, 1);
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "tool.completed",
        ).length,
        0,
      );
    },
  );

  test(
    `${backend}: a known completion survives an unknown receipt and settles a pending cancellation`,
    options,
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        crashAfterResolved: true,
        unknownReconciliationOnce: true,
        resultCapacity: capacity,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      await fixture.reopen();
      const uncertain = await fixture.worker().wake();
      assert.equal(uncertain.kind, "retried", JSON.stringify(uncertain));
      assert.equal((await fixture.run())?.status, "reconciling");
      assert.equal((await fixture.receipts())[0]?.status, "unknownOutcome");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      await fixture.cancel();
      await fixture.reopen();
      const canceled = await fixture.worker().wake();
      assert.equal(canceled.kind, "canceled", JSON.stringify(canceled));
      assert.equal((await fixture.receipts())[0]?.status, "completed");
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(fixture.executions(), 1);
      assert.equal(fixture.requests.length, 1);
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "tool.completed",
        ).length,
        0,
      );
      assert.equal(
        (await fixture.history()).filter(
          (item) => item.type === "tool_result" && item.status === "aborted",
        ).length,
        1,
      );
    },
  );

  test(
    `${backend}: an interrupted unknown-result ACK repairs without a second cancellation attempt`,
    options,
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        crashAfterResolved: true,
        unknownOutcome: true,
        settlementFailure: "beforeAck",
        resultCapacity: capacity,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      await fixture.cancel();
      await fixture.reopen();
      const interrupted = await fixture.worker().wake();
      assert.equal(interrupted.kind, "retried", JSON.stringify(interrupted));
      assert.equal((await fixture.run())?.status, "reconciling");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      await fixture.reopen();
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(fixture.executions(), 1);
      assert.equal(fixture.requests.length, 1);
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "run.canceled",
        ).length,
        0,
      );
    },
  );
}
