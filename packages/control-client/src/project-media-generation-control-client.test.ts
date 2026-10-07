import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
const command = {
  projectId: "项目/雨夜",
  mediaInputId: "input-1",
  inputRevision: 2,
  expectedInputRevision: 2,
  executionId: "execution-1",
  threadId: "thread-1",
  expectedThreadRevision: 4,
  idempotencyKey: "original-intent-key",
};
const accepted = {
  disposition: "committed",
  projectId: command.projectId,
  mediaInputId: command.mediaInputId,
  inputRevision: 2,
  executionId: command.executionId,
  threadId: command.threadId,
  threadRevision: 5,
  runId: "run-original",
};
function client(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "named-csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "named-session",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  });
}
test("generation client uses original auth, encoded route, CSRF and exact caller intent without automatic retry", async () => {
  let calls = 0;
  const c = client(async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      `https://control.test/api/v1/creative-projects/${encodeURIComponent(command.projectId)}/media-generations`,
    );
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer named-session");
    assert.equal(headers.get("x-csrf-token"), "named-csrf");
    assert.equal(headers.get("idempotency-key"), command.idempotencyKey);
    const { projectId: _, idempotencyKey: __, ...body } = command;
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return Response.json(accepted);
  });
  assert.equal(c.projectMediaGenerations, c.projectMediaGenerations);
  assert.deepEqual(await c.projectMediaGenerations.generate(command), accepted);
  assert.equal(calls, 1);
  let failures = 0;
  await assert.rejects(
    client(async () => {
      failures++;
      throw new Error("named-disconnect");
    }).projectMediaGenerations.generate(command),
  );
  assert.equal(failures, 1);
});
test("generation client rejects unbound response, extra authority, missing CSRF and aborted intent", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json(accepted);
  };
  await assert.rejects(
    client(fetch, null).projectMediaGenerations.generate(command),
    ControlApiProtocolError,
  );
  await assert.rejects(
    client(fetch).projectMediaGenerations.generate({
      ...command,
      providerUrl: "https://supplier.test",
    } as typeof command),
    ControlApiProtocolError,
  );
  await assert.rejects(
    client(fetch).projectMediaGenerations.generate(command, {
      signal: AbortSignal.abort(),
    }),
    ControlApiProtocolError,
  );
  assert.equal(calls, 0);
  for (const response of [
    { ...accepted, threadId: "foreign-thread" },
    { ...accepted, executionId: "foreign-intent" },
    { ...accepted, threadRevision: 4 },
    { ...accepted, providerUrl: "https://supplier.test" },
    { ...accepted, padding: "x".repeat(2048) },
  ])
    await assert.rejects(
      client(async () =>
        Response.json(response),
      ).projectMediaGenerations.generate(command),
      ControlApiProtocolError,
    );
});
