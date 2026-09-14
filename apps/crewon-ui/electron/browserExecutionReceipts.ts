import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseWorkspaceChangeSummary } from "@crewon/contracts";
import type { ToolExecutionResolution } from "@crewon/tool-broker";

const MAX_RECORD_BYTES = 32 * 1024;
const SCHEMA_VERSION = "crewon.browser-execution-receipt.v1";
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;

export type BrowserExecutionReceiptIdentity = Readonly<{
  executionId: string;
  actionDigest: string;
  runId: string;
}>;

type Receipt = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  identity: BrowserExecutionReceiptIdentity;
  resolution: ToolExecutionResolution | null;
}>;

export class BrowserExecutionReceiptsError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BrowserExecutionReceiptsError";
    this.code = code;
  }
}

/**
 * Main-process dispatch fences. A missing result never permits a second effect.
 * The host owns in-flight promise deduplication; even same-process reads of a
 * pending fence return unknownOutcome. Records are never evicted automatically.
 */
export class BrowserExecutionReceipts {
  readonly #directory: string;
  readonly #maxEntries: number;

  constructor(directory: string, options: { maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 2048;
    if (
      !Number.isSafeInteger(this.#maxEntries) ||
      this.#maxEntries < 1 ||
      this.#maxEntries > 65_536
    ) {
      fail("browser_receipt_capacity_invalid");
    }
    this.#directory = resolve(directory);
    storageOperation(() => {
      const firstCreated = mkdirSync(this.#directory, {
        recursive: true,
        mode: 0o700,
      });
      if (firstCreated !== undefined) {
        // Persist new directory entries as well as subsequent receipt entries.
        const stop = dirname(resolve(firstCreated));
        for (let current = this.#directory; ; current = dirname(current)) {
          syncDirectory(current);
          if (current === stop) break;
        }
      }
      this.#entryCount();
    });
  }

  read(
    executionId: string,
    actionDigest: string,
    runId: string,
  ): ToolExecutionResolution | null {
    const identity = parseIdentity({ executionId, actionDigest, runId });
    return storageOperation(() => {
      const receipt = this.#read(identity);
      return receipt === null ? null : resolutionFor(receipt);
    });
  }

  begin(identity: BrowserExecutionReceiptIdentity): {
    created: boolean;
    resolution: ToolExecutionResolution | null;
  } {
    const checked = parseIdentity(identity);
    return storageOperation(() => {
      const previous = this.#read(checked);
      if (previous !== null) {
        return { created: false, resolution: resolutionFor(previous) };
      }
      if (this.#entryCount() >= this.#maxEntries) {
        fail("browser_receipt_capacity_exceeded");
      }
      const created = this.#write(
        { schemaVersion: SCHEMA_VERSION, identity: checked, resolution: null },
        "create",
      );
      if (!created) {
        const concurrent = this.#read(checked);
        if (concurrent === null) fail("browser_receipt_storage_unavailable");
        return { created: false, resolution: resolutionFor(concurrent) };
      }
      return { created: true, resolution: null };
    });
  }

  complete(
    identity: BrowserExecutionReceiptIdentity,
    resolution: ToolExecutionResolution,
  ): void {
    const checked = parseIdentity(identity);
    const settled = parseResolution(resolution, checked.executionId);
    storageOperation(() => {
      const previous = this.#read(checked);
      if (previous === null) fail("browser_receipt_not_started");
      if (previous.resolution !== null) {
        if (JSON.stringify(previous.resolution) !== JSON.stringify(settled)) {
          fail("browser_receipt_resolution_conflict");
        }
        return;
      }
      this.#write({ ...previous, resolution: settled }, "replace");
    });
  }

  #path(executionId: string): string {
    return join(
      this.#directory,
      `${createHash("sha256").update(executionId).digest("hex")}.json`,
    );
  }

  #entryCount(): number {
    let count = 0;
    const directory = opendirSync(this.#directory);
    try {
      for (
        let entry = directory.readSync();
        entry;
        entry = directory.readSync()
      ) {
        if (!RECORD_NAME.test(entry.name)) continue;
        if (++count > this.#maxEntries)
          fail("browser_receipt_capacity_exceeded");
      }
      return count;
    } finally {
      directory.closeSync();
    }
  }

  #read(identity: BrowserExecutionReceiptIdentity): Receipt | null {
    let descriptor: number;
    try {
      descriptor = openSync(
        this.#path(identity.executionId),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) {
        fail("browser_receipt_record_invalid");
      }
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let count = 0;
      while (count < bytes.byteLength) {
        const received = readSync(
          descriptor,
          bytes,
          count,
          bytes.length - count,
          null,
        );
        if (received === 0) break;
        count += received;
      }
      if (count > MAX_RECORD_BYTES) fail("browser_receipt_record_invalid");
      let receipt: Receipt;
      try {
        receipt = parseReceipt(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(0, count),
            ),
          ),
        );
      } catch {
        fail("browser_receipt_record_invalid");
      }
      if (
        receipt.identity.executionId !== identity.executionId ||
        receipt.identity.actionDigest !== identity.actionDigest ||
        receipt.identity.runId !== identity.runId
      ) {
        fail("browser_receipt_identity_conflict");
      }
      return receipt;
    } finally {
      closeSync(descriptor);
    }
  }

  #write(receipt: Receipt, mode: "create" | "replace"): boolean {
    const content = Buffer.from(JSON.stringify(receipt));
    if (content.byteLength > MAX_RECORD_BYTES)
      fail("browser_receipt_record_too_large");
    const destination = this.#path(receipt.identity.executionId);
    const temporary = join(this.#directory, `.receipt-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);
    let created = true;
    try {
      try {
        writeFileSync(descriptor, content);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (mode === "replace") {
        renameSync(temporary, destination);
      } else {
        try {
          // Atomic exclusive publication cannot overwrite another dispatch fence.
          linkSync(temporary, destination);
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          created = false;
        }
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      syncDirectory(this.#directory);
    }
    return created;
  }
}

function resolutionFor(receipt: Receipt): ToolExecutionResolution {
  return (
    receipt.resolution ?? {
      status: "unknownOutcome",
      executionId: receipt.identity.executionId,
      providerReceiptId: null,
    }
  );
}

function parseReceipt(value: unknown): Receipt {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "identity", "resolution"]) ||
    value.schemaVersion !== SCHEMA_VERSION
  ) {
    fail("browser_receipt_record_invalid");
  }
  const identity = parseIdentity(value.identity);
  return {
    schemaVersion: SCHEMA_VERSION,
    identity,
    resolution:
      value.resolution === null
        ? null
        : parseResolution(value.resolution, identity.executionId),
  };
}

function parseIdentity(value: unknown): BrowserExecutionReceiptIdentity {
  if (
    !record(value) ||
    !exactKeys(value, ["executionId", "actionDigest", "runId"]) ||
    !opaqueId(value.executionId) ||
    !opaqueId(value.actionDigest) ||
    !opaqueId(value.runId)
  ) {
    fail("browser_receipt_identity_invalid");
  }
  return {
    executionId: value.executionId,
    actionDigest: value.actionDigest,
    runId: value.runId,
  };
}

function parseResolution(
  value: unknown,
  executionId: string,
): ToolExecutionResolution {
  if (!record(value) || value.executionId !== executionId)
    fail("browser_receipt_resolution_invalid");
  if (value.status === "canceled" || value.status === "unknownOutcome") {
    if (
      !exactKeys(value, ["status", "executionId", "providerReceiptId"]) ||
      !(value.providerReceiptId === null || opaqueId(value.providerReceiptId))
    )
      fail("browser_receipt_resolution_invalid");
    return {
      status: value.status,
      executionId,
      providerReceiptId: value.providerReceiptId,
    };
  }
  if (
    value.status !== "completed" ||
    !exactKeys(value, [
      "status",
      "executionId",
      "providerReceiptId",
      "result",
    ]) ||
    !opaqueId(value.providerReceiptId) ||
    !record(value.result)
  )
    fail("browser_receipt_resolution_invalid");
  const result = value.result;
  if (
    !exactKeys(
      result,
      ["schemaVersion", "callId", "output", "isError", "artifactRef"],
      ["workspaceChanges"],
    ) ||
    result.schemaVersion !== "crewon.tool-result.v0" ||
    !opaqueId(result.callId) ||
    typeof result.output !== "string" ||
    typeof result.isError !== "boolean" ||
    !(result.artifactRef === null || typeof result.artifactRef === "string")
  )
    fail("browser_receipt_resolution_invalid");
  return {
    status: "completed",
    executionId,
    providerReceiptId: value.providerReceiptId,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: result.callId,
      output: result.output,
      isError: result.isError,
      artifactRef: result.artifactRef,
      ...(result.workspaceChanges === undefined
        ? {}
        : {
            workspaceChanges: parseWorkspaceChangeSummary(
              result.workspaceChanges,
            ),
          }),
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

function opaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value)
  );
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hasCode(value: unknown, code: string): boolean {
  return record(value) && value.code === code;
}

function storageOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof BrowserExecutionReceiptsError) throw error;
    // Filesystem errors can contain host paths. Return only a stable public code.
    fail("browser_receipt_storage_unavailable");
  }
}

function fail(code: string): never {
  throw new BrowserExecutionReceiptsError(code);
}
