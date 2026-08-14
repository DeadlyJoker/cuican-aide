import {
  latestAutomationScheduleOccurrence,
  RunStoreError,
  type AutomationDefinitionRecord,
  type AutomationInvocationResult,
  type AutomationScheduleClaim,
  type AutomationScheduleClaimInput,
  type AutomationScheduleLeaseInput,
  type CommitScheduledAutomationInvocationInput,
  type RetryAutomationScheduleClaimInput,
  type ScheduledAutomationReceiptQuery,
} from "@crewon/application";
import { parseAutomationScheduleState } from "@crewon/domain";
import type { Pool, PoolClient } from "pg";

import {
  automationPostgresError,
  decodeAutomationRow,
  replayInvocationReceiptInTransaction,
  type AutomationRow,
} from "./postgres-automation-context.ts";
import { commitPostgresAutomationInvocationInTransaction } from "./postgres-automation-transaction.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import { stableJson } from "./store-invariants.ts";
import { safeInteger } from "./postgres-thread-codec.ts";
import {
  invalidAutomationScheduleState,
  scheduleOccurrenceDigest,
  timestamp,
  validateAutomationScheduleClaimInput,
  validateAutomationScheduleLease,
  validateScheduledAutomationReceiptQuery,
} from "./postgres-automation-scheduler-support.ts";

type ScheduleClaimRow = AutomationRow &
  Readonly<{ claim_epoch: string | number | null }>;

type StoredScheduleClaimRow = Readonly<{
  tenant_id: string;
  automation_id: string;
  schedule_revision: string | number;
  scheduled_for: Date | string;
  occurrence_digest: string;
  observed_at: Date | string;
  lease_owner_id: string;
  lease_id: string;
  lease_epoch: string | number;
  lease_expires_at: Date | string;
}>;

type ScheduledReceiptRow = Readonly<{
  tenant_id: string;
  automation_id: string;
  schedule_revision: string | number;
  scheduled_for: Date | string;
  occurrence_digest: string;
  invocation_scope: string;
  invocation_key: string;
  fingerprint: string;
}>;

export async function claimNextDuePostgresAutomation(
  pool: Pool,
  schema: string,
  input: AutomationScheduleClaimInput,
): Promise<AutomationScheduleClaim | null> {
  validateAutomationScheduleClaimInput(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<ScheduleClaimRow>(
      `SELECT a.tenant_id, a.space_id, a.automation_id, a.thread_id,
              a.revision, a.definition_digest, a.definition_json,
              a.schedule_state_json, a.updated_at,
              c.lease_epoch AS claim_epoch
       FROM ${schema}.automations AS a
       LEFT JOIN ${schema}.automation_schedule_claims AS c
         ON c.tenant_id=a.tenant_id AND c.automation_id=a.automation_id
       WHERE a.schedule_state_json->>'status'='enabled'
         AND a.schedule_state_json->>'nextOccurrenceAt' IS NOT NULL
         AND COALESCE(
               NULLIF(a.schedule_state_json->>'retryAt', '')::timestamptz,
               (a.schedule_state_json->>'nextOccurrenceAt')::timestamptz
             ) <= $1::timestamptz
         AND (c.lease_expires_at IS NULL OR c.lease_expires_at <= $1::timestamptz)
       ORDER BY COALESCE(
                  NULLIF(a.schedule_state_json->>'retryAt', '')::timestamptz,
                  (a.schedule_state_json->>'nextOccurrenceAt')::timestamptz
                ), a.automation_id COLLATE "C"
       FOR UPDATE OF a SKIP LOCKED
       LIMIT 1`,
      [input.observedAt],
    );
    const row = selected.rows[0];
    if (row === undefined) {
      await client.query("COMMIT");
      return null;
    }
    const record = decodeAutomationRow(row);
    const nextOccurrenceAt = record.scheduleState.nextOccurrenceAt;
    if (nextOccurrenceAt === null) invalidAutomationScheduleState();
    const scheduledFor =
      record.scheduleState.retryAt === null
        ? latestAutomationScheduleOccurrence({
            schedule: record.definition.schedule,
            through: input.observedAt,
          })
        : nextOccurrenceAt;
    if (
      scheduledFor === null ||
      Date.parse(scheduledFor) < Date.parse(nextOccurrenceAt)
    ) {
      invalidAutomationScheduleState();
    }
    const occurrenceDigest = scheduleOccurrenceDigest(record, scheduledFor);
    const leaseEpoch =
      (row.claim_epoch === null ? 0 : safeInteger(row.claim_epoch)) + 1;
    const expiresAt = new Date(
      Date.parse(input.observedAt) + input.leaseDurationMs,
    ).toISOString();
    await client.query(
      `INSERT INTO ${schema}.automation_schedule_claims (
         tenant_id, automation_id, schedule_revision, scheduled_for,
         occurrence_digest, observed_at, lease_owner_id, lease_id,
         lease_epoch, lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, automation_id) DO UPDATE SET
         schedule_revision=EXCLUDED.schedule_revision,
         scheduled_for=EXCLUDED.scheduled_for,
         occurrence_digest=EXCLUDED.occurrence_digest,
         observed_at=EXCLUDED.observed_at,
         lease_owner_id=EXCLUDED.lease_owner_id,
         lease_id=EXCLUDED.lease_id,
         lease_epoch=EXCLUDED.lease_epoch,
         lease_expires_at=EXCLUDED.lease_expires_at`,
      [
        record.definition.tenantId,
        record.definition.automationId,
        record.scheduleState.scheduleRevision,
        scheduledFor,
        occurrenceDigest,
        input.observedAt,
        input.ownerId,
        input.leaseId,
        leaseEpoch,
        expiresAt,
      ],
    );
    await client.query("COMMIT");
    return {
      record,
      scheduledFor,
      observedAt: input.observedAt,
      occurrenceDigest,
      lease: {
        ownerId: input.ownerId,
        leaseId: input.leaseId,
        epoch: leaseEpoch,
        expiresAt,
      },
    };
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}

export async function loadPostgresScheduledAutomationReceipt(
  pool: Pool,
  schema: string,
  query: ScheduledAutomationReceiptQuery,
): Promise<AutomationInvocationResult | null> {
  validateScheduledAutomationReceiptQuery(query);
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const result = await loadScheduledReceiptInTransaction(
      client,
      schema,
      query,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}

export async function commitPostgresScheduledAutomationInvocation(
  pool: Pool,
  schema: string,
  input: CommitScheduledAutomationInvocationInput,
): Promise<AutomationInvocationResult> {
  validateScheduledAutomationReceiptQuery(input.receipt);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prior = await loadScheduledReceiptInTransaction(
      client,
      schema,
      input.receipt,
    );
    if (prior !== null) {
      await client.query("COMMIT");
      return prior;
    }
    const { claim, record } = await requireScheduleLease(
      client,
      schema,
      input.lease,
    );
    const nextState = parseAutomationScheduleState(input.nextScheduleState);
    if (
      record.definitionDigest !== input.expectedDefinitionDigest ||
      record.scheduleState.revision !== input.expectedScheduleStateRevision ||
      claim.occurrence_digest !== input.receipt.occurrenceDigest ||
      input.receipt.tenantId !== record.definition.tenantId ||
      input.receipt.automationId !== record.definition.automationId ||
      input.receipt.scheduleRevision !==
        record.scheduleState.scheduleRevision ||
      input.receipt.scheduledFor !== timestamp(claim.scheduled_for) ||
      nextState.automationId !== record.definition.automationId ||
      nextState.scheduleRevision !== record.scheduleState.scheduleRevision ||
      nextState.revision !== record.scheduleState.revision + 1 ||
      nextState.lastScheduledFor !== timestamp(claim.scheduled_for) ||
      nextState.retryAt !== null ||
      input.invocation.binding.trigger.kind !== "schedule" ||
      input.invocation.binding.trigger.scheduleRevision !==
        safeInteger(claim.schedule_revision) ||
      input.invocation.binding.trigger.scheduledFor !==
        timestamp(claim.scheduled_for) ||
      input.invocation.binding.trigger.occurrenceDigest !==
        claim.occurrence_digest
    ) {
      throw new RunStoreError("automation_schedule_commit_invalid");
    }
    const result = await commitPostgresAutomationInvocationInTransaction(
      client,
      schema,
      input.invocation,
    );
    const updated = await client.query(
      `UPDATE ${schema}.automations SET schedule_state_json=$1::jsonb
       WHERE tenant_id=$2 AND automation_id=$3 AND definition_digest=$4`,
      [
        stableJson(nextState),
        record.definition.tenantId,
        record.definition.automationId,
        record.definitionDigest,
      ],
    );
    if (updated.rowCount !== 1)
      throw new RunStoreError("automation_schedule_commit_invalid");
    await client.query(
      `INSERT INTO ${schema}.automation_scheduled_invocation_receipts (
         tenant_id, automation_id, schedule_revision, scheduled_for,
         occurrence_digest, invocation_scope, invocation_key, run_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.receipt.tenantId,
        input.receipt.automationId,
        input.receipt.scheduleRevision,
        input.receipt.scheduledFor,
        input.receipt.occurrenceDigest,
        input.invocation.idempotency.scope,
        input.invocation.idempotency.key,
        result.runState.runId,
      ],
    );
    await deleteScheduleClaim(client, schema, claim);
    await client.query("COMMIT");
    return structuredClone(result);
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}

export async function retryPostgresAutomationScheduleClaim(
  pool: Pool,
  schema: string,
  input: RetryAutomationScheduleClaimInput,
): Promise<void> {
  validateAutomationScheduleLease(input);
  await settleScheduleClaim(pool, schema, input, "retry");
}

export async function disablePostgresAutomationScheduleClaim(
  pool: Pool,
  schema: string,
  input: AutomationScheduleLeaseInput & Readonly<{ reasonCode: string }>,
): Promise<void> {
  validateAutomationScheduleLease(input);
  await settleScheduleClaim(pool, schema, input, "disable");
}

async function loadScheduledReceiptInTransaction(
  client: PoolClient,
  schema: string,
  query: ScheduledAutomationReceiptQuery,
): Promise<AutomationInvocationResult | null> {
  const result = await client.query<ScheduledReceiptRow>(
    `SELECT scheduled.tenant_id, scheduled.automation_id,
            scheduled.schedule_revision, scheduled.scheduled_for,
            scheduled.occurrence_digest, scheduled.invocation_scope,
            scheduled.invocation_key, invocation.fingerprint
     FROM ${schema}.automation_scheduled_invocation_receipts AS scheduled
     JOIN ${schema}.automation_invocation_receipts AS invocation
       ON invocation.tenant_id=scheduled.tenant_id
      AND invocation.scope=scheduled.invocation_scope
      AND invocation.idempotency_key=scheduled.invocation_key
     WHERE scheduled.tenant_id=$1 AND scheduled.automation_id=$2
       AND scheduled.schedule_revision=$3 AND scheduled.scheduled_for=$4`,
    [
      query.tenantId,
      query.automationId,
      query.scheduleRevision,
      query.scheduledFor,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const replay = await replayInvocationReceiptInTransaction(client, schema, {
    tenantId: query.tenantId,
    automationId: query.automationId,
    idempotency: {
      scope: row.invocation_scope,
      key: row.invocation_key,
      requestFingerprint: row.fingerprint,
    },
  });
  const trigger = replay.binding.trigger;
  if (
    row.tenant_id !== query.tenantId ||
    row.automation_id !== query.automationId ||
    safeInteger(row.schedule_revision) !== query.scheduleRevision ||
    timestamp(row.scheduled_for) !== query.scheduledFor ||
    row.occurrence_digest !== query.occurrenceDigest ||
    trigger.kind !== "schedule" ||
    trigger.scheduleRevision !== query.scheduleRevision ||
    trigger.scheduledFor !== query.scheduledFor ||
    trigger.occurrenceDigest !== query.occurrenceDigest
  ) {
    throw new RunStoreError("automation_scheduled_receipt_invalid");
  }
  return { ...replay, disposition: "replayed" };
}

async function requireScheduleLease(
  client: PoolClient,
  schema: string,
  input: AutomationScheduleLeaseInput,
): Promise<{
  claim: StoredScheduleClaimRow;
  record: AutomationDefinitionRecord;
}> {
  validateAutomationScheduleLease(input);
  const result = await client.query<StoredScheduleClaimRow & AutomationRow>(
    `SELECT c.tenant_id, c.automation_id, c.schedule_revision,
            c.scheduled_for, c.occurrence_digest, c.observed_at,
            c.lease_owner_id, c.lease_id, c.lease_epoch, c.lease_expires_at,
            a.space_id, a.thread_id, a.revision, a.definition_digest,
            a.definition_json, a.schedule_state_json, a.updated_at
     FROM ${schema}.automation_schedule_claims AS c
     JOIN ${schema}.automations AS a
       ON a.tenant_id=c.tenant_id AND a.automation_id=c.automation_id
     WHERE c.tenant_id=$1 AND c.automation_id=$2
     FOR UPDATE OF c, a`,
    [input.tenantId, input.automationId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    safeInteger(row.schedule_revision) !== input.scheduleRevision ||
    timestamp(row.scheduled_for) !== input.scheduledFor ||
    row.lease_owner_id !== input.ownerId ||
    row.lease_id !== input.leaseId ||
    safeInteger(row.lease_epoch) !== input.leaseEpoch
  ) {
    throw new RunStoreError("automation_schedule_lease_lost");
  }
  const record = decodeAutomationRow(row);
  if (
    record.definition.tenantId !== input.tenantId ||
    record.scheduleState.scheduleRevision !== input.scheduleRevision ||
    record.scheduleState.nextOccurrenceAt === null ||
    Date.parse(record.scheduleState.nextOccurrenceAt) >
      Date.parse(input.scheduledFor)
  ) {
    throw new RunStoreError("automation_schedule_lease_lost");
  }
  return { claim: row, record };
}

async function settleScheduleClaim(
  pool: Pool,
  schema: string,
  input:
    | RetryAutomationScheduleClaimInput
    | (AutomationScheduleLeaseInput & Readonly<{ reasonCode: string }>),
  disposition: "retry" | "disable",
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { claim, record } = await requireScheduleLease(client, schema, input);
    const retryAt =
      disposition === "retry" && "retryAt" in input ? input.retryAt : null;
    const nextState = parseAutomationScheduleState({
      ...record.scheduleState,
      status: disposition === "disable" ? "disabled" : "enabled",
      nextOccurrenceAt:
        disposition === "retry"
          ? timestamp(claim.scheduled_for)
          : record.scheduleState.nextOccurrenceAt,
      retryAt,
      revision: record.scheduleState.revision + 1,
      updatedAt: retryAt ?? timestamp(claim.observed_at),
    });
    const updated = await client.query(
      `UPDATE ${schema}.automations SET schedule_state_json=$1::jsonb
       WHERE tenant_id=$2 AND automation_id=$3 AND definition_digest=$4`,
      [
        stableJson(nextState),
        record.definition.tenantId,
        record.definition.automationId,
        record.definitionDigest,
      ],
    );
    if (updated.rowCount !== 1)
      throw new RunStoreError("automation_schedule_lease_lost");
    await deleteScheduleClaim(client, schema, claim);
    await client.query("COMMIT");
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}

async function deleteScheduleClaim(
  client: PoolClient,
  schema: string,
  claim: StoredScheduleClaimRow,
): Promise<void> {
  const deleted = await client.query(
    `DELETE FROM ${schema}.automation_schedule_claims
     WHERE tenant_id=$1 AND automation_id=$2 AND lease_id=$3 AND lease_epoch=$4`,
    [
      claim.tenant_id,
      claim.automation_id,
      claim.lease_id,
      safeInteger(claim.lease_epoch),
    ],
  );
  if (deleted.rowCount !== 1)
    throw new RunStoreError("automation_schedule_lease_lost");
}
