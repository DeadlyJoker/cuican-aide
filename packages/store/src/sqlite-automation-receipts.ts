import type { DatabaseSync } from "node:sqlite";

import {
  RunStoreError,
  type AutomationCreateResult,
  type AutomationInvocationResult,
  type CommitAutomationCreateInput,
  type CommitAutomationInvocationInput,
} from "@crewon/application";

import {
  automationReceiptKey,
  validateAutomationCreateReceiptAuthority,
  validateAutomationInvocationReceiptAuthority,
  type StoredAutomationCreateReceipt,
  type StoredAutomationInvocationReceipt,
} from "./automation-store-support.ts";
import { stableJson } from "./store-invariants.ts";

type AutomationReceiptRow = Readonly<{
  tenant_id: string;
  automation_id: string;
  run_id?: string;
  fingerprint: string;
  result_json: string;
}>;

type InvocationAuthority = Parameters<
  typeof validateAutomationInvocationReceiptAuthority
>[1];

export function loadSqliteAutomationCreateReceipt(
  database: DatabaseSync,
  tenantId: string,
  idempotency: CommitAutomationCreateInput["idempotency"],
): StoredAutomationCreateReceipt | null {
  automationReceiptKey(tenantId, idempotency);
  const row = database
    .prepare(
      `SELECT tenant_id, automation_id, fingerprint, result_json
       FROM automation_create_receipts
       WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?`,
    )
    .get(tenantId, idempotency.scope, idempotency.key) as
    | AutomationReceiptRow
    | undefined;
  if (row === undefined) return null;
  return {
    tenantId: row.tenant_id,
    automationId: row.automation_id,
    fingerprint: row.fingerprint,
    result: parseStoredJson<AutomationCreateResult>(
      row.result_json,
      "automation_create_receipt_invalid",
    ),
  };
}

export function loadSqliteAutomationInvocationReceipt(
  database: DatabaseSync,
  tenantId: string,
  idempotency: CommitAutomationInvocationInput["idempotency"],
): StoredAutomationInvocationReceipt | null {
  automationReceiptKey(tenantId, idempotency);
  const row = database
    .prepare(
      `SELECT tenant_id, automation_id, run_id, fingerprint, result_json
       FROM automation_invocation_receipts
       WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?`,
    )
    .get(tenantId, idempotency.scope, idempotency.key) as
    | AutomationReceiptRow
    | undefined;
  if (row === undefined) return null;
  if (typeof row.run_id !== "string") {
    throw new RunStoreError("automation_invocation_receipt_invalid");
  }
  return {
    tenantId: row.tenant_id,
    automationId: row.automation_id,
    runId: row.run_id,
    fingerprint: row.fingerprint,
    result: parseStoredJson<AutomationInvocationResult>(
      row.result_json,
      "automation_invocation_receipt_invalid",
    ),
  };
}

export function validateSqliteAutomationCreateReceipt(
  receipt: StoredAutomationCreateReceipt,
  loadRecord: (automationId: string) => InvocationAuthority["record"],
): void {
  validateAutomationCreateReceiptAuthority(
    receipt,
    loadRecord(receipt.automationId),
  );
}

export function validateSqliteAutomationInvocationReceipt(
  receipt: StoredAutomationInvocationReceipt,
  loadAuthority: (
    receipt: StoredAutomationInvocationReceipt,
  ) => InvocationAuthority,
): void {
  validateAutomationInvocationReceiptAuthority(receipt, loadAuthority(receipt));
}

function parseStoredJson<T>(json: string, code: string): T {
  try {
    const parsed: unknown = JSON.parse(json);
    stableJson(parsed);
    return parsed as T;
  } catch (error) {
    throw new RunStoreError(code, { cause: error });
  }
}
