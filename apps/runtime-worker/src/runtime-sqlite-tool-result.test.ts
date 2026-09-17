import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

test("SQLite encoded tool result resumes after lost ACK with exact model continuation and one tool execution", async (context) => {
  const output = "persistent result line\n".repeat(800);
  const f = await createFixture(context, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    settlementFailure: "beforeAck",
    output,
  });
  const interrupted = await f.worker().wake();
  assert.equal(interrupted.kind, "retried", JSON.stringify(interrupted));
  assert.equal(f.executions(), 1);
  assert.equal(f.requests.length, 1);
  assert.equal(await f.encodedToolResultCount(), 1);
  const receipts = await f.receipts(),
    history = await f.history(),
    events = await f.events();
  assert.equal(receipts[0]!.result!.output, output);
  await f.reopen();
  await f.makeDue();
  const finished = await f.worker().wake();
  assert.equal(finished.kind, "completed", JSON.stringify(finished));
  assert.equal(f.executions(), 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.previous_response_id, "resp-tools");
  assert.deepEqual(f.requests[1]!.input, [
    { type: "function_call_output", call_id: "call-1", output },
  ]);
  const configuration = (r: Record<string, unknown>) => ({
    model: r.model,
    instructions: r.instructions,
    tools: r.tools,
  });
  assert.deepEqual(
    configuration(f.requests[1]!),
    configuration(f.requests[0]!),
  );
  assert.deepEqual(await f.receipts(), receipts);
  assert.deepEqual((await f.history()).slice(0, history.length), history);
  assert.deepEqual((await f.events()).slice(0, events.length), events);
  assert.equal(
    (await f.events()).filter((event) => event.type === "tool.completed")
      .length,
    1,
  );
});
