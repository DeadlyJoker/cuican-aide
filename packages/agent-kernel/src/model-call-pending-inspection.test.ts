import assert from "node:assert/strict";
import test from "node:test";
import {
  beginModelCall,
  type ModelHttpPendingInspection,
} from "./model-call-observer.ts";
import type { ModelCallObservation } from "@crewon/domain";

async function fixture() {
  const records: ModelCallObservation[] = [];
  const call = await beginModelCall({
    options: {
      callSink: {
        purpose: "agent",
        record: async (value) => {
          records.push(value);
        },
      },
    },
    identity: {
      agentVersionId: "agent",
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "model",
    },
    transport: "http",
    operation: "generate",
    signal: new AbortController().signal,
  });
  return { call: call!, records };
}

test("a complete pending terminal-shaped JSON diagnosis preserves failure and never manufactures terminal authority", async () => {
  const { call, records } = await fixture();
  call.httpStreamPending(28_786);
  call.httpFailure({ reason: "idleTimeout", code: "responses_idle_timeout" });
  call.httpStreamPendingInspection({
    pendingJsonState: "complete-object",
    pendingEventType: "response.completed",
  });
  await call.finish("failed");
  const final = records.at(-1)!;
  assert.equal(final.outcome, "failed");
  assert.equal(
    final.httpDiagnostics?.termination?.code,
    "responses_idle_timeout",
  );
  assert.equal(
    final.httpDiagnostics?.stream?.pendingJsonState,
    "complete-object",
  );
  assert.equal(
    final.httpDiagnostics?.stream?.pendingEventType,
    "response.completed",
  );
  assert.equal(final.httpDiagnostics?.stream?.terminalEventCount, 0);
  assert.equal(final.httpDiagnostics?.stream?.pendingFrameBytes, 28_786);
  assert.equal(final.usageEventObserved, false);
  assert.equal(records.length, 2);
});

test("invalid or hostile optional inspection never replaces original failure or reads accessors", async () => {
  const { call, records } = await fixture();
  let reads = 0;
  const hostile = {
    pendingJsonState: "complete-object",
    get pendingEventType() {
      reads++;
      throw new Error("private text");
    },
  };
  for (const value of [
    hostile,
    { pendingJsonState: "secret" },
    { pendingJsonState: "no-data", pendingEventType: "response.completed" },
    { pendingJsonState: "complete-object", pendingEventType: "secret" },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile descriptor trap");
        },
      },
    ),
  ])
    assert.doesNotThrow(() =>
      call.httpStreamPendingInspection(value as ModelHttpPendingInspection),
    );
  call.httpFailure({
    reason: "protocolError",
    code: "responses_event_json_invalid",
  });
  await call.finish("failed");
  assert.equal(reads, 0);
  assert.equal(
    records.at(-1)?.httpDiagnostics?.stream?.pendingJsonState,
    undefined,
  );
  assert.equal(
    records.at(-1)?.httpDiagnostics?.termination?.code,
    "responses_event_json_invalid",
  );
});
