import assert from "node:assert/strict";
import test from "node:test";
import { childWorker } from "./workflow-child-worker.test-support.ts";
import { compositionFixture } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { requestWorkflowCancel } from "../../../packages/store/src/workflow-cancellation.test-support.ts";

for (const cancelRequested of [false, true])
  for (const queueFailure of ["none", "beforeCommit", "afterCommit"] as const)
    test(`Worker without a workflow scheduler preserves the root authority and yields, cancel=${cancelRequested}, queue=${queueFailure}`, async (t) => {
      const f = await compositionFixture(t, { nowEpochMs: Date.now() });
      if (cancelRequested)
        await requestWorkflowCancel(
          f.store,
          f.input,
          f.clock.nowEpochMilliseconds(),
        );
      await f.store.retryWorkItem({
        ...f.input.lease,
        retryAfterMs: 0,
        reasonCode: "fixture_root_ready",
      });
      const before = await f.store.loadRun(f.input),
        events = await f.store.listRunEvents(f.input, 0, 100);
      let calls = 0;
      let fail = queueFailure !== "none";
      const { worker } = childWorker(
        {
          ...f,
          open: () => {
            const store = f.open();
            return new Proxy(store, {
              get(target, key) {
                if (key === "retryWorkItem")
                  return async (
                    input: Parameters<typeof store.retryWorkItem>[0],
                  ) => {
                    if (
                      !fail ||
                      input.reasonCode !== "workflow_scheduler_unavailable"
                    )
                      return target.retryWorkItem(input);
                    fail = false;
                    if (queueFailure === "afterCommit")
                      await target.retryWorkItem(input);
                    throw new Error("fixture_workflow_queue_write_failed");
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        },
        t,
        {
          adapterName: "unsupported-root",
          adapterVersion: "1",
          modelId: "fixture",
          async *stream() {
            calls++;
            throw new Error("workflow root must not sample");
          },
        },
      );
      assert.deepEqual(await worker.wake(), {
        kind: "retried",
        runId: f.input.runId,
        code:
          queueFailure === "none"
            ? "workflow_scheduler_unavailable"
            : "workflow_scheduler_requeue_failed",
      });
      if (queueFailure !== "none") {
        f.clock.advance(30001);
        assert.deepEqual(await worker.wake(), {
          kind: "retried",
          runId: f.input.runId,
          code: "workflow_scheduler_unavailable",
        });
      }
      assert.deepEqual(await f.store.loadRun(f.input), before);
      assert.deepEqual(await f.store.listRunEvents(f.input, 0, 100), events);
      assert.equal(calls, 0);
    });
