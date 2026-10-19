import type { DatabaseSync } from "node:sqlite";
import {
  validateThreadState,
  extensionCanonicalJson,
  type RunState,
} from "@crewon/domain";
import {
  parseProjectMediaImageReviewJob,
  sameProjectMediaImageReviewJobIntent,
  mediaInputSame,
  mediaInputData,
  type ProjectMediaImageReviewJob,
  type ProjectMediaImageReviewJobLocator,
  type CommitTurnStartInput,
  type CommitTurnStartResult,
} from "@crewon/application";
import {
  assertSqliteMediaImageReviewJobSchema,
  migrateSqliteMediaImageReviewJobs,
} from "./project-media-image-review-job-schema.ts";
import { assertSqliteProjectMediaResultSchema } from "./project-media-result-schema.ts";
import { assertSqliteProjectMediaOperationSchema } from "./project-media-operation-schema.ts";
import { assertSqliteProjectAssetSchema } from "./project-asset-schema.ts";
import { captureSqliteAssetLegacyExecution } from "./project-asset-legacy-instruction.ts";
import { mediaResultLoadPlan } from "./project-media-result-plan.ts";
import { assertSqliteOrdinaryTurnProjectScope } from "./project-conversation-ordinary-turn-fence.ts";
import { validateTurnStartInput } from "./store-invariants.ts";

const fail = (code: string): never => {
  throw new Error(`project_media_image_review_job_${code}`);
};
/** Explicit Native SQLite admission on the original Run connection; no separate execution queue. */
export class SqliteProjectMediaImageReviewJobStore {
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  readonly #run: (scope: {
    tenantId: string;
    runId: string;
  }) => RunState | null;
  readonly #commitTurn: (input: CommitTurnStartInput) => CommitTurnStartResult;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    commitTurnWithinTransaction(
      input: CommitTurnStartInput,
    ): CommitTurnStartResult;
    loadRunWithinTransaction(scope: {
      tenantId: string;
      runId: string;
    }): RunState | null;
  }) {
    this.#db = input.database;
    this.#open = input.assertOpen;
    this.#commitTurn = input.commitTurnWithinTransaction;
    this.#run = input.loadRunWithinTransaction;
  }
  #active() {
    this.#open();
    if (this.#db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
      fail("foreign_keys_required");
  }
  async migrate(): Promise<void> {
    this.#active();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectMediaResultSchema(this.#db);
      migrateSqliteMediaImageReviewJobs(this.#db);
      this.#active();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }
  #rollback() {
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      /* Preserve failure. */
    }
  }
  #candidate(job: ProjectMediaImageReviewJob) {
    assertSqliteProjectMediaResultSchema(this.#db);
    const plan = mediaResultLoadPlan(
      { postgres: false, schema: "main", prefix: "" },
      job.request,
    );
    const legacy = captureSqliteAssetLegacyExecution(this.#db);
    let next = plan.next();
    while (!next.done) {
      let rows: readonly Record<string, unknown>[];
      if ("assetLegacyAccess" in next.value) rows = legacy.execute(next.value);
      else if ("mediaOperationSchema" in next.value) {
        assertSqliteProjectMediaOperationSchema(this.#db);
        rows = [];
      } else if ("assetSchema" in next.value) {
        assertSqliteProjectAssetSchema(this.#db);
        rows = [];
      } else if ("sql" in next.value)
        rows = this.#db.prepare(next.value.sql).all(...next.value.values);
      else return fail("source_invalid");
      next = plan.next(rows);
    }
    legacy.assertCurrent();
    const c = next.value;
    if (
      !c ||
      c.candidateId !== job.candidateId ||
      c.contentDigest !== job.candidateDigest ||
      c.frozen.source.byteDigest !== job.originalByteDigest ||
      !mediaInputSame(c.frozen.request, job.request)
    )
      fail("candidate_changed");
  }
  #load(
    scope: ProjectMediaImageReviewJobLocator,
  ): ProjectMediaImageReviewJob | null {
    assertSqliteMediaImageReviewJobSchema(this.#db);
    const row = this.#db
      .prepare(
        "SELECT * FROM project_media_image_review_jobs WHERE tenant_id=? AND space_id=? AND run_id=?",
      )
      .get(scope.tenantId, scope.spaceId, scope.runId);
    if (!row) return null;
    const job = parseProjectMediaImageReviewJob(
      JSON.parse(String(row.record_json)),
    );
    if (
      job.request.actor.tenantId !== row.tenant_id ||
      job.request.actor.spaceId !== row.space_id ||
      job.runId !== row.run_id ||
      job.threadId !== row.thread_id ||
      job.contentDigest !== row.content_digest
    )
      fail("record_invalid");
    const run = this.#run({ tenantId: scope.tenantId, runId: scope.runId });
    if (run === null) return fail("run_missing");
    if (
      run.goalBinding !== null ||
      run.tenantId !== scope.tenantId ||
      run.spaceId !== scope.spaceId ||
      run.runId !== job.runId ||
      run.threadId !== job.threadId ||
      run.createdByActorId !== job.request.actor.actorId ||
      run.agentVersionId !== job.agentVersionId ||
      run.authorityId !== job.authorityId ||
      run.runtimeGeneration !== job.runtimeGeneration ||
      run.policySnapshotId !== job.policySnapshotId ||
      run.workspaceBindingId !== null ||
      run.collaborationMode !== "default" ||
      (run.origin ?? null) !== null ||
      (run.purpose ?? "turn") !== "turn"
    )
      fail("run_changed");
    this.#candidate(job);
    return job;
  }
  async load(
    scope: ProjectMediaImageReviewJobLocator,
  ): Promise<ProjectMediaImageReviewJob | null> {
    this.#active();
    if (this.#db.isTransaction) fail("transaction_owned");
    this.#db.exec("BEGIN DEFERRED");
    try {
      const job = this.#load(scope);
      this.#active();
      this.#db.exec("COMMIT");
      return job;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }
  /** Read-only queue classification. Absence never installs a review schema or grants authority. */
  async loadIfAvailable(
    scope: ProjectMediaImageReviewJobLocator,
  ): Promise<ProjectMediaImageReviewJob | null> {
    this.#active();
    if (this.#db.isTransaction) fail("transaction_owned");
    this.#db.exec("BEGIN DEFERRED");
    try {
      const job = assertSqliteMediaImageReviewJobSchema(this.#db, true)
        ? this.#load(scope)
        : null;
      this.#active();
      this.#db.exec("COMMIT");
      return job;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }
  async commit(
    input: Readonly<{
      job: ProjectMediaImageReviewJob;
      turn: CommitTurnStartInput;
      assertActive(): void;
    }>,
  ) {
    const job = parseProjectMediaImageReviewJob(input.job);
    const turnInput = mediaInputData(
      input.turn,
      256 * 1024,
    ) as CommitTurnStartInput;
    const { runId, threadId } = validateTurnStartInput(turnInput);
    const event = turnInput.run.events[0];
    if (
      event?.type !== "run.created" ||
      event.data.tenantId !== job.request.actor.tenantId ||
      event.data.spaceId !== job.request.actor.spaceId ||
      event.data.createdByActorId !== job.request.actor.actorId ||
      runId !== job.runId ||
      threadId !== job.threadId ||
      event.data.agentVersionId !== job.agentVersionId ||
      event.data.authorityId !== job.authorityId ||
      event.data.runtimeGeneration !== job.runtimeGeneration ||
      event.data.policySnapshotId !== job.policySnapshotId ||
      event.data.workspaceBindingId !== null ||
      event.data.collaborationMode !== "default" ||
      event.occurredAt !== job.createdAt ||
      turnInput.goal.kind !== "keep" ||
      turnInput.goal.expectedRevision !== null
    )
      fail("turn_invalid");
    this.#active();
    input.assertActive();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteMediaImageReviewJobSchema(this.#db);
      this.#candidate(job);
      const thread = this.#db
        .prepare(
          "SELECT state_json FROM threads WHERE tenant_id=? AND space_id=? AND thread_id=?",
        )
        .get(
          job.request.actor.tenantId,
          job.request.actor.spaceId,
          job.threadId,
        );
      if (!thread) fail("thread_invalid");
      const state = JSON.parse(String(thread!.state_json));
      validateThreadState(state);
      if (
        state.tenantId !== job.request.actor.tenantId ||
        state.spaceId !== job.request.actor.spaceId ||
        state.threadId !== job.threadId ||
        state.createdByActorId !== job.request.actor.actorId ||
        state.workspaceId !== null
      )
        fail("thread_invalid");
      // The generic within-transaction committer omits this fence; preserve it explicitly.
      assertSqliteOrdinaryTurnProjectScope(this.#db, state);
      input.assertActive();
      const turn = this.#commitTurn(turnInput);
      if (turn.disposition === "committed")
        this.#db
          .prepare(
            "INSERT INTO project_media_image_review_jobs VALUES(?,?,?,?,?,?)",
          )
          .run(
            job.request.actor.tenantId,
            job.request.actor.spaceId,
            job.runId,
            job.threadId,
            job.contentDigest,
            extensionCanonicalJson(job),
          );
      const saved = this.#load({
        tenantId: job.request.actor.tenantId,
        spaceId: job.request.actor.spaceId,
        runId: turn.runState.runId,
      });
      if (!saved || !sameProjectMediaImageReviewJobIntent(saved, job))
        fail("replay_changed");
      input.assertActive();
      this.#active();
      this.#db.exec("COMMIT");
      return Object.freeze({ turn, job: saved! });
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }
}
