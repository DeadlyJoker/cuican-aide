import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolExecutionResolution } from "@crewon/tool-broker";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserExecutionReceipts,
  BrowserExecutionReceiptsError,
  type BrowserExecutionReceiptIdentity,
} from "./browserExecutionReceipts.ts";

const roots: string[] = [];
const identity: BrowserExecutionReceiptIdentity = {
  executionId: "execution-1",
  actionDigest: "sha256:1234",
  runId: "run-1",
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("BrowserExecutionReceipts", () => {
  it("distinguishes absent requests from pending fences, including same-process duplicates", () => {
    const receipts = new BrowserExecutionReceipts(directory());
    expect(read(receipts)).toBeNull();
    expect(receipts.begin(identity)).toEqual({
      created: true,
      resolution: null,
    });
    expect(read(receipts)).toEqual(unknownOutcome());
    expect(receipts.begin(identity)).toEqual({
      created: false,
      resolution: unknownOutcome(),
    });
    receipts.complete(identity, completed());
    expect(read(receipts)).toEqual(completed());
  });

  it("retains the dispatch fence after the dispatching process is killed", () => {
    const root = directory();
    const implementation = fileURLToPath(
      new URL("./browserExecutionReceipts.ts", import.meta.url),
    );
    const script = `
      import { BrowserExecutionReceipts } from ${JSON.stringify(implementation)};
      const receipts = new BrowserExecutionReceipts(${JSON.stringify(root)});
      receipts.begin(${JSON.stringify(identity)});
      process.kill(process.pid, "SIGKILL");
    `;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.signal).toBe("SIGKILL");
    const reopened = new BrowserExecutionReceipts(root);
    expect(read(reopened)).toEqual(unknownOutcome());
    expect(reopened.begin(identity)).toEqual({
      created: false,
      resolution: unknownOutcome(),
    });
  });

  it.each(["completed", "canceled", "unknownOutcome"] as const)(
    "persists %s results across reopening",
    (status) => {
      const root = directory();
      const receipts = new BrowserExecutionReceipts(root);
      receipts.begin(identity);
      const resolution: ToolExecutionResolution =
        status === "completed" ? completed() : { ...unknownOutcome(), status };
      receipts.complete(identity, resolution);
      const reopened = new BrowserExecutionReceipts(root);
      expect(read(reopened)).toEqual(resolution);
      expect(reopened.begin(identity)).toEqual({ created: false, resolution });
      expect(() => reopened.complete(identity, resolution)).not.toThrow();
    },
  );

  it("rejects digest and run changes before and after completion", () => {
    const receipts = new BrowserExecutionReceipts(directory());
    receipts.begin(identity);
    for (const conflict of [
      { ...identity, actionDigest: "sha256:other" },
      { ...identity, runId: "another-run" },
    ]) {
      expect(() => read(receipts, conflict)).toThrow(
        "browser_receipt_identity_conflict",
      );
      expect(() => receipts.begin(conflict)).toThrow(
        "browser_receipt_identity_conflict",
      );
      expect(() => receipts.complete(conflict, completed())).toThrow(
        "browser_receipt_identity_conflict",
      );
    }
    receipts.complete(identity, completed());
    expect(() => receipts.begin({ ...identity, runId: "another-run" })).toThrow(
      "browser_receipt_identity_conflict",
    );
    expect(read(receipts)).toEqual(completed());
  });

  it("refuses completion without a fence or with a different execution identity", () => {
    const receipts = new BrowserExecutionReceipts(directory());
    expect(() => receipts.complete(identity, completed())).toThrow(
      "browser_receipt_not_started",
    );
    receipts.begin(identity);
    expect(() =>
      receipts.complete(identity, {
        ...completed(),
        executionId: "execution-2",
      }),
    ).toThrow("browser_receipt_resolution_invalid");
    expect(read(receipts)).toEqual(unknownOutcome());
  });

  it("never replaces settled outcomes with contradictory results", () => {
    const receipts = new BrowserExecutionReceipts(directory());
    receipts.begin(identity);
    receipts.complete(identity, completed());
    expect(() => receipts.complete(identity, unknownOutcome())).toThrow(
      "browser_receipt_resolution_conflict",
    );
    expect(() =>
      receipts.complete(identity, completed("different result")),
    ).toThrow("browser_receipt_resolution_conflict");
    expect(read(receipts)).toEqual(completed());
  });

  it("reserves bounded capacity before dispatch and retains completed fences", () => {
    const root = directory();
    const receipts = new BrowserExecutionReceipts(root, { maxEntries: 1 });
    receipts.begin(identity);
    receipts.complete(identity, completed());
    const reopened = new BrowserExecutionReceipts(root, { maxEntries: 1 });
    expect(reopened.begin(identity).created).toBe(false);
    const second = { ...identity, executionId: "execution-2" };
    expect(() => reopened.begin(second)).toThrow(
      "browser_receipt_capacity_exceeded",
    );
    expect(read(reopened, second)).toBeNull();
    expect(read(reopened)).toEqual(completed());
    expect(readdirSync(root)).toHaveLength(1);
  });

  it.each([0, -1, 1.2, NaN, Infinity, 65_537])(
    "rejects invalid capacity %s",
    (maxEntries) => {
      expect(
        () => new BrowserExecutionReceipts(directory(), { maxEntries }),
      ).toThrow("browser_receipt_capacity_invalid");
    },
  );

  it("uses hashed filenames and private files rather than raw identities", () => {
    const root = directory();
    new BrowserExecutionReceipts(root).begin(identity);
    const [filename] = readdirSync(root);
    expect(filename).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(filename).not.toContain(identity.executionId);
    expect(statSync(join(root, filename)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(join(root, filename), "utf8")),
    ).toMatchObject({ identity, resolution: null });
  });

  it.each([
    "../outside",
    "with/slash",
    "with\\slash",
    "has space",
    "bad\nline",
    "",
    "x".repeat(257),
  ])("rejects unsafe opaque identity %j", (executionId) => {
    const receipts = new BrowserExecutionReceipts(directory());
    const invalid = { ...identity, executionId };
    expect(() => receipts.begin(invalid)).toThrow(
      "browser_receipt_identity_invalid",
    );
    expect(() => read(receipts, invalid)).toThrow(
      "browser_receipt_identity_invalid",
    );
  });

  it.each([
    "invalid json",
    "null",
    JSON.stringify({ schemaVersion: "wrong" }),
    "x".repeat(32 * 1024 + 1),
  ])("fails closed on corrupted or oversized records", (content) => {
    const root = directory();
    const receipts = new BrowserExecutionReceipts(root);
    receipts.begin(identity);
    writeFileSync(receiptPath(root), content);
    expect(() => read(receipts)).toThrow("browser_receipt_record_invalid");
    expect(() => receipts.begin(identity)).toThrow(
      "browser_receipt_record_invalid",
    );
    expect(readFileSync(receiptPath(root), "utf8")).toBe(content);
  });

  it("rejects non-file receipts without following symbolic links or exposing paths", () => {
    const root = directory();
    const outside = join(directory(), "private-data.json");
    writeFileSync(outside, "private-data");
    symlinkSync(outside, receiptPath(root));
    const receipts = new BrowserExecutionReceipts(root);
    let failure: unknown;
    try {
      read(receipts);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BrowserExecutionReceiptsError);
    expect((failure as Error).message).toBe(
      "browser_receipt_storage_unavailable",
    );
    expect((failure as Error).message).not.toContain(root);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("preserves an unknown fence when a completion exceeds the byte limit", () => {
    const receipts = new BrowserExecutionReceipts(directory());
    receipts.begin(identity);
    expect(() =>
      receipts.complete(identity, completed("界".repeat(12 * 1024))),
    ).toThrow("browser_receipt_record_too_large");
    expect(read(receipts)).toEqual(unknownOutcome());
    receipts.complete(identity, completed("bounded result"));
    expect(read(receipts)).toEqual(completed("bounded result"));
  });

  it("isolates stored results from caller mutations", () => {
    const receipts = new BrowserExecutionReceipts(directory());
    receipts.begin(identity);
    const result = completed();
    receipts.complete(identity, result);
    result.result.output = "caller mutation";
    const retrieved = read(receipts);
    expect(retrieved).toEqual(completed());
    if (retrieved?.status !== "completed")
      throw new Error("Expected completion");
    (retrieved.result as { output: string }).output = "reader mutation";
    expect(read(receipts)).toEqual(completed());
  });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "crewon-browser-receipts-"));
  roots.push(root);
  return root;
}

function receiptPath(root: string): string {
  return join(
    root,
    `${createHash("sha256").update(identity.executionId).digest("hex")}.json`,
  );
}

function read(
  receipts: BrowserExecutionReceipts,
  key = identity,
): ToolExecutionResolution | null {
  return receipts.read(key.executionId, key.actionDigest, key.runId);
}

function unknownOutcome() {
  return {
    status: "unknownOutcome" as const,
    executionId: identity.executionId,
    providerReceiptId: null,
  };
}

function completed(output = "download persisted") {
  return {
    status: "completed" as const,
    executionId: identity.executionId,
    providerReceiptId: "browser-receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0" as const,
      callId: "call-1",
      output,
      isError: false,
      artifactRef: "delivery-input-1",
    },
  };
}
