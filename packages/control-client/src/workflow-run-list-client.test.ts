import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { workflowRunReadFixture } from "../../contracts/src/workflow-run-read.test-support.ts";
test("root SDK uses one bounded authenticated read, validates before transport and refuses late cancellation or replaced roots", async () => {
  let calls = 0;
  let value: unknown = {
    data: [workflowRunReadFixture().run],
    nextCursor: null,
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    origin: "https://ui.example",
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://control.example/api/v1/workflow-runs?workflowVersionId=version-1&limit=20",
      );
      assert.equal(init!.method, "GET");
      assert.equal(init!.credentials, "include");
      assert.equal(
        new Headers(init!.headers).get("authorization"),
        "Bearer token",
      );
      return Response.json(value);
    },
  });
  assert.equal(
    (await client.listWorkflowRuns({ workflowVersionId: "version-1" })).data
      .length,
    1,
  );
  await assert.rejects(
    client.listWorkflowRuns({ workflowVersionId: "version-1", limit: 21 }),
  );
  assert.equal(calls, 1);
  value = {
    data: [
      {
        ...workflowRunReadFixture().run,
        purpose: "turn",
        workflowVersionBinding: null,
      },
    ],
    nextCursor: null,
  };
  await assert.rejects(
    client.listWorkflowRuns({ workflowVersionId: "version-1" }),
    ControlApiProtocolError,
  );
  value = { padding: "x".repeat(1024 * 1024 + 1) };
  await assert.rejects(
    client.listWorkflowRuns({ workflowVersionId: "version-1" }),
  );
  assert.equal(calls, 3);
  const controller = new AbortController();
  const late = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    fetch: async () => {
      controller.abort();
      return Response.json({ data: [], nextCursor: null });
    },
  });
  await assert.rejects(
    late.listWorkflowRuns(
      { workflowVersionId: "version-1" },
      { signal: controller.signal },
    ),
  );
});
