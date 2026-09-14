import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SOAK_READ_TOOL, SOAK_TOOL_STEPS } from "./tool-fixture.ts";

/** Bounded read of this runner's private database, never an application mutation. */
export function verifySoakToolReceipts(
  root: string,
  runId: string,
  marker: string,
) {
  const database = new DatabaseSync(
    join(root, "profile/control-runtime-v1/control.sqlite"),
    { readOnly: true },
  );
  try {
    database.exec("PRAGMA busy_timeout = 1000; PRAGMA query_only = ON");
    const receipts = database
      .prepare(
        `SELECT receipt_id AS receiptId, status,
      json_extract(state_json, '$.call.callId') AS callId,
      json_extract(state_json, '$.call.name') AS name,
      json_extract(state_json, '$.executionId') AS executionId,
      json_extract(state_json, '$.result.isError') AS isError
      FROM tool_execution_receipts WHERE tenant_id = 'standalone-tenant' AND run_id = ? LIMIT ?`,
      )
      .all(runId, SOAK_TOOL_STEPS + 1);
    const expected = new Set(
      Array.from(
        { length: SOAK_TOOL_STEPS },
        (_, index) => `fixture_${marker}_${index + 1}`,
      ),
    );
    if (receipts.length !== SOAK_TOOL_STEPS)
      throw new Error("soak_tool_receipt_count_invalid");
    for (const receipt of receipts) {
      if (
        receipt.status !== "completed" ||
        receipt.isError !== 0 ||
        receipt.name !== SOAK_READ_TOOL ||
        typeof receipt.callId !== "string" ||
        !expected.delete(receipt.callId) ||
        typeof receipt.executionId !== "string" ||
        !receipt.executionId ||
        typeof receipt.receiptId !== "string" ||
        !receipt.receiptId
      )
        throw new Error("soak_tool_receipt_invalid");
    }
    if (
      new Set(receipts.map((item) => item.executionId)).size !== SOAK_TOOL_STEPS
    )
      throw new Error("soak_tool_execution_identity_invalid");
    return receipts.map((item) => ({
      receiptId: item.receiptId as string,
      executionId: item.executionId as string,
      callId: item.callId as string,
    }));
  } finally {
    database.close();
  }
}
