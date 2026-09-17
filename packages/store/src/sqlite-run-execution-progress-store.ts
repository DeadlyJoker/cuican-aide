import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type RunExecutionProgressStore,
  type ReadRunExecutionProgressInput,
  type SaveRunExecutionProgressInput,
} from "@crewon/application";
import {
  decodeRunExecutionProgress,
  progressSaveIsReplay,
  runExecutionProgressDigest,
  validateRunExecutionProgressRead,
  validateRunExecutionProgressSave,
  type RunExecutionProgressRow,
} from "./run-execution-progress-support.ts";
export class SqliteRunExecutionProgressStore
  implements RunExecutionProgressStore
{
  readonly database: DatabaseSync;
  readonly guard: (input: ReadRunExecutionProgressInput) => void;
  constructor(
    database: DatabaseSync,
    guard: (input: ReadRunExecutionProgressInput) => void,
  ) {
    this.database = database;
    this.guard = guard;
  }
  async load(input: ReadRunExecutionProgressInput) {
    validateRunExecutionProgressRead(input);
    return this.within(input, () => this.read(input));
  }
  async save(input: SaveRunExecutionProgressInput) {
    validateRunExecutionProgressSave(input);
    this.within(input, () => {
      if (progressSaveIsReplay(this.read(input), input)) return;
      const cp = input.checkpoint;
      const anchor = this.database
        .prepare(
          "SELECT event_id FROM run_events WHERE tenant_id=? AND run_id=? AND sequence=?",
        )
        .get(input.scope.tenantId, input.scope.runId, cp.throughSequence);
      if (anchor?.event_id !== cp.sourceEventId)
        throw new RunStoreError("run_execution_progress_anchor_mismatch");
      this.database
        .prepare(
          `INSERT INTO run_execution_progress(tenant_id,run_id,through_sequence,source_event_id,payload,payload_digest) VALUES (?,?,?,?,?,?)
        ON CONFLICT(tenant_id,run_id) DO UPDATE SET through_sequence=excluded.through_sequence,source_event_id=excluded.source_event_id,payload=excluded.payload,payload_digest=excluded.payload_digest`,
        )
        .run(
          input.scope.tenantId,
          input.scope.runId,
          cp.throughSequence,
          cp.sourceEventId,
          cp.payload,
          runExecutionProgressDigest(cp),
        );
    });
  }
  async resetForCancellation(input: ReadRunExecutionProgressInput) {
    validateRunExecutionProgressRead(input);
    if (input.purpose !== "cancel")
      throw new RunStoreError(
        "run_execution_progress_reset_requires_cancellation",
      );
    this.within(input, () => {
      this.database
        .prepare(
          "DELETE FROM run_execution_progress WHERE tenant_id=? AND run_id=?",
        )
        .run(input.scope.tenantId, input.scope.runId);
    });
  }
  private read(input: ReadRunExecutionProgressInput) {
    const row = this.database
      .prepare(
        `SELECT p.through_sequence,p.source_event_id,CASE WHEN length(CAST(p.payload AS BLOB))<=262144 THEN p.payload ELSE NULL END payload,p.payload_digest,e.event_id anchor_id
      FROM run_execution_progress p LEFT JOIN run_events e ON e.tenant_id=p.tenant_id AND e.run_id=p.run_id AND e.sequence=p.through_sequence WHERE p.tenant_id=? AND p.run_id=?`,
      )
      .get(input.scope.tenantId, input.scope.runId);
    return decodeRunExecutionProgress(
      row as RunExecutionProgressRow | undefined,
    );
  }
  private within<T>(input: ReadRunExecutionProgressInput, action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.guard(input);
      const result = action();
      this.guard(input);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
