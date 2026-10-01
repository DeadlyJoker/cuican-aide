import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test, type TestContext } from "node:test";
import {
  ApplicationError,
  ExtensionTaskApplicationService,
  ThreadGoalApplicationService,
  type CreateExtensionTaskCommand,
  type ExtensionHostPort,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import {
  scope,
  target,
  timestamp,
  digest,
} from "./extension-store.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

const command: CreateExtensionTaskCommand = {
  pluginId: scope.pluginId,
  threadId: "task-thread",
  expectedThreadRevision: 1,
  idempotencyKey: "task-1",
  intent: {
    kind: "generate",
    input: { prompt: "A short drama concept image." },
  },
};
async function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const f = await configurationServiceFixture(t, backend);
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  await seedThread(f.first.parent, { ...actor, threadId: command.threadId });
  const create = (
    storage = f.first,
    host: ExtensionHostPort = f.dependencies.host,
  ) =>
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      host,
      store: storage.parent,
      extensions: storage.store,
      operations: f.operations,
      ids: { nextId: () => randomUUID() },
    });
  return { ...f, task: create(), secondTask: create(f.second), create };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === expected;

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `authorized extension task admission (${backend})`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("concurrent requests create one Turn and bind the exact authorized configuration and input", async (t) => {
        const f = await fixture(t, backend);
        const results = await Promise.all([
          f.task.createTask(actor, command),
          f.secondTask.createTask(actor, command),
        ]);
        assert.deepEqual(results.map((value) => value.run.disposition).sort(), [
          "committed",
          "replayed",
        ]);
        const saved = results.find(
          (value) => value.run.disposition === "committed",
        )!;
        assert.deepEqual(saved.binding.target, target);
        assert.equal(
          saved.turn.messages[0]!.content,
          extensionCanonicalJson({ prompt: "A short drama concept image." }),
        );
        assert.equal(
          saved.turn.messages[0]!.contentDigest,
          saved.binding.inputDigest,
        );
        assert.equal(await f.count("messages"), 1);
        assert.equal(await f.count("extension_run_bindings"), 1);
        assert.equal(await f.count("work_items"), 1);
        f.state.catalogAvailable = false;
        f.state.readiness = {
          outcome: "unavailable",
          reasonCode: "extension_runtime_unavailable",
        };
        await f.service.setActivation(actor, {
          ...activateCommand,
          expectedRevision: 1,
          idempotencyKey: "disable",
          state: "disabled",
          agentVersionId: null,
        });
        const replay = await f.task.createTask(actor, command);
        assert.deepEqual(replay.binding, saved.binding);
        assert.equal(replay.turn.disposition, "replayed");
        assert.equal(await f.count("messages"), 1);
        f.state.denied = "extension:run";
        await assert.rejects(
          f.task.createTask(actor, command),
          code("authorization_denied"),
        );
      });

      test("invalid input, denied permissions and unavailable target admit no message or Run", async (t) => {
        const f = await fixture(t, backend);
        await assert.rejects(
          f.task.createTask(actor, {
            ...command,
            intent: {
              kind: "generate",
              input: { prompt: "x", serviceUrl: "https://other.example/" },
            },
          }),
          code("extension_task_input_invalid"),
        );
        for (const denied of [
          "extension:run",
          "thread:message:append",
          "run:create",
        ] as const) {
          f.state.denied = denied;
          await assert.rejects(
            f.task.createTask(actor, command),
            code("authorization_denied"),
          );
        }
        f.state.denied = null;
        f.state.readiness = {
          outcome: "unavailable",
          reasonCode: "extension_execution_authority_unsupported",
        };
        await assert.rejects(
          f.task.createTask(actor, command),
          code("extension_execution_authority_unsupported"),
        );
        f.state.readiness = {
          outcome: "ready",
          target: { ...target, agentVersionId: "another-agent" },
        };
        await assert.rejects(
          f.task.createTask(actor, command),
          code("extension_execution_target_mismatch"),
        );
        assert.equal(await f.count("messages"), 0);
        assert.equal(await f.count("run_snapshots"), 0);
      });

      test("a configuration/activation race is a conflict and leaves the user Turn unwritten", async (t) => {
        const f = await fixture(t, backend);
        const task = f.create(f.first, {
          ...f.dependencies.host,
          evaluate: async () => {
            await f.service.setActivation(actor, {
              ...activateCommand,
              expectedRevision: 1,
              idempotencyKey: "race-disable",
              state: "disabled",
              agentVersionId: null,
            });
            return { outcome: "ready", target };
          },
        });
        await assert.rejects(
          task.createTask(actor, command),
          code("extension_activation_revision_conflict"),
        );
        assert.equal(await f.count("messages"), 0);
        assert.equal(await f.count("model_history_items"), 0);
        assert.equal(await f.count("run_snapshots"), 0);
      });

      test("plugin admission preserves an existing active Thread Goal and does not append to its history", async (t) => {
        const f = await fixture(t, backend);
        const goals = new ThreadGoalApplicationService({
          ...f.dependencies,
          store: f.first.parent,
          ids: { nextId: () => randomUUID() },
          routeResolver: {
            resolveRoute: async () => ({
              agentVersionId: target.agentVersionId,
              authorityId: target.authorityId,
              runtimeGeneration: target.runtimeGeneration,
              policySnapshotId: target.policySnapshotId,
              workspaceBindingId: target.workspaceBindingId,
            }),
          },
        });
        const original = await goals.setGoal(actor, {
          kind: "thread.goal.set",
          threadId: command.threadId,
          expectedRevision: null,
          idempotencyKey: "existing-goal",
          objective: "Keep the existing product task running.",
          status: "active",
          tokenBudget: { kind: "set", value: 200_000 },
        });
        const history = await f.first.parent.listModelHistoryItems(
          { ...actor, threadId: command.threadId },
          0,
          10,
        );
        const runs = await f.count("run_snapshots");
        await assert.rejects(
          f.task.createTask(actor, command),
          code("extension_thread_goal_active"),
        );
        assert.deepEqual(
          await f.first.parent.loadThreadGoal({
            ...actor,
            threadId: command.threadId,
          }),
          original.goalState,
        );
        assert.deepEqual(
          await f.first.parent.listModelHistoryItems(
            { ...actor, threadId: command.threadId },
            0,
            10,
          ),
          history,
        );
        assert.equal(await f.count("messages"), 0);
        assert.equal(await f.count("extension_run_bindings"), 0);
        assert.equal(await f.count("run_snapshots"), runs);
      });

      test("query task retains the original configuration after a switch and requires original Run read access", async (t) => {
        const f = await fixture(t, backend);
        const original = await f.task.createTask(actor, command);
        const operationId = randomUUID();
        await f.operations.reserveExternalOperation({
          tenantId: actor.tenantId,
          runId: original.binding.runId,
          bindingDigest: original.binding.bindingDigest,
          operationId,
          correlationId: operationId,
          executionId: "execution-1",
          idempotencyKey: "operation-1",
          actionDigest: digest,
          requestDigest: digest,
          createdAt: timestamp,
        });
        await f.service.saveConfiguration(actor, {
          ...saveCommand,
          expectedRevision: 1,
          idempotencyKey: "config-2",
          parameters: { format: "webm" },
        });
        await f.service.setActivation(actor, {
          ...activateCommand,
          configurationRevision: 2,
          expectedRevision: 1,
          idempotencyKey: "activate-2",
        });
        await f.service.setActivation(actor, {
          ...activateCommand,
          configurationRevision: 2,
          expectedRevision: 2,
          idempotencyKey: "disable-2",
          state: "disabled",
          agentVersionId: null,
        });
        await seedThread(f.first.parent, {
          ...actor,
          threadId: "query-thread",
        });
        const query: CreateExtensionTaskCommand = {
          ...command,
          threadId: "query-thread",
          idempotencyKey: "query-1",
          intent: {
            kind: "query",
            sourceRunId: original.binding.runId,
            operationId,
          },
        };
        f.state.denied = "run:read";
        await assert.rejects(
          f.task.createTask(actor, query),
          code("authorization_denied"),
        );
        assert.equal(await f.count("messages"), 1);
        f.state.denied = null;
        const saved = await f.task.createTask(actor, query);
        assert.equal(saved.binding.configurationRevision, 1);
        assert.equal(
          saved.binding.configurationDigest,
          original.binding.configurationDigest,
        );
        assert.deepEqual(saved.binding.source, {
          runId: original.binding.runId,
          bindingDigest: original.binding.bindingDigest,
          operationId,
        });
        assert.equal(
          saved.turn.messages[0]!.content,
          extensionCanonicalJson({ kind: "query", operationId }),
        );
        f.state.denied = "run:read";
        await assert.rejects(
          f.task.createTask(actor, query),
          code("authorization_denied"),
        );
        assert.equal(await f.count("messages"), 2);
        f.state.denied = null;
        await assert.rejects(
          f.task.createTask(actor, {
            ...query,
            idempotencyKey: "other-op",
            intent: {
              ...(query.intent as Extract<
                CreateExtensionTaskCommand["intent"],
                { kind: "query" }
              >),
              operationId: "00000000-0000-0000-0000-000000000000",
            },
          }),
          code("extension_query_source_not_found"),
        );
      });

      test("client scope/route injection and idempotency payload changes are rejected", async (t) => {
        const f = await fixture(t, backend);
        const permissionCount = f.state.permissions.length;
        await assert.rejects(
          f.task.createTask(actor, {
            ...command,
            tenantId: "other",
          } as CreateExtensionTaskCommand),
          code("extension_command_invalid"),
        );
        assert.equal(f.state.permissions.length, permissionCount);
        const saved = await f.task.createTask(actor, command);
        await assert.rejects(
          f.task.createTask(actor, {
            ...command,
            intent: { kind: "generate", input: { prompt: "changed request" } },
          }),
          code("extension_idempotency_conflict"),
        );
        assert.equal(
          (await f.first.parent.loadRun(saved.binding))?.agentVersionId,
          target.agentVersionId,
        );
        assert.equal(await f.count("messages"), 1);
      });
    },
  );
}
