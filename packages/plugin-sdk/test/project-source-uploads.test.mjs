import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  createPluginProjectSourceUploadsClient,
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES,
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  parseProjectSourceUploadPartResponse,
} from "../dist/project-source-uploads.js";
import {
  uploadVectors,
  upload,
  uploadId,
  uploadDigest,
  uploadBeginInput,
  partLocator,
  writtenUpload,
  rawSealedUpload,
  readyUpload,
} from "./fixtures/project-source-upload-responses.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function clientFor(
  output,
  rawOutput = { disposition: "committed", upload: writtenUpload },
) {
  return createPluginProjectSourceUploadsClient(
    {
      async invoke() {
        return output;
      },
    },
    {
      raw: {
        async writePart() {
          return rawOutput;
        },
      },
    },
  );
}
function watch(signal) {
  let added = 0,
    removed = 0;
  const add = signal.addEventListener.bind(signal),
    remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    if (args[0] === "abort") added++;
    return add(...args);
  };
  signal.removeEventListener = (...args) => {
    if (args[0] === "abort") removed++;
    return remove(...args);
  };
  return () => ({ added, removed });
}

test("source uploads preserve the exact four original JSON actions and bounded portable contracts", async () => {
  assert.equal(PROJECT_SOURCE_UPLOAD_PART_BYTES, 65_536);
  assert.equal(MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES, 8 * 1024);
  assert.equal(MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES, 60 * 1024);
  for (const [method, input, output] of uploadVectors) {
    let calls = 0;
    const controller = new AbortController();
    const services = {
      async invoke(action, json, options) {
        assert.equal(this, services);
        assert.equal(action, PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS[method]);
        assert.deepEqual(json, input);
        assert.notEqual(json, input);
        assert.ok(Object.isFrozen(json));
        assert.equal(options.signal, controller.signal);
        calls++;
        return output;
      },
    };
    const client = createPluginProjectSourceUploadsClient(services);
    assert.ok(Object.isFrozen(client));
    assert.deepEqual(Object.keys(client), [
      "begin",
      "status",
      "prepare",
      "cancel",
      "writePart",
    ]);
    const result = await client[method](input, { signal: controller.signal });
    assert.deepEqual(result, output);
    assert.notEqual(result, output);
    assert.ok(Object.isFrozen(result.upload));
    assert.equal(calls, 1);
  }
});

test("construction captures original dispatch and byte methods without calling, probing or inventing availability", async () => {
  let jsonCalls = 0,
    rawCalls = 0,
    replaced = 0;
  const services = {
    async invoke() {
      assert.equal(this, services);
      jsonCalls++;
      return { upload };
    },
  };
  const raw = {
    async writePart() {
      assert.equal(this, raw);
      rawCalls++;
      return { disposition: "replayed", upload: writtenUpload };
    },
  };
  const client = createPluginProjectSourceUploadsClient(services, { raw });
  services.invoke = async () => {
    replaced++;
    throw new Error("replaced");
  };
  raw.writePart = async () => {
    replaced++;
    throw new Error("replaced");
  };
  assert.equal(jsonCalls + rawCalls, 0);
  await client.status({ uploadId });
  await client.writePart(partLocator, new Uint8Array(7));
  assert.deepEqual(
    { jsonCalls, rawCalls, replaced },
    { jsonCalls: 1, rawCalls: 1, replaced: 0 },
  );
  const noRaw = createPluginProjectSourceUploadsClient({
    async invoke() {
      return { upload };
    },
  });
  await assert.rejects(
    noRaw.writePart(partLocator, new Uint8Array(7)),
    /plugin_project_source_upload_raw_port_required/u,
  );
  assert.deepEqual(await noRaw.status({ uploadId }), { upload });
});

test("JSON inputs refuse raw bytes, base64, private owner and unknown fields before invoking anything", async () => {
  let calls = 0;
  const client = createPluginProjectSourceUploadsClient({
    async invoke() {
      calls++;
      return { upload };
    },
  });
  for (const input of [
    { ...uploadBeginInput, bytes: new Uint8Array(7) },
    { ...uploadBeginInput, base64: "Ym9vaw==" },
    { ...uploadBeginInput, owner: { principalId: "foreign" } },
    { ...uploadBeginInput, fileDigest: "SHA256:" + "a".repeat(64) },
    { ...uploadBeginInput, byteLength: 20_000_001 },
    { ...uploadBeginInput, fileName: "../book.txt" },
    { ...uploadBeginInput, idempotencyKey: "x".repeat(9000) },
  ])
    await assert.rejects(client.begin(input));
  let accesses = 0;
  const input = Object.defineProperty({ ...uploadBeginInput }, "fileName", {
    enumerable: true,
    get() {
      accesses++;
      return "story.txt";
    },
  });
  await assert.rejects(client.begin(input));
  assert.equal(accesses, 0);
  assert.equal(calls, 0);
});

test("status resumes exactly the returned descriptors; unknown preparation and host CAS refusals never retry or begin a new upload", async () => {
  const seen = [];
  const refusal = new Error("revision_conflict");
  const client = createPluginProjectSourceUploadsClient({
    async invoke(action, input) {
      seen.push([action, input]);
      if (action === PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS.status)
        return { upload: rawSealedUpload };
      throw refusal;
    },
  });
  assert.deepEqual(
    (await client.status({ uploadId })).upload.receivedParts,
    rawSealedUpload.receivedParts,
  );
  await assert.rejects(
    client.prepare({ uploadId, expectedRevision: 3 }),
    (error) => error === refusal,
  );
  assert.deepEqual(
    seen.map(([action]) => action),
    [
      PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS.status,
      PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS.prepare,
    ],
  );
  const uncertain = new Error("unknown_after_submission");
  const replay = [];
  const retry = createPluginProjectSourceUploadsClient({
    async invoke(action, input) {
      replay.push([action, input]);
      if (replay.length === 1) throw uncertain;
      return { disposition: "replayed", upload: readyUpload };
    },
  });
  await assert.rejects(
    retry.begin(uploadBeginInput),
    (error) => error === uncertain,
  );
  assert.equal(replay.length, 1);
  assert.equal((await retry.begin(uploadBeginInput)).disposition, "replayed");
  assert.deepEqual(replay[0], replay[1]);
});

test("raw bytes are snapshotted before awaiting and never go through services.invoke", async () => {
  let calls = 0,
    jsonCalls = 0;
  const controller = new AbortController();
  const source = new Uint8Array([9, 1, 2, 3, 4, 5, 6, 7, 8]),
    view = source.subarray(1, 8);
  const raw = {
    async writePart(locator, bytes, options) {
      assert.equal(this, raw);
      assert.deepEqual(locator, partLocator);
      assert.ok(Object.isFrozen(locator));
      assert.notEqual(bytes, view);
      assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(bytes.byteOffset, 0);
      assert.equal(bytes.buffer.byteLength, 7);
      assert.equal(options.signal, controller.signal);
      calls++;
      return { disposition: "committed", upload: writtenUpload };
    },
  };
  const client = createPluginProjectSourceUploadsClient(
    {
      async invoke() {
        jsonCalls++;
        throw new Error("raw_must_not_be_json");
      },
    },
    { raw },
  );
  const operation = client.writePart({ ...partLocator }, view, {
    signal: controller.signal,
  });
  view.fill(0);
  assert.deepEqual(await operation, {
    disposition: "committed",
    upload: writtenUpload,
  });
  assert.deepEqual({ calls, jsonCalls }, { calls: 1, jsonCalls: 0 });
});

test("native byte validation accepts only a bounded Uint8Array and refuses proxies, shared buffers, detached and forged inputs without getters", async () => {
  let calls = 0,
    accesses = 0;
  const client = createPluginProjectSourceUploadsClient(
    {
      async invoke() {
        throw new Error("no_json");
      },
    },
    {
      raw: {
        async writePart() {
          calls++;
          return { disposition: "committed", upload: writtenUpload };
        },
      },
    },
  );
  const detached = new Uint8Array(7);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const bytes of [
    [],
    new ArrayBuffer(7),
    new Uint16Array(7),
    new Uint8ClampedArray(7),
    new Uint8Array(),
    new Uint8Array(65_537),
    new Uint8Array(new SharedArrayBuffer(7)),
    detached,
    new Proxy(new Uint8Array(7), {
      get() {
        accesses++;
        throw new Error("proxy_getter");
      },
    }),
    Object.create(Uint8Array.prototype),
    {
      get byteLength() {
        accesses++;
        return 7;
      },
      get buffer() {
        accesses++;
        return new ArrayBuffer(7);
      },
    },
  ])
    await assert.rejects(
      client.writePart(partLocator, bytes),
      /plugin_project_source_upload_part_bytes_invalid/u,
    );
  assert.equal(calls, 0);
  assert.equal(accesses, 0);
});

test("raw acknowledgement binds the actual upload, acknowledged part, length and digest and refuses private or oversized responses", async () => {
  for (const output of [
    { ...writtenUpload },
    { disposition: "unknown", upload: writtenUpload },
    { disposition: "committed", upload: rawSealedUpload },
    {
      disposition: "committed",
      upload: { ...writtenUpload, uploadId: "foreign" },
    },
    { disposition: "committed", upload },
    {
      disposition: "committed",
      upload: {
        ...writtenUpload,
        receivedParts: [
          { index: 0, byteLength: 7, rawDigest: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
    {
      disposition: "committed",
      upload: { ...writtenUpload, ownerPrincipalId: "foreign" },
    },
    {
      disposition: "committed",
      upload: writtenUpload,
      preparedPointer: { schemaVersion: "private" },
    },
    {
      disposition: "committed",
      upload: writtenUpload,
      rawBytes: "x".repeat(61 * 1024),
    },
  ])
    await assert.rejects(
      clientFor({ upload }, output).writePart(partLocator, new Uint8Array(7)),
    );
  for (const locator of [
    { ...partLocator, partIndex: 306 },
    { ...partLocator, expectedRevision: 1 },
    { ...partLocator, owner: { principalId: "foreign" } },
    { ...partLocator, rawDigest: "sha256:" + "A".repeat(64) },
  ])
    await assert.rejects(
      clientFor({ upload }).writePart(locator, new Uint8Array(7)),
    );
  await assert.rejects(
    clientFor({ upload }).writePart(partLocator, new Uint8Array(6)),
  );
});

test("JSON response parsing refuses foreign uploads, private fields, forged ready state and output above 60 KiB", async () => {
  for (const output of [
    { upload: { ...upload, uploadId: "foreign" } },
    { upload: { ...upload, owner: { principalId: "foreign" } } },
    { upload, unknown: true },
    { upload, raw: "x".repeat(61 * 1024) },
  ])
    await assert.rejects(clientFor(output).status({ uploadId }));
  await assert.rejects(
    clientFor({ disposition: "ready", upload: rawSealedUpload }).prepare({
      uploadId,
      expectedRevision: 3,
    }),
  );
  await assert.rejects(
    clientFor({
      disposition: "committed",
      upload: { ...upload, fileDigest: `sha256:${"b".repeat(64)}` },
    }).begin(uploadBeginInput),
  );
});

test("both channels enforce native cancellation, keep late failures observed, and remove their abort listeners", async () => {
  for (const channel of ["json", "raw"]) {
    const completion = deferred(),
      controller = new AbortController(),
      counts = watch(controller.signal);
    let calls = 0;
    const client = createPluginProjectSourceUploadsClient(
      {
        async invoke() {
          calls++;
          return completion.promise;
        },
      },
      {
        raw: {
          async writePart() {
            calls++;
            return completion.promise;
          },
        },
      },
    );
    const operation =
      channel === "json"
        ? client.status({ uploadId }, { signal: controller.signal })
        : client.writePart(partLocator, new Uint8Array(7), {
            signal: controller.signal,
          });
    await turn();
    const reason = new Error(`cancel_${channel}`);
    controller.abort(reason);
    await assert.rejects(operation, (error) => error === reason);
    completion.reject(new Error("late_native_failure"));
    await turn();
    assert.equal(calls, 1);
    assert.deepEqual(counts(), { added: 1, removed: 1 });
    await assert.rejects(
      channel === "json"
        ? client.status({ uploadId }, { signal: controller.signal })
        : client.writePart(partLocator, new Uint8Array(7), {
            signal: controller.signal,
          }),
      (error) => error === reason,
    );
    assert.equal(calls, 1);
  }
  const client = clientFor({ upload });
  let getters = 0;
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      getters++;
      return new AbortController().signal;
    },
  });
  for (const invalid of [
    null,
    {
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
      },
    },
    { signal: Object.create(AbortSignal.prototype) },
    { signal: Promise.resolve() },
    options,
    { signal: new AbortController().signal, raw: true },
  ]) {
    await assert.rejects(client.status({ uploadId }, invalid));
    await assert.rejects(
      client.writePart(partLocator, new Uint8Array(7), invalid),
    );
  }
  assert.equal(getters, 0);
});

test("actual native HTTP byte transport recovers a lost 64 KiB acknowledgement, sends its final fragment and resumes without another begin", async (t) => {
  // Native internal transport fixture only: this is neither a formal installed mount nor an Agent Run.
  const bytes = new Uint8Array(65_543);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  let state = {
    ...upload,
    byteLength: bytes.length,
    partCount: 2,
    fileDigest: digest(bytes),
  };
  const actions = [],
    accepted = new Map(),
    writes = new Map();
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let count = 0;
      for await (const chunk of request) {
        count += chunk.byteLength;
        assert.ok(count <= 65_536);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks),
        path = new URL(request.url, "http://localhost").pathname;
      let output;
      if (path === "/invoke") {
        assert.equal(request.headers["content-type"], "application/json");
        const { action, input } = JSON.parse(body.toString("utf8"));
        actions.push(action);
        if (action === PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS.begin) {
          assert.equal(input.fileDigest, digest(bytes));
          output = { disposition: "committed", upload: state };
        } else {
          assert.equal(action, PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS.status);
          assert.equal(input.uploadId, uploadId);
          output = { upload: state };
        }
      } else {
        assert.equal(
          request.headers["content-type"],
          "application/octet-stream",
        );
        const index = Number(path.slice("/parts/".length));
        writes.set(index, (writes.get(index) ?? 0) + 1);
        assert.equal(digest(body), request.headers["x-raw-digest"]);
        assert.deepEqual(
          body,
          Buffer.from(
            bytes.subarray(
              index * 65_536,
              Math.min(bytes.length, (index + 1) * 65_536),
            ),
          ),
        );
        const previous = accepted.get(index),
          descriptor = {
            index,
            byteLength: body.length,
            rawDigest: digest(body),
          };
        if (previous) assert.deepEqual(previous, descriptor);
        else {
          accepted.set(index, descriptor);
          state = {
            ...state,
            revision: accepted.size + 1,
            phase: "receiving",
            receivedParts: [...accepted.values()].sort(
              (a, b) => a.index - b.index,
            ),
          };
        }
        output = {
          disposition: previous ? "replayed" : "committed",
          upload: state,
        };
        if (index === 0 && previous === undefined) {
          response.writeHead(503, { "content-type": "text/plain" });
          response.end("acknowledgement_lost_after_acceptance");
          return;
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(output));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createPluginProjectSourceUploadsClient(
    {
      async invoke(action, input, options) {
        const response = await fetch(base + "/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, input }),
          signal: options.signal,
        });
        assert.equal(response.status, 200);
        return response.json();
      },
    },
    {
      raw: {
        async writePart(locator, part, options) {
          const response = await fetch(`${base}/parts/${locator.partIndex}`, {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "x-raw-digest": locator.rawDigest,
            },
            body: part,
            signal: options.signal,
          });
          if (response.status !== 200) throw new Error(await response.text());
          return response.json();
        },
      },
    },
  );
  await client.begin({
    ...uploadBeginInput,
    byteLength: bytes.length,
    fileDigest: digest(bytes),
  });
  for (let index = 0; index < 2; index++) {
    const part = bytes.subarray(
      index * 65_536,
      Math.min(bytes.length, (index + 1) * 65_536),
    );
    const locator = { uploadId, partIndex: index, rawDigest: digest(part) };
    if (index === 0) {
      await assert.rejects(
        client.writePart(locator, part),
        /acknowledgement_lost_after_acceptance/u,
      );
      assert.equal(accepted.size, 1);
      assert.equal(writes.get(0), 1); // No automatic retry after an unknown result.
    } else {
      assert.equal(
        (await client.writePart(locator, part)).disposition,
        "committed",
      );
    }
    assert.equal(
      (await client.writePart(locator, part)).disposition,
      "replayed",
    );
  }
  const restored = (await client.status({ uploadId })).upload;
  assert.equal(restored.phase, "receiving");
  assert.deepEqual(
    restored.receivedParts.map((part) => part.byteLength),
    [65_536, 7],
  );
  assert.deepEqual(actions, [
    PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS.begin,
    PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS.status,
  ]);
  assert.equal(accepted.size, 2);
  assert.deepEqual(
    [...writes.entries()],
    [
      [0, 2],
      [1, 2],
    ],
  );
  assert.equal(
    parseProjectSourceUploadPartResponse(
      { disposition: "replayed", upload: restored },
      { uploadId, partIndex: 1, rawDigest: digest(bytes.subarray(65_536)) },
      7,
    ).disposition,
    "replayed",
  );
});
