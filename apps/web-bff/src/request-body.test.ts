import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { DELIVERY_UPLOAD_BODY_BYTES } from "@crewon/domain/delivery-http-policy";
import {
  readFetchRequestBody,
  readIncomingBody,
  RequestBodyTooLargeError,
} from "./request-body.ts";
const path = "/api/v1/threads/thread_1/delivery/inputs";

test("BFF fetch reader accepts a complete 10 MiB CSV envelope and stops streaming immediately at the exact route limit", async () => {
  const csv = Buffer.alloc(10 * 1024 * 1024, "a");
  const body = JSON.stringify({
    name: "large.csv",
    role: "data",
    mediaType: "text/csv",
    contentBase64: csv.toString("base64"),
  });
  const request = new Request(`https://crewon.test${path}`, {
    method: "POST",
    body,
  });
  assert.equal(
    (await readFetchRequestBody(request))?.byteLength,
    Buffer.byteLength(body),
  );
  let produced = 0;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        produced++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const large = new Request(`https://crewon.test${path}`, {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(readFetchRequestBody(large), RequestBodyTooLargeError);
  assert.equal(canceled, true);
  assert.equal(
    produced,
    Math.floor(DELIVERY_UPLOAD_BODY_BYTES / (64 * 1024)) + 1,
  );
  for (const suffix of ["?x=1", "/"])
    await assert.rejects(
      readFetchRequestBody(
        new Request(`https://crewon.test${path}${suffix}`, {
          method: "POST",
          body: new Uint8Array(65537),
        }),
      ),
      RequestBodyTooLargeError,
    );
});

test("BFF HTTP listener applies the same upload budget and replies 413 for declared or chunked overflows", async (t) => {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncomingBody(incoming, "https://crewon.test");
      outgoing.writeHead(200);
      outgoing.end(String(body.byteLength));
    } catch (error) {
      incoming.resume();
      outgoing.writeHead(error instanceof RequestBodyTooLargeError ? 413 : 500);
      outgoing.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const content = Buffer.from(
    JSON.stringify({
      contentBase64: Buffer.alloc(10 * 1024 * 1024, "a").toString("base64"),
    }),
  );
  const upload = await fetch(origin + path, { method: "POST", body: content });
  assert.equal(upload.status, 200);
  assert.equal(await upload.text(), String(content.byteLength));
  assert.equal(
    (await fetch(origin + path + "?x=1", { method: "POST", body: content }))
      .status,
    413,
  );
  const oversized = new Uint8Array(DELIVERY_UPLOAD_BODY_BYTES + 1);
  assert.equal(
    (await fetch(origin + path, { method: "POST", body: oversized })).status,
    413,
  );
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65537));
      controller.close();
    },
  });
  assert.equal(
    (
      await fetch(origin + "/api/v1/threads/thread_1/turns", {
        method: "POST",
        body: chunked,
        duplex: "half",
      } as RequestInit)
    ).status,
    413,
  );
});
