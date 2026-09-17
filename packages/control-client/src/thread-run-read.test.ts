import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "./control-api-client.ts";

const run = {
  runId: "run-1",
  threadId: "thread-1",
  status: "completed",
  revision: 1,
  lastSequence: 1,
  cancelRequested: false,
  waitingApproval: null,
  collaborationMode: "default",
  purpose: "turn",
  workflowVersionBinding: null,
  goalBinding: null,
  outputRef: null,
  failure: null,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  terminalAt: "2026-09-11T00:00:00Z",
};

test("Thread-scoped Run reads use one authenticated request and reject an unrelated Run", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const client = new ControlApiClient({
    baseUrl: "http://fixture.invalid",
    accessToken: "fixture-token",
    fetch: async (url, options) => {
      calls++;
      assert.equal(String(url), "http://fixture.invalid/api/v1/runs/run-1");
      assert.equal(options?.signal, signal);
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        "Bearer fixture-token",
      );
      return Response.json({ run });
    },
  });
  assert.deepEqual(
    await client.getRunInThread("thread-1", "run-1", { signal }),
    { run },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.getRunInThread("thread-other", "run-1", { signal }),
    /control_client_thread_run_invalid/,
  );
});

test("Run reads cancel an oversized body before JSON parsing", async () => {
  let canceled = false;
  const client = new ControlApiClient({
    baseUrl: "http://fixture.invalid",
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(700_000));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    client.getRunInThread("thread-1", "run-1"),
    /response_too_large/,
  );
  assert.equal(canceled, true);
});
