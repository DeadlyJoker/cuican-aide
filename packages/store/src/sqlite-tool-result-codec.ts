import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import { RunStoreError } from "@crewon/application";
import { stableJson } from "./store-invariants.ts";

const VERSION = "crewon.sqlite-tool-result.v1";
const MAX_BYTES = 256 * 1024;
const MIN_BYTES = 2 * 1024;

/** Only the stored result body changes representation; all indexed/recovery metadata stays ordinary JSON. */
export function encodeSqliteToolReceiptState(
  receipt: ToolExecutionReceiptState,
): string {
  const ordinary = stableJson(receipt);
  if (
    receipt.result === null ||
    Buffer.byteLength(receipt.result.output) < MIN_BYTES ||
    Buffer.byteLength(receipt.result.output) > MAX_BYTES
  )
    return ordinary;
  const raw = Buffer.from(
    JSON.stringify({
      binding: binding(receipt),
      output: receipt.result.output,
    }),
  );
  if (raw.length < MIN_BYTES || raw.length > MAX_BYTES) return ordinary;
  const compressed = deflateRawSync(raw, {
    level: 1,
    maxOutputLength: MAX_BYTES + 1024,
  });
  const output = {
    schemaVersion: VERSION,
    codec: "deflate-raw",
    rawBytes: raw.length,
    digest: digest(raw),
    data: compressed.toString("base64"),
  };
  const encoded = stableJson({
    ...receipt,
    result: { ...receipt.result, output },
  });
  const originalBytes = Buffer.byteLength(ordinary),
    storedBytes = Buffer.byteLength(encoded);
  return storedBytes <= originalBytes * 0.75 &&
    originalBytes - storedBytes >= 512
    ? encoded
    : ordinary;
}

/** Restore exact JS text, including escaped code units, before domain and SQL-column identity validation. */
export function decodeSqliteToolReceiptState(
  stored: string,
): ToolExecutionReceiptState {
  try {
    const receipt = JSON.parse(stored) as ToolExecutionReceiptState;
    const output: unknown = receipt?.result?.output;
    if (typeof output === "string" || receipt?.result === null) return receipt;
    if (
      !object(output, [
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
      output.rawBytes > MAX_BYTES ||
      typeof output.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(output.digest) ||
      typeof output.data !== "string" ||
      output.data.length > MAX_BYTES
    )
      throw invalid();
    const compressed = Buffer.from(output.data, "base64");
    if (
      compressed.length === 0 ||
      compressed.toString("base64") !== output.data
    )
      throw invalid();
    const raw = inflateRawSync(compressed, {
      maxOutputLength: output.rawBytes,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (
      raw.engine.bytesWritten !== compressed.length ||
      raw.buffer.length !== output.rawBytes ||
      digest(raw.buffer) !== output.digest
    )
      throw invalid();
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw.buffer),
    );
    if (
      !object(decoded, ["binding", "output"]) ||
      decoded.binding !== binding(receipt) ||
      typeof decoded.output !== "string"
    )
      throw invalid();
    return {
      ...receipt,
      result: { ...receipt.result!, output: decoded.output },
    };
  } catch (cause) {
    throw invalid(cause);
  }
}

function binding(receipt: ToolExecutionReceiptState): string {
  return digest(
    Buffer.from(
      stableJson({ ...receipt, result: { ...receipt.result!, output: null } }),
    ),
  );
}
function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function object(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}
function invalid(cause?: unknown) {
  return new RunStoreError("stored_tool_receipt_invalid", { cause });
}
