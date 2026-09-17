import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { RunStoreError } from "@crewon/application";

// This is a SQLite storage encoding, never an application fingerprint or model input.
const FAMILY = "crewon.sqlite-execution-receipt.";
const VERSION = `${FAMILY}v1`;
const PREFIX = `${VERSION}:sha256:`;
const MAX_BYTES = 256 * 1024;
// Frequent segment receipts are about 2 KiB; smaller candidates add work without
// meeting the savings gate in the measured workload. Keep the gate below too.
const MIN_BYTES = 2 * 1024;
const MAX_SCOPE_CHARS = 4096;

type Address = Readonly<{ scope: string; key: string }>;
type Receipt = Readonly<{
  tenant_id: string;
  run_id: string;
  fingerprint: string;
  result_json: string;
}>;

/** Only the canonical internal execution namespace opts in; public receipts stay ordinary JSON. */
function executionScope(
  row: Receipt,
  address: Address,
): Record<string, unknown> | null {
  if (
    address.scope.length > MAX_SCOPE_CHARS ||
    address.key.length > MAX_SCOPE_CHARS
  )
    return null;
  try {
    const scope: unknown = JSON.parse(address.scope);
    if (
      !objectWithKeys(scope, [
        "namespace",
        "runId",
        "schemaVersion",
        "tenantId",
        "workItemId",
      ]) ||
      scope.namespace !== "run-execution" ||
      scope.schemaVersion !== "crewon.idempotency-scope.v0" ||
      scope.tenantId !== row.tenant_id ||
      scope.runId !== row.run_id ||
      typeof scope.workItemId !== "string" ||
      scope.workItemId.length === 0 ||
      JSON.stringify(scope) !== address.scope
    )
      return null;
    return scope;
  } catch {
    return null;
  }
}

function executionFingerprint(
  row: Receipt,
  address: Address,
  scope: Record<string, unknown>,
): boolean {
  try {
    const fingerprint: unknown = JSON.parse(row.fingerprint);
    return (
      objectWithKeys(fingerprint, [
        "command",
        "phase",
        "runId",
        "schemaVersion",
        "workItemId",
      ]) &&
      fingerprint.schemaVersion === "crewon.run-execution-fingerprint.v0" &&
      fingerprint.runId === row.run_id &&
      fingerprint.workItemId === scope.workItemId &&
      fingerprint.phase === address.key
    );
  } catch {
    return false;
  }
}

/** One bounded, fast compression attempt per new eligible receipt; no startup rewrite or cache. */
export function encodeSqliteExecutionReceipt<T extends Receipt>(
  row: T,
  address: Address,
): T {
  if (row.fingerprint.length + row.result_json.length > MAX_BYTES) return row;
  const originalBytes =
    Buffer.byteLength(row.fingerprint) + Buffer.byteLength(row.result_json);
  if (originalBytes < MIN_BYTES || originalBytes > MAX_BYTES) return row;
  const scope = executionScope(row, address);
  if (scope === null || !executionFingerprint(row, address, scope)) return row;
  const body = Buffer.from(
    JSON.stringify({
      scope: address.scope,
      key: address.key,
      fingerprint: row.fingerprint,
      resultJson: row.result_json,
    }),
  );
  if (body.length > MAX_BYTES) return row;
  const compressed = deflateRawSync(body, {
    level: 1,
    maxOutputLength: MAX_BYTES + 1024,
  });
  const fingerprint = PREFIX + digest(body);
  const result_json = JSON.stringify({
    schemaVersion: VERSION,
    codec: "deflate-raw",
    rawBytes: body.length,
    data: compressed.toString("base64"),
  });
  const storedBytes =
    Buffer.byteLength(fingerprint) + Buffer.byteLength(result_json);
  if (storedBytes > originalBytes * 0.75 || originalBytes - storedBytes < 512)
    return row;
  return { ...row, fingerprint, result_json };
}

/** Restore exact old strings before the existing lease, identity and typed-result checks. */
export function decodeSqliteExecutionReceipt<T extends Receipt>(
  row: T,
  address: Address,
): T {
  if (!row.fingerprint.startsWith(FAMILY)) return row;
  // Opaque public fingerprints retain their old meaning, even if they resemble our tag.
  const scope = executionScope(row, address);
  if (scope === null) return row;
  try {
    if (
      !row.fingerprint.startsWith(PREFIX) ||
      !/^[a-f0-9]{64}$/.test(row.fingerprint.slice(PREFIX.length)) ||
      row.result_json.length > MAX_BYTES ||
      Buffer.byteLength(row.result_json) > MAX_BYTES
    )
      throw invalid();
    const envelope: unknown = JSON.parse(row.result_json);
    if (
      !objectWithKeys(envelope, [
        "codec",
        "data",
        "rawBytes",
        "schemaVersion",
      ]) ||
      envelope.schemaVersion !== VERSION ||
      envelope.codec !== "deflate-raw" ||
      typeof envelope.rawBytes !== "number" ||
      !Number.isSafeInteger(envelope.rawBytes) ||
      envelope.rawBytes < 1 ||
      envelope.rawBytes > MAX_BYTES ||
      typeof envelope.data !== "string" ||
      envelope.data.length > MAX_BYTES
    )
      throw invalid();
    const compressed = Buffer.from(envelope.data, "base64");
    if (
      compressed.toString("base64") !== envelope.data ||
      compressed.length === 0
    )
      throw invalid();
    // Node 24 returns this shape for info:true; the pinned @types/node omits that overload.
    const inflated = inflateRawSync(compressed, {
      maxOutputLength: envelope.rawBytes,
      info: true,
    }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (
      inflated.engine.bytesWritten !== compressed.length ||
      inflated.buffer.length !== envelope.rawBytes ||
      PREFIX + digest(inflated.buffer) !== row.fingerprint
    )
      throw invalid();
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(inflated.buffer),
    );
    if (
      !objectWithKeys(body, ["fingerprint", "key", "resultJson", "scope"]) ||
      body.scope !== address.scope ||
      body.key !== address.key ||
      typeof body.fingerprint !== "string" ||
      typeof body.resultJson !== "string"
    )
      throw invalid();
    const decoded = {
      ...row,
      fingerprint: body.fingerprint,
      result_json: body.resultJson,
    };
    if (!executionFingerprint(decoded, address, scope)) throw invalid();
    return decoded;
  } catch (cause) {
    throw invalid(cause);
  }
}

function objectWithKeys(
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
function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
function invalid(cause?: unknown): RunStoreError {
  return new RunStoreError("idempotency_receipt_invalid", { cause });
}
