import type { DatabaseSync } from "node:sqlite";
import type {
  CompactionCheckpointStore,
  ReadCompactionCheckpointInput,
  SaveCompactionCheckpointInput,
} from "@crewon/application";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { validateModelUsageAttempt } from "./model-usage-store-support.ts";
import {
  checkpointDigest,
  checkpointSaveRevision,
  decodeCheckpoint,
  validateCheckpointInput,
  validateCheckpointSave,
  type CompactionCheckpointRow,
} from "./compaction-checkpoint-support.ts";
export class SqliteCompactionCheckpointStore
  implements CompactionCheckpointStore
{
  readonly database: DatabaseSync;
  readonly guard: (input: ReadCompactionCheckpointInput) => void;
  constructor(
    database: DatabaseSync,
    guard: (input: ReadCompactionCheckpointInput) => void,
  ) {
    this.database = database;
    this.guard = guard;
  }
  async load(input: ReadCompactionCheckpointInput) {
    validateCheckpointInput(input);
    return this.within(input, () => this.read(input));
  }
  async save(input: SaveCompactionCheckpointInput) {
    validateCheckpointSave(input);
    return this.within(input, () => {
      const next = checkpointSaveRevision(this.read(input), input);
      if (!next.replay)
        this.database
          .prepare(
            `INSERT INTO context_compaction_checkpoints(tenant_id,run_id,step_id,context_digest,revision,payload,payload_digest) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id,run_id,step_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,payload_digest=excluded.payload_digest`,
          )
          .run(
            input.scope.tenantId,
            input.scope.runId,
            input.scope.stepId,
            input.contextDigest,
            next.revision,
            input.payload,
            checkpointDigest(input.payload),
          );
      return next.revision;
    });
  }
  private read(input: ReadCompactionCheckpointInput) {
    const row = this.database
      .prepare(
        "SELECT step_id,context_digest,revision,CASE WHEN length(CAST(payload AS BLOB))<=262144 THEN payload ELSE NULL END payload,payload_digest FROM context_compaction_checkpoints WHERE tenant_id=? AND run_id=?",
      )
      .get(input.scope.tenantId, input.scope.runId);
    return decodeCheckpoint(row as CompactionCheckpointRow | undefined, input);
  }
  private within<T>(input: ReadCompactionCheckpointInput, action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.guard(input);
      validateModelUsageAttempt(
        { lease: input.lease, record: input.scope },
        loadSqliteRunAttempt(this.database, input.scope),
        loadSqliteRunStep(this.database, input.scope),
      );
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
