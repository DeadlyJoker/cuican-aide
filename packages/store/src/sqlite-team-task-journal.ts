import type { DatabaseSync } from "node:sqlite";
import type { RunState } from "@crewon/domain";
import type {
  CommitThreadInput,
  CommitThreadResult,
} from "@crewon/application";
import {
  captureAutonomousTaskChildAdmission,
  type AutonomousTaskChildAdmission,
} from "@crewon/application/autonomous-task-admission";
import type { AutonomousTaskChildAdmissionResult } from "@crewon/application/team-task-journal";
import {
  captureTeamTaskIntent,
  teamJournalJson,
  teamJournalBytes,
  teamJournalFail,
  validateTeamLeaseDuration,
  teamJournalId,
  validateTeamTaskFence,
  validateTeamTaskLocator,
  validateTeamTaskListLimit,
  validateTeamTaskScope,
  type TeamTaskIntent,
  type TeamTaskLocator,
  type TeamTaskScope,
  type TeamTaskFence,
  type TeamTaskEffect,
  type TeamTaskAdmissionResult,
  type TeamTaskJournalStore,
  TEAM_JOURNAL_LIMITS,
} from "@crewon/application/team-task-journal";
import type { ControlTeamTurnResult } from "@crewon/application/team-turn";
import {
  TEAM_TASK_COLUMNS,
  TEAM_EFFECT_COLUMNS,
  teamTaskKeys,
  decodeTeamTask,
  assertTeamFence,
  decodeTeamEffect,
  captureTeamEffect,
  assertTeamEffectReplay,
  assertAutonomousChildAdmissionReplay,
  assertAutonomousTaskDeadline,
  assertTeamJournalBudget,
  assertTeamTaskSource,
  captureTeamResult,
  assertTeamFinalRun,
  type TeamJournalRow,
} from "./team-task-journal-state.ts";
import { AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE } from "./sqlite-autonomous-task-edge-store.ts";

type TeamJournalHost = {
  assertOpen(): void;
  now(): number;
  loadRun(locator: { tenantId: string; runId: string }): RunState | null;
  commitThreadWithinTransaction(input: CommitThreadInput): CommitThreadResult;
};
/** Explicit experimental storage; no network/async callback runs in its transaction. */
export class ExperimentalSqliteTeamTaskJournal implements TeamTaskJournalStore {
  private readonly database: DatabaseSync;
  private readonly host: TeamJournalHost;
  constructor(database: DatabaseSync, host: TeamJournalHost) {
    this.database = database;
    this.host = host;
  }
  #schema() {
    const names = this.database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('team_task_journal_schema','team_task_journals','team_task_effects')`,
      )
      .all();
    if (names.length !== 3) teamJournalFail("team_journal_schema_unavailable");
    const versions = this.database
      .prepare("SELECT version FROM team_task_journal_schema")
      .all();
    if (versions.length !== 1 || versions[0]!.version !== 1)
      teamJournalFail("team_journal_schema_unsupported");
  }
  #edgeSchema() {
    const names = this.database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('autonomous_task_edge_schema','autonomous_task_edges','${AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE}')`,
      )
      .all();
    if (names.length !== 3)
      teamJournalFail("autonomous_task_edge_schema_unavailable");
    const version = this.database
      .prepare("SELECT version FROM autonomous_task_edge_schema")
      .all();
    if (version.length !== 1 || version[0]!.version !== 1)
      teamJournalFail("autonomous_task_edge_schema_unsupported");
  }
  #transaction<T>(work: () => T, schema = true): T {
    this.host.assertOpen();
    if (this.database.isTransaction)
      teamJournalFail("team_journal_nested_transaction");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (schema) this.#schema();
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  async migrate() {
    this.#transaction(() => {
      const present = this.database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('team_task_journal_schema','team_task_journals','team_task_effects')`,
        )
        .all();
      if (present.length) {
        this.#schema();
        return;
      }
      this.database
        .exec(`CREATE TABLE team_task_journal_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
        INSERT INTO team_task_journal_schema VALUES(1,1);
        CREATE TABLE team_task_journals (${TEAM_TASK_COLUMNS.replaceAll("BIGINT", "INTEGER")}) STRICT;
        CREATE TABLE team_task_effects (${TEAM_EFFECT_COLUMNS}, FOREIGN KEY(tenant_id,space_id,task_id) REFERENCES team_task_journals(tenant_id,space_id,task_id)) STRICT;
        CREATE INDEX team_task_thread_lookup ON team_task_journals(tenant_id,space_id,thread_id);`);
    }, false);
  }
  async listRunnable(input: TeamTaskScope & { limit: number }) {
    validateTeamTaskScope(input);
    validateTeamTaskListLimit(input.limit);
    this.host.assertOpen();
    this.#schema();
    const rows = this.database
      .prepare(
        `SELECT tenant_id,space_id,task_id
         FROM team_task_journals
         WHERE tenant_id=? AND space_id=? AND status='coordinating'
           AND cancel_requested=0
           AND (lease_expires_at IS NULL OR lease_expires_at<=?)
         ORDER BY revision,task_id
         LIMIT ?`,
      )
      .all(input.tenantId, input.spaceId, this.host.now(), input.limit) as {
      tenant_id: string;
      space_id: string;
      task_id: string;
    }[];
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      spaceId: row.space_id,
      taskId: row.task_id,
    }));
  }
  #read(locator: TeamTaskLocator) {
    return decodeTeamTask(
      this.database
        .prepare(
          "SELECT * FROM team_task_journals WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .get(...teamTaskKeys(locator)) as TeamJournalRow | undefined,
      locator,
    );
  }
  async read(locator: TeamTaskLocator) {
    this.host.assertOpen();
    this.#schema();
    return this.#read(locator);
  }
  async create(input: TeamTaskIntent) {
    const intent = captureTeamTaskIntent(input),
      text = teamJournalJson(intent, 131072);
    return this.#transaction(() => this.#createInTransaction(intent, text));
  }

  #createInTransaction(
    intent: TeamTaskIntent,
    text = teamJournalJson(intent, 131072),
  ) {
    const prior = this.#read(intent);
    if (prior) {
      if (teamJournalJson(prior.intent, 131072) !== text)
        teamJournalFail("team_task_intent_conflict");
      return prior;
    }
    const thread = this.database
      .prepare(
        "SELECT tenant_id,space_id,thread_id,status,revision FROM threads WHERE tenant_id=? AND thread_id=?",
      )
      .get(intent.tenantId, intent.turn.threadId);
    const office = this.database
      .prepare(
        "SELECT definition_json FROM office_definitions WHERE tenant_id=? AND space_id=? AND office_version_id=?",
      )
      .get(intent.tenantId, intent.spaceId, intent.turn.plan.officeVersionId);
    assertTeamTaskSource(intent, thread, office?.definition_json);
    if (
      this.database
        .prepare(
          "SELECT 1 FROM team_task_journals WHERE tenant_id=? AND space_id=? AND thread_id=? AND status='coordinating' LIMIT 1",
        )
        .get(intent.tenantId, intent.spaceId, intent.turn.threadId)
    )
      teamJournalFail("team_task_main_busy");
    if (
      this.database
        .prepare(
          `SELECT 1 FROM run_snapshots AS snapshots JOIN run_thread_bindings AS bindings ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id WHERE snapshots.tenant_id=? AND bindings.thread_id=? AND json_extract(snapshots.state_json,'$.status') NOT IN ('completed','failed','canceled') LIMIT 1`,
        )
        .get(intent.tenantId, intent.turn.threadId)
    )
      teamJournalFail("team_task_run_active");
    this.database
      .prepare(
        `INSERT INTO team_task_journals (tenant_id,space_id,task_id,thread_id,intent_json,status,revision,cancel_requested,lease_epoch,effect_count,journal_bytes) VALUES(?,?,?,?,?,'coordinating',1,0,0,0,?)`,
      )
      .run(
        ...teamTaskKeys(intent),
        intent.turn.threadId,
        text,
        teamJournalBytes(text),
      );
    return this.#read(intent)!;
  }

  async admit(input: {
    intent: TeamTaskIntent;
    thread: CommitThreadInput;
  }): Promise<TeamTaskAdmissionResult> {
    const intent = captureTeamTaskIntent(input.intent);
    const text = teamJournalJson(intent, 131072);
    if (input.thread.teamTaskFence !== undefined)
      teamJournalFail("team_task_admission_fence_invalid");
    const message = input.thread.messages[0];
    const history = input.thread.history.items[0];
    if (
      input.thread.messages.length !== 1 ||
      intent.mainMessageSequence !== message?.sequence ||
      input.thread.history.items.length !== 1 ||
      intent.mainHistorySequence !== (history?.sequence ?? 0) - 1 ||
      message.role !== "user" ||
      message.threadId !== intent.turn.threadId ||
      message.content !== intent.turn.content
    )
      teamJournalFail("team_task_admission_message_invalid");
    this.host.assertOpen();
    this.#schema();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#read(intent);
      if (prior) {
        if (teamJournalJson(prior.intent, 131072) !== text)
          teamJournalFail("team_task_intent_conflict");
        this.database.exec("COMMIT");
        return { disposition: "replayed", task: prior, thread: null };
      }
      const task = this.#createInTransaction(intent, text);
      const now = this.host.now();
      const ownerId = `admission:${intent.taskId}`;
      const leaseId = `${ownerId}:lease`;
      const epoch = 1;
      const expiresAt = now + 30_000;
      this.database
        .prepare(
          "UPDATE team_task_journals SET lease_owner=?,lease_id=?,lease_epoch=?,lease_expires_at=?,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(ownerId, leaseId, epoch, expiresAt, ...teamTaskKeys(intent));
      const thread = this.host.commitThreadWithinTransaction({
        ...input.thread,
        teamTaskFence: {
          tenantId: intent.tenantId,
          spaceId: intent.spaceId,
          taskId: intent.taskId,
          ownerId,
          leaseId,
          epoch,
        },
      });
      if (thread.disposition !== "committed")
        teamJournalFail("team_task_admission_thread_replay");
      this.database
        .prepare(
          "UPDATE team_task_journals SET lease_owner=NULL,lease_id=NULL,lease_expires_at=NULL,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(...teamTaskKeys(intent));
      const committed = this.#read(intent)!;
      this.database.exec("COMMIT");
      return { disposition: "committed", task: committed, thread };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  async claim(
    input: TeamTaskLocator & {
      ownerId: string;
      leaseId: string;
      durationMs: number;
    },
  ) {
    teamJournalId(input.ownerId);
    teamJournalId(input.leaseId);
    validateTeamLeaseDuration(input.durationMs);
    return this.#transaction(() => {
      const task = this.#read(input),
        now = this.host.now();
      if (
        !task ||
        task.cancelRequested ||
        task.status !== "coordinating" ||
        (task.lease && task.lease.expiresAt > now)
      )
        return null;
      const row = this.database
        .prepare(
          "SELECT lease_epoch FROM team_task_journals WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .get(...teamTaskKeys(input))!;
      const epoch = Number(row.lease_epoch) + 1;
      if (
        !Number.isSafeInteger(epoch) ||
        !Number.isSafeInteger(now + input.durationMs)
      )
        teamJournalFail("team_journal_lease_invalid");
      this.database
        .prepare(
          "UPDATE team_task_journals SET lease_owner=?,lease_id=?,lease_epoch=?,lease_expires_at=?,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(
          input.ownerId,
          input.leaseId,
          epoch,
          now + input.durationMs,
          ...teamTaskKeys(input),
        );
      return {
        tenantId: input.tenantId,
        spaceId: input.spaceId,
        taskId: input.taskId,
        ownerId: input.ownerId,
        leaseId: input.leaseId,
        epoch,
      };
    });
  }
  #fenced(fence: TeamTaskFence, allowCanceled = false) {
    const task = this.#read(fence);
    assertTeamFence(task, fence, this.host.now(), allowCanceled);
    return task;
  }
  async renew(fence: TeamTaskFence, durationMs: number) {
    validateTeamLeaseDuration(durationMs);
    this.#transaction(() => {
      this.#fenced(fence);
      const expiry = this.host.now() + durationMs;
      if (!Number.isSafeInteger(expiry))
        teamJournalFail("team_journal_lease_invalid");
      this.database
        .prepare(
          "UPDATE team_task_journals SET lease_expires_at=?,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(expiry, ...teamTaskKeys(fence));
    });
  }
  #effect(locator: TeamTaskLocator, key: string) {
    teamJournalId(key);
    return decodeTeamEffect(
      this.database
        .prepare(
          "SELECT * FROM team_task_effects WHERE tenant_id=? AND space_id=? AND task_id=? AND effect_key=?",
        )
        .get(...teamTaskKeys(locator), key) as TeamJournalRow | undefined,
    );
  }
  async prepare(
    fence: TeamTaskFence,
    input: Omit<TeamTaskEffect, "response" | "settled">,
    options: { renewForMs: number },
  ) {
    validateTeamLeaseDuration(options.renewForMs);
    const effect = captureTeamEffect(input);
    return this.#transaction(() => {
      const task = this.#fenced(fence);
      const expiry = this.host.now() + options.renewForMs;
      if (!Number.isSafeInteger(expiry))
        teamJournalFail("team_journal_lease_invalid");
      this.database
        .prepare(
          "UPDATE team_task_journals SET lease_expires_at=?,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(expiry, ...teamTaskKeys(fence));
      const prior = this.#effect(fence, effect.key);
      if (prior) {
        assertTeamEffectReplay(prior, effect);
        return prior;
      }
      const bytes = teamJournalBytes(effect.requestJson);
      assertTeamJournalBudget(task, bytes, true);
      this.database
        .prepare(
          "INSERT INTO team_task_effects (tenant_id,space_id,task_id,effect_key,kind,request_json) VALUES(?,?,?,?,?,?)",
        )
        .run(
          ...teamTaskKeys(fence),
          effect.key,
          effect.kind,
          effect.requestJson,
        );
      this.database
        .prepare(
          "UPDATE team_task_journals SET effect_count=effect_count+1,journal_bytes=journal_bytes+?,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(bytes, ...teamTaskKeys(fence));
      return this.#effect(fence, effect.key)!;
    });
  }
  async settle(
    fence: TeamTaskFence,
    key: string,
    response: import("@crewon/contracts").JsonValue,
  ) {
    const text = teamJournalJson(response);
    return this.#transaction(() => {
      const task = this.#fenced(fence, true),
        prior = this.#effect(fence, key);
      if (!prior) teamJournalFail("team_journal_effect_missing");
      if (prior.settled) {
        if (teamJournalJson(prior.response) !== text)
          teamJournalFail("team_journal_effect_conflict");
        return prior;
      }
      const bytes = teamJournalBytes(text);
      assertTeamJournalBudget(task, bytes, false);
      this.database
        .prepare(
          "UPDATE team_task_effects SET response_json=? WHERE tenant_id=? AND space_id=? AND task_id=? AND effect_key=?",
        )
        .run(text, ...teamTaskKeys(fence), key);
      this.database
        .prepare(
          "UPDATE team_task_journals SET journal_bytes=journal_bytes+?,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(bytes, ...teamTaskKeys(fence));
      return this.#effect(fence, key)!;
    });
  }
  async effects(locator: TeamTaskLocator) {
    this.host.assertOpen();
    this.#schema();
    return this.database
      .prepare(
        "SELECT * FROM team_task_effects WHERE tenant_id=? AND space_id=? AND task_id=? ORDER BY effect_key LIMIT 129",
      )
      .all(...teamTaskKeys(locator))
      .map((row) => decodeTeamEffect(row)!);
  }
  async requestCancel(locator: TeamTaskLocator) {
    this.#transaction(() => {
      if (!this.#read(locator)) teamJournalFail("team_task_not_found");
      this.database
        .prepare(
          "UPDATE team_task_journals SET cancel_requested=1,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(...teamTaskKeys(locator));
    });
  }

  async admitAutonomousChild(
    input: AutonomousTaskChildAdmission & { parentFence: TeamTaskFence },
  ): Promise<AutonomousTaskChildAdmissionResult> {
    const { parentFence, ...admissionInput } = input;
    const admission = captureAutonomousTaskChildAdmission(admissionInput);
    validateTeamTaskFence(parentFence);
    if (
      parentFence.tenantId !== admission.capability.tenantId ||
      parentFence.spaceId !== admission.capability.spaceId ||
      parentFence.taskId !== admission.parentTaskId
    )
      teamJournalFail("autonomous_task_child_scope_mismatch");
    const effect = captureTeamEffect({
      key: `command:autonomous.child:${admission.idempotencyKey}`,
      kind: "command",
      request: {
        schemaVersion: "crewon.autonomous-task-child-admission.v0",
        parentTaskId: admission.parentTaskId,
        childTaskId: admission.childTaskId,
        edge: admission.edge,
        budget: admission.budget,
        capability: admission.capability,
      },
    });
    return this.#transaction(() => {
      this.#edgeSchema();
      const parent = this.#fenced(parentFence);
      if (
        parent.intent.actorId !== admission.capability.actorId ||
        parent.intent.principalId !== admission.capability.principalId
      )
        teamJournalFail("autonomous_task_child_issuer_mismatch");
      const existingAdmission = this.database
        .prepare(
          `SELECT * FROM ${AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE} WHERE tenant_id=? AND space_id=? AND parent_task_id=? AND idempotency_key=?`,
        )
        .get(
          admission.capability.tenantId,
          admission.capability.spaceId,
          admission.parentTaskId,
          admission.idempotencyKey,
        ) as Record<string, unknown> | undefined;
      const priorEffect = this.#effect(parentFence, effect.key);
      if (existingAdmission || priorEffect) {
        if (!existingAdmission || !priorEffect || !priorEffect.settled)
          teamJournalFail("autonomous_task_child_admission_corrupt");
        assertTeamEffectReplay(priorEffect, effect);
        assertAutonomousChildAdmissionReplay(existingAdmission, admission);
        const child = this.#read(admission.childIntent);
        if (!child) teamJournalFail("autonomous_task_child_admission_corrupt");
        const edge = readAutonomousEdge(this.database, admission);
        return {
          disposition: "replayed" as const,
          task: child,
          edge,
          effect: priorEffect,
          wakeKey: String(existingAdmission.wake_key),
        };
      }
      const intentJson = teamJournalJson(
        admission.childIntent,
        TEAM_JOURNAL_LIMITS.intentBytes,
      );
      const createdAt = this.host.now();
      assertAutonomousTaskDeadline(admission.budget.deadlineAt, createdAt);
      const child = this.#createInTransaction(
        admission.childIntent,
        intentJson,
      );
      const wakeKey = `team-task:${admission.childTaskId}`;
      const budgetJson = teamJournalJson(admission.budget);
      const capabilityJson = teamJournalJson(admission.capability);
      this.database
        .prepare(
          `INSERT INTO autonomous_task_edges (tenant_id,space_id,root_task_id,parent_task_id,child_task_id,depth,child_ordinal,created_at) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          admission.capability.tenantId,
          admission.capability.spaceId,
          admission.edge.rootTaskId,
          admission.edge.parentTaskId,
          admission.edge.childTaskId,
          admission.edge.depth,
          admission.edge.childOrdinal,
          createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO ${AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE} (tenant_id,space_id,parent_task_id,child_task_id,idempotency_key,budget_json,capability_json,intent_json,wake_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          admission.capability.tenantId,
          admission.capability.spaceId,
          admission.parentTaskId,
          admission.childTaskId,
          admission.idempotencyKey,
          budgetJson,
          capabilityJson,
          intentJson,
          wakeKey,
          createdAt,
        );
      const response = {
        schemaVersion: "crewon.autonomous-task-child-result.v0",
        childTaskId: admission.childTaskId,
        wakeKey,
        edge: { ...admission.edge, createdAt },
      };
      const requestBytes = teamJournalBytes(effect.requestJson);
      const responseText = teamJournalJson(response);
      assertTeamJournalBudget(
        parent,
        requestBytes + teamJournalBytes(responseText),
        true,
      );
      this.database
        .prepare(
          `INSERT INTO team_task_effects (tenant_id,space_id,task_id,effect_key,kind,request_json,response_json) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          ...teamTaskKeys(parentFence),
          effect.key,
          effect.kind,
          effect.requestJson,
          responseText,
        );
      this.database
        .prepare(
          `UPDATE team_task_journals SET effect_count=effect_count+1,journal_bytes=journal_bytes+?,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?`,
        )
        .run(
          requestBytes + teamJournalBytes(responseText),
          ...teamTaskKeys(parentFence),
        );
      return {
        disposition: "created" as const,
        task: child,
        edge: Object.freeze({ ...admission.edge, createdAt }),
        effect: this.#effect(parentFence, effect.key)!,
        wakeKey,
      };
    });
  }
  async cancelAutonomousTree(locator: TeamTaskLocator): Promise<void> {
    validateTeamTaskLocator(locator);
    this.#transaction(() => {
      this.#edgeSchema();
      if (!this.#read(locator)) teamJournalFail("team_task_not_found");
      const rows = this.database
        .prepare(
          `WITH RECURSIVE descendants(child_task_id) AS (
             SELECT child_task_id FROM autonomous_task_edges
             WHERE tenant_id=? AND space_id=? AND parent_task_id=?
             UNION ALL
             SELECT e.child_task_id FROM autonomous_task_edges e
             JOIN descendants d ON e.tenant_id=? AND e.space_id=? AND e.parent_task_id=d.child_task_id
           ) SELECT child_task_id FROM descendants`,
        )
        .all(
          locator.tenantId,
          locator.spaceId,
          locator.taskId,
          locator.tenantId,
          locator.spaceId,
        ) as { child_task_id: string }[];
      const ids = [locator.taskId, ...rows.map((row) => row.child_task_id)];
      const placeholders = ids.map(() => "?").join(",");
      this.database
        .prepare(
          `UPDATE team_task_journals SET cancel_requested=1,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id IN (${placeholders}) AND status='coordinating'`,
        )
        .run(locator.tenantId, locator.spaceId, ...ids);
    });
  }
  async finalAccepted(fence: TeamTaskFence, value: ControlTeamTurnResult) {
    this.#transaction(() => {
      const task = this.#fenced(fence),
        result = captureTeamResult(task.intent, value);
      assertTeamFinalRun(
        task.intent,
        result,
        this.host.loadRun({
          tenantId: fence.tenantId,
          runId: result.run.runId,
        }),
      );
      const text = teamJournalJson(result);
      assertTeamJournalBudget(task, teamJournalBytes(text), false);
      this.database
        .prepare(
          "UPDATE team_task_journals SET status='finalAccepted',result_json=?,journal_bytes=journal_bytes+?,lease_owner=NULL,lease_id=NULL,lease_expires_at=NULL,revision=revision+1 WHERE tenant_id=? AND space_id=? AND task_id=?",
        )
        .run(text, teamJournalBytes(text), ...teamTaskKeys(fence));
    });
  }
}

function readAutonomousEdge(
  database: DatabaseSync,
  admission: AutonomousTaskChildAdmission,
): import("@crewon/application").AutonomousTaskEdge {
  const row = database
    .prepare(
      `SELECT * FROM autonomous_task_edges WHERE tenant_id=? AND space_id=? AND child_task_id=?`,
    )
    .get(
      admission.capability.tenantId,
      admission.capability.spaceId,
      admission.childTaskId,
    ) as Record<string, unknown> | undefined;
  if (!row) teamJournalFail("autonomous_task_child_admission_corrupt");
  const createdAt = Number(row.created_at);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    teamJournalFail("autonomous_task_child_admission_corrupt");
  if (
    row.root_task_id !== admission.edge.rootTaskId ||
    row.parent_task_id !== admission.edge.parentTaskId ||
    row.child_task_id !== admission.edge.childTaskId ||
    Number(row.depth) !== admission.edge.depth ||
    Number(row.child_ordinal) !== admission.edge.childOrdinal
  )
    teamJournalFail("autonomous_task_child_admission_corrupt");
  return Object.freeze({ ...admission.edge, createdAt });
}
