import assert from "node:assert/strict";
import test from "node:test";
import {
  RunApplicationService,
  ThreadApplicationService,
} from "@crewon/application";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const configured = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  for (const storeResponses of [false, true]) {
    test(
      `${backend}: bounded tool execution lets another Thread finish and resumes the exact model input after reopen, stored=${storeResponses}`,
      configured,
      async (t) => {
        let activeWatchers = 0;
        const f = await createFixture(t, {
          backend,
          storeResponses,
          crashAfterCommit: false,
          executionBudget: { maxBoundariesPerWake: 1 },
          cancellationScheduler: {
            every: () => {
              activeWatchers++;
              return () => {
                activeWatchers--;
              };
            },
          },
          observeQueueYield: () => assert.equal(activeWatchers, 0),
        });
        const sibling = await startSibling(f);
        const first = await f.worker().wake();
        assert.deepEqual(first, {
          kind: "retried",
          runId: (await f.run())!.runId,
          code: "run_execution_yield",
        });
        assert.equal(f.requests.length, 1);
        assert.equal(f.executions(), 1);
        assert.equal((await f.run())!.status, "running");
        const history = await f.history(),
          events = await f.events(),
          receipt = await f.receipts();
        assert.equal(receipt[0]!.status, "completed");
        f.advanceClock();
        await f.reopen();
        assert.deepEqual(await f.worker().wake(), {
          kind: "completed",
          runId: sibling,
        });
        assert.equal((await f.run())!.status, "running");
        assert.match(
          JSON.stringify(f.requests[1]!.input),
          /independent sibling/,
        );
        assert.equal((await f.worker().wake()).kind, "completed");
        assert.equal(f.requests.length, 3);
        assert.equal(f.executions(), 1);
        assert.deepEqual(await f.receipts(), receipt);
        assert.deepEqual((await f.history()).slice(0, history.length), history);
        assert.deepEqual((await f.events()).slice(0, events.length), events);
        const resumed = f.requests[2]!;
        for (const key of ["model", "instructions", "tools"])
          assert.deepEqual(resumed[key], f.requests[0]![key]);
        if (storeResponses) {
          assert.equal(resumed.previous_response_id, "resp-tools");
          assert.deepEqual(resumed.input, [
            {
              type: "function_call_output",
              call_id: "call-1",
              output: "tool-result",
            },
          ]);
        } else {
          const input = resumed.input as unknown[],
            original = f.requests[0]!.input as unknown[];
          assert.deepEqual(input.slice(0, original.length), original);
          assert.deepEqual(input.at(-1), {
            type: "function_call_output",
            call_id: "call-1",
            output: "tool-result",
          });
        }
        assert.equal(
          (await f.accountingReport()).total.usage.inputTokens,
          4096,
        );
        assert.equal(activeWatchers, 0);
      },
    );
  }

  for (const queueYieldFailure of ["beforeCommit", "afterCommit"] as const)
    test(
      `${backend}: ${queueYieldFailure} while yielding does not repeat an already committed tool`,
      configured,
      async (t) => {
        const f = await createFixture(t, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          executionBudget: { maxBoundariesPerWake: 1 },
          queueYieldFailure,
        });
        const interrupted = await f.worker().wake();
        assert.equal(
          interrupted.kind,
          queueYieldFailure === "beforeCommit" ? "retried" : "leaseLost",
          JSON.stringify(interrupted),
        );
        assert.equal(f.executions(), 1);
        assert.equal(f.requests.length, 1);
        const prefix = await f.history();
        await f.reopen();
        await f.makeDue();
        assert.equal((await f.worker().wake()).kind, "completed");
        assert.equal(f.executions(), 1);
        assert.equal(f.requests.length, 2);
        assert.deepEqual((await f.history()).slice(0, prefix.length), prefix);
        assert.equal(f.requests[1]!.previous_response_id, "resp-tools");
      },
    );

  test(
    `${backend}: cancellation during a scheduled yield ends the Run without another model call`,
    configured,
    async (t) => {
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        executionBudget: { maxBoundariesPerWake: 1 },
      });
      assert.equal((await f.worker().wake()).kind, "retried");
      await f.cancel();
      await f.reopen();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "canceled");
      assert.equal(f.requests.length, 1);
      assert.equal(f.executions(), 1);
    },
  );

  test(
    `${backend}: per-wake fairness never resets the persisted Run tool-round budget`,
    configured,
    async (t) => {
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        maxToolRounds: 3,
        executionBudget: { maxBoundariesPerWake: 1 },
        modelResponseEvents: roundResponse,
      });
      for (let round = 0; round < 3; round++) {
        const outcome = await f.worker().wake();
        assert.equal(outcome.kind, "retried", JSON.stringify(outcome));
        assert.equal("code" in outcome && outcome.code, "run_execution_yield");
        assert.equal(f.requests.length, round + 1);
        assert.equal(f.executions(), round + 1);
        await f.reopen();
        await f.makeDue();
      }
      const ended = await f.worker().wake();
      assert.equal(ended.kind, "failed");
      assert.equal(
        "code" in ended && ended.code,
        "model_tool_round_limit_exceeded",
      );
      assert.equal(f.requests.length, 3);
      assert.equal((await f.accountingReport()).total.usage.inputTokens, 300);
      assert.equal((await f.receipts()).length, 3);
    },
  );
}

async function startSibling(f: Awaited<ReturnType<typeof createFixture>>) {
  const { actor, route, ...deps } = f.fixtureScope,
    store = f.store();
  const threads = new ThreadApplicationService({ store, ...deps });
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "sibling-thread",
    title: null,
  });
  await threads.appendMessage(actor, {
    kind: "thread.message.append",
    threadId: thread.state.threadId,
    expectedRevision: thread.state.revision,
    idempotencyKey: "sibling-message",
    role: "user",
    content: "independent sibling",
  });
  const run = await new RunApplicationService({ store, ...deps }).createRun(
    actor,
    {
      kind: "run.create",
      threadId: thread.state.threadId,
      idempotencyKey: "sibling-run",
      route,
      toolPermissionMode: "fullAccess",
    },
  );
  return run.state.runId;
}

function roundResponse(n: number) {
  const item = {
    type: "function_call",
    call_id: `round-call-${n}`,
    name: "fixture_tool",
    arguments: "{}",
  };
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: `round-${n}` },
    },
    { type: "response.output_item.done", sequence_number: 1, item },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: `round-${n}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 2,
          total_tokens: 102,
        },
      },
    },
  ];
}
