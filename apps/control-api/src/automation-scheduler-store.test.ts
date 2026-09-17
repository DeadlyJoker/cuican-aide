import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import {
  AutomationApplicationService,
  ThreadApplicationService,
  type DomainStore,
  type AutomationStore,
} from "@crewon/application";
import {
  InMemoryRunStore,
  SqliteRunStore,
  PostgresDomainStore,
} from "@crewon/store";
import { AutomationScheduler } from "./automation-scheduler.ts";

type Backend = "memory" | "sqlite" | "postgres";
type SchedulerStore = DomainStore & AutomationStore;
const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};

for (const backend of ["memory", "sqlite", "postgres"] as const) {
  test(
    `${backend}: cache eviction, lost enqueue acknowledgement and restart replay durable schedule receipts`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (context) => {
      const storage = await createStorage(context, backend);
      let store = storage.store;
      let sequence = 0;
      const ids = { nextId: (kind: string) => `${kind}-${++sequence}` };
      const clock = { now: () => "2026-08-29T00:00:00.000Z" };
      const digester = {
        sha256: (value: string) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      };
      const authorization = {
        authorize: async () => ({ outcome: "allow" as const }),
      };
      const routeResolver = {
        resolveRoute: async () => ({
          authorityId: "authority",
          runtimeGeneration: "generation",
          agentVersionId: "agent-version",
          policySnapshotId: "policy",
          workspaceBindingId: null,
        }),
      };
      const services = () => ({
        automations: new AutomationApplicationService({
          store,
          clock,
          ids,
          digester,
          authorization,
          routeResolver,
        }),
        threads: new ThreadApplicationService({
          store,
          clock,
          ids,
          digester,
          authorization,
        }),
      });
      const initial = services();
      const threadIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const thread = await initial.threads.createThread(actor, {
          kind: "thread.create",
          idempotencyKey: `create-thread-${index}`,
          title: null,
        });
        threadIds.push(thread.state.threadId);
        await initial.automations.createAutomation(actor, {
          kind: "automation.create",
          idempotencyKey: `create-automation-${index}`,
          threadId: thread.state.threadId,
          expectedThreadRevision: thread.state.revision,
          title: "Due report",
          prompt: "Report progress",
          requestedAgentVersionId: null,
          executionMode: "scheduled",
          schedule: {
            scheduleType: "once",
            nextRunAt: clock.now(),
            intervalSeconds: 0,
            time: "00:00",
            weekday: 5,
            timezone: "UTC",
          },
        });
      }
      let failAcknowledgement = true;
      let committed = 0;
      let replayed = 0;
      const schedulers: AutomationScheduler[] = [];
      context.after(async () => {
        for (const scheduler of schedulers) await scheduler.close();
      });
      const scheduler = () => {
        const current = services();
        const created = new AutomationScheduler(
          {
            store,
            threads: current.threads,
            now: clock.now,
            automations: {
              runAutomationNow: async (actor, command) => {
                const result = await current.automations.runAutomationNow(
                  actor,
                  command,
                );
                if (result.disposition === "committed") committed += 1;
                else replayed += 1;
                if (failAcknowledgement) {
                  failAcknowledgement = false;
                  throw new Error("test_enqueue_acknowledgement_lost");
                }
                return result;
              },
            },
          },
          { scanIntervalMs: null, completedAutomationCacheLimit: 1 },
        );
        schedulers.push(created);
        return created;
      };
      const first = scheduler();
      await first.wake();
      assert.equal(
        first.lastFailureCode(),
        "test_enqueue_acknowledgement_lost",
      );
      assert.equal(committed, 3);
      assert.equal(first.resourceSnapshot().cachedAutomationCount, 1);
      const work = await store.listPendingWorkItems(100);
      assert.equal(work.length, 3);
      await first.wake();
      assert.equal(first.lastFailureCode(), null);
      assert.equal(replayed, 3);
      assert.deepEqual(await store.listPendingWorkItems(100), work);
      for (const threadId of threadIds) {
        const locator = { tenantId: actor.tenantId, threadId };
        assert.equal((await store.listMessages(locator, 0, 100)).length, 1);
        assert.equal(
          (await store.listModelHistoryItems(locator, 0, 100)).length,
          1,
        );
      }
      await first.close();
      assert.equal(first.resourceSnapshot().cachedIdentityBytes, 0);
      store = await storage.reopen();
      const restarted = scheduler();
      const overlapping = scheduler();
      await Promise.all([restarted.wake(), overlapping.wake()]);
      assert.equal(restarted.lastFailureCode(), null);
      assert.equal(overlapping.lastFailureCode(), null);
      assert.equal(committed, 3);
      assert.equal(replayed, 9);
      assert.deepEqual(await store.listPendingWorkItems(100), work);
      assert.equal(restarted.resourceSnapshot().cachedAutomationCount, 1);
      for (const threadId of threadIds) {
        const locator = { tenantId: actor.tenantId, threadId };
        assert.equal((await store.listMessages(locator, 0, 100)).length, 1);
        assert.equal(
          (await store.listModelHistoryItems(locator, 0, 100)).length,
          1,
        );
      }
    },
  );
}

async function createStorage(
  context: TestContext,
  backend: Backend,
): Promise<{
  store: SchedulerStore;
  reopen: () => Promise<SchedulerStore>;
}> {
  if (backend === "memory") {
    const store = new InMemoryRunStore();
    context.after(() => store.close());
    return { store, reopen: async () => store };
  }
  if (backend === "sqlite") {
    const directory = mkdtempSync(join(tmpdir(), "crewon-scheduler-cache-"));
    const path = join(directory, "store.sqlite");
    const opened: SqliteRunStore[] = [];
    const open = () => {
      const store = new SqliteRunStore(path);
      opened.push(store);
      return store;
    };
    const store = open();
    context.after(async () => {
      for (const instance of opened) await instance.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return {
      store,
      reopen: async () => {
        await opened.at(-1)?.close();
        return open();
      },
    };
  }
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  assert.ok(connectionString !== undefined);
  const schema = `crewon_scheduler_${randomUUID().replaceAll("-", "_")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const opened: PostgresDomainStore[] = [];
  const open = async () => {
    const store = await PostgresDomainStore.open({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    opened.push(store);
    return store;
  };
  context.after(async () => {
    for (const instance of opened) await instance.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  return {
    store: await open(),
    reopen: async () => {
      await opened.at(-1)?.close();
      return open();
    },
  };
}
