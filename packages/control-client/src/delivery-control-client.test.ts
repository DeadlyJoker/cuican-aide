import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ControlApiClient } from "./control-api-client.ts";

const target = {
  schemaVersion: "crewon.delivery-target.v1",
  tenantId: "tenant-1",
  spaceId: "space-1",
  threadId: "thread-1",
  targetId: "thread-deliveries",
};
const bytes = new TextEncoder().encode("name,amount\n第四页,17\n");
const record = {
  inputId: "input-1",
  target,
  ownerActorId: "actor-1",
  name: "orders.csv",
  role: "data",
  mediaType: "text/csv",
  byteLength: bytes.length,
  contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  inspection: {
    sheets: [{ name: "CSV", rows: 2, columns: 2 }],
    formulaCount: 0,
  },
  createdAt: "2026-09-14T00:00:00.000Z",
};
const json = (value: unknown) => Response.json(value);

test("F01-R06 history accepts a bounded version array without relaxing catalog objects", async () => {
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => json([]),
  });
  assert.deepEqual(await client.delivery.history("thread-1", "delivery-1"), []);
  await assert.rejects(client.delivery.catalog("thread-1"));
});

test("F01-R01/R07 delivery upload preserves complete bytes and session/CSRF/idempotency", async () => {
  let request: RequestInit | undefined;
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf",
    accessToken: "token",
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        "https://control.example/api/v1/threads/thread-1/delivery/inputs",
      );
      request = init;
      return json(record);
    },
  });
  const uploaded = await client.delivery.upload(
    "thread-1",
    {
      name: record.name,
      role: "data",
      mediaType: "text/csv",
      contentBase64: Buffer.from(bytes).toString("base64"),
    },
    "upload-1",
  );
  assert.equal(uploaded.byteLength, bytes.length);
  assert.deepEqual(
    Buffer.from(JSON.parse(String(request?.body)).contentBase64, "base64"),
    Buffer.from(bytes),
  );
  assert.equal(request?.credentials, "include");
  assert.equal(new Headers(request?.headers).get("x-csrf-token"), "csrf");
  assert.equal(
    new Headers(request?.headers).get("authorization"),
    "Bearer token",
  );
  assert.equal(
    new Headers(request?.headers).get("idempotency-key"),
    "upload-1",
  );
});

test("F01-R07 catalog rejects another task and malformed metadata", async () => {
  for (const value of [
    { target: { ...target, threadId: "other" }, inputs: [], deliveries: [] },
    { target, inputs: [{ ...record, byteLength: -1 }], deliveries: [] },
    {
      target,
      inputs: [{ ...record, target: { ...target, spaceId: "other" } }],
      deliveries: [],
    },
    { target, inputs: [], deliveries: [], inferredFile: "reply.xlsx" },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.example/",
      fetch: async () => json(value),
    });
    await assert.rejects(client.delivery.catalog("thread-1"));
  }
});

test("F01-R01/R08 page validates sheet, cursor, and bounded response", async () => {
  const page = {
    sheet: "CSV",
    startRow: 2,
    rows: [["第四页", 17]],
    nextRow: null,
    totalRows: 2,
    totalColumns: 2,
  };
  for (const value of [
    { ...page, sheet: "other" },
    { ...page, nextRow: 1 },
    { ...page, rows: [["x".repeat(17 * 1024)]] },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.example/",
      fetch: async () => json(value),
    });
    await assert.rejects(
      client.delivery.page(
        "thread-1",
        { kind: "input", id: "input-1" },
        { sheet: "CSV", startRow: 2, limit: 50 },
      ),
    );
  }
});

test("F01-R04 downloads validate exact persisted digest and length", async () => {
  for (const content of [bytes, new TextEncoder().encode("wrong")]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.example/",
      fetch: async () =>
        new Response(content, { headers: { "content-type": "text/csv" } }),
    });
    // The public download method binds the expected digest and byte length from metadata.
    const promise = client.delivery.download(
      "thread-1",
      { kind: "input", id: "input-1" },
      {
        mediaType: "text/csv",
        byteLength: record.byteLength,
        contentDigest: record.contentDigest,
      },
    );
    if (content === bytes) assert.deepEqual(await promise, bytes);
    else await assert.rejects(promise);
  }
});
