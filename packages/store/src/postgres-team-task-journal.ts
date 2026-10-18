import type { Pool, PoolClient } from "pg";
import type { RunState } from "@crewon/domain";
import type {
  CommitThreadInput,
  CommitThreadResult,
} from "@crewon/application";
import {
  captureTeamTaskIntent,
  teamJournalJson,
  teamJournalBytes,
  teamJournalFail,
  validateTeamLeaseDuration,
  teamJournalId,
  validateTeamTaskListLimit,
  validateTeamTaskScope,
  type TeamTaskIntent,
  type TeamTaskLocator,
  type TeamTaskScope,
  type TeamTaskFence,
  type TeamTaskEffect,
  type TeamTaskAdmissionResult,
  type TeamTaskJournalStore,
} from "@crewon/application/team-task-journal";
import type { ControlTeamTurnResult } from "@crewon/application/team-turn";
import {
  TEAM_TABLES,
  TEAM_TASK_COLUMNS,
  TEAM_EFFECT_COLUMNS,
  teamTaskKeys,
  decodeTeamTask,
  assertTeamFence,
  decodeTeamEffect,
  captureTeamEffect,
  assertTeamEffectReplay,
  assertTeamJournalBudget,
  assertTeamTaskSource,
  captureTeamResult,
  assertTeamFinalRun,
} from "./team-task-journal-state.ts";
import { advisoryLock, threadLockKey } from "./postgres-thread-lock.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";

type TeamJournalHost = {
  assertOpen(): void;
  loadRun(
    client: PoolClient,
    locator: { tenantId: string; runId: string },
  ): Promise<RunState | null>;
  commitThreadWithinTransaction(
    client: PoolClient,
    input: CommitThreadInput,
  ): Promise<CommitThreadResult>;
};
export class ExperimentalPostgresTeamTaskJournal
  implements TeamTaskJournalStore
{
  private readonly pool: Pool;
  private readonly schemaSql: string;
  private readonly host: TeamJournalHost;
  constructor(pool: Pool, schemaSql: string, host: TeamJournalHost) {
    this.pool = pool;
    this.schemaSql = schemaSql;
    this.host = host;
  }
  #table(name: string) {
    return `${this.schemaSql}.${name}`;
  }
  async #present(client: PoolClient | Pool) {
    const { rows } = await client.query(
      "SELECT to_regclass($1) AS a,to_regclass($2) AS b,to_regclass($3) AS c",
      TEAM_TABLES.map((name) => this.#table(name)),
    );
    return Object.values(rows[0]!).filter((value) => value !== null).length;
  }
  async #schema(client: PoolClient | Pool, lock = false) {
    if ((await this.#present(client)) !== 3)
      teamJournalFail("team_journal_schema_unavailable");
    const { rows } = await client.query(
      `SELECT version FROM ${this.#table("team_task_journal_schema")} LIMIT 2${lock ? " FOR SHARE" : ""}`,
    );
    if (rows.length !== 1 || rows[0]!.version !== 1)
      teamJournalFail("team_journal_schema_unsupported");
  }
  async #transaction<T>(
    locator: TeamTaskLocator | null,
    work: (client: PoolClient) => Promise<T>,
    schema = true,
  ): Promise<T> {
    this.host.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        JSON.stringify([
          "team-journal",
          this.schemaSql,
          locator === null ? "schema" : teamTaskKeys(locator),
        ]),
      );
      if (schema) await this.#schema(client, true);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }
  async #now(client: PoolClient) {
    const { rows } = await client.query(
      "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
    );
    const now = Number(rows[0]!.now);
    if (!Number.isSafeInteger(now) || now < 0)
      teamJournalFail("team_journal_clock_invalid");
    return now;
  }
  async #lockThread(client: PoolClient, intent: TeamTaskIntent) {
    await advisoryLock(
      client,
      threadLockKey(intent.tenantId, intent.turn.threadId),
    );
  }
  async migrate() {
    await this.#transaction(
      null,
      async (client) => {
        if (await this.#present(client)) {
          await this.#schema(client);
          return;
        }
        await client.query(`CREATE TABLE ${this.#table("team_task_journal_schema")} (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1));
        INSERT INTO ${this.#table("team_task_journal_schema")} VALUES(1,1);
        CREATE TABLE ${this.#table("team_task_journals")} (${TEAM_TASK_COLUMNS});
        CREATE TABLE ${this.#table("team_task_effects")} (${TEAM_EFFECT_COLUMNS}, FOREIGN KEY(tenant_id,space_id,task_id) REFERENCES ${this.#table("team_task_journals")}(tenant_id,space_id,task_id));
        CREATE INDEX team_task_thread_lookup ON ${this.#table("team_task_journals")}(tenant_id,space_id,thread_id);`);
      },
      false,
    );
  }
  async listRunnable(input: TeamTaskScope & { limit: number }) {
    validateTeamTaskScope(input);
    validateTeamTaskListLimit(input.limit);
    this.host.assertOpen();
    await this.#schema(this.pool);
    const { rows } = await this.pool.query(
      `SELECT tenant_id,space_id,task_id
       FROM ${this.#table("team_task_journals")}
       WHERE tenant_id=$1 AND space_id=$2 AND status='coordinating'
         AND cancel_requested=0
         AND (lease_expires_at IS NULL OR lease_expires_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
       ORDER BY revision,task_id
       LIMIT $3`,
      [input.tenantId, input.spaceId, input.limit],
    );
    return rows.map((row) => ({
      tenantId: row.tenant_id as string,
      spaceId: row.space_id as string,
      taskId: row.task_id as string,
    }));
  }
  async #read(
    client: PoolClient | Pool,
    locator: TeamTaskLocator,
    lock = false,
  ) {
    const { rows } = await client.query(
      `SELECT * FROM ${this.#table("team_task_journals")} WHERE tenant_id=$1 AND space_id=$2 AND task_id=$3${lock ? " FOR UPDATE" : ""}`,
      teamTaskKeys(locator),
    );
    return decodeTeamTask(rows[0], locator);
  }
  async read(locator: TeamTaskLocator) {
    this.host.assertOpen();
    await this.#schema(this.pool);
    return this.#read(this.pool, locator);
  }
  async create(input: TeamTaskIntent) {
    const intent = captureTeamTaskIntent(input),
      text = teamJournalJson(intent, 131072);
    return this.#transaction(intent, (client) =>
      this.#createInTransaction(client, intent, text),
    );
  }

  async #createInTransaction(
    client: PoolClient,
    intent: TeamTaskIntent,
    text = teamJournalJson(intent, 131072),
  ) {
    const prior = await this.#read(client, intent);
    if (prior) {
      if (teamJournalJson(prior.intent, 131072) !== text)
        teamJournalFail("team_task_intent_conflict");
      return prior;
    }
    const thread = await client.query(
      `SELECT tenant_id,space_id,thread_id,status,revision FROM ${this.#table("threads")} WHERE tenant_id=$1 AND thread_id=$2 FOR SHARE`,
      [intent.tenantId, intent.turn.threadId],
    );
    const office = await client.query(
      `SELECT definition_json FROM ${this.#table("office_definitions")} WHERE tenant_id=$1 AND space_id=$2 AND office_version_id=$3`,
      [intent.tenantId, intent.spaceId, intent.turn.plan.officeVersionId],
    );
    assertTeamTaskSource(
      intent,
      thread.rows[0],
      office.rows[0]?.definition_json,
    );
    const busy = await client.query(
      `SELECT 1 FROM ${this.#table("team_task_journals")} WHERE tenant_id=$1 AND space_id=$2 AND thread_id=$3 AND status='coordinating' LIMIT 1`,
      [intent.tenantId, intent.spaceId, intent.turn.threadId],
    );
    if (busy.rows.length !== 0) teamJournalFail("team_task_main_busy");
    const activeRun = await client.query(
      `SELECT 1 FROM ${this.#table("run_snapshots")} AS snapshots JOIN ${this.#table("run_thread_bindings")} AS bindings ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id WHERE snapshots.tenant_id=$1 AND bindings.thread_id=$2 AND (snapshots.state_json->>'status') NOT IN ('completed','failed','canceled') LIMIT 1`,
      [intent.tenantId, intent.turn.threadId],
    );
    if (activeRun.rows.length !== 0) teamJournalFail("team_task_run_active");
    await client.query(
      `INSERT INTO ${this.#table("team_task_journals")} (tenant_id,space_id,task_id,thread_id,intent_json,status,revision,cancel_requested,lease_epoch,effect_count,journal_bytes) VALUES($1,$2,$3,$4,$5,'coordinating',1,0,0,0,$6)`,
      [
        ...teamTaskKeys(intent),
        intent.turn.threadId,
        text,
        teamJournalBytes(text),
      ],
    );
    return (await this.#read(client, intent))!;
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
    if (
      input.thread.messages.length !== 1 ||
      intent.mainMessageSequence !== message?.sequence ||
      message.role !== "user" ||
      message.threadId !== intent.turn.threadId ||
      message.content !== intent.turn.content
    )
      teamJournalFail("team_task_admission_message_invalid");
    const ownerId = `admission:${intent.taskId}`;
    const leaseId = `${ownerId}:lease`;
    return this.#transaction(intent, async (client) => {
      const prior = await this.#read(client, intent);
      if (prior) {
        if (teamJournalJson(prior.intent, 131072) !== text)
          teamJournalFail("team_task_intent_conflict");
        return { disposition: "replayed", task: prior, thread: null };
      }
      await this.#lockThread(client, intent);
      const task = await this.#createInTransaction(client, intent, text);
      const now = await this.#now(client);
      const expiresAt = now + 30_000;
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET lease_owner=$1,lease_id=$2,lease_epoch=1,lease_expires_at=$3,revision=revision+1 WHERE tenant_id=$4 AND space_id=$5 AND task_id=$6`,
        [ownerId, leaseId, expiresAt, ...teamTaskKeys(intent)],
      );
      const fence = {
        tenantId: intent.tenantId,
        spaceId: intent.spaceId,
        taskId: intent.taskId,
        ownerId,
        leaseId,
        epoch: 1,
      } as const;
      const thread = await this.host.commitThreadWithinTransaction(client, {
        ...input.thread,
        teamTaskFence: fence,
      });
      if (thread.disposition !== "committed")
        teamJournalFail("team_task_admission_thread_replay");
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET lease_owner=NULL,lease_id=NULL,lease_expires_at=NULL,revision=revision+1 WHERE tenant_id=$1 AND space_id=$2 AND task_id=$3`,
        teamTaskKeys(intent),
      );
      const committed = (await this.#read(client, intent))!;
      return { disposition: "committed", task: committed, thread };
    });
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
    return this.#transaction(input, async (client) => {
      const task = await this.#read(client, input, true),
        now = await this.#now(client);
      if (
        !task ||
        task.cancelRequested ||
        task.status !== "coordinating" ||
        (task.lease && task.lease.expiresAt > now)
      )
        return null;
      const { rows } = await client.query(
        `SELECT lease_epoch FROM ${this.#table("team_task_journals")} WHERE tenant_id=$1 AND space_id=$2 AND task_id=$3`,
        teamTaskKeys(input),
      );
      const epoch = Number(rows[0]!.lease_epoch) + 1;
      if (
        !Number.isSafeInteger(epoch) ||
        !Number.isSafeInteger(now + input.durationMs)
      )
        teamJournalFail("team_journal_lease_invalid");
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET lease_owner=$1,lease_id=$2,lease_epoch=$3,lease_expires_at=$4,revision=revision+1 WHERE tenant_id=$5 AND space_id=$6 AND task_id=$7`,
        [
          input.ownerId,
          input.leaseId,
          epoch,
          now + input.durationMs,
          ...teamTaskKeys(input),
        ],
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
  async #fenced(
    client: PoolClient,
    fence: TeamTaskFence,
    allowCanceled = false,
  ) {
    const task = await this.#read(client, fence, true);
    assertTeamFence(task, fence, await this.#now(client), allowCanceled);
    return task;
  }
  async renew(fence: TeamTaskFence, durationMs: number) {
    validateTeamLeaseDuration(durationMs);
    await this.#transaction(fence, async (client) => {
      await this.#fenced(client, fence);
      const expiry = (await this.#now(client)) + durationMs;
      if (!Number.isSafeInteger(expiry))
        teamJournalFail("team_journal_lease_invalid");
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET lease_expires_at=$1,revision=revision+1 WHERE tenant_id=$2 AND space_id=$3 AND task_id=$4`,
        [expiry, ...teamTaskKeys(fence)],
      );
    });
  }
  async #effect(
    client: PoolClient | Pool,
    locator: TeamTaskLocator,
    key: string,
  ) {
    teamJournalId(key);
    const { rows } = await client.query(
      `SELECT * FROM ${this.#table("team_task_effects")} WHERE tenant_id=$1 AND space_id=$2 AND task_id=$3 AND effect_key=$4`,
      [...teamTaskKeys(locator), key],
    );
    return decodeTeamEffect(rows[0]);
  }
  async prepare(
    fence: TeamTaskFence,
    input: Omit<TeamTaskEffect, "response" | "settled">,
    options: { renewForMs: number },
  ) {
    validateTeamLeaseDuration(options.renewForMs);
    const effect = captureTeamEffect(input);
    return this.#transaction(fence, async (client) => {
      const task = await this.#fenced(client, fence);
      const expiry = (await this.#now(client)) + options.renewForMs;
      if (!Number.isSafeInteger(expiry))
        teamJournalFail("team_journal_lease_invalid");
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET lease_expires_at=$1,revision=revision+1 WHERE tenant_id=$2 AND space_id=$3 AND task_id=$4`,
        [expiry, ...teamTaskKeys(fence)],
      );
      const prior = await this.#effect(client, fence, effect.key);
      if (prior) {
        assertTeamEffectReplay(prior, effect);
        return prior;
      }
      const bytes = teamJournalBytes(effect.requestJson);
      assertTeamJournalBudget(task, bytes, true);
      await client.query(
        `INSERT INTO ${this.#table("team_task_effects")} (tenant_id,space_id,task_id,effect_key,kind,request_json) VALUES($1,$2,$3,$4,$5,$6)`,
        [...teamTaskKeys(fence), effect.key, effect.kind, effect.requestJson],
      );
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET effect_count=effect_count+1,journal_bytes=journal_bytes+$1,revision=revision+1 WHERE tenant_id=$2 AND space_id=$3 AND task_id=$4`,
        [bytes, ...teamTaskKeys(fence)],
      );
      return (await this.#effect(client, fence, effect.key))!;
    });
  }
  async settle(
    fence: TeamTaskFence,
    key: string,
    response: import("@crewon/contracts").JsonValue,
  ) {
    const text = teamJournalJson(response);
    return this.#transaction(fence, async (client) => {
      const task = await this.#fenced(client, fence, true),
        prior = await this.#effect(client, fence, key);
      if (!prior) teamJournalFail("team_journal_effect_missing");
      if (prior.settled) {
        if (teamJournalJson(prior.response) !== text)
          teamJournalFail("team_journal_effect_conflict");
        return prior;
      }
      const bytes = teamJournalBytes(text);
      assertTeamJournalBudget(task, bytes, false);
      await client.query(
        `UPDATE ${this.#table("team_task_effects")} SET response_json=$1 WHERE tenant_id=$2 AND space_id=$3 AND task_id=$4 AND effect_key=$5`,
        [text, ...teamTaskKeys(fence), key],
      );
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET journal_bytes=journal_bytes+$1,revision=revision+1 WHERE tenant_id=$2 AND space_id=$3 AND task_id=$4`,
        [bytes, ...teamTaskKeys(fence)],
      );
      return (await this.#effect(client, fence, key))!;
    });
  }
  async effects(locator: TeamTaskLocator) {
    this.host.assertOpen();
    await this.#schema(this.pool);
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.#table("team_task_effects")} WHERE tenant_id=$1 AND space_id=$2 AND task_id=$3 ORDER BY effect_key LIMIT 129`,
      teamTaskKeys(locator),
    );
    return rows.map((row) => decodeTeamEffect(row)!);
  }
  async requestCancel(locator: TeamTaskLocator) {
    await this.#transaction(locator, async (client) => {
      if (!(await this.#read(client, locator, true)))
        teamJournalFail("team_task_not_found");
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET cancel_requested=1,revision=revision+1 WHERE tenant_id=$1 AND space_id=$2 AND task_id=$3`,
        teamTaskKeys(locator),
      );
    });
  }
  async finalAccepted(fence: TeamTaskFence, value: ControlTeamTurnResult) {
    await this.#transaction(fence, async (client) => {
      const task = await this.#fenced(client, fence),
        result = captureTeamResult(task.intent, value);
      assertTeamFinalRun(
        task.intent,
        result,
        await this.host.loadRun(client, {
          tenantId: fence.tenantId,
          runId: result.run.runId,
        }),
      );
      const text = teamJournalJson(result);
      assertTeamJournalBudget(task, teamJournalBytes(text), false);
      await client.query(
        `UPDATE ${this.#table("team_task_journals")} SET status='finalAccepted',result_json=$1,journal_bytes=journal_bytes+$2,lease_owner=NULL,lease_id=NULL,lease_expires_at=NULL,revision=revision+1 WHERE tenant_id=$3 AND space_id=$4 AND task_id=$5`,
        [text, teamJournalBytes(text), ...teamTaskKeys(fence)],
      );
    });
  }
}
