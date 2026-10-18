import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import { executeTeamTask } from "@crewon/application/team-task-execution";
import {
  TeamTaskJournalError,
  TEAM_JOURNAL_LIMITS,
  type TeamTaskIntent,
  type TeamTaskJournalStore,
} from "@crewon/application/team-task-journal";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import {
  originalTask,
  priorContext,
  lastUser,
  completed,
  prepare,
  teamOperations as operations,
} from "./team-turn-application.test-support.ts";

const digester = new NodeSha256ContentDigester();
function isCode(code: string) {
  return (error: unknown) =>
    error instanceof TeamTaskJournalError && error.code === code;
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

for (const drop of ["planner", "worker", "final", "member"] as const)
  workflowDeploymentIntegrationTest(
    `Team journal resumes original ${drop} command after accepted response loss, parent Store/Control close and lease takeover without replaying model work`,
    async (t, fixture) => {
      let reopened: SqliteRunStore | PostgresDomainStore | undefined;
      t.after(async () => {
        await reopened?.close();
      });
      const calls: string[] = [];
      const f = await fixture(t, {
        output: (request) => {
          calls.push(request.runId);
          return lastUser(request) === priorContext
            ? "PRIOR_REPLY: customer-alpha confirmed."
            : lastUser(request).includes("组长拆解]")
              ? "PLAN: independent QA and security evidence."
              : lastUser(request).includes("成员任务]")
                ? "MEMBER_REPORT: preserve unknown evidence."
                : lastUser(request).includes("成员报告]")
                  ? "@QA give the final evidence-based response.\n[[CrewON delegate:qa]]"
                  : "TEAM_FINAL: journal retained one original task.";
        },
      });
      let server = await f.control(null);
      const worker = await f.worker();
      worker.start();
      const { thread, plan } = await prepare(server.client, drop !== "planner");
      const intent: TeamTaskIntent = {
        schemaVersion: "crewon.team-task.v1",
        ...f.actor,
        taskId: "restart-task",
        turn: {
          threadId: thread.threadId,
          expectedRevision: thread.revision,
          content: originalTask,
          plan,
          ...(drop === "member"
            ? { responseMode: "member" as const }
            : {
                responseMode: "manager" as const,
                managerResponseKind: "office" as const,
              }),
        },
      };
      let journal: TeamTaskJournalStore =
        await f.store.experimentalTeamTaskJournalStore();
      await assert.rejects(
        journal.read(intent),
        isCode("team_journal_schema_unavailable"),
      );
      await journal.migrate();
      const [a, b] = await Promise.all([
        journal.create(intent),
        journal.create(structuredClone(intent)),
      ]);
      assert.deepEqual(a, b);
      const claims = await Promise.all([
        journal.claim({
          ...intent,
          ownerId: "owner-a",
          leaseId: "lease-a",
          durationMs: 1000,
        }),
        journal.claim({
          ...intent,
          ownerId: "owner-b",
          leaseId: "lease-b",
          durationMs: 1000,
        }),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const fence = claims.find((value) => value !== null)!;
      const first = operations(server.client);
      let lostRunId = "",
        lostRequest: unknown;
      if (drop === "planner" || drop === "worker") {
        const create = first.createRun;
        first.createRun = async (body, key) => {
          const result = await create(body, key);
          if (
            body.agentVersionId ===
            (drop === "planner" ? "agent-1" : "verifier-1")
          ) {
            lostRunId = result.run.runId;
            lostRequest = structuredClone([body, key]);
            throw new TeamTaskJournalError("test_process_stopped_after_commit");
          }
          return result;
        };
      } else {
        const start = first.startTurn;
        first.startTurn = async (id, body, key) => {
          const result = await start(id, body, key);
          if (drop === "member" && body.agentVersionId !== "verifier-1")
            return result;
          lostRunId = result.run.runId;
          lostRequest = structuredClone([id, body, key]);
          throw new TeamTaskJournalError("test_process_stopped_after_commit");
        };
      }
      await assert.rejects(
        executeTeamTask({
          actor: f.actor,
          store: journal,
          fence,
          operations: first,
          digester,
          pollIntervalMs: 10,
          runDeadlineMs: 20_000,
          leaseDurationMs: 1000,
        }),
        isCode("test_process_stopped_after_commit"),
      );
      assert.ok(lostRunId);
      assert.equal(
        (await completed(server.client, lostRunId)).status,
        "completed",
      );
      const before = await journal.effects(intent);
      const unknown = before.filter(
        (effect) => effect.kind === "command" && !effect.settled,
      );
      assert.equal(unknown.length, 1);
      assert.deepEqual(
        (unknown[0]!.request as { args: unknown }).args,
        lostRequest,
      );
      const record = (await journal.read(intent))!;
      assert.equal(record.status, "coordinating");
      await server.runtime.app.close();
      await f.store.close();
      reopened =
        "databasePath" in f
          ? new SqliteRunStore(f.databasePath)
          : await PostgresDomainStore.open({
              connectionString: f.connectionString,
              schema: f.schema,
            });
      journal = await reopened.experimentalTeamTaskJournalStore();
      await journal.migrate();
      assert.deepEqual(
        await journal.effects(intent),
        before,
        "reopening must not repair or execute prepared commands",
      );
      await setTimeout(Math.max(0, record.lease!.expiresAt - Date.now() + 15));
      const next = await journal.claim({
        ...intent,
        ownerId: "new-process",
        leaseId: "new-lease",
        durationMs: 1000,
      });
      assert.ok(next);
      assert.equal(next.epoch, fence.epoch + 1);
      await assert.rejects(
        journal.settle(fence, unknown[0]!.key, {}),
        isCode("team_journal_lease_lost"),
      );
      server = await f.control(null);
      const resumed = operations(server.client),
        replays: unknown[] = [];
      if (drop === "planner" || drop === "worker") {
        const create = resumed.createRun;
        resumed.createRun = async (body, key) => {
          replays.push(structuredClone([body, key]));
          return create(body, key);
        };
      } else {
        const start = resumed.startTurn;
        resumed.startTurn = async (id, body, key) => {
          replays.push(structuredClone([id, body, key]));
          return start(id, body, key);
        };
      }
      const sampledBefore = calls.length;
      const result = await executeTeamTask({
        actor: f.actor,
        store: journal,
        fence: next,
        operations: resumed,
        digester,
        pollIntervalMs: 10,
        runDeadlineMs: 20_000,
        leaseDurationMs: 1000,
      });
      if (drop === "planner") {
        assert.deepEqual(replays[0], lostRequest);
        assert.equal(
          replays.length,
          3,
          "replay the one planner, then admit two previously unsubmitted workers",
        );
      } else
        assert.deepEqual(
          replays,
          [lostRequest],
          "only the unknown command crosses the application boundary again",
        );
      if (drop === "final" || drop === "member") {
        assert.equal(result.run.runId, lostRunId);
        assert.equal(calls.length, sampledBefore);
      }
      assert.equal(
        (await completed(server.client, result.run.runId)).status,
        "completed",
      );
      assert.equal(
        new Set(calls).size,
        drop === "planner" || drop === "member" ? 5 : 4,
      );
      assert.equal(
        calls.length,
        drop === "planner" || drop === "member" ? 5 : 4,
        "one seed, optional planner, two members and one final model call",
      );
      const messages = (await server.client.listThreadMessages(thread.threadId))
        .data;
      assert.equal(
        messages.filter((message) => message.content === originalTask).length,
        1,
      );
      assert.equal(
        messages.filter(
          (message) =>
            message.content ===
            "TEAM_FINAL: journal retained one original task.",
        ).length,
        1,
      );
      const accepted = (await journal.read(intent))!;
      assert.equal(accepted.status, "finalAccepted");
      assert.equal(accepted.lease, null);
      assert.deepEqual(accepted.result, result);
      assert.equal(
        (await journal.effects(intent)).filter((effect) => !effect.settled)
          .length,
        0,
      );
      await assert.rejects(
        journal.create({
          ...intent,
          turn: { ...intent.turn, content: "changed task" },
        }),
        isCode("team_task_intent_conflict"),
      );
      assert.equal(
        await journal.read({ ...intent, spaceId: "foreign-space" }),
        null,
      );
    },
  );

workflowDeploymentIntegrationTest(
  "Team journal replays an unknown Goal pause using its initial snapshot, then resumes that same Goal on the final main turn",
  async (t, fixture) => {
    const release = barrier(),
      finalStarted = barrier();
    let reopened: SqliteRunStore | PostgresDomainStore | undefined;
    t.after(async () => {
      release.resolve();
      await reopened?.close();
    });
    let calls = 0;
    const f = await fixture(t, {
      beforeModel: async () => {
        if (++calls === 4) {
          finalStarted.resolve();
          await release.promise;
        }
      },
      output: (request) =>
        lastUser(request) === priorContext
          ? "PRIOR_REPLY: customer-alpha confirmed."
          : "MEMBER_REPORT: preserve the original Goal.",
    });
    let server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "goal-restart",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "experts",
        executionIntent: "goal",
      },
    };
    let journal: TeamTaskJournalStore =
      await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    await journal.create(intent);
    const fence = (await journal.claim({
      ...intent,
      ownerId: "first",
      leaseId: "first",
      durationMs: 1000,
    }))!;
    const first = operations(server.client),
      pause = first.setThreadGoalWithExecutionIntentV1;
    let originalPause: unknown;
    first.setThreadGoalWithExecutionIntentV1 = async (id, body, key) => {
      const result = await pause(id, body, key);
      originalPause = structuredClone([id, body, key]);
      throw new TeamTaskJournalError("test_process_stopped_after_goal_commit");
    };
    await assert.rejects(
      executeTeamTask({
        actor: f.actor,
        store: journal,
        fence,
        operations: first,
        digester,
        pollIntervalMs: 10,
        leaseDurationMs: 1000,
      }),
      isCode("test_process_stopped_after_goal_commit"),
    );
    const paused = (await server.client.getThreadGoal(thread.threadId)).goal!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.objective, originalTask);
    const task = (await journal.read(intent))!;
    await server.runtime.app.close();
    await f.store.close();
    reopened =
      "databasePath" in f
        ? new SqliteRunStore(f.databasePath)
        : await PostgresDomainStore.open({
            connectionString: f.connectionString,
            schema: f.schema,
          });
    journal = await reopened.experimentalTeamTaskJournalStore();
    await journal.migrate();
    await setTimeout(Math.max(0, task.lease!.expiresAt - Date.now() + 15));
    const next = (await journal.claim({
      ...intent,
      ownerId: "second",
      leaseId: "second",
      durationMs: 1000,
    }))!;
    server = await f.control(null);
    const resumed = operations(server.client),
      resumePause = resumed.setThreadGoalWithExecutionIntentV1;
    let liveInitialReads = 0,
      pauseReplays = 0;
    resumed.getThreadGoal = async () => {
      liveInitialReads++;
      throw Error("initial Goal must use its recorded observation");
    };
    resumed.setThreadGoalWithExecutionIntentV1 = async (id, body, key) => {
      assert.deepEqual([id, body, key], originalPause);
      pauseReplays++;
      return resumePause(id, body, key);
    };
    const result = await executeTeamTask({
      actor: f.actor,
      store: journal,
      fence: next,
      operations: resumed,
      digester,
      pollIntervalMs: 10,
      leaseDurationMs: 1000,
    });
    assert.equal(liveInitialReads, 0);
    assert.equal(pauseReplays, 1);
    const waitAbort = new AbortController();
    await Promise.race([
      finalStarted.promise,
      setTimeout(20_000, undefined, { signal: waitAbort.signal }).then(() => {
        throw Error("team_final_not_started");
      }),
    ]).finally(() => waitAbort.abort());
    const active = (await server.client.getThreadGoal(thread.threadId)).goal!;
    assert.equal(active.goalId, paused.goalId);
    assert.equal(active.status, "active");
    assert.equal(active.objective, originalTask);
    assert.equal(result.run.goalBinding?.goalId, paused.goalId);
    const stop = await server.client.setThreadGoalWithExecutionIntentV1(
      thread.threadId,
      {
        expectedRevision: active.revision,
        objective: null,
        status: "paused",
        tokenBudget: { kind: "keep" },
      },
      "user-pause",
    );
    await server.client.cancelRun(
      result.run.runId,
      { expectedRevision: stop.retainedRun!.revision },
      "user-stop",
    );
    release.resolve();
    assert.equal(
      (await completed(server.client, result.run.runId)).status,
      "canceled",
    );
    assert.equal(calls, 4);
  },
);

workflowDeploymentIntegrationTest(
  "Team journal rejects changed identities and effects, fences canceled execution, and preserves already-dispatched receipts including JSON null",
  async (t, fixture) => {
    const f = await fixture(t, { output: () => "PRIOR_REPLY" });
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "fence-case",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    await assert.rejects(
      journal.create({ ...intent, spaceId: "foreign-space" }),
      isCode("team_task_thread_unavailable"),
    );
    await assert.rejects(
      journal.create({
        ...intent,
        taskId: "forged-office",
        turn: {
          ...intent.turn,
          plan: {
            ...plan,
            manager: { ...plan.manager, agentVersionId: "unrelated-agent" },
          },
        },
      }),
      isCode("team_task_office_mismatch"),
    );
    let getterReads = 0;
    const accessor = {
      ...intent,
      taskId: "accessor",
      turn: { ...intent.turn },
    };
    Object.defineProperty(accessor.turn, "content", {
      enumerable: true,
      get() {
        getterReads++;
        return "changed";
      },
    });
    await assert.rejects(
      journal.create(accessor),
      isCode("team_journal_value_invalid"),
    );
    assert.equal(getterReads, 0);
    assert.equal(await journal.read({ ...intent, taskId: "accessor" }), null);
    const badProfiles: unknown[] = [
      false,
      { ...plan.manager.profile!, teamCoordination: null },
      {
        ...plan.manager.profile!,
        skills: [{ name: "unexpected", description: "metadata", grant: true }],
      },
    ];
    for (const [index, profile] of badProfiles.entries())
      await assert.rejects(
        journal.create({
          ...intent,
          taskId: `bad-profile-${index}`,
          turn: {
            ...intent.turn,
            plan: { ...plan, manager: { ...plan.manager, profile } },
          },
        } as unknown as TeamTaskIntent),
        isCode("team_task_intent_invalid"),
      );
    const mutable = structuredClone(intent);
    const creating = journal.create(mutable);
    (mutable.turn as { content: string }).content =
      "changed after admission began";
    assert.equal((await creating).intent.turn.content, originalTask);
    await journal.create(intent);
    const fence = (await journal.claim({
      ...intent,
      ownerId: "owner",
      leaseId: "lease",
      durationMs: 30_000,
    }))!;
    await assert.rejects(
      executeTeamTask({
        actor: { ...f.actor, principalId: "different-principal" },
        store: journal,
        fence,
        operations: operations(server.client),
        digester,
      }),
      isCode("team_task_issuer_mismatch"),
    );
    const effect = {
      key: "unknown-action",
      kind: "command" as const,
      request: { operation: "team.worker.qa", body: "original" },
    };
    await journal.prepare(fence, effect, { renewForMs: 30_000 });
    await assert.rejects(
      journal.prepare(
        fence,
        { ...effect, request: { body: "different" } },
        { renewForMs: 30_000 },
      ),
      isCode("team_journal_effect_conflict"),
    );
    assert.equal((await journal.effects(intent)).length, 1);
    await journal.requestCancel(intent);
    await assert.rejects(
      journal.prepare(
        fence,
        { ...effect, key: "new-action" },
        { renewForMs: 30_000 },
      ),
      isCode("team_task_cancel_requested"),
    );
    await assert.rejects(
      journal.renew(fence, 30_000),
      isCode("team_task_cancel_requested"),
    );
    assert.equal(
      await journal.claim({
        ...intent,
        ownerId: "other",
        leaseId: "other",
        durationMs: 1000,
      }),
      null,
    );
    const receipt = await journal.settle(fence, effect.key, null);
    assert.equal(receipt.settled, true);
    assert.equal(receipt.response, null);
    assert.deepEqual(await journal.settle(fence, effect.key, null), receipt);
    await assert.rejects(
      journal.settle(fence, effect.key, { changed: true }),
      isCode("team_journal_effect_conflict"),
    );
    assert.equal((await journal.effects(intent)).length, 1);
    assert.equal((await journal.read(intent))!.cancelRequested, true);
    await assert.rejects(
      executeTeamTask({
        actor: f.actor,
        store: journal,
        fence,
        operations: operations(server.client),
        digester,
      }),
      isCode("team_task_cancel_requested"),
    );
    assert.equal(
      f.requests.length,
      1,
      "journal cancellation must not launch models",
    );
  },
);

workflowDeploymentIntegrationTest(
  "Team journal bounds effect count and bytes without evicting unknown commands or partially settling an oversized receipt",
  async (t, fixture) => {
    const f = await fixture(t, { output: () => "PRIOR_REPLY" });
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "bounded",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "member",
      },
    };
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    await journal.create(intent);
    const fence = (await journal.claim({
      ...intent,
      ownerId: "owner",
      leaseId: "lease",
      durationMs: 30_000,
    }))!;
    for (let n = 0; n < TEAM_JOURNAL_LIMITS.effects; n++)
      await journal.prepare(
        fence,
        { key: `effect-${n}`, kind: "command", request: { n } },
        { renewForMs: 30_000 },
      );
    const before = (await journal.read(intent))!;
    await assert.rejects(
      journal.prepare(
        fence,
        { key: "overflow", kind: "command", request: {} },
        { renewForMs: 30_000 },
      ),
      isCode("team_journal_budget_exceeded"),
    );
    await assert.rejects(
      journal.settle(
        fence,
        "effect-0",
        "x".repeat(TEAM_JOURNAL_LIMITS.effectBytes),
      ),
      isCode("team_journal_budget_exceeded"),
    );
    assert.equal(
      (await journal.read(intent))!.journalBytes,
      before.journalBytes,
    );
    for (let n = 0; n < 4; n++)
      await journal.settle(fence, `effect-${n}`, "x".repeat(250_000));
    const bounded = (await journal.read(intent))!;
    await assert.rejects(
      journal.settle(fence, "effect-4", "x".repeat(250_000)),
      isCode("team_journal_budget_exceeded"),
    );
    const effects = await journal.effects(intent);
    assert.equal(effects.length, 128);
    assert.equal(effects.filter((entry) => entry.settled).length, 4);
    assert.ok(!effects.find((entry) => entry.key === "effect-4")!.settled);
    assert.equal(
      (await journal.read(intent))!.journalBytes,
      bounded.journalBytes,
    );
  },
);

for (const fault of ["partial", "future"] as const)
  workflowDeploymentIntegrationTest(
    `Team journal rejects ${fault} storage instead of repairing or downgrading it`,
    async (t, fixture) => {
      const f = await fixture(t);
      const journal = await f.store.experimentalTeamTaskJournalStore();
      const locator = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        taskId: "read-only",
      };
      await assert.rejects(
        journal.read(locator),
        isCode("team_journal_schema_unavailable"),
      );
      await journal.migrate();
      if ("database" in f) {
        if (fault === "partial")
          f.database.exec("DROP TABLE team_task_effects");
        else {
          f.database.exec(
            "PRAGMA ignore_check_constraints=ON;UPDATE team_task_journal_schema SET version=2;PRAGMA ignore_check_constraints=OFF;",
          );
        }
      } else if (fault === "partial")
        await f.admin.query(`DROP TABLE ${f.sql}.team_task_effects`);
      else
        await f.admin.query(
          `ALTER TABLE ${f.sql}.team_task_journal_schema DROP CONSTRAINT team_task_journal_schema_version_check;UPDATE ${f.sql}.team_task_journal_schema SET version=2;`,
        );
      const expected =
        fault === "partial"
          ? "team_journal_schema_unavailable"
          : "team_journal_schema_unsupported";
      await assert.rejects(journal.migrate(), isCode(expected));
      await assert.rejects(journal.read(locator), isCode(expected));
      if ("database" in f) {
        if (fault === "partial")
          assert.equal(
            f.database
              .prepare(
                "SELECT count(*) AS n FROM sqlite_master WHERE name='team_task_effects'",
              )
              .get()!.n,
            0,
          );
        else
          assert.equal(
            f.database
              .prepare("SELECT version FROM team_task_journal_schema")
              .get()!.version,
            2,
          );
      } else if (fault === "partial")
        assert.equal(
          (
            await f.admin.query("SELECT to_regclass($1) AS table_name", [
              `${f.schema}.team_task_effects`,
            ])
          ).rows[0]!.table_name,
          null,
        );
      else
        assert.equal(
          (
            await f.admin.query(
              `SELECT version FROM ${f.sql}.team_task_journal_schema`,
            )
          ).rows[0]!.version,
          2,
        );
    },
  );

workflowDeploymentIntegrationTest(
  "Team admission reserves one main thread and rejects a second coordinating task or an already-active ordinary Run",
  async (t, fixture) => {
    const f = await fixture(t);
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    await worker.close();
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const base: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "main-admission",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    await journal.create(base);
    await assert.rejects(
      journal.create({ ...base, taskId: "second-main-admission" }),
      isCode("team_task_main_busy"),
    );
    const other = await server.client.createThread(
      { title: "Active ordinary Run" },
      "active-ordinary-thread",
    );
    const active = await server.client.createRun(
      {
        threadId: other.thread.threadId,
        agentVersionId: plan.manager.agentVersionId,
      },
      "active-ordinary-run",
    );
    const activeIntent: TeamTaskIntent = {
      ...base,
      taskId: "active-run-admission",
      turn: {
        ...base.turn,
        threadId: other.thread.threadId,
        expectedRevision: other.thread.revision,
      },
    };
    await assert.rejects(
      journal.create(activeIntent),
      isCode("team_task_run_active"),
    );
    const { run } = await server.client.getRun(active.run.runId);
    await server.client.cancelRun(
      active.run.runId,
      { expectedRevision: run.revision },
      "cleanup-active-run",
    );
  },
);
