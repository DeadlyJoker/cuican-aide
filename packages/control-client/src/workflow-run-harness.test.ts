import assert from "node:assert/strict";
import test from "node:test";

import { ControlApiClient } from "./control-api-client.ts";
import { startWorkflowRunAndWaitForTerminal } from "./workflow-run-harness.ts";

test("drives Workflow start, terminal SSE, and canonical Run read through Control", async () => {
  const binding = {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  };
  const started = run({ status: "queued", lastSequence: 1, binding });
  const terminal = run({ status: "completed", lastSequence: 2, binding });
  const requests: Array<{ url: string; method: string }> = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, method: init.method ?? "GET" });
      if (url.endsWith("/api/v1/workflow-runs")) {
        return jsonResponse(201, { disposition: "committed", run: started });
      }
      if (url.includes("/events?view=audit")) {
        return new Response(
          `id: 2\nevent: run.completed\ndata: ${JSON.stringify({
            eventId: "event-2",
            runId: started.runId,
            sequence: 2,
            occurredAt: "2026-08-12T01:00:00.000Z",
            type: "run.completed",
            data: { outputRef: "value:output-1" },
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return jsonResponse(200, { run: terminal });
    },
  });

  const result = await startWorkflowRunAndWaitForTerminal(client, {
    request: {
      workflowVersionId: binding.workflowVersionId,
      threadId: "thread-1",
      input: { prompt: "ship" },
    },
    idempotencyKey: "workflow-start-1",
  });

  assert.deepEqual(result, {
    started,
    terminalEvent: {
      eventId: "event-2",
      runId: started.runId,
      sequence: 2,
      occurredAt: "2026-08-12T01:00:00.000Z",
      type: "run.completed",
      data: { outputRef: "value:output-1" },
    },
    terminal,
  });
  assert.deepEqual(requests, [
    { url: "https://control.example/api/v1/workflow-runs", method: "POST" },
    {
      url: "https://control.example/api/v1/runs/run-1/events?view=audit",
      method: "GET",
    },
    { url: "https://control.example/api/v1/runs/run-1", method: "GET" },
  ]);
});

function run(input: {
  status: "queued" | "completed";
  lastSequence: number;
  binding: {
    workflowId: string;
    workflowVersionId: string;
    contentDigest: string;
  };
}) {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: input.status,
    revision: input.lastSequence,
    lastSequence: input.lastSequence,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: null,
    purpose: "workflow" as const,
    workflowVersionBinding: input.binding,
    goalBinding: null,
    outputRef: input.status === "completed" ? "value:output-1" : null,
    failure: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T01:00:00.000Z",
    terminalAt:
      input.status === "completed" ? "2026-08-12T01:00:00.000Z" : null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
