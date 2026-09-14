import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySoakToolReceipts } from "./tool-evidence.ts";
import { SOAK_READ_TOOL } from "./tool-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(mutate: (db: DatabaseSync) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "crewon-soak-receipts-"));
  roots.push(root);
  const directory = join(root, "profile/control-runtime-v1");
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "control.sqlite"));
  try {
    db.exec(
      "CREATE TABLE tool_execution_receipts (receipt_id TEXT PRIMARY KEY, tenant_id TEXT, run_id TEXT, status TEXT, state_json TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO tool_execution_receipts VALUES (?, ?, ?, ?, ?)",
    );
    for (let step = 1; step <= 4; step++)
      insert.run(
        `receipt-${step}`,
        "standalone-tenant",
        "run",
        "completed",
        JSON.stringify({
          executionId: `execution-${step}`,
          call: { name: SOAK_READ_TOOL, callId: `fixture_SOAK-tool-1_${step}` },
          result: { isError: false },
        }),
      );
    mutate(db);
  } finally {
    db.close();
  }
  return root;
}

describe("durable tool completion evidence", () => {
  it("requires four distinct successful executions bound to the requested run and marker", () => {
    const root = fixture();
    const receipts = verifySoakToolReceipts(root, "run", "SOAK-tool-1");
    expect(receipts).toHaveLength(4);
    expect(new Set(receipts.map((item) => item.executionId)).size).toBe(4);
    expect(() =>
      verifySoakToolReceipts(root, "another-run", "SOAK-tool-1"),
    ).toThrow("soak_tool_receipt_count_invalid");
    expect(() => verifySoakToolReceipts(root, "run", "SOAK-tool-2")).toThrow(
      "soak_tool_receipt_invalid",
    );
  });

  it.each([
    "DELETE FROM tool_execution_receipts WHERE receipt_id = 'receipt-4'",
    "UPDATE tool_execution_receipts SET tenant_id = 'another-tenant' WHERE receipt_id = 'receipt-4'",
    "UPDATE tool_execution_receipts SET status = 'dispatched' WHERE receipt_id = 'receipt-4'",
    "UPDATE tool_execution_receipts SET state_json = json_set(state_json, '$.result.isError', 1) WHERE receipt_id = 'receipt-4'",
    "UPDATE tool_execution_receipts SET state_json = json_set(state_json, '$.executionId', 'execution-1') WHERE receipt_id = 'receipt-4'",
    "UPDATE tool_execution_receipts SET state_json = json_set(state_json, '$.executionId', '') WHERE receipt_id = 'receipt-4'",
    "UPDATE tool_execution_receipts SET state_json = json_set(state_json, '$.call.callId', 'fixture_SOAK-tool-1_1') WHERE receipt_id = 'receipt-4'",
    "INSERT INTO tool_execution_receipts SELECT 'extra', tenant_id, run_id, status, state_json FROM tool_execution_receipts LIMIT 1",
  ])(
    "rejects incomplete, failed or conflicting persisted evidence: %s",
    (sql) => {
      const root = fixture((db) => db.exec(sql));
      expect(() => verifySoakToolReceipts(root, "run", "SOAK-tool-1")).toThrow(
        /soak_tool_/,
      );
    },
  );
});
