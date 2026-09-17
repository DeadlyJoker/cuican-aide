import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import {
  encodeSqliteExecutionReceipt as encode,
  decodeSqliteExecutionReceipt as decode,
} from "./sqlite-execution-receipt-codec.ts";
import { stableJson } from "./store-invariants.ts";

const address = {
  scope: stableJson({
    namespace: "run-execution",
    runId: "run-1",
    tenantId: "tenant-1",
    workItemId: "work-1",
    schemaVersion: "crewon.idempotency-scope.v0",
  }),
  key: "complete",
};
const row = {
  tenant_id: "tenant-1",
  run_id: "run-1",
  fingerprint: stableJson({
    schemaVersion: "crewon.run-execution-fingerprint.v0",
    runId: "run-1",
    workItemId: "work-1",
    phase: "complete",
    command: { output: "中文\n\u0000🚀".repeat(2000) },
  }),
  result_json: stableJson({
    disposition: "committed",
    messages: [{ content: "中文\n\u0000🚀".repeat(2000) }],
  }),
};
const invalid = (error: unknown) =>
  error instanceof Error && error.message === "idempotency_receipt_invalid";

test("losslessly restores exact fingerprint and result strings without mutating inputs", () => {
  const before = structuredClone(row),
    packed = encode(row, address);
  assert.notEqual(packed.fingerprint, row.fingerprint);
  assert.ok(packed.result_json.length < row.result_json.length / 4);
  assert.deepEqual(decode(packed, address), row);
  assert.deepEqual(row, before);
  assert.deepEqual(encode(row, address), packed);
});

test("small internal receipts use byte-based admission and keep unhelpful encodings as JSON", () => {
  const fingerprint = stableJson({
    schemaVersion: "crewon.run-execution-fingerprint.v0",
    runId: "run-1",
    workItemId: "work-1",
    phase: "complete",
    command: null,
  });
  const candidate = (bytes: number) => ({
    ...row,
    fingerprint,
    result_json: JSON.stringify(
      "x".repeat(bytes - Buffer.byteLength(fingerprint) - 2),
    ),
  });
  const tiny = candidate(2047);
  assert.equal(encode(tiny, address), tiny);
  for (const bytes of [2048, 3072, 4095]) {
    const source = candidate(bytes),
      packed = encode(source, address);
    assert.notEqual(packed.fingerprint, source.fingerprint);
    assert.deepEqual(decode(packed, address), source);
    const stored =
      Buffer.byteLength(packed.fingerprint) +
      Buffer.byteLength(packed.result_json);
    assert.ok(bytes - stored >= 512 && stored <= bytes * 0.75);
  }
  const unicode = {
    ...row,
    fingerprint,
    result_json: JSON.stringify("字🚀".repeat(400)),
  };
  assert.ok(unicode.fingerprint.length + unicode.result_json.length < 2048);
  assert.notEqual(encode(unicode, address).fingerprint, fingerprint);
  assert.deepEqual(decode(encode(unicode, address), address), unicode);
  const entropy = {
    ...row,
    fingerprint,
    result_json: JSON.stringify(randomBytes(1900).toString("base64")),
  };
  assert.ok(Buffer.byteLength(entropy.result_json) < 4096);
  assert.equal(encode(entropy, address), entropy);
});

test("legacy, public, noncanonical internal identity, small, oversized and unhelpful compression stay ordinary JSON", () => {
  assert.equal(decode(row, address), row);
  for (const target of [
    { scope: "public", key: "complete" },
    { ...address, key: "other" },
    { ...address, scope: address.scope.replace("run-1", "run-2") },
  ])
    assert.equal(encode(row, target), row);
  const publicTagged = {
    ...row,
    fingerprint: "crewon.sqlite-execution-receipt.v1:sha256:opaque",
  };
  assert.equal(
    decode(publicTagged, { scope: "public", key: "key" }),
    publicTagged,
  );
  for (const candidate of [
    { ...row, fingerprint: "opaque", result_json: "{}" },
    { ...row, result_json: JSON.stringify("x".repeat(256 * 1024)) },
    { ...row, fingerprint: row.fingerprint.replace("work-1", "other") },
    { ...row, result_json: JSON.stringify("字".repeat(100000)) },
    {
      ...row,
      fingerprint: stableJson({
        schemaVersion: "crewon.run-execution-fingerprint.v0",
        runId: "run-1",
        workItemId: "work-1",
        phase: "complete",
        command: null,
      }),
      result_json: JSON.stringify(randomBytes(64000).toString("base64")),
    },
  ])
    assert.equal(encode(candidate, address), candidate);
});

test("corrupt envelopes, truncated streams, trailing bytes, extra fields and unknown versions fail closed", () => {
  const packed = encode(row, address),
    envelope = JSON.parse(packed.result_json);
  for (const altered of [
    { ...envelope, schemaVersion: "crewon.sqlite-execution-receipt.v2" },
    { ...envelope, codec: "gzip" },
    { ...envelope, rawBytes: 0 },
    { ...envelope, rawBytes: 256 * 1024 + 1 },
    { ...envelope, rawBytes: 1.5 },
    { ...envelope, rawBytes: envelope.rawBytes - 1 },
    { ...envelope, rawBytes: envelope.rawBytes + 1 },
    { ...envelope, data: envelope.data + "\n" },
    {
      ...envelope,
      data: Buffer.from(envelope.data, "base64")
        .subarray(0, -1)
        .toString("base64"),
    },
    {
      ...envelope,
      data: Buffer.concat([
        Buffer.from(envelope.data, "base64"),
        Buffer.from("junk"),
      ]).toString("base64"),
    },
    { ...envelope, unexpected: true },
  ])
    assert.throws(
      () =>
        decode({ ...packed, result_json: JSON.stringify(altered) }, address),
      invalid,
    );
  assert.throws(
    () =>
      decode(
        { ...packed, fingerprint: packed.fingerprint.replace("v1", "v2") },
        address,
      ),
    invalid,
  );
  assert.throws(
    () =>
      decode(
        { ...packed, fingerprint: packed.fingerprint.slice(0, -1) },
        address,
      ),
    invalid,
  );
  assert.throws(
    () => decode({ ...packed, result_json: "{" }, address),
    invalid,
  );
  assert.throws(
    () =>
      decode({ ...packed, result_json: "x".repeat(256 * 1024 + 1) }, address),
    invalid,
  );
});

test("bounded decompression rejects expanding payload, invalid UTF-8 and cross-receipt substitution", () => {
  const packed = encode(row, address);
  function raw(body: Buffer, rawBytes = body.length) {
    return {
      ...packed,
      fingerprint:
        "crewon.sqlite-execution-receipt.v1:sha256:" +
        createHash("sha256").update(body).digest("hex"),
      result_json: JSON.stringify({
        schemaVersion: "crewon.sqlite-execution-receipt.v1",
        codec: "deflate-raw",
        rawBytes,
        data: deflateRawSync(body).toString("base64"),
      }),
    };
  }
  assert.throws(
    () => decode(raw(Buffer.alloc(512 * 1024), 256 * 1024), address),
    invalid,
  );
  assert.throws(() => decode(raw(Buffer.from([0xff, 0xfe])), address), invalid);
  assert.throws(
    () => decode(packed, { ...address, key: "different-phase" }),
    invalid,
  );
  const moved = {
    ...address,
    scope: address.scope.replace("work-1", "work-2"),
  };
  assert.throws(() => decode(packed, moved), invalid);
  const badBody = Buffer.from(
    JSON.stringify({
      scope: address.scope,
      key: address.key,
      fingerprint: "opaque",
      resultJson: "{}",
    }),
  );
  assert.throws(() => decode(raw(badBody), address), invalid);
  assert.throws(
    () =>
      decode(
        {
          ...packed,
          fingerprint:
            packed.fingerprint.slice(0, -1) +
            (packed.fingerprint.endsWith("a") ? "b" : "a"),
        },
        address,
      ),
    invalid,
  );
});
