import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const storeResponses of [false, true]) {
  test(`SQLite canonical tool encoding preserves HTTP ${storeResponses ? "incremental" : "full-history"} input after lost ACK and reopen`, async (t) => {
    const output = "result 界🚀\n  exact whitespace\n".repeat(500);
    const normal = await createFixture(t, {
      backend: "sqlite",
      storeResponses,
      crashAfterCommit: false,
      output,
    });
    assert.equal((await normal.worker().wake()).kind, "completed");
    const recovered = await createFixture(t, {
      backend: "sqlite",
      storeResponses,
      crashAfterCommit: false,
      settlementFailure: "beforeAck",
      output,
    });
    assert.equal((await recovered.worker().wake()).kind, "retried");
    assert.equal(recovered.requests.length, 1);
    assert.equal(recovered.executions(), 1);
    assert.deepEqual(await recovered.canonicalToolOutputCounts(), {
      history: 1,
      events: 1,
    });
    const history = await recovered.history(),
      events = await recovered.events();
    await recovered.reopen();
    await recovered.makeDue();
    assert.equal((await recovered.worker().wake()).kind, "completed");
    assert.equal(recovered.executions(), 1);
    assert.deepEqual(recovered.requests, normal.requests);
    assert.deepEqual(recovered.requestBodyDigests, normal.requestBodyDigests);
    assert.deepEqual(
      (await recovered.history()).slice(0, history.length),
      history,
    );
    assert.deepEqual(
      (await recovered.events()).slice(0, events.length),
      events,
    );
    const input = recovered.requests[1]!.input as Record<string, unknown>[];
    assert.deepEqual(
      input.filter((item) => item.type === "function_call_output"),
      [{ type: "function_call_output", call_id: "call-1", output }],
    );
    assert.equal(
      recovered.requests[1]!.previous_response_id,
      storeResponses ? "resp-tools" : undefined,
    );
  });

  test(
    `encoded SQLite and plain PostgreSQL emit identical HTTP requests with storeResponses=${storeResponses}`,
    {
      skip: process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (t) => {
      const output = "same stable tool result 界\n".repeat(400);
      const plain = await createFixture(t, {
        backend: "postgres",
        storeResponses,
        crashAfterCommit: false,
        output,
      });
      const encoded = await createFixture(t, {
        backend: "sqlite",
        storeResponses,
        crashAfterCommit: false,
        output,
      });
      assert.equal((await plain.worker().wake()).kind, "completed");
      assert.equal((await encoded.worker().wake()).kind, "completed");
      assert.deepEqual(await plain.canonicalToolOutputCounts(), {
        history: 0,
        events: 0,
      });
      assert.deepEqual(await encoded.canonicalToolOutputCounts(), {
        history: 1,
        events: 1,
      });
      assert.deepEqual(encoded.requests, plain.requests);
      assert.deepEqual(encoded.requestBodyDigests, plain.requestBodyDigests);
      assert.deepEqual(await encoded.history(), await plain.history());
    },
  );
}
