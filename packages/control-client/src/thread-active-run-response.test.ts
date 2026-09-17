import assert from "node:assert/strict";
import test from "node:test";
import { MAX_THREAD_ACTIVE_RUN_RESPONSE_BYTES } from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const run = {
  runId: "run-1",
  threadId: "thread-1",
  status: "queued",
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
  terminalAt: null,
};
const response = {
  schemaVersion: "crewon.thread-active-run.v0",
  threadId: "thread-1",
  run,
};

test("active Run read forwards identity and cancellation and distinguishes absent from active", async () => {
  const controller = new AbortController();
  for (const body of [response, { ...response, run: null }]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.example",
      accessToken: "test-token",
      fetch: async (input, init) => {
        assert.equal(
          new URL(String(input)).pathname,
          "/api/v1/threads/thread-1/active-run",
        );
        assert.equal(init?.signal, controller.signal);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer test-token",
        );
        return Response.json(body);
      },
    });
    assert.deepEqual(
      await client.getThreadActiveRun("thread-1", {
        signal: controller.signal,
      }),
      body,
    );
  }
});
test("active Run read rejects invalid, terminal and cross-thread responses", async () => {
  for (const body of [
    null,
    { ...response, run: undefined },
    { ...response, threadId: "other" },
    { ...response, run: { ...run, threadId: "other" } },
    { ...response, extra: true },
    { ...response, run: { ...run, status: "unknown" } },
    {
      ...response,
      run: { ...run, status: "completed", terminalAt: run.updatedAt },
    },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.example",
      fetch: async () => Response.json(body),
    });
    await assert.rejects(
      client.getThreadActiveRun("thread-1"),
      body === null
        ? /control_api_response_invalid/
        : /control_client_active_run_invalid/,
    );
  }
});
test("active Run read cancels oversized response before parsing unbounded JSON", async () => {
  let canceled = false;
  let reads = 0;
  const chunk = new Uint8Array(256 * 1024).fill(32);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () =>
      new Response(stream, { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    client.getThreadActiveRun("thread-1"),
    ControlApiProtocolError,
  );
  assert.equal(canceled, true);
  assert.ok(
    reads <= MAX_THREAD_ACTIVE_RUN_RESPONSE_BYTES / chunk.byteLength + 2,
  );
});
