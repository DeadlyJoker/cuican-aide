import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import test, { type TestContext } from "node:test";
import {
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  projectSourceUploadPartPath,
  type ProjectSourceUploadMutationResponse,
} from "@crewon/contracts/project-source-uploads";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const ref = "mount_" + "a".repeat(32);
const bytes = new Uint8Array([0, 255, 0, 7, 128, 13, 10, 65]);
const digest = (value: Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const locator = {
  uploadId: "作品 / 第一章",
  partIndex: 0,
  rawDigest: digest(bytes),
};
const expectedPath = projectSourceUploadPartPath(ref, locator);
const reply = (): ProjectSourceUploadMutationResponse => ({
  disposition: "committed",
  upload: {
    uploadId: locator.uploadId,
    revision: 2,
    phase: "receiving",
    fileName: "作品.txt",
    format: "txt",
    byteLength: bytes.length,
    fileDigest: digest(bytes),
    partBytes: 65_536,
    partCount: 1,
    receivedParts: [
      { index: 0, byteLength: bytes.length, rawDigest: locator.rawDigest },
    ],
    prepared: null,
    failureCode: null,
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Real loopback HTTP, native fetch and the original ControlApiClient authentication transport.
 * This fixture contains no Store, installation authority, parser, Run or browser cookie jar. */
async function fixture(
  t: TestContext,
  config: { csrfToken?: string | null; accessToken?: string | null } = {},
) {
  const requests: {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
    bytes: Uint8Array;
  }[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const replies: {
    contentLength: string | null;
    transferEncoding: string | null;
  }[] = [];
  const state = {
    response: reply() as unknown,
    status: 200,
    contentType: "application/json",
    headers: {} as Record<string, string>,
    encoded: null as string | null,
    beforeFetch: null as (() => void | Promise<void>) | null,
    beforeReply: null as (() => void | Promise<void>) | null,
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        method: request.method!,
        path: request.url!,
        headers: request.headers,
        bytes: new Uint8Array(Buffer.concat(chunks)),
      });
      await state.beforeReply?.();
      response.writeHead(state.status, {
        "content-type": state.contentType,
        ...state.headers,
      });
      response.end(state.encoded ?? JSON.stringify(state.response));
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new ControlApiClient({
    baseUrl: `http://127.0.0.1:${address.port}/existing-prefix`,
    accessToken:
      config.accessToken === undefined ? "actor-token" : config.accessToken,
    csrfToken: config.csrfToken === undefined ? "csrf-token" : config.csrfToken,
    origin: "https://ui.test",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      await state.beforeFetch?.();
      const response = await globalThis.fetch(url, init);
      replies.push({
        contentLength: response.headers.get("content-length"),
        transferEncoding: response.headers.get("transfer-encoding"),
      });
      return response;
    },
  });
  return {
    client,
    state,
    calls,
    requests,
    replies,
    write: (input = bytes, signal?: AbortSignal) =>
      client.plugins.writeSourceUploadPart(
        ref,
        locator,
        input,
        signal === undefined ? undefined : { signal },
      ),
  };
}

test("raw source part uses genuine HTTP PUT, canonical locator, original credentials and unencoded native bytes", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  assert.deepEqual(await f.write(bytes, controller.signal), reply());
  assert.equal(f.calls.length, 1);
  assert.equal(f.requests.length, 1);
  const actual = f.requests[0]!,
    call = f.calls[0]!;
  assert.equal(actual.method, "PUT");
  assert.equal(actual.path, expectedPath);
  assert.ok(expectedPath.includes("%E4%BD%9C%E5%93%81%20%2F%20"));
  assert.deepEqual(actual.bytes, bytes);
  assert.ok(call.init.body instanceof Uint8Array);
  assert.notEqual(call.init.body, bytes);
  assert.equal(typeof call.init.body, "object");
  assert.equal(call.init.credentials, "include");
  assert.equal(call.init.redirect, "manual");
  assert.equal(call.init.signal, controller.signal);
  assert.equal(actual.headers.authorization, "Bearer actor-token");
  assert.equal(actual.headers.origin, "https://ui.test");
  assert.equal(actual.headers["x-csrf-token"], "csrf-token");
  assert.equal(actual.headers["content-type"], "application/octet-stream");
  assert.equal(actual.headers.accept, "application/json");
  assert.equal(actual.headers["idempotency-key"], undefined);
  assert.equal(actual.headers["content-encoding"], undefined);
});

test("cookie-mode configuration retains credentials include without manufacturing bearer identity", async (t) => {
  const f = await fixture(t, { accessToken: null });
  await f.write();
  assert.equal(f.calls[0]!.init.credentials, "include");
  assert.equal(f.requests[0]!.headers.authorization, undefined);
  assert.equal(f.requests[0]!.headers.origin, "https://ui.test");
  assert.equal(f.requests[0]!.headers["x-csrf-token"], "csrf-token");
});

test("a complete 64KiB native part crosses HTTP unchanged while own typed-array getters remain unread", async (t) => {
  const f = await fixture(t),
    full = new Uint8Array(PROJECT_SOURCE_UPLOAD_PART_BYTES);
  for (let index = 0; index < full.length; index++) full[index] = index % 256;
  let reads = 0;
  Object.defineProperties(full, {
    byteLength: {
      get() {
        reads++;
        throw new Error("must_not_read");
      },
    },
    buffer: {
      get() {
        reads++;
        throw new Error("must_not_read");
      },
    },
  });
  const rawDigest = digest(full),
    request = { ...locator, rawDigest };
  const response = reply();
  f.state.response = {
    ...response,
    upload: {
      ...response.upload,
      byteLength: PROJECT_SOURCE_UPLOAD_PART_BYTES,
      fileDigest: rawDigest,
      receivedParts: [
        { index: 0, byteLength: PROJECT_SOURCE_UPLOAD_PART_BYTES, rawDigest },
      ],
    },
  };
  const result = await f.client.plugins.writeSourceUploadPart(
    ref,
    request,
    full,
  );
  assert.equal(
    result.upload.receivedParts[0]!.byteLength,
    PROJECT_SOURCE_UPLOAD_PART_BYTES,
  );
  assert.equal(f.requests[0]!.bytes.length, PROJECT_SOURCE_UPLOAD_PART_BYTES);
  assert.equal(digest(f.requests[0]!.bytes), rawDigest);
  assert.equal(reads, 0);
});

test("exact retransmission may return replayed acknowledgement without inferred task authority", async (t) => {
  const f = await fixture(t);
  f.state.response = { ...reply(), disposition: "replayed" };
  const result = await f.write();
  assert.equal(result.disposition, "replayed");
  assert.equal(Object.hasOwn(result, "owner"), false);
  assert.equal(Object.hasOwn(result, "task"), false);
});

test("native offset views are copied before the first await and locator snapshots cannot drift", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  const backing = new Uint8Array(bytes.length + 8);
  backing.set(bytes, 3);
  const view = backing.subarray(3, 3 + bytes.length),
    request = { ...locator };
  f.state.beforeFetch = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.client.plugins.writeSourceUploadPart(ref, request, view);
  await entered.promise;
  view.fill(0);
  request.uploadId = "changed";
  request.rawDigest = `sha256:${"a".repeat(64)}`;
  release.resolve();
  assert.deepEqual(await pending, reply());
  assert.deepEqual(f.requests[0]!.bytes, bytes);
  assert.equal(f.requests[0]!.path, expectedPath);
});

test("non-native, shared, proxy and invalid-length payloads reject without fetch or getters", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const hostile = Object.defineProperty({}, "byteLength", {
    enumerable: true,
    get() {
      reads++;
      return 8;
    },
  });
  const proxy = new Proxy(bytes, {
    get() {
      reads++;
      throw new Error("must_not_read");
    },
  });
  const detached = new Uint8Array(8);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const input of [
    new Uint8Array(0),
    new Uint8Array(PROJECT_SOURCE_UPLOAD_PART_BYTES + 1),
    new Uint16Array([1, 2]),
    new Uint8Array(new SharedArrayBuffer(8)),
    detached,
    proxy,
    hostile,
    Array.from(bytes),
    "AAECAw==",
    null,
  ])
    await assert.rejects(
      f.client.plugins.writeSourceUploadPart(ref, locator, input as Uint8Array),
      { code: "control_client_plugin_request_invalid" },
    );
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(reads, 0);
});

test("foreign locator/options fields and accessors cannot supply renderer authority or a signal", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const accessor = Object.defineProperty(
    { partIndex: 0, rawDigest: locator.rawDigest },
    "uploadId",
    {
      enumerable: true,
      get() {
        reads++;
        return locator.uploadId;
      },
    },
  );
  for (const input of [
    { ...locator, owner: "forged" },
    { ...locator, mountRef: ref },
    { ...locator, bytes: [] },
    accessor,
    { ...locator, partIndex: -1 },
    { ...locator, partIndex: 306 },
    { ...locator, rawDigest: `sha256:${"A".repeat(64)}` },
  ])
    await assert.rejects(
      f.client.plugins.writeSourceUploadPart(ref, input as never, bytes),
      { code: "control_client_plugin_request_invalid" },
    );
  const signalGetter = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      reads++;
      return new AbortController().signal;
    },
  });
  for (const options of [
    signalGetter,
    { signal: {} },
    { signal: new AbortController().signal, owner: "forged" },
  ])
    await assert.rejects(
      f.client.plugins.writeSourceUploadPart(
        ref,
        locator,
        bytes,
        options as never,
      ),
      { code: "control_client_plugin_request_invalid" },
    );
  await assert.rejects(
    f.client.plugins.writeSourceUploadPart("../other-mount", locator, bytes),
    { code: "control_client_plugin_request_invalid" },
  );
  assert.equal(f.calls.length, 0);
  assert.equal(reads, 0);
});

test("raw transport requires the existing CSRF token before network dispatch", async (t) => {
  const f = await fixture(t, { csrfToken: null });
  await assert.rejects(f.write(), {
    code: "control_client_csrf_token_required",
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 0);
});

test("foreign, altered and private acknowledgements cannot become trusted part receipts", async (t) => {
  const f = await fixture(t),
    original = reply();
  const changedPart = (value: object) => ({
    ...original,
    upload: {
      ...original.upload,
      receivedParts: [{ ...original.upload.receivedParts[0], ...value }],
    },
  });
  for (const response of [
    { ...original, upload: { ...original.upload, uploadId: "other-upload" } },
    changedPart({ rawDigest: `sha256:${"b".repeat(64)}` }),
    changedPart({ byteLength: bytes.length - 1 }),
    changedPart({ index: 1 }),
    { ...original, upload: { ...original.upload, receivedParts: [] } },
    { ...original, upload: { ...original.upload, owner: "private" } },
    { ...original, upload: { ...original.upload, revision: 1 } },
    {
      ...original,
      upload: { ...original.upload, prepared: { digest: locator.rawDigest } },
    },
    { ...original, disposition: "pending" },
    { ...original, state: "private" },
    {
      ...original,
      upload: {
        ...original.upload,
        receivedParts: [
          original.upload.receivedParts[0],
          original.upload.receivedParts[0],
        ],
      },
    },
    { upload: original.upload },
    { result: original },
  ]) {
    f.state.response = response;
    await assert.rejects(
      f.write(),
      (error: unknown) =>
        error instanceof ControlApiProtocolError &&
        error.code === "control_client_plugin_response_invalid",
    );
  }
});

test("unexpected media type, invalid JSON and null/array replies cannot yield an acknowledgement", async (t) => {
  const f = await fixture(t);
  f.state.contentType = "text/html";
  await assert.rejects(f.write(), { code: "control_api_content_type_invalid" });
  f.state.contentType = "application/json";
  f.state.encoded = "{broken";
  await assert.rejects(f.write(), { code: "control_api_json_invalid" });
  f.state.encoded = null;
  for (const response of [null, [], "ack"]) {
    f.state.response = response;
    await assert.rejects(f.write(), { code: "control_api_response_invalid" });
  }
});

test("both declared and streamed replies remain inside the independent 60KiB response budget", async (t) => {
  const f = await fixture(t);
  const oversized = "x".repeat(MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES + 1);
  f.state.headers = { "content-length": String(Buffer.byteLength(oversized)) };
  f.state.encoded = oversized;
  await assert.rejects(f.write(), {
    code: "control_client_workspace_response_too_large",
  });
  assert.equal(
    f.replies[0]!.contentLength,
    String(Buffer.byteLength(oversized)),
  );
  f.state.headers = {}; // node:http streams without a declared Content-Length.
  await assert.rejects(f.write(), {
    code: "control_client_workspace_response_too_large",
  });
  assert.equal(f.replies[1]!.contentLength, null);
  assert.equal(f.replies[1]!.transferEncoding, "chunked");
});

test("redirects are never followed and public Control errors retain their original identity", async (t) => {
  const f = await fixture(t);
  f.state.status = 302;
  f.state.headers = { location: "/redirected-credentials" };
  f.state.response = {};
  await assert.rejects(f.write(), {
    code: "control_api_error_envelope_invalid",
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls[0]!.init.redirect, "manual");
  f.state.status = 403;
  f.state.headers = {};
  f.state.response = {
    error: {
      category: "authorization",
      code: "source_write_denied",
      requestId: "request-raw",
    },
  };
  await assert.rejects(
    f.write(),
    (error: unknown) =>
      error instanceof ControlApiClientError &&
      error.status === 403 &&
      error.code === "source_write_denied" &&
      error.requestId === "request-raw",
  );
  f.state.status = 204;
  await assert.rejects(f.write());
});

test("native abort before fetch and during genuine pending HTTP never returns a stale acknowledgement", async (t) => {
  const f = await fixture(t),
    already = new AbortController();
  already.abort();
  await assert.rejects(f.write(bytes, already.signal), { name: "AbortError" });
  assert.equal(f.calls.length, 0);
  const entered = deferred(),
    release = deferred(),
    pendingController = new AbortController();
  f.state.beforeReply = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.write(bytes, pendingController.signal);
  await entered.promise;
  pendingController.abort();
  release.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.calls[0]!.init.signal, pendingController.signal);
});
