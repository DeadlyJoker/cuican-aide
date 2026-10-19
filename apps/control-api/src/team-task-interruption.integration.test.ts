import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { executeTeamTask } from "@crewon/application/team-task-execution";
import { resolveControlTeamPlan } from "@crewon/application/team-turn";
import { TeamTaskScheduler } from "@crewon/application/team-task-scheduler";
import {
  TeamTaskJournalError,
  type TeamTaskIntent,
} from "@crewon/application/team-task-journal";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import {
  originalTask,
  priorContext,
  lastUser,
  completed,
  prepare,
  teamOperations,
} from "./team-turn-application.test-support.ts";

function spawnTeamClaimProcess(input: {
  backend?: "sqlite" | "postgres";
  databasePath: string;
  connectionString?: string;
  schema?: string;
  markerPath: string;
  tenantId: string;
  spaceId: string;
  ownerId: string;
  leaseDurationMs: number;
}) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./team-task-scheduler-process.test-support.ts",
          import.meta.url,
        ),
      ),
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: fileURLToPath(
          new URL("../../../node_modules/.bin/", import.meta.url),
        ),
        CREWON_TEAM_PROCESS_BACKEND: input.backend ?? "sqlite",
        CREWON_TEAM_PROCESS_DATABASE: input.databasePath,
        CREWON_TEAM_PROCESS_CONNECTION: input.connectionString ?? "",
        CREWON_TEAM_PROCESS_SCHEMA: input.schema ?? "",
        CREWON_TEAM_PROCESS_MARKER: input.markerPath,
        CREWON_TEAM_PROCESS_TENANT: input.tenantId,
        CREWON_TEAM_PROCESS_SPACE: input.spaceId,
        CREWON_TEAM_PROCESS_OWNER: input.ownerId,
        CREWON_TEAM_PROCESS_LEASE_MS: String(input.leaseDurationMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, stdout: () => stdout, stderr: () => stderr };
}

function spawnTeamEffectProcess(input: {
  backend?: "sqlite" | "postgres";
  databasePath: string;
  connectionString?: string;
  schema?: string;
  markerPath: string;
  tenantId: string;
  spaceId: string;
  taskId: string;
  ownerId: string;
  leaseDurationMs: number;
  mode: "prepare" | "recover";
}) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./team-task-effect-process.test-support.ts", import.meta.url),
      ),
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: fileURLToPath(
          new URL("../../../node_modules/.bin/", import.meta.url),
        ),
        CREWON_TEAM_PROCESS_BACKEND: input.backend ?? "sqlite",
        CREWON_TEAM_PROCESS_DATABASE: input.databasePath,
        CREWON_TEAM_PROCESS_CONNECTION: input.connectionString ?? "",
        CREWON_TEAM_PROCESS_SCHEMA: input.schema ?? "",
        CREWON_TEAM_PROCESS_MARKER: input.markerPath,
        CREWON_TEAM_PROCESS_TENANT: input.tenantId,
        CREWON_TEAM_PROCESS_SPACE: input.spaceId,
        CREWON_TEAM_PROCESS_TASK: input.taskId,
        CREWON_TEAM_PROCESS_OWNER: input.ownerId,
        CREWON_TEAM_PROCESS_LEASE_MS: String(input.leaseDurationMs),
        CREWON_TEAM_PROCESS_MODE: input.mode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, stdout: () => stdout, stderr: () => stderr };
}

async function waitForClaimProcess(
  processHandle: ReturnType<typeof spawnTeamClaimProcess>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!processHandle.stdout().includes("claimed\n")) {
    assert.ok(
      Date.now() < deadline,
      `claim process did not start: ${processHandle.stderr()}`,
    );
    await setTimeout(10);
  }
}

async function waitForEffectProcess(
  processHandle: ReturnType<typeof spawnTeamEffectProcess>,
  marker: "prepared" | "settled",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!processHandle.stdout().includes(`${marker}\n`)) {
    assert.ok(
      Date.now() < deadline,
      `effect process did not reach ${marker}: ${processHandle.stderr()}`,
    );
    await setTimeout(10);
  }
}

function isCode(code: string) {
  return (error: unknown) =>
    error instanceof TeamTaskJournalError && error.code === code;
}

workflowDeploymentIntegrationTest(
  "atomically admits an autonomous child with its edge, metadata and parent receipt",
  async (t, fixture) => {
    const f = await fixture(t, {
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const members = [
      {
        memberId: "manager",
        displayName: "Lead",
        agentVersionId: "agent-1",
        responsibility:
          "Own the final decision and preserve every unresolved conflict.",
      },
      {
        memberId: "qa",
        displayName: "QA",
        agentVersionId: "verifier-1",
        responsibility:
          "Verify acceptance claims against reproducible test evidence.",
      },
      {
        memberId: "security",
        displayName: "Security",
        agentVersionId: "agent-1",
        responsibility:
          "Identify security blockers and missing threat-model evidence.",
      },
    ];
    const { office } = await server.client.createOffice(
      {
        expectedRevision: 0,
        title: "Team application acceptance",
        members,
        executionTargets: members.map((member) => ({
          targetId: member.memberId,
          agentVersionId: member.agentVersionId,
        })),
      },
      "atomic-team-office",
    );
    const createdThread = await server.client.createThread(
      { title: "Atomic Team main" },
      "atomic-team-thread",
    );
    const thread = createdThread.thread;
    const plan = await resolveControlTeamPlan({
      client: server.client,
      threadId: thread.threadId,
      officeVersionId: office.officeVersionId,
      catalog: await server.client.getActiveAgentVersionCatalog(),
    });
    const journal = await f.store.experimentalTeamTaskJournalStore();
    const edges = await f.store.experimentalAutonomousTaskEdgeStore();
    await journal.migrate();
    await edges.migrate();
    const parent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "atomic-parent",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    await journal.create(parent);
    const parentFence = (await journal.claim({
      ...parent,
      ownerId: "atomic-owner",
      leaseId: "atomic-lease",
      durationMs: 30_000,
    }))!;
    const operations = teamOperations(server.client);
    const fork = await operations.forkThread(
      thread.threadId,
      { expectedRevision: thread.revision, throughHistorySequence: null },
      "atomic-child-fork",
    );
    const child: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "atomic-child",
      turn: {
        threadId: fork.thread.threadId,
        expectedRevision: fork.thread.revision,
        content: "child work",
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    const admission = {
      schemaVersion: "crewon.autonomous-task-child-admission.v0" as const,
      idempotencyKey: "spawn-atomic-1",
      parentTaskId: parent.taskId,
      childTaskId: child.taskId,
      edge: {
        schemaVersion: "crewon.autonomous-task-edge.v0" as const,
        rootTaskId: parent.taskId,
        parentTaskId: parent.taskId,
        childTaskId: child.taskId,
        depth: 1,
        childOrdinal: 1,
      },
      budget: {
        schemaVersion: "crewon.autonomous-task-budget.v0" as const,
        maxDepth: 3,
        maxChildren: 4,
        deadlineAt: "2030-01-02T03:04:05Z",
        tokenBudget: 1000,
        outputBytesBudget: 4096,
      },
      parentCapability: {
        schemaVersion: "crewon.autonomous-task-capability.v0" as const,
        ...f.actor,
        authorityId: "authority-1",
        runtimeGeneration: "runtime-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
        toolPermissionMode: "requestApproval" as const,
      },
      capability: {
        schemaVersion: "crewon.autonomous-task-capability.v0" as const,
        ...f.actor,
        authorityId: "authority-1",
        runtimeGeneration: "runtime-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
        toolPermissionMode: "requestApproval" as const,
      },
      childIntent: child,
      parentFence,
    };
    const first = await journal.admitAutonomousChild(admission);
    assert.equal(first.disposition, "created");
    assert.equal(first.task.intent.taskId, child.taskId);
    assert.equal(first.effect.settled, true);
    assert.equal(
      (
        await edges.listChildren({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          parentTaskId: parent.taskId,
        })
      ).length,
      1,
    );
    const replay = await journal.admitAutonomousChild(admission);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.edge.createdAt, first.edge.createdAt);
    await assert.rejects(
      journal.admitAutonomousChild({
        ...admission,
        childIntent: {
          ...child,
          turn: { ...child.turn, content: "same key, different child input" },
        },
      }),
      isCode("team_journal_effect_conflict"),
    );

    const expiredFork = await operations.forkThread(
      thread.threadId,
      {
        expectedRevision: (await server.client.getThread(thread.threadId))
          .thread.revision,
        throughHistorySequence: null,
      },
      "atomic-expired-child-fork",
    );
    const expiredChild = {
      ...child,
      taskId: "atomic-expired-child",
      turn: {
        ...child.turn,
        threadId: expiredFork.thread.threadId,
        expectedRevision: expiredFork.thread.revision,
      },
    } satisfies TeamTaskIntent;
    await assert.rejects(
      journal.admitAutonomousChild({
        ...admission,
        idempotencyKey: "spawn-expired-child",
        childTaskId: expiredChild.taskId,
        childIntent: expiredChild,
        edge: {
          ...admission.edge,
          childTaskId: expiredChild.taskId,
          childOrdinal: 2,
        },
        budget: { ...admission.budget, deadlineAt: "2000-01-01T00:00:00.000Z" },
      }),
      isCode("autonomous_task_deadline_expired"),
    );
    assert.equal(await journal.read(expiredChild), null);
    assert.equal(
      (await journal.effects(parent)).some((effect) =>
        effect.key.endsWith("spawn-expired-child"),
      ),
      false,
    );
    assert.equal(
      (
        await edges.listChildren({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          parentTaskId: parent.taskId,
        })
      ).length,
      1,
    );
    assert.equal(
      (
        await journal.listRunnable({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          limit: 10,
        })
      ).some((locator) => locator.taskId === expiredChild.taskId),
      false,
    );

    const fork2 = await operations.forkThread(
      thread.threadId,
      {
        expectedRevision: (await server.client.getThread(thread.threadId))
          .thread.revision,
        throughHistorySequence: null,
      },
      "atomic-child-fork-2",
    );
    const child2 = {
      ...child,
      taskId: "atomic-child-rollback",
      turn: {
        ...child.turn,
        threadId: fork2.thread.threadId,
        expectedRevision: fork2.thread.revision,
      },
    } satisfies TeamTaskIntent;
    await assert.rejects(
      journal.admitAutonomousChild({
        ...admission,
        idempotencyKey: "spawn-atomic-2",
        childTaskId: child2.taskId,
        childIntent: child2,
        edge: { ...admission.edge, childTaskId: child2.taskId },
      }),
    );
    assert.equal(await journal.read(child2), null);
    assert.equal(
      (await journal.effects(parent)).some((effect) =>
        effect.key.endsWith("spawn-atomic-2"),
      ),
      false,
    );
    const fork3 = await operations.forkThread(
      thread.threadId,
      {
        expectedRevision: (await server.client.getThread(thread.threadId))
          .thread.revision,
        throughHistorySequence: null,
      },
      "atomic-expiring-child-fork",
    );
    const expiringChild = {
      ...child,
      taskId: "atomic-expiring-child",
      turn: {
        ...child.turn,
        threadId: fork3.thread.threadId,
        expectedRevision: fork3.thread.revision,
      },
    } satisfies TeamTaskIntent;
    const expiringDeadline = new Date(Date.now() + 100).toISOString();
    await journal.admitAutonomousChild({
      ...admission,
      idempotencyKey: "spawn-expiring-child",
      childTaskId: expiringChild.taskId,
      childIntent: expiringChild,
      edge: {
        ...admission.edge,
        childTaskId: expiringChild.taskId,
        childOrdinal: 2,
      },
      budget: { ...admission.budget, deadlineAt: expiringDeadline },
    });
    await setTimeout(150);
    assert.equal((await journal.read(expiringChild))?.cancelRequested, false);
    let childStartedResolve!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      childStartedResolve = resolve;
    });
    let childAborted = false;
    let schedulerErrors = 0;
    const scheduler = new TeamTaskScheduler({
      store: journal,
      scope: { tenantId: f.actor.tenantId, spaceId: f.actor.spaceId },
      ownerId: "autonomous-child-scheduler",
      concurrency: 1,
      listLimit: 10,
      leaseDurationMs: 5000,
      cancellationPollIntervalMs: 5,
      createLeaseId: ({ locator, sequence }) =>
        `autonomous-${locator.taskId}-${sequence}`,
      execute: async (fence, signal) => {
        assert.equal(fence.taskId, child.taskId);
        childStartedResolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              childAborted = true;
              reject(signal.reason ?? new Error("child_cancelled"));
            },
            { once: true },
          );
        });
      },
      onError: () => {
        schedulerErrors++;
      },
    });
    assert.equal((await scheduler.wake()).started, 1);
    await childStarted;
    assert.equal((await journal.read(expiringChild))?.cancelRequested, true);
    await journal.cancelAutonomousTree(parent);
    assert.equal((await journal.read(parent))?.cancelRequested, true);
    assert.equal((await journal.read(child))?.cancelRequested, true);
    await scheduler.idle();
    assert.equal(childAborted, true);
    assert.equal(schedulerErrors, 1);
    assert.deepEqual(await scheduler.wake(), {
      started: 0,
      skipped: 0,
      capacity: 1,
    });
    await scheduler.close();
  },
);

workflowDeploymentIntegrationTest(
  "Team cancellation interrupts live Run waiting without transient-read retries, final submission, or freezing a nonterminal response",
  async (t, fixture) => {
    let release!: () => void;
    const gate = new Promise<void>((ready) => {
      release = ready;
    });
    t.after(() => {
      release();
    });
    let calls = 0;
    const f = await fixture(t, {
      beforeModel: async () => {
        if (++calls > 1) await gate;
      },
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "cancel-live",
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
    await journal.create(intent);
    const fence = (await journal.claim({
      ...intent,
      ownerId: "owner",
      leaseId: "lease",
      durationMs: 1000,
    }))!;
    const operations = teamOperations(server.client),
      getRun = operations.getRun;
    let reads = 0;
    operations.getRun = async (id) => {
      reads++;
      return getRun(id);
    };
    const outcome = executeTeamTask({
      actor: f.actor,
      store: journal,
      fence,
      operations,
      digester: new NodeSha256ContentDigester(),
      pollIntervalMs: 10,
      runDeadlineMs: 20_000,
      leaseDurationMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 20_000;
    while (calls < 3 || reads < 2) {
      assert.ok(
        Date.now() < deadline,
        "both child models and live status reads must start",
      );
      await setTimeout(10);
    }
    const effects = await journal.effects(intent);
    const polling = effects.filter(
      (effect) =>
        effect.kind === "observation" &&
        (effect.request as { label?: string }).label?.startsWith("run."),
    );
    assert.equal(polling.length, 2);
    assert.ok(polling.every((effect) => !effect.settled));
    await journal.requestCancel(intent);
    const atCancel = reads;
    const error = await outcome;
    assert.ok(error instanceof TeamTaskJournalError);
    assert.equal(error.code, "team_task_cancel_requested");
    assert.ok(
      reads <= atCancel + 2,
      "lease/cancel errors must not use the transient read retry budget",
    );
    const after = await journal.effects(intent);
    assert.ok(
      !after.some(
        (effect) =>
          effect.kind === "command" &&
          (effect.request as { method?: string }).method === "startTurn",
      ),
    );
    const children = after
      .filter(
        (effect) =>
          effect.kind === "command" &&
          (effect.request as { method?: string }).method === "createRun",
      )
      .map(
        (effect) => (effect.response as { run: { runId: string } }).run.runId,
      );
    assert.equal(children.length, 2);
    for (const id of children) {
      const { run } = await server.client.getRun(id);
      await server.client.cancelRun(
        id,
        { expectedRevision: run.revision },
        `cleanup:${id}`,
      );
    }
    release();
    for (const id of children)
      assert.equal((await completed(server.client, id)).status, "canceled");
    assert.equal(
      calls,
      3,
      "journal cancellation has not been misrepresented as child Run propagation",
    );
  },
);

workflowDeploymentIntegrationTest(
  "Team main-thread reservation rejects an unscoped concurrent append while the fenced coordinator completes",
  async (t, fixture) => {
    let getThreadCalls = 0;
    const f = await fixture(t, {
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const intent = {
      schemaVersion: "crewon.team-task.v1" as const,
      ...f.actor,
      taskId: "main-revision-fence",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager" as const,
        managerResponseKind: "office" as const,
      },
    };
    await journal.create(intent);
    const fence = (await journal.claim({
      ...intent,
      ownerId: "fence-owner",
      leaseId: "fence-lease",
      durationMs: 30_000,
    }))!;
    const operations = teamOperations(server.client);
    const originalGetThread = operations.getThread;
    operations.getThread = async (threadId) => {
      getThreadCalls++;
      if (getThreadCalls === 2) {
        const current = await server.client.getThread(threadId);
        await assert.rejects(
          server.client.appendThreadMessage(
            threadId,
            {
              expectedRevision: current.thread.revision,
              content: "CONCURRENT_USER_INPUT",
            },
            "concurrent-user-input",
          ),
          (error: unknown) =>
            error instanceof Error &&
            error.message === "team_task_main_reserved",
        );
      }
      return originalGetThread(threadId);
    };
    const result = await executeTeamTask({
      actor: f.actor,
      store: journal,
      fence,
      operations,
      digester: new NodeSha256ContentDigester(),
      pollIntervalMs: 10,
      runDeadlineMs: 20_000,
    });
    const messages = (await server.client.listThreadMessages(thread.threadId))
      .data;
    assert.equal(
      messages.filter((message) => message.content === "CONCURRENT_USER_INPUT")
        .length,
      0,
    );
    assert.equal((await journal.read(intent))!.status, "finalAccepted");
    assert.equal(
      (await journal.read(intent))!.result?.run.runId,
      result.run.runId,
    );
  },
);

workflowDeploymentIntegrationTest(
  "Runtime Worker scheduler discovers and completes a persisted Team task through the fenced executor",
  async (t, fixture) => {
    const f = await fixture(t, {
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    let operations: ReturnType<typeof teamOperations> | null = null;
    const executorErrors: unknown[] = [];
    const worker = await f.worker(f.workflow, 2, {
      scope: { tenantId: f.actor.tenantId, spaceId: f.actor.spaceId },
      concurrency: 1,
      listLimit: 1,
      leaseDurationMs: 5_000,
      scanIntervalMs: null,
      execute: (fence) =>
        executeTeamTask({
          actor: f.actor,
          store: journal,
          fence,
          operations: operations!,
          digester: new NodeSha256ContentDigester(),
          pollIntervalMs: 10,
          runDeadlineMs: 20_000,
          leaseDurationMs: 5_000,
        }).then(() => undefined),
      onError: (_fence, error) => {
        executorErrors.push(error);
      },
    });
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "runtime-worker-scheduled-team-task",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    await journal.create(intent);
    operations = teamOperations(server.client);
    worker.teamTaskScheduler!.notify();
    const deadline = Date.now() + 30_000;
    let record = await journal.read(intent);
    while (record?.status !== "finalAccepted") {
      assert.ok(Date.now() < deadline, "scheduled Team task did not finish");
      await setTimeout(10);
      record = await journal.read(intent);
    }
    assert.deepEqual(executorErrors, []);
    assert.equal(record.result?.message.threadId, thread.threadId);
    assert.equal(record.result?.message.content, originalTask);
    const messageDeadline = Date.now() + 5_000;
    let scheduledMessages = (
      await server.client.listThreadMessages(thread.threadId)
    ).data;
    while (
      scheduledMessages.every(
        (message) => message.content !== "MEMBER_REPORT",
      ) &&
      Date.now() < messageDeadline
    ) {
      await setTimeout(10);
      scheduledMessages = (
        await server.client.listThreadMessages(thread.threadId)
      ).data;
    }
    assert.equal(
      scheduledMessages.filter((message) => message.content === "MEMBER_REPORT")
        .length,
      1,
    );
    await worker.close();
  },
);

workflowDeploymentIntegrationTest(
  "Runtime Worker scheduler reclaims a Team task after owner failure and lease expiry",
  async (t, fixture) => {
    const f = await fixture(t, {
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const firstErrors: unknown[] = [];
    const firstWorker = await f.worker(f.workflow, 2, {
      scope: { tenantId: f.actor.tenantId, spaceId: f.actor.spaceId },
      concurrency: 1,
      listLimit: 1,
      leaseDurationMs: 200,
      scanIntervalMs: null,
      execute: async () => {
        throw new Error("simulated_team_worker_owner_failure");
      },
      onError: (_fence, error) => {
        firstErrors.push(error);
      },
    });
    firstWorker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "runtime-worker-lease-recovery",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    await journal.create(intent);
    firstWorker.teamTaskScheduler!.notify();
    const claimDeadline = Date.now() + 10_000;
    let claimed = await journal.read(intent);
    while (firstErrors.length === 0 || claimed?.lease === null) {
      assert.ok(Date.now() < claimDeadline, "first scheduler did not claim");
      await setTimeout(10);
      claimed = await journal.read(intent);
    }
    assert.equal(firstErrors.length, 1);
    assert.ok(claimed?.lease !== null && claimed !== null);
    const expiry = claimed.lease.expiresAt;
    await firstWorker.close();
    while (Date.now() <= expiry) await setTimeout(10);

    const operations = teamOperations(server.client);
    const secondErrors: unknown[] = [];
    const secondWorker = await f.worker(f.workflow, 2, {
      scope: { tenantId: f.actor.tenantId, spaceId: f.actor.spaceId },
      concurrency: 1,
      listLimit: 1,
      leaseDurationMs: 5_000,
      scanIntervalMs: null,
      execute: (fence) =>
        executeTeamTask({
          actor: f.actor,
          store: journal,
          fence,
          operations,
          digester: new NodeSha256ContentDigester(),
          pollIntervalMs: 10,
          runDeadlineMs: 20_000,
          leaseDurationMs: 5_000,
        }).then(() => undefined),
      onError: (_fence, error) => {
        secondErrors.push(error);
      },
    });
    secondWorker.start();
    secondWorker.teamTaskScheduler!.notify();
    const deadline = Date.now() + 30_000;
    let record = await journal.read(intent);
    while (record?.status !== "finalAccepted") {
      assert.ok(Date.now() < deadline, "reclaimed Team task did not finish");
      await setTimeout(10);
      record = await journal.read(intent);
    }
    assert.deepEqual(secondErrors, []);
    assert.equal(record.result?.message.content, originalTask);
    await secondWorker.close();
  },
);

workflowDeploymentIntegrationTest(
  "Runtime Worker scheduler propagates durable Team cancellation into a live executor",
  async (t, fixture) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let calls = 0;
    const f = await fixture(t, {
      beforeModel: async () => {
        if (++calls > 1) await gate;
      },
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    let operations: ReturnType<typeof teamOperations> | null = null;
    const errors: unknown[] = [];
    const worker = await f.worker(f.workflow, 2, {
      scope: { tenantId: f.actor.tenantId, spaceId: f.actor.spaceId },
      concurrency: 1,
      listLimit: 1,
      leaseDurationMs: 5_000,
      cancellationPollIntervalMs: 10,
      scanIntervalMs: null,
      execute: (fence, signal) =>
        executeTeamTask({
          actor: f.actor,
          store: journal,
          fence,
          operations: operations!,
          digester: new NodeSha256ContentDigester(),
          pollIntervalMs: 10,
          runDeadlineMs: 20_000,
          leaseDurationMs: 5_000,
          signal,
        }).then(() => undefined),
      onError: (_fence, error) => {
        errors.push(error);
      },
    });
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "runtime-worker-team-cancel",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    await journal.create(intent);
    operations = teamOperations(server.client);
    worker.teamTaskScheduler!.notify();
    const deadline = Date.now() + 20_000;
    while (calls < 3) {
      assert.ok(Date.now() < deadline, "Team child work did not start");
      await setTimeout(10);
    }
    await journal.requestCancel(intent);
    while (errors.length === 0) {
      assert.ok(
        Date.now() < deadline,
        "scheduler did not observe cancellation",
      );
      await setTimeout(10);
    }
    assert.equal(
      errors[0] instanceof TeamTaskJournalError
        ? errors[0].code
        : errors[0] instanceof Error
          ? errors[0].message
          : "unknown",
      "team_task_cancel_requested",
    );
    const effects = await journal.effects(intent);
    assert.equal(
      effects.some(
        (effect) =>
          effect.kind === "command" &&
          (effect.request as { method?: string }).method === "startTurn",
      ),
      false,
    );
    const childRunIds = effects
      .filter(
        (effect) =>
          effect.kind === "command" &&
          (effect.request as { method?: string }).method === "createRun",
      )
      .map(
        (effect) => (effect.response as { run: { runId: string } }).run.runId,
      );
    for (const runId of childRunIds) {
      const { run } = await server.client.getRun(runId);
      if (!["completed", "failed", "canceled"].includes(run.status))
        await server.client.cancelRun(
          runId,
          { expectedRevision: run.revision },
          `cleanup:${runId}`,
        );
    }
    release();
    await worker.close();
  },
);

workflowDeploymentIntegrationTest(
  "Team scheduler reclaims a task after an actual owner process SIGKILL",
  async (t, fixture) => {
    const f = await fixture(t, {
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const bootstrap = await f.worker();
    bootstrap.start();
    const { thread, plan } = await prepare(server.client, true);
    await bootstrap.close();
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "process-owner-recovery",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    await journal.create(intent);
    const markerDirectory = mkdtempSync(join(tmpdir(), "crewon-team-process-"));
    t.after(() => rmSync(markerDirectory, { recursive: true, force: true }));
    const markerPath = join(markerDirectory, "claim-markers");
    const processBackend =
      "databasePath" in f
        ? {
            backend: "sqlite" as const,
            databasePath: f.databasePath,
          }
        : {
            backend: "postgres" as const,
            databasePath: "",
            connectionString: f.connectionString,
            schema: f.schema,
          };
    appendFileSync(markerPath, "", { mode: 0o600 });
    const first = spawnTeamClaimProcess({
      ...processBackend,
      markerPath,
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      ownerId: "process-owner-a",
      leaseDurationMs: 200,
    });
    t.after(async () => {
      if (first.child.exitCode === null && first.child.signalCode === null)
        first.child.kill("SIGKILL");
      await first.completion;
    });
    await waitForClaimProcess(first);
    const claimed = await journal.read(intent);
    assert.equal(claimed?.lease?.ownerId, "process-owner-a");
    const expiry = claimed.lease!.expiresAt;
    first.child.kill("SIGKILL");
    assert.equal((await first.completion).signal, "SIGKILL");
    while (Date.now() <= expiry) await setTimeout(10);

    const second = spawnTeamClaimProcess({
      ...processBackend,
      markerPath,
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      ownerId: "process-owner-b",
      leaseDurationMs: 5_000,
    });
    t.after(async () => {
      if (second.child.exitCode === null && second.child.signalCode === null)
        second.child.kill("SIGKILL");
      await second.completion;
    });
    await waitForClaimProcess(second);
    const recovered = await journal.read(intent);
    assert.equal(recovered?.lease?.ownerId, "process-owner-b");
    assert.equal(recovered?.lease?.epoch, 2);
    assert.deepEqual(
      readFileSync(markerPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(":")[0]),
      ["process-owner-a", "process-owner-b"],
    );
    second.child.kill("SIGKILL");
    assert.equal((await second.completion).signal, "SIGKILL");
  },
);

workflowDeploymentIntegrationTest(
  "Team journal recovers one unknown external effect after an owner process SIGKILL",
  async (t, fixture) => {
    const f = await fixture(t, {
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const bootstrap = await f.worker();
    bootstrap.start();
    const { thread, plan } = await prepare(server.client, true);
    await bootstrap.close();
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "process-unknown-effect-recovery",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    await journal.create(intent);
    const markerDirectory = mkdtempSync(
      join(tmpdir(), "crewon-team-effect-process-"),
    );
    t.after(() => rmSync(markerDirectory, { recursive: true, force: true }));
    const markerPath = join(markerDirectory, "effect-markers");
    const processBackend =
      "databasePath" in f
        ? {
            backend: "sqlite" as const,
            databasePath: f.databasePath,
          }
        : {
            backend: "postgres" as const,
            databasePath: "",
            connectionString: f.connectionString,
            schema: f.schema,
          };
    appendFileSync(markerPath, "", { mode: 0o600 });
    const first = spawnTeamEffectProcess({
      ...processBackend,
      markerPath,
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      taskId: intent.taskId,
      ownerId: "effect-owner-a",
      leaseDurationMs: 200,
      mode: "prepare",
    });
    t.after(async () => {
      if (first.child.exitCode === null && first.child.signalCode === null)
        first.child.kill("SIGKILL");
      await first.completion;
    });
    await waitForEffectProcess(first, "prepared");
    const prepared = await journal.effects(intent);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0]!.key, "command:process-unknown-effect");
    assert.equal(prepared[0]!.settled, false);
    const claimed = await journal.read(intent);
    assert.equal(claimed?.lease?.ownerId, "effect-owner-a");
    const expiry = claimed.lease!.expiresAt;
    first.child.kill("SIGKILL");
    assert.equal((await first.completion).signal, "SIGKILL");
    while (Date.now() <= expiry) await setTimeout(10);

    const second = spawnTeamEffectProcess({
      ...processBackend,
      markerPath,
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      taskId: intent.taskId,
      ownerId: "effect-owner-b",
      leaseDurationMs: 5_000,
      mode: "recover",
    });
    t.after(async () => {
      if (second.child.exitCode === null && second.child.signalCode === null)
        second.child.kill("SIGKILL");
      await second.completion;
    });
    await waitForEffectProcess(second, "settled");
    assert.deepEqual(await second.completion, { code: 0, signal: null });
    const recovered = await journal.effects(intent);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.settled, true);
    assert.deepEqual(recovered[0]!.response, {
      providerReceiptId: "process-recovered-receipt",
    });
    assert.deepEqual(readFileSync(markerPath, "utf8").trim().split("\n"), [
      "prepared:1",
      "recovered:false:2",
    ]);
  },
);
