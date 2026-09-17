import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { RunStoreError } from "@crewon/application";
import type { ModelHistoryItem, RunLifecycleEvent } from "@crewon/domain";
import { stableJson } from "./store-invariants.ts";

const VERSION = "crewon.sqlite-canonical-tool-output.v1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MIN_BODY_BYTES = 2 * 1024;
type RecordValue = Record<string, unknown>;
type Kind = "history" | "event";

// This is a disk representation only. Context hashes, replay and model input
// continue to use the exact decoded domain records, never these JSON bytes.
export function encodeSqliteModelHistoryItem(item: ModelHistoryItem): string {
  return encode(item, "history");
}
export function decodeSqliteModelHistoryItem(stored: string): ModelHistoryItem {
  return decode(stored, "history") as ModelHistoryItem;
}
export function encodeSqliteRunEvent(event: RunLifecycleEvent): string {
  return encode(event, "event");
}
export function decodeSqliteRunEvent(stored: string): RunLifecycleEvent {
  return decode(stored, "event") as RunLifecycleEvent;
}

function encode(
  record: ModelHistoryItem | RunLifecycleEvent,
  kind: Kind,
): string {
  const ordinary = stableJson(record);
  if (!candidate(record, kind)) return ordinary;
  const output = readOutput(record, kind);
  const originalBytes = Buffer.byteLength(ordinary);
  if (
    typeof output !== "string" ||
    originalBytes > MAX_RECORD_BYTES ||
    Buffer.byteLength(output) < MIN_BODY_BYTES ||
    Buffer.byteLength(output) > MAX_BODY_BYTES
  )
    return ordinary;
  const raw = Buffer.from(
    JSON.stringify({ binding: binding(record, kind), output }),
  );
  if (raw.length > MAX_BODY_BYTES) return ordinary;
  const compressed = deflateRawSync(raw, {
    level: 1,
    maxOutputLength: MAX_BODY_BYTES + 1024,
  });
  const encoded = stableJson(
    withOutput(record, kind, {
      schemaVersion: VERSION,
      codec: "deflate-raw",
      rawBytes: raw.length,
      digest: digest(raw),
      data: compressed.toString("base64"),
    }),
  );
  const storedBytes = Buffer.byteLength(encoded);
  return storedBytes <= originalBytes * 0.75 &&
    originalBytes - storedBytes >= 512
    ? encoded
    : ordinary;
}

function decode(stored: string, kind: Kind): unknown {
  try {
    const record: unknown = JSON.parse(stored);
    if (!candidate(record, kind)) return record;
    const output = readOutput(record, kind);
    if (typeof output === "string") return record; // Legacy and deliberately uncompressed bodies.
    if (
      Buffer.byteLength(stored) > MAX_RECORD_BYTES ||
      !exactObject(output, [
        "codec",
        "data",
        "digest",
        "rawBytes",
        "schemaVersion",
      ]) ||
      output.schemaVersion !== VERSION ||
      output.codec !== "deflate-raw" ||
      typeof output.rawBytes !== "number" ||
      !Number.isSafeInteger(output.rawBytes) ||
      output.rawBytes < 1 ||
      output.rawBytes > MAX_BODY_BYTES ||
      typeof output.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(output.digest) ||
      typeof output.data !== "string" ||
      output.data.length > MAX_BODY_BYTES
    )
      throw invalid(kind);
    const compressed = Buffer.from(output.data, "base64");
    if (!compressed.length || compressed.toString("base64") !== output.data)
      throw invalid(kind);
    const raw = inflateRawSync(compressed, {
      maxOutputLength: output.rawBytes,
      info: true,
    }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (
      raw.engine.bytesWritten !== compressed.length ||
      raw.buffer.length !== output.rawBytes ||
      digest(raw.buffer) !== output.digest
    )
      throw invalid(kind);
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw.buffer),
    );
    if (
      !exactObject(decoded, ["binding", "output"]) ||
      decoded.binding !== binding(record, kind) ||
      typeof decoded.output !== "string"
    )
      throw invalid(kind);
    return withOutput(record, kind, decoded.output);
  } catch (cause) {
    throw invalid(kind, cause);
  }
}

function candidate(record: unknown, kind: Kind): record is RecordValue {
  return (
    object(record) &&
    record.type === (kind === "history" ? "tool_result" : "tool.completed")
  );
}
function readOutput(record: RecordValue, kind: Kind): unknown {
  return kind === "history"
    ? record.output
    : object(record.data)
      ? record.data.output
      : undefined;
}
function withOutput(
  record: RecordValue,
  kind: Kind,
  output: unknown,
): RecordValue {
  if (kind === "history") return { ...record, output };
  if (!object(record.data)) throw invalid(kind);
  return { ...record, data: { ...record.data, output } };
}
function binding(record: RecordValue, kind: Kind): string {
  return digest(
    Buffer.from(kind + ":" + stableJson(withOutput(record, kind, null))),
  );
}
function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactObject(
  value: unknown,
  keys: readonly string[],
): value is RecordValue {
  return (
    object(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}
function invalid(kind: Kind, cause?: unknown): RunStoreError {
  return new RunStoreError(
    kind === "history"
      ? "stored_model_history_item_invalid"
      : "stored_event_invalid",
    { cause },
  );
}
