import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { workflowGateReviewFixture } from "../../contracts/src/workflow-human-gate-review.test-support.ts";
import {
  workflowReadLocator,
  workflowReadDigest,
} from "../../contracts/src/workflow-run-read.test-support.ts";
const body = {
  inputDigest: workflowReadDigest,
  decision: "approved" as const,
  comment: workflowGateReviewFixture().review!.comment,
};
test("SDK discovers explicit context independently and preserves opt-in in one non-retrying review request", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    csrfToken: "csrf",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json(
        String(url).includes("/capabilities/")
          ? { version: "v1", available: true }
          : {
              disposition: "committed",
              review: workflowGateReviewFixture().review,
            },
      );
    },
  });
  assert.deepEqual(await client.getWorkflowReviewContextCapability(), {
    version: "v1",
    available: true,
  });
  const command = { ...body, commentContext: "descendants-v1" as const };
  await client.reviewWorkflowHumanGate(workflowReadLocator, command);
  assert.ok(calls[0]!.url.endsWith("/capabilities/workflow-review-context-v1"));
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), command);
  assert.equal(calls.length, 2);
  await assert.rejects(
    client.reviewWorkflowHumanGate(workflowReadLocator, {
      ...body,
      commentContext: "all",
    } as any),
  );
  assert.equal(calls.length, 2);
});
test("review SDK reuses credentials, Origin, CSRF, limits and captured request without write retries or extra keys", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    csrfToken: "csrf",
    origin: "https://ui.example",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json(
        String(url).includes("/capabilities/")
          ? { version: "v1", available: true }
          : init!.method === "POST"
            ? {
                disposition: "committed",
                review: workflowGateReviewFixture().review,
              }
            : workflowGateReviewFixture(),
      );
    },
  });
  assert.deepEqual(await client.getWorkflowReviewCapability(), {
    version: "v1",
    available: true,
  });
  assert.deepEqual(
    await client.getWorkflowHumanGateReview(workflowReadLocator),
    workflowGateReviewFixture(),
  );
  assert.equal(
    (await client.reviewWorkflowHumanGate(workflowReadLocator, body)).review
      .comment,
    body.comment,
  );
  assert.ok(calls[0]!.url.endsWith("/capabilities/workflow-reviews-v1"));
  assert.ok(calls[1]!.url.endsWith("/gates/request-1/review-v1"));
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("origin"), "https://ui.example");
    assert.equal(headers.get("idempotency-key"), null);
    assert.equal(init.credentials, "include");
  }
  assert.equal(new Headers(calls[2]!.init.headers).get("x-csrf-token"), "csrf");
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), body);
});
test("review SDK refuses malformed, substituted, oversized and late canceled responses without fallback", async () => {
  let payload: unknown = {
      disposition: "committed",
      review: { ...workflowGateReviewFixture().review!, comment: "changed" },
    },
    calls = 0;
  const controller = new AbortController();
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    csrfToken: "csrf",
    fetch: async () => {
      calls++;
      return Response.json(payload);
    },
  });
  await assert.rejects(
    client.reviewWorkflowHumanGate(workflowReadLocator, body),
    ControlApiProtocolError,
  );
  payload = {
    ...workflowGateReviewFixture(),
    input: { pad: "x".repeat(131073) },
  };
  await assert.rejects(client.getWorkflowHumanGateReview(workflowReadLocator));
  payload = { version: "v1", available: "yes" };
  await assert.rejects(
    client.getWorkflowReviewCapability(),
    ControlApiProtocolError,
  );
  controller.abort();
  await assert.rejects(
    client.getWorkflowHumanGateReview(workflowReadLocator, {
      signal: controller.signal,
    }),
  );
  assert.equal(calls, 3);
  let late = 0;
  const abort = new AbortController();
  const lateClient = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    csrfToken: "csrf",
    fetch: async () => {
      late++;
      abort.abort();
      return Response.json({
        disposition: "committed",
        review: workflowGateReviewFixture().review,
      });
    },
  });
  await assert.rejects(
    lateClient.reviewWorkflowHumanGate(workflowReadLocator, body, {
      signal: abort.signal,
    }),
  );
  assert.equal(late, 1);
});
