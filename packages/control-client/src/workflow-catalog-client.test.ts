import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
test("catalog SDK uses one authenticated bounded read, validates before transport and honors late cancellation", async () => {
  let calls = 0;
  let value: unknown = { data: [], nextCursor: null };
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://control.example/api/v1/workflow-catalog?limit=20",
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
  assert.deepEqual(
    await client.listWorkflowVersionCatalog({ cursor: null, limit: 20 }),
    value,
  );
  await assert.rejects(client.listWorkflowVersionCatalog({ limit: 21 }));
  assert.equal(calls, 1);
  value = { data: [], nextCursor: "fabricated" };
  await assert.rejects(
    client.listWorkflowVersionCatalog({ limit: 20 }),
    ControlApiProtocolError,
  );
  value = { pad: "x".repeat(1024 * 1024 + 1) };
  await assert.rejects(client.listWorkflowVersionCatalog({ limit: 20 }));
  assert.equal(calls, 3);
  const abort = new AbortController();
  const late = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    fetch: async () => {
      abort.abort();
      return Response.json({ data: [], nextCursor: null });
    },
  });
  await assert.rejects(
    late.listWorkflowVersionCatalog({}, { signal: abort.signal }),
  );
});
