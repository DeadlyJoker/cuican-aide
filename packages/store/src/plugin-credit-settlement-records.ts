import {
  assertExtensionCreditAdmission,
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  parseExtensionRunBinding,
  parsePluginTaskAdmission,
  releaseCreditReservation,
  settleCreditReservation,
  validateCreditAccount,
  validateCreditReservation,
  validateCreditScope,
  type CreditAccount,
  type CreditReservation,
  type PluginTaskAdmission,
} from "@crewon/domain";
import {
  type PluginCreditSettlementDecision,
  type PluginCreditSettlementEvidence,
  type PluginCreditSettlementFinalization,
  type PluginCreditSettlementLocator,
} from "@crewon/application";
import { decodeExtensionCreditAdmission } from "./extension-credit-admission-records.ts";
import {
  extensionStoreDigester,
  parseExtensionTaskReceipt,
  parseExtensionTurnReceipt,
} from "./extension-store-records.ts";
import {
  assertCreditReservationReplay,
  assertCreditScope,
  creditAmount,
  decodeCreditAccount,
  decodeCreditReservation,
} from "./plugin-credit-support.ts";

import {
  assertSettlementRunTarget,
  readSettlementExecution,
} from "./plugin-credit-settlement-execution-records.ts";
import {
  allowed,
  bounded,
  fail,
  hash,
  indexed,
  indexedScope,
  integer,
  json,
  optionalRow,
  record,
  requiredRow,
  same,
  sorted,
  versions,
} from "./plugin-credit-settlement-support.ts";

export const SETTLEMENT_COLLECTION_LIMIT = 64;
export type SettlementRow = Readonly<Record<string, unknown>>;
export type SettlementEvidenceRows = Readonly<{
  admissionRow?: SettlementRow;
  bindingRow?: SettlementRow;
  taskReceiptRow?: SettlementRow;
  runRow?: SettlementRow;
  accountRow?: SettlementRow;
  reservationRow?: SettlementRow;
  installedAdmission: PluginTaskAdmission | null;
  creditVersions: readonly SettlementRow[];
  admissionVersions: readonly SettlementRow[];
  operations: readonly SettlementRow[];
  toolReceipts: readonly SettlementRow[];
  steps: readonly SettlementRow[];
  attempts: readonly SettlementRow[];
  workItems: readonly SettlementRow[];
}>;
export type SettlementSnapshot = Readonly<{
  evidence: PluginCreditSettlementEvidence;
  account: CreditAccount;
  reservation: CreditReservation;
}>;

const decisionVersion = "crewon.plugin-credit-settlement-decision.v1";
const finalizationVersion = "crewon.plugin-credit-settlement-finalization.v1";

export function parseSettlementLocator(
  input: unknown,
): PluginCreditSettlementLocator {
  const value = record(input, ["tenantId", "runId"]);
  return Object.freeze({
    tenantId: extensionOpaqueId(value.tenantId),
    runId: extensionOpaqueId(value.runId),
  });
}

export function parseSettlementDecision(
  input: unknown,
): PluginCreditSettlementDecision {
  const value = record(json(input, 8192), [
    "schemaVersion",
    "evidenceDigest",
    "authorityId",
    "authorityRevision",
    "decisionId",
    "outcome",
  ]);
  if (value.schemaVersion !== decisionVersion)
    fail("plugin_credit_settlement_decision_version_unsupported");
  const outcome = record(value.outcome);
  let parsed: PluginCreditSettlementDecision["outcome"];
  if (outcome.kind === "settle") {
    record(outcome, ["kind", "actualCredits"]);
    parsed = Object.freeze({
      kind: "settle",
      actualCredits: creditAmount(outcome.actualCredits),
    });
  } else if (outcome.kind === "release") {
    record(outcome, ["kind"]);
    parsed = Object.freeze({ kind: "release" });
  } else fail("plugin_credit_settlement_decision_invalid");
  return Object.freeze({
    schemaVersion: decisionVersion,
    evidenceDigest: extensionDigest(value.evidenceDigest),
    authorityId: extensionOpaqueId(value.authorityId),
    authorityRevision: extensionOpaqueId(value.authorityRevision),
    decisionId: extensionOpaqueId(value.decisionId),
    outcome: parsed,
  });
}

export function parseSettlementFinalization(
  input: unknown,
  inputLocator: PluginCreditSettlementLocator,
): PluginCreditSettlementFinalization {
  const locator = parseSettlementLocator(inputLocator);
  const value = record(json(input, 24 * 1024), [
    "schemaVersion",
    "locator",
    "scope",
    "reservationId",
    "bindingDigest",
    "admissionDigest",
    "priceRevision",
    "quotedCredits",
    "decision",
    "account",
    "reservation",
  ]);
  if (value.schemaVersion !== finalizationVersion)
    fail("plugin_credit_settlement_finalization_version_unsupported");
  const savedLocator = parseSettlementLocator(value.locator);
  same(locator, savedLocator);
  const scope = validateCreditScope(value.scope);
  const account = validateCreditAccount(value.account);
  const reservation = validateCreditReservation(value.reservation);
  const decision = parseSettlementDecision(value.decision);
  assertCreditScope(scope, account.scope);
  assertCreditScope(scope, reservation.scope);
  if (
    scope.tenantId !== locator.tenantId ||
    reservation.reservationId !== locator.runId ||
    reservation.reservationId !== value.reservationId ||
    reservation.priceRevision !== integer(value.priceRevision, 1) ||
    reservation.quotedCredits !== creditAmount(value.quotedCredits, "positive")
  )
    fail();
  if (
    decision.outcome.kind === "settle"
      ? reservation.state !== "settled" ||
        reservation.settledCredits !== decision.outcome.actualCredits
      : reservation.state !== "released" || reservation.settledCredits !== "0"
  )
    fail("plugin_credit_settlement_finalization_outcome_invalid");
  return Object.freeze({
    schemaVersion: finalizationVersion,
    locator,
    scope,
    reservationId: reservation.reservationId,
    bindingDigest: extensionDigest(value.bindingDigest),
    admissionDigest: extensionDigest(value.admissionDigest),
    priceRevision: reservation.priceRevision,
    quotedCredits: reservation.quotedCredits,
    decision,
    account,
    reservation,
  });
}

export function createSettlementFinalization(
  snapshot: SettlementSnapshot,
  inputDecision: PluginCreditSettlementDecision,
  next: Readonly<{ account: CreditAccount; reservation: CreditReservation }>,
): PluginCreditSettlementFinalization {
  const decision = parseSettlementDecision(inputDecision);
  if (
    !snapshot.evidence.readyToFinalize ||
    snapshot.reservation.state !== "reserved"
  )
    fail("plugin_credit_settlement_not_ready");
  if (decision.evidenceDigest !== snapshot.evidence.evidenceDigest)
    fail("plugin_credit_settlement_evidence_changed");
  const expected =
    decision.outcome.kind === "settle"
      ? settleCreditReservation(
          snapshot.account,
          snapshot.reservation,
          decision.outcome.actualCredits,
        )
      : releaseCreditReservation(snapshot.account, snapshot.reservation);
  same(expected, {
    account: validateCreditAccount(next.account),
    reservation: validateCreditReservation(next.reservation),
  });
  const evidence = snapshot.evidence;
  return parseSettlementFinalization(
    {
      schemaVersion: finalizationVersion,
      locator: evidence.locator,
      scope: evidence.scope,
      reservationId: evidence.reservationId,
      bindingDigest: evidence.bindingDigest,
      admissionDigest: evidence.admissionDigest,
      priceRevision: evidence.priceRevision,
      quotedCredits: evidence.quotedCredits,
      decision,
      ...expected,
    },
    evidence.locator,
  );
}

export function assertSettlementReplay(
  saved: PluginCreditSettlementFinalization,
  inputDecision: PluginCreditSettlementDecision,
): void {
  const finalization = parseSettlementFinalization(saved, saved.locator);
  const decision = parseSettlementDecision(inputDecision);
  if (
    extensionCanonicalJson(finalization.decision) !==
    extensionCanonicalJson(decision)
  )
    fail("plugin_credit_settlement_decision_conflict");
}

/** A paid receipt is immutable historical evidence, never a new quote or grant. */
export function buildSettlementSnapshot(
  inputLocator: PluginCreditSettlementLocator,
  inputRows: SettlementEvidenceRows,
): SettlementSnapshot | null {
  const locator = parseSettlementLocator(inputLocator);
  const rowRecord = record(inputRows);
  allowed(rowRecord, [
    "admissionRow",
    "bindingRow",
    "taskReceiptRow",
    "runRow",
    "accountRow",
    "reservationRow",
    "installedAdmission",
    "creditVersions",
    "admissionVersions",
    "operations",
    "toolReceipts",
    "steps",
    "attempts",
    "workItems",
  ]);
  const rows = rowRecord as unknown as SettlementEvidenceRows;
  for (const name of [
    "operations",
    "toolReceipts",
    "steps",
    "attempts",
    "workItems",
    "creditVersions",
    "admissionVersions",
  ] as const)
    bounded(rows[name]);
  const admissionRow = optionalRow(rows.admissionRow);
  const taskRow = optionalRow(rows.taskReceiptRow);
  if (admissionRow === undefined) {
    if (
      taskRow !== undefined &&
      Object.hasOwn(
        record(json(taskRow.result_json, 2 * 1024 * 1024)),
        "creditAdmission",
      )
    )
      fail("plugin_credit_settlement_admission_missing");
    return null;
  }
  versions(rows.creditVersions);
  versions(rows.admissionVersions);
  const admission = decodeExtensionCreditAdmission({
    tenant_id: admissionRow.tenant_id,
    space_id: admissionRow.space_id,
    run_id: admissionRow.run_id,
    principal_id: admissionRow.principal_id,
    pool_id: admissionRow.pool_id,
    reservation_id: admissionRow.reservation_id,
    admission_json: json(admissionRow.admission_json, 8192),
  });
  if (
    admission === null ||
    admission.tenantId !== locator.tenantId ||
    admission.runId !== locator.runId
  )
    fail();
  const bindingRow = requiredRow(rows.bindingRow);
  const binding = parseExtensionRunBinding(
    json(bindingRow.binding_json, 8192),
    extensionStoreDigester,
  );
  indexed(bindingRow, binding, {
    tenant_id: "tenantId",
    space_id: "spaceId",
    plugin_id: "pluginId",
    run_id: "runId",
    configuration_revision: "configurationRevision",
  });
  if (taskRow === undefined)
    fail("plugin_credit_settlement_task_receipt_missing");
  const command = {
    actorId: extensionOpaqueId(taskRow.actor_id),
    idempotencyKey: extensionOpaqueId(taskRow.idempotency_key),
    requestDigest: extensionDigest(taskRow.request_digest),
  };
  if (taskRow.kind !== "task") fail();
  indexed(taskRow, binding, {
    tenant_id: "tenantId",
    space_id: "spaceId",
    plugin_id: "pluginId",
    actor_id: "actorId",
  });
  assertExtensionCreditAdmission(
    { admission, binding, receipt: command },
    extensionStoreDigester,
  );
  const receiptRecord = record(json(taskRow.result_json, 2 * 1024 * 1024));
  record(
    receiptRecord,
    receiptRecord.schemaVersion === "crewon.extension-turn-admission.v0"
      ? ["schemaVersion", "binding", "creditAdmission", "turn", "run"]
      : ["binding", "creditAdmission", "run"],
  );
  const receipt =
    receiptRecord.schemaVersion === "crewon.extension-turn-admission.v0"
      ? parseExtensionTurnReceipt(receiptRecord, binding, command)
      : parseExtensionTaskReceipt(receiptRecord, binding, command);
  if (receipt.creditAdmission === undefined)
    fail("plugin_credit_settlement_paid_receipt_required");
  same(receipt.creditAdmission, admission);
  same(receipt.binding, binding);
  assertSettlementRunTarget(receipt.run.state, binding);
  const installed =
    rows.installedAdmission === null
      ? null
      : parsePluginTaskAdmission(rows.installedAdmission);
  if (installed !== null) {
    assertPluginTaskAdmission(
      { admission: installed, binding, receipt: command },
      extensionStoreDigester,
    );
    if (installed.principalId !== admission.reservation.scope.principalId)
      fail("plugin_credit_settlement_payer_mismatch");
  }
  const scope = admission.reservation.scope;
  const accountRow = requiredRow(rows.accountRow);
  const reservationRow = requiredRow(rows.reservationRow);
  indexedScope(accountRow, scope);
  indexedScope(reservationRow, scope);
  const account = decodeCreditAccount(
    {
      revision: accountRow.revision,
      account_json: json(accountRow.account_json, 4096),
    },
    scope,
  );
  const reservation = decodeCreditReservation(
    {
      reservation_id: reservationRow.reservation_id,
      idempotency_key: reservationRow.idempotency_key,
      record_json: json(reservationRow.record_json, 8192),
    },
    scope,
  );
  if (account === null || reservation === null)
    fail("plugin_credit_settlement_hold_missing");
  assertCreditReservationReplay(reservation, admission.reservation);
  if (
    reservation.state === "reserved" &&
    BigInt(account.reservedCredits) < BigInt(reservation.quotedCredits)
  )
    fail("plugin_credit_settlement_hold_invalid");
  const {
    run,
    steps,
    attempts,
    workItems,
    tools,
    operations,
    readyToFinalize: executionReady,
  } = readSettlementExecution(locator, binding, rows);
  const mutations = tools.filter((tool) => tool.effect === "mutation");
  const readyToFinalize =
    installed !== null && reservation.state === "reserved" && executionReady;
  const body = {
    schemaVersion: "crewon.plugin-credit-settlement-evidence.v1" as const,
    locator,
    spaceId: binding.spaceId,
    actorId: binding.actorId,
    pluginId: binding.pluginId,
    bindingDigest: binding.bindingDigest,
    admissionDigest: hash(admission),
    taskReceiptDigest: hash(receiptRecord),
    installedAdmissionDigest: installed === null ? null : hash(installed),
    scope,
    reservationId: reservation.reservationId,
    priceRevision: reservation.priceRevision,
    quotedCredits: reservation.quotedCredits,
    run: Object.freeze({
      revision: run.revision,
      status: run.status,
      terminalAt: run.terminalAt,
      cancelRequested: run.cancelRequested,
    }),
    operations: sorted(
      operations.map((operation) =>
        Object.freeze({
          operationId: operation.operationId,
          revision: operation.revision,
          status: operation.status,
          recordDigest: hash(operation),
        }),
      ),
      "operationId",
    ),
    mutationReceipts: sorted(
      mutations.map((tool) =>
        Object.freeze({
          receiptId: tool.receiptId,
          status: tool.status,
          revision: tool.revision,
          dispatchedAt: tool.dispatchedAt,
          resultDigest: tool.result?.outputDigest ?? null,
          recordDigest: hash(tool),
        }),
      ),
      "receiptId",
    ),
    attempts: sorted(
      attempts.map((attempt) =>
        Object.freeze({
          attemptId: attempt.attemptId,
          status: attempt.status,
          recordDigest: hash(attempt),
        }),
      ),
      "attemptId",
    ),
    workItems: sorted(
      workItems.map((item) =>
        Object.freeze({
          workItemId: item.workItemId,
          status: item.status,
          leaseEpoch: item.leaseEpoch,
          recordDigest: hash(item),
        }),
      ),
      "workItemId",
    ),
    readyToFinalize,
  };
  // All observations, including read-only receipts and Step state, participate in the CAS digest.
  // The current account revision is deliberately absent: unrelated grants/holds do not change this Run's evidence.
  const evidenceDigest = hash({
    ...body,
    runRecordDigest: hash(run),
    reservationRecordDigest: hash(reservation),
    steps: sorted(
      steps.map((step) => ({ stepId: step.stepId, recordDigest: hash(step) })),
      "stepId",
    ),
    toolReceipts: sorted(
      tools.map((tool) => ({
        receiptId: tool.receiptId,
        recordDigest: hash(tool),
      })),
      "receiptId",
    ),
  });
  return Object.freeze({
    evidence: Object.freeze({ ...body, evidenceDigest }),
    account,
    reservation,
  });
}
