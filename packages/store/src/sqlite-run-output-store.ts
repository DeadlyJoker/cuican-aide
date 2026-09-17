import type { DatabaseSync } from "node:sqlite";
import { decodeSqliteExecutionReceipt } from "./sqlite-execution-receipt-codec.ts";
import {
  RunStoreError,
  type AppendRunStreamEventsInput,
  type AppendRunStreamEventsResult,
  type CommitRunResult,
  type OutboxMessage,
  type RunStreamEvent,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { rollback } from "./sqlite-schema.ts";
import {
  legacyRunOutputReceipt,
  prepareRunOutputAppend,
  validateRunOutputAppend,
} from "./run-output-append.ts";

export function appendSqliteRunStreamEvents<E extends RunStreamEvent>(
  database: DatabaseSync,
  input: AppendRunStreamEventsInput<E>,
  host: Readonly<{
    validateLease: () => void;
    loadRun: () => RunState | null;
    eventIdExists: (id: string) => boolean;
    outboxIdExists: (id: string) => boolean;
    writeSnapshot: (current: RunState, next: RunState) => void;
    writeEvents: (events: readonly E[]) => void;
    writeOutbox: (messages: readonly OutboxMessage[]) => void;
  }>,
  mode: "output" | "progress" = "output",
): AppendRunStreamEventsResult<E> {
  validateRunOutputAppend(input, mode);
  database.exec("BEGIN IMMEDIATE");
  try {
    host.validateLease();
    const current = host.loadRun();
    if (current === null) throw new RunStoreError("run_not_found");
    const load =
      database.prepare(`SELECT receipts.fingerprint, receipts.run_sequence, events.event_id
      FROM run_output_receipts AS receipts JOIN run_events AS events
        ON events.run_id = receipts.run_id AND events.sequence = receipts.run_sequence
      WHERE receipts.tenant_id = ? AND receipts.run_id = ? AND receipts.segment_id = ? AND receipts.segment_sequence = ?`);
    const loadLegacy = database.prepare(
      "SELECT tenant_id, run_id, fingerprint, result_json FROM idempotency_receipts WHERE scope = ? AND idempotency_key = ?",
    );
    const prior = input.entries.map((entry) => {
      const row = load.get(
        input.tenantId,
        input.runId,
        entry.event.data.segmentId,
        entry.event.data.segmentSequence,
      );
      if (row !== undefined)
        return {
          fingerprint: String(row.fingerprint),
          runSequence: Number(row.run_sequence),
          eventId: String(row.event_id),
        };
      const legacy = loadLegacy.get(
        entry.idempotency.scope,
        entry.idempotency.key,
      );
      if (legacy === undefined) return null;
      const decoded = decodeSqliteExecutionReceipt(
        {
          tenant_id: String(legacy.tenant_id),
          run_id: String(legacy.run_id),
          fingerprint: String(legacy.fingerprint),
          result_json: String(legacy.result_json),
        },
        entry.idempotency,
      );
      let result: CommitRunResult;
      try {
        result = JSON.parse(decoded.result_json) as CommitRunResult;
      } catch (cause) {
        throw new RunStoreError("idempotency_receipt_invalid", { cause });
      }
      return legacyRunOutputReceipt(input, entry, {
        tenantId: String(legacy.tenant_id),
        runId: String(legacy.run_id),
        fingerprint: decoded.fingerprint,
        result,
      });
    });
    const head = database
      .prepare(
        "SELECT segment_sequence FROM run_output_receipts WHERE run_id = ? AND segment_id = ? ORDER BY segment_sequence DESC LIMIT 1",
      )
      .get(input.runId, input.entries[0]!.event.data.segmentId);
    const plan = prepareRunOutputAppend(current, input, prior, {
      eventId: host.eventIdExists,
      outboxId: host.outboxIdExists,
      lastSourceSequence: Number(head?.segment_sequence ?? 0),
    });
    if (plan.appendedEvents.length > 0) {
      host.writeSnapshot(current, plan.state);
      host.writeEvents(plan.appendedEvents);
      host.writeOutbox(plan.outbox);
    }
    const insert = database.prepare(`INSERT INTO run_output_receipts
      (tenant_id, run_id, segment_id, segment_sequence, run_sequence, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, segment_id, segment_sequence) DO NOTHING`);
    for (const { entry, receipt } of plan.receipts) {
      insert.run(
        input.tenantId,
        input.runId,
        entry.event.data.segmentId,
        entry.event.data.segmentSequence,
        receipt.runSequence,
        receipt.fingerprint,
      );
    }
    database.exec("COMMIT");
    return structuredClone({
      state: plan.state,
      appendedEvents: plan.appendedEvents,
      replayedCount: plan.replayedCount,
    });
  } catch (error) {
    rollback(database);
    throw error;
  }
}
