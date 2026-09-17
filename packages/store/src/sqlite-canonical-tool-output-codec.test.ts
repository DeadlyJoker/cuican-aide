import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import type { ModelHistoryItem, RunLifecycleEvent } from "@crewon/domain";
import {
  encodeSqliteModelHistoryItem,
  decodeSqliteModelHistoryItem,
  encodeSqliteRunEvent,
  decodeSqliteRunEvent,
} from "./sqlite-canonical-tool-output-codec.ts";
import { stableJson } from "./store-invariants.ts";
import { toolHistory } from "./model-history-append.test-support.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";

function history(output: string): ModelHistoryItem {
  const item = toolHistory(2, "call-1", "tool_result");
  assert.equal(item.type, "tool_result");
  return { ...item, output } as ModelHistoryItem;
}
function event(output: string): RunLifecycleEvent {
  const base = createRunningCommitFixture().events[0]!;
  return {
    ...base,
    type: "tool.completed",
    data: {
      segmentId: "segment-1",
      segmentSequence: 2,
      callId: "call-1",
      kind: "function",
      name: "read_file",
      output,
      isError: false,
      artifactRef: null,
      outputTruncated: false,
    },
  };
}

for (const kind of ["history", "event"] as const) {
  const encode = (output: string) =>
    kind === "history"
      ? encodeSqliteModelHistoryItem(history(output))
      : encodeSqliteRunEvent(event(output));
  const decode = (stored: string) =>
    kind === "history"
      ? decodeSqliteModelHistoryItem(stored)
      : decodeSqliteRunEvent(stored);
  const fixture = (output: string) =>
    kind === "history" ? history(output) : event(output);
  const body = (record: Record<string, any>) =>
    kind === "history" ? record : record.data;
  const invalid = (record: unknown) =>
    assert.throws(() => decode(JSON.stringify(record)), {
      code:
        kind === "history"
          ? "stored_model_history_item_invalid"
          : "stored_event_invalid",
    });
  test(`${kind}: canonical output is deterministic and preserves exact text and metadata`, () => {
    for (const output of [
      "line 界🚀\n".repeat(1000),
      '\ud800\n"\\\u0000'.repeat(1000),
      '{"schemaVersion":"crewon.sqlite-canonical-tool-output.v1"}'.repeat(200),
    ]) {
      const original = fixture(output),
        before = structuredClone(original),
        stored = encode(output);
      assert.equal(typeof body(JSON.parse(stored)).output, "object");
      assert(
        Buffer.byteLength(stored) < Buffer.byteLength(stableJson(original)) / 2,
      );
      assert.deepEqual(decode(stored), original);
      assert.deepEqual(original, before);
      assert.equal(encode(output), stored);
    }
  });
  test(`${kind}: legacy, small, incompressible and oversized outputs remain plain`, () => {
    for (const output of [
      "done",
      randomBytes(32000).toString("base64"),
      "\0".repeat(60000),
      "a".repeat(262144),
    ]) {
      assert.equal(encode(output), stableJson(fixture(output)));
      assert.deepEqual(decode(encode(output)), fixture(output));
    }
    assert.deepEqual(decode(stableJson(fixture("legacy"))), fixture("legacy"));
  });
  test(`${kind}: malformed, truncated, trailing and over-budget payloads fail closed`, () => {
    const source = JSON.parse(encode("output\n".repeat(2000))),
      envelope = body(source).output;
    const data = Buffer.from(envelope.data, "base64");
    const oversized = Buffer.from(
      JSON.stringify({ binding: "untrusted", output: "a".repeat(300000) }),
    );
    for (const patch of [
      { schemaVersion: "future" },
      { codec: "gzip" },
      { rawBytes: 0 },
      { rawBytes: 262145 },
      { rawBytes: 1.5 },
      { digest: "0".repeat(64) },
      { data: "" },
      { data: "bad-base64!" },
      { data: "a".repeat(262145) },
      { data: envelope.data + "\n" },
      { extra: true },
      { rawBytes: envelope.rawBytes - 1 },
      { data: data.subarray(0, -1).toString("base64") },
      { data: Buffer.concat([data, Buffer.from([0])]).toString("base64") },
      { data: deflateRawSync(oversized).toString("base64"), rawBytes: 262144 },
    ]) {
      const modified = structuredClone(source);
      body(modified).output = { ...envelope, ...patch };
      invalid(modified);
    }
    for (const raw of [
      Buffer.from([0xff, 0xfe]),
      Buffer.from('{"binding":"wrong","output":"changed"}'),
    ]) {
      const modified = structuredClone(source);
      body(modified).output = {
        ...envelope,
        rawBytes: raw.length,
        digest: createHash("sha256").update(raw).digest("hex"),
        data: deflateRawSync(raw).toString("base64"),
      };
      invalid(modified);
    }
  });
  test(`${kind}: encoded output cannot move to different identities or altered metadata`, () => {
    const original = JSON.parse(encode("output\n".repeat(2000)));
    const patches =
      kind === "history"
        ? [
            { tenantId: "other" },
            { threadId: "other" },
            { runId: "other" },
            { itemId: "other" },
            { sequence: 3 },
            { status: "failed" },
            { callId: "other" },
          ]
        : [
            { identity: { ...original.identity, runId: "other" } },
            { eventId: "other" },
            { sequence: 3 },
            { data: { ...original.data, callId: "other" } },
            { data: { ...original.data, artifactRef: "changed" } },
          ];
    for (const patch of patches) invalid({ ...original, ...patch });
    invalid({ ...original, padding: "a".repeat(524288) });
  });
}

test("canonical codec leaves other history and event kinds byte-identical", () => {
  const item = toolHistory(1, "call-1", "tool_call");
  assert.equal(encodeSqliteModelHistoryItem(item), stableJson(item));
  for (const event of createRunningCommitFixture().events) {
    assert.equal(encodeSqliteRunEvent(event), stableJson(event));
    assert.deepEqual(decodeSqliteRunEvent(stableJson(event)), event);
  }
});

test("canonical event and history outputs cannot share an encoded envelope", () => {
  const storedHistory = JSON.parse(
    encodeSqliteModelHistoryItem(history("output".repeat(1000))),
  );
  const storedEvent = JSON.parse(
    encodeSqliteRunEvent(event("output".repeat(1000))),
  );
  storedEvent.data.output = storedHistory.output;
  assert.throws(() => decodeSqliteRunEvent(JSON.stringify(storedEvent)), {
    code: "stored_event_invalid",
  });
});
