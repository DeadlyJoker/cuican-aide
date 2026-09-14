import assert from "node:assert/strict";
import test from "node:test";
import { ToolResultCapacity } from "@crewon/tool-broker";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: real HTTP tool continuation sends only new results after a committed-sample crash`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (context) => {
      const normal = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
      });
      assert.equal((await normal.worker().wake()).kind, "completed");
      const recovered = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: true,
      });
      const stopped = await recovered.worker().wake();
      assert.equal(stopped.kind, "retried", JSON.stringify(stopped));
      assert.equal(recovered.requests.length, 1);
      assert.equal(recovered.executions(), 0);
      assert.equal(recovered.sampleCommits.length, 1);
      await recovered.reopen();
      assert.equal((await recovered.worker().wake()).kind, "completed");
      assert.equal(recovered.executions(), 1);
      assert.equal(recovered.requests.length, 2);
      assert.deepEqual(recovered.requests, normal.requests);
      assert.equal(recovered.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(recovered.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
      ]);
      const prefix = (request: Record<string, unknown>) => ({
        model: request.model,
        instructions: request.instructions,
        tools: request.tools,
      });
      assert.deepEqual(
        prefix(recovered.requests[0]!),
        prefix(recovered.requests[1]!),
      );
      assert.ok(
        Buffer.byteLength(JSON.stringify(recovered.requests[1])) <
          Buffer.byteLength(JSON.stringify(recovered.requests[0])) / 4,
      );
      const events = await recovered.events();
      assert.equal(
        events.filter((event) => event.type === "tool.requested").length,
        1,
      );
      assert.equal(
        events.filter((event) => event.type === "tool.completed").length,
        1,
      );
      assert.equal(
        events.filter((event) => event.type === "run.completed").length,
        1,
      );
      const beforeReopen = events;
      await recovered.reopen();
      assert.equal((await recovered.worker().wake()).kind, "idle");
      assert.deepEqual(await recovered.events(), beforeReopen);
    },
  );
}

for (const legacyStore of [false, true])
  test(`${legacyStore ? "Legacy Stores" : "Providers without stored responses"} retain full manual tool history`, async (context) => {
    const fixture = await createFixture(context, {
      backend: "sqlite",
      storeResponses: legacyStore,
      crashAfterCommit: false,
      legacyStore,
    });
    assert.equal((await fixture.worker().wake()).kind, "completed");
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[1]?.previous_response_id, undefined);
    assert.equal(fixture.sampleCommits.length, 0);
    const input = fixture.requests[1]?.input;
    assert.ok(Array.isArray(input));
    assert.equal(input[0].role, "user");
    assert.equal(input[1].role, "assistant");
    assert.equal(input[2].type, "function_call");
    assert.equal(input[3].type, "function_call_output");
    assert.equal(fixture.executions(), 1);
  });

test("a hung tool result keeps one Worker wake promise through 20,000 timer calls", async (context) => {
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
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    resultCapacity: capacity,
    holdResult: { entered, wait },
  });
  const running = fixture.worker().wake();
  await reached;
  for (let i = 0; i < 20_000; i += 1)
    assert.equal(fixture.worker().wake(), running);
  assert.equal(fixture.executions(), 1);
  assert.equal(fixture.requests.length, 1);
  assert.equal(capacity.resourceSnapshot().executionCount, 1);
  finish();
  assert.equal((await running).kind, "completed");
  assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
  assert.equal((await fixture.worker().wake()).kind, "idle");
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: expired tool checkpoint restores the persisted history after restart without repeating tools`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (context) => {
      const manual = await createFixture(context, {
        backend,
        storeResponses: true,
        legacyStore: true,
        crashAfterCommit: false,
      });
      assert.equal((await manual.worker().wake()).kind, "completed");
      const recovered = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: true,
        rejectPreviousResponse: true,
      });
      assert.equal((await recovered.worker().wake()).kind, "retried");
      assert.equal(recovered.executions(), 0);
      await recovered.reopen();
      assert.equal((await recovered.worker().wake()).kind, "completed");
      assert.equal(recovered.requests.length, 3);
      assert.equal(recovered.executions(), 1);
      assert.equal(recovered.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(recovered.requests[2], manual.requests[1]);
      const events = await recovered.events();
      const fallbacks = events.filter(
        (event) => event.type === "model.transport.fallback",
      );
      assert.equal(fallbacks.length, 1);
      assert.equal(
        fallbacks[0]?.data.code,
        "responses_previous_response_not_found",
      );
      for (const type of ["tool.requested", "tool.completed", "run.completed"])
        assert.equal(events.filter((event) => event.type === type).length, 1);
      await recovered.reopen();
      assert.equal((await recovered.worker().wake()).kind, "idle");
      assert.deepEqual(await recovered.events(), events);
      await recovered.nextUserTurn();
      assert.equal((await recovered.worker().wake()).kind, "completed");
      assert.equal(recovered.requests.length, 4);
      assert.equal(recovered.requests[3]?.previous_response_id, "resp-answer");
      assert.deepEqual(recovered.requests[3]?.input, [
        { role: "user", content: "next user turn" },
      ]);
      assert.equal(recovered.executions(), 1);
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  const testOptions = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };
  test(
    `${backend}: process result capacity waits before dispatch and preserves real HTTP incremental continuation`,
    testOptions,
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const first = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        resultCapacity: capacity,
        crashAfterResolved: true,
      });
      assert.equal((await first.worker().wake()).kind, "retried");
      assert.equal(first.executions(), 1);
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      const second = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        resultCapacity: capacity,
      });
      const blocked = await second.worker().wake();
      assert.equal(blocked.kind, "retried");
      assert.ok(
        "code" in blocked && blocked.code === "tool_result_capacity_exhausted",
      );
      const attempts = await second.toolAttempts();
      const events = await second.events();
      for (let i = 0; i < 100; i += 1) {
        await second.makeDue();
        assert.equal((await second.worker().wake()).kind, "retried");
      }
      assert.deepEqual(await second.toolAttempts(), attempts);
      assert.deepEqual(await second.events(), events);
      assert.deepEqual(
        (await second.receipts()).map((receipt) => receipt?.status),
        ["prepared"],
      );
      assert.equal(second.executions(), 0);
      assert.equal(second.requests.length, 1);
      await first.reopen();
      await first.makeDue();
      assert.equal((await first.worker().wake()).kind, "completed");
      assert.equal(first.executions(), 1);
      assert.equal(capacity.resourceSnapshot().executionCount, 0);
      await second.reopen();
      await second.makeDue();
      assert.equal((await second.worker().wake()).kind, "completed");
      assert.equal(second.executions(), 1);
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.deepEqual(second.requests, first.requests);
      assert.equal(second.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(second.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
      ]);
      assert.equal(
        (await second.events()).filter(
          (event) => event.type === "tool.completed",
        ).length,
        1,
      );
    },
  );

  for (const execution of ["serial", "parallel"] as const) {
    test(
      `${backend}: ${execution} tool batch makes progress with only one result slot`,
      testOptions,
      async (context) => {
        const normal = await createFixture(context, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          toolCount: 2,
          execution,
        });
        assert.equal((await normal.worker().wake()).kind, "completed");
        const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
        const limited = await createFixture(context, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          resultCapacity: capacity,
          toolCount: 2,
          execution,
        });
        assert.equal((await limited.worker().wake()).kind, "retried");
        assert.equal(limited.executions(), 1);
        assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
        assert.equal(limited.requests.length, 1);
        await limited.makeDue();
        await limited.reopen();
        assert.equal((await limited.worker().wake()).kind, "completed");
        assert.equal(limited.executions(), 2);
        assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
        assert.deepEqual(limited.requests, normal.requests);
        assert.equal(
          (await limited.events()).filter(
            (event) => event.type === "tool.completed",
          ).length,
          2,
        );
      },
    );
  }

  test(
    `${backend}: cancel remains available under full result capacity`,
    testOptions,
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const occupied = capacity.reserve(1);
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        resultCapacity: capacity,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      await fixture.cancel();
      await fixture.makeDue();
      assert.equal((await fixture.worker().wake()).kind, "canceled");
      assert.equal(fixture.executions(), 0);
      assert.equal(fixture.requests.length, 1);
      occupied.release();
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
    },
  );

  test(
    `${backend}: durably unknown mutation releases its memory fence and remains non-replayable after reopen`,
    testOptions,
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        resultCapacity: capacity,
        unknownOutcome: true,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(fixture.executions(), 1);
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.deepEqual(
        (await fixture.receipts()).map((receipt) => receipt?.status),
        ["unknownOutcome"],
      );
      await fixture.reopen();
      await fixture.makeDue();
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(fixture.executions(), 1);
      assert.equal(fixture.requests.length, 1);
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
    },
  );
}
