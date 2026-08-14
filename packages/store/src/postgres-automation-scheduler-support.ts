import { createHash } from "node:crypto";

import {
  RunStoreError,
  type AutomationDefinitionRecord,
  type AutomationScheduleClaimInput,
  type AutomationScheduleLeaseInput,
  type RetryAutomationScheduleClaimInput,
  type ScheduledAutomationReceiptQuery,
} from "@crewon/application";

import { requireNonEmpty, stableJson } from "./store-invariants.ts";

export function validateAutomationScheduleClaimInput(
  input: AutomationScheduleClaimInput,
): void {
  requireNonEmpty(input.ownerId, "automation_schedule_owner_invalid");
  requireNonEmpty(input.leaseId, "automation_schedule_lease_id_invalid");
  validateTimestamp(
    input.observedAt,
    "automation_schedule_observed_at_invalid",
  );
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > 24 * 60 * 60 * 1_000
  ) {
    throw new RunStoreError("automation_schedule_lease_duration_invalid");
  }
}

export function validateAutomationScheduleLease(
  input:
    | AutomationScheduleLeaseInput
    | RetryAutomationScheduleClaimInput
    | (AutomationScheduleLeaseInput & Readonly<{ reasonCode: string }>),
): void {
  requireNonEmpty(input.tenantId, "tenant_id_invalid");
  requireNonEmpty(input.automationId, "automation_id_invalid");
  requireNonEmpty(input.ownerId, "automation_schedule_owner_invalid");
  requireNonEmpty(input.leaseId, "automation_schedule_lease_id_invalid");
  validateTimestamp(input.scheduledFor, "automation_scheduled_for_invalid");
  if ("reasonCode" in input)
    requireNonEmpty(input.reasonCode, "automation_schedule_reason_invalid");
  if ("retryAt" in input)
    validateTimestamp(input.retryAt, "automation_schedule_retry_at_invalid");
  if (
    input.scheduleRevision !== 1 ||
    !Number.isSafeInteger(input.leaseEpoch) ||
    input.leaseEpoch < 1
  ) {
    throw new RunStoreError("automation_schedule_lease_invalid");
  }
}

export function validateScheduledAutomationReceiptQuery(
  query: ScheduledAutomationReceiptQuery,
): void {
  requireNonEmpty(query.tenantId, "tenant_id_invalid");
  requireNonEmpty(query.automationId, "automation_id_invalid");
  requireNonEmpty(
    query.occurrenceDigest,
    "automation_occurrence_digest_invalid",
  );
  validateTimestamp(query.scheduledFor, "automation_scheduled_for_invalid");
  if (
    query.scheduleRevision !== 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(query.occurrenceDigest)
  ) {
    throw new RunStoreError("automation_scheduled_receipt_query_invalid");
  }
}

export function scheduleOccurrenceDigest(
  record: AutomationDefinitionRecord,
  scheduledFor: string,
): string {
  return `sha256:${createHash("sha256")
    .update(
      stableJson({
        schemaVersion: "crewon.automation-schedule-occurrence.v1",
        automationId: record.definition.automationId,
        scheduleRevision: record.scheduleState.scheduleRevision,
        scheduledFor,
        definitionDigest: record.definitionDigest,
      }),
    )
    .digest("hex")}`;
}

export function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) invalidAutomationScheduleState();
  return parsed.toISOString();
}

export function invalidAutomationScheduleState(): never {
  throw new RunStoreError("automation_schedule_state_invalid");
}

function validateTimestamp(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new RunStoreError(code);
}
