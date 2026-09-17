import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  validateToolExecutionReceipt,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import {
  encodeSqliteToolReceiptState as encode,
  decodeSqliteToolReceiptState as decode,
} from "./sqlite-tool-result-codec.ts";
import { stableJson } from "./store-invariants.ts";

function receipt(
  output = "output 界🚀\n".repeat(4000),
): ToolExecutionReceiptState {
  const state: ToolExecutionReceiptState = {
    schemaVersion: "crewon.tool-execution-receipt.v0",
    receiptId: "receipt-1",
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    workItemId: "work-1",
    executionId: "execution-1",
    idempotencyKey: "run-1/tool/call-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    actionIntent: null,
    call: {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function",
      name: "read_file",
      inputDigest: `sha256:${"b".repeat(64)}`,
    },
    effect: "readOnly",
    recovery: "replaySafe",
    status: "completed",
    revision: 3,
    providerReceiptId: "provider-1",
    result: {
      output,
      outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
      isError: false,
      artifactRef: "artifact-1",
      workspaceChanges: {
        schemaVersion: "crewon.workspace-change-summary.v0",
        paths: ["src/file.ts"],
        additions: 2,
        deletions: 1,
        statsComplete: true,
      },
    },
    preparedAt: "2026-09-15T00:00:00Z",
    dispatchedAt: "2026-09-15T00:00:01Z",
    updatedAt: "2026-09-15T00:00:02Z",
    resolvedAt: "2026-09-15T00:00:02Z",
  };
  validateToolExecutionReceipt(state);
  return state;
}
function invalid(value: unknown) {
  assert.throws(() => decode(JSON.stringify(value)), {
    code: "stored_tool_receipt_invalid",
  });
}

test("tool result encoding is deterministic, lossless and leaves all recovery metadata intact", () => {
  const state = receipt(),
    before = structuredClone(state),
    text = encode(state),
    stored = JSON.parse(text);
  assert.equal(typeof stored.result.output, "object");
  assert(text.length < stableJson(state).length / 2);
  assert.deepEqual(
    { ...stored, result: { ...stored.result, output: state.result!.output } },
    state,
  );
  assert.deepEqual(decode(text), state);
  assert.equal(encode(state), text);
  assert.deepEqual(state, before);
  validateToolExecutionReceipt(decode(text));
});

test("legacy plaintext, small, high-entropy and escaped-over-budget bodies stay plaintext", () => {
  for (const output of [
    "done",
    randomBytes(32000).toString("base64"),
    "\0".repeat(60000),
    "a".repeat(256 * 1024),
  ]) {
    const state = receipt(output);
    assert.equal(encode(state), stableJson(state));
    assert.deepEqual(decode(encode(state)), state);
  }
  const state = receipt();
  assert.deepEqual(decode(stableJson(state)), state);
});

test("pending and canceled receipts without a result retain their ordinary storage shape", () => {
  const original = receipt();
  const prepared = {
    ...original,
    status: "prepared" as const,
    revision: 1,
    providerReceiptId: null,
    result: null,
    dispatchedAt: null,
    resolvedAt: null,
    updatedAt: original.preparedAt,
  };
  const canceled = {
    ...prepared,
    status: "canceled" as const,
    revision: 2,
    resolvedAt: original.updatedAt,
    updatedAt: original.updatedAt,
  };
  for (const state of [prepared, canceled]) {
    validateToolExecutionReceipt(state);
    assert.equal(encode(state), stableJson(state));
    assert.deepEqual(decode(encode(state)), state);
  }
});

test("encoding preserves exact escaped code units and treats envelope-looking strings as user text", () => {
  for (const output of [
    '\ud800\n"\\界'.repeat(1000),
    '{"schemaVersion":"crewon.sqlite-tool-result.v1","data":"literal"}'.repeat(
      1000,
    ),
  ]) {
    const state = receipt(output);
    assert.equal(typeof JSON.parse(encode(state)).result.output, "object");
    assert.equal(decode(encode(state)).result!.output, output);
  }
});

test("invalid envelope keys, versions, sizes and base64 fail closed before inflation", () => {
  const original = JSON.parse(encode(receipt()));
  for (const patch of [
    { schemaVersion: "crewon.sqlite-tool-result.v2" },
    { codec: "gzip" },
    { rawBytes: 0 },
    { rawBytes: 262145 },
    { rawBytes: 1.5 },
    { digest: "x" },
    { data: "" },
    { data: "not-base64" },
    { data: "x".repeat(262145) },
    { extra: true },
  ])
    invalid({
      ...original,
      result: {
        ...original.result,
        output: { ...original.result.output, ...patch },
      },
    });
});

test("truncated, trailing and digest-mismatched compressed data is rejected", () => {
  const original = JSON.parse(encode(receipt())),
    envelope = original.result.output,
    data = Buffer.from(envelope.data, "base64");
  for (const patch of [
    { data: data.subarray(0, -1).toString("base64") },
    { data: Buffer.concat([data, Buffer.from([0])]).toString("base64") },
    { rawBytes: envelope.rawBytes - 1 },
    { digest: "0".repeat(64) },
  ])
    invalid({
      ...original,
      result: { ...original.result, output: { ...envelope, ...patch } },
    });
});

test("encoded results cannot move across receipt identities, revisions or recovery metadata", () => {
  const original = JSON.parse(encode(receipt()));
  for (const patch of [
    { tenantId: "foreign" },
    { runId: "foreign" },
    { receiptId: "foreign" },
    { revision: 4 },
    { providerReceiptId: "foreign" },
    { status: "canceled" },
    { call: { ...original.call, callId: "foreign" } },
    { result: { ...original.result, artifactRef: "foreign" } },
  ])
    invalid({ ...original, ...patch });
});

test("bounded inflation rejects compressed bombs even with a recomputed digest", () => {
  const original = JSON.parse(encode(receipt())),
    raw = Buffer.alloc(1024 * 1024, 65);
  invalid({
    ...original,
    result: {
      ...original.result,
      output: {
        ...original.result.output,
        rawBytes: 32,
        digest: createHash("sha256").update(raw).digest("hex"),
        data: deflateRawSync(raw).toString("base64"),
      },
    },
  });
});

test("invalid UTF-8 and structurally invalid decoded content cannot bypass the envelope checksum", () => {
  const original = JSON.parse(encode(receipt()));
  for (const raw of [
    Buffer.from([255, 254]),
    Buffer.from("{}"),
    Buffer.from('{"binding":"wrong","output":"different"}'),
  ])
    invalid({
      ...original,
      result: {
        ...original.result,
        output: {
          ...original.result.output,
          rawBytes: raw.length,
          digest: createHash("sha256").update(raw).digest("hex"),
          data: deflateRawSync(raw).toString("base64"),
        },
      },
    });
});
