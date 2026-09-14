import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client, Pool } from "pg";
import { RunStoreError, type CommitRunInput } from "@crewon/application";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { PostgresQueueStore } from "./postgres-queue-store.ts";
import {
  automationApplicationService,
  automationCreateCommand,
  automationRunCommand,
  seedAutomationThread,
} from "./automation-store-conformance.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const policy = {
  retentionMs: 2_000,
  minimumIntervalMs: 1_000,
  maxBatchSize: 1,
};
const locator = { tenantId: "tenant-1", runId: "run-store-1" };
type Backend = "SQLite" | "PostgreSQL" | "InMemory";

for (const backend of ["SQLite", "PostgreSQL", "InMemory"] as const) {
  const options = {
    skip: backend === "PostgreSQL" && connectionString === undefined,
  };
  test(
    `${backend} retires only aged deliveries, preserves replay and rejects reused identities`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      const { store } = fixture;
      await seedThread(store);
      const input = notifications(5);
      const original = await store.commitRun(input);
      await acknowledge(store, 2);
      await fixture.ageDelivered();
      await acknowledge(store, 1);
      const held = await store.claimNextOutbox({
        ownerId: "held",
        leaseId: "held",
        leaseDurationMs: 60_000,
      });
      assert.equal(held?.message.messageId, "notification-3");

      assert.deepEqual(
        await store.outboxRetention.pruneDeliveredOutbox(policy),
        { disposition: "pruned", deletedMessages: 1 },
      );
      assert.deepEqual(
        await store.outboxRetention.pruneDeliveredOutbox(policy),
        { disposition: "deferred", deletedMessages: 0 },
      );
      await fixture.nextMaintenance();
      assert.deepEqual(
        await store.outboxRetention.pruneDeliveredOutbox(policy),
        { disposition: "pruned", deletedMessages: 1 },
      );
      assert.deepEqual(
        await store.listRunEvents(locator, 0, 100),
        input.events,
      );
      assert.deepEqual(await store.loadRun(locator), original.state);
      assert.deepEqual(await store.commitRun(input), {
        ...original,
        disposition: "replayed",
      });
      assert.deepEqual(
        (await store.listPendingOutbox(100)).map(
          (message) => message.messageId,
        ),
        ["notification-4"],
      );
      assert.deepEqual(await store.listPendingWorkItems(100), input.workItems);
      await assert.rejects(
        store.commitRun(reuseRetiredId(input)),
        (error: unknown) =>
          error instanceof RunStoreError &&
          error.code === "outbox_message_conflict",
      );
      assert.equal(
        await store.loadRun({ tenantId: "tenant-1", runId: "different-run" }),
        null,
      );
      // An old ACK cannot recreate a removed queue row or deliver another message.
      await assert.rejects(
        store.acknowledgeOutbox({
          messageId: "notification-0",
          ownerId: "dispatcher",
          leaseId: "lease-0",
          leaseEpoch: 1,
        }),
      );
      assert.deepEqual(
        (await store.listPendingOutbox(100)).map(
          (message) => message.messageId,
        ),
        ["notification-4"],
      );
    },
  );

  test(
    `${backend} bounds each cleanup and catches up without recreating retired notifications`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      const { store } = fixture;
      await seedThread(store);
      const input = notifications(125);
      const original = await store.commitRun(input);
      await acknowledge(store, 125);
      await fixture.ageDelivered();
      const counts: number[] = [];
      for (let pass = 0; pass < 4; pass++) {
        await fixture.nextMaintenance();
        counts.push(
          (
            await store.outboxRetention.pruneDeliveredOutbox({
              ...policy,
              maxBatchSize: 50,
            })
          ).deletedMessages,
        );
      }
      assert.deepEqual(counts, [50, 50, 25, 0]);
      assert.deepEqual(await store.commitRun(input), {
        ...original,
        disposition: "replayed",
      });
      assert.deepEqual(await store.listPendingOutbox(100), []);
      assert.deepEqual(
        await store.listRunEvents(locator, 0, 100),
        input.events,
      );
    },
  );

  test(
    `${backend} validates retention limits before doing maintenance`,
    options,
    async (context) => {
      const { store } = await open(context, backend);
      for (const invalid of [
        { maxBatchSize: 501 },
        { retentionMs: 0 },
        { minimumIntervalMs: NaN },
        { maxBatchSize: 1.5 },
      ]) {
        await assert.rejects(
          store.outboxRetention.pruneDeliveredOutbox({ ...policy, ...invalid }),
          (error: unknown) =>
            error instanceof RunStoreError &&
            error.code === "outbox_retention_policy_invalid",
        );
      }
      assert.deepEqual(
        await store.outboxRetention.pruneDeliveredOutbox(policy),
        { disposition: "pruned", deletedMessages: 0 },
      );
    },
  );

  test(
    `${backend} preserves referenced Automation notification authority after queue retirement`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      const { store, clock, admin, schema, path } = fixture;
      clock.advance(86_400_000);
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      const actor = {
        principalId: "principal-1",
        actorId: "actor-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
      };
      await service.createAutomation(actor, automationCreateCommand());
      const invoked = await service.runAutomationNow(
        actor,
        automationRunCommand(),
      );
      await acknowledge(store, 1);
      await fixture.ageDelivered();
      assert.equal(
        (await store.outboxRetention.pruneDeliveredOutbox(policy))
          .deletedMessages,
        1,
      );
      assert.deepEqual(
        await service.runAutomationNow(actor, automationRunCommand()),
        { ...invoked, disposition: "replayed" },
      );
      assert.deepEqual(await store.listPendingOutbox(100), []);
      if (admin) {
        assert.equal(
          (
            await admin.query(
              `SELECT COUNT(*)::int AS count FROM "${schema}".outbox`,
            )
          ).rows[0].count,
          0,
        );
        await admin.query(
          `UPDATE "${schema}".outbox_deduplication SET replay_message_json = jsonb_set(replay_message_json, '{topic}', '"corrupted"')`,
        );
        await assert.rejects(
          service.runAutomationNow(actor, automationRunCommand()),
          /automation_invocation_receipt_invalid/,
        );
      } else if (path) {
        const database = new DatabaseSync(path);
        try {
          assert.equal(
            database.prepare("SELECT COUNT(*) AS count FROM outbox").get()!
              .count,
            0,
          );
          database.exec(
            "UPDATE outbox_deduplication SET replay_message_json = json_set(replay_message_json, '$.topic', 'corrupted')",
          );
          await assert.rejects(
            service.runAutomationNow(actor, automationRunCommand()),
            /automation_invocation_receipt_invalid/,
          );
        } finally {
          database.close();
        }
      }
    },
  );
}

test("SQLite v26 migration is lazy; an interrupted cleanup rolls back identities, deletion and schedule together", async (context) => {
  const directory = temporaryDirectory(context);
  const path = join(directory, "store.db");
  const clock = new ManualLeaseClock();
  let store = new SqliteRunStore(path, { clock });
  context.after(() => store.close());
  await seedThread(store);
  const input = notifications(2);
  const original = await store.commitRun(input);
  await acknowledge(store, 2);
  await store.close();
  const database = new DatabaseSync(path);
  context.after(() => database.close());
  database.exec(`DROP TRIGGER outbox_register_message_id; DROP TRIGGER outbox_immutable_message_identity;
    DROP INDEX outbox_delivered_retention_idx; DROP TABLE outbox_deduplication; DROP TABLE outbox_maintenance;
    PRAGMA user_version = 26;`);
  store = new SqliteRunStore(path, { clock });
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM outbox_deduplication")
      .get()!.count,
    0,
  );
  assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, SQLITE_SCHEMA_VERSION);
  database.exec(`CREATE TRIGGER fail_retention BEFORE DELETE ON outbox WHEN OLD.message_id = 'notification-1'
    BEGIN SELECT RAISE(ABORT, 'retention_injected_failure'); END;`);
  clock.advance(5_000);
  await assert.rejects(
    store.outboxRetention.pruneDeliveredOutbox({ ...policy, maxBatchSize: 2 }),
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM outbox").get()!.count,
    2,
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM outbox_deduplication")
      .get()!.count,
    0,
  );
  assert.equal(
    database.prepare("SELECT next_due_ms FROM outbox_maintenance").get()!
      .next_due_ms,
    0,
  );
  database.exec("DROP TRIGGER fail_retention");
  assert.equal(
    (
      await store.outboxRetention.pruneDeliveredOutbox({
        ...policy,
        maxBatchSize: 2,
      })
    ).deletedMessages,
    2,
  );
  await store.close();
  store = new SqliteRunStore(path, { clock });
  assert.deepEqual(await store.commitRun(input), {
    ...original,
    disposition: "replayed",
  });
  assert.deepEqual(await store.listRunEvents(locator, 0, 100), input.events);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM outbox").get()!.count,
    0,
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM outbox_deduplication")
      .get()!.count,
    2,
  );
  await assert.rejects(
    store.commitRun(reuseRetiredId(input)),
    /outbox_message_conflict/,
  );
});

test("SQLite skips foreground writer locks, shares a maintenance cadence and uses an aged-delivery index", async (context) => {
  const fixture = await open(context, "SQLite");
  const { store, clock, path } = fixture;
  assert.ok(path);
  await seedThread(store);
  await store.commitRun(notifications(4));
  await acknowledge(store, 4);
  await fixture.ageDelivered();
  const second = new SqliteRunStore(path, { clock });
  const blocker = new DatabaseSync(path);
  context.after(async () => {
    blocker.close();
    await second.close();
  });
  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.deepEqual(await store.outboxRetention.pruneDeliveredOutbox(policy), {
      disposition: "deferred",
      deletedMessages: 0,
    });
  } finally {
    blocker.exec("ROLLBACK");
  }
  assert.equal(
    (await store.outboxRetention.pruneDeliveredOutbox(policy)).deletedMessages,
    1,
  );
  assert.deepEqual(await second.outboxRetention.pruneDeliveredOutbox(policy), {
    disposition: "deferred",
    deletedMessages: 0,
  });
  const plan = blocker
    .prepare(
      `EXPLAIN QUERY PLAN SELECT message_id FROM outbox INDEXED BY outbox_delivered_retention_idx WHERE status = 'delivered'
    AND delivered_at_ms <= ? ORDER BY delivered_at_ms, outbox_order LIMIT ?`,
    )
    .all(clock.nowEpochMilliseconds(), 10);
  assert.ok(
    plan.some((row) =>
      String(row.detail).includes("outbox_delivered_retention_idx"),
    ),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.every((row) => !/TEMP B-TREE|SCAN outbox/u.test(String(row.detail))),
    JSON.stringify(plan),
  );
});

test(
  "PostgreSQL v1 queue migration stays lazy and cleanup interruption leaves replay data and schedule intact",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await open(context, "PostgreSQL");
    const { store, admin, schema } = fixture;
    assert.ok(admin);
    await seedThread(store);
    const input = notifications(2);
    const original = await store.commitRun(input);
    await acknowledge(store, 2);
    await fixture.ageDelivered();
    await admin.query(`DROP TRIGGER outbox_register_message_id ON "${schema}".outbox;
    DROP FUNCTION "${schema}".outbox_register_message_id();
    DROP TABLE "${schema}".outbox_deduplication;
    DROP TABLE "${schema}".outbox_maintenance;
    DROP INDEX "${schema}".outbox_delivered_retention_idx;
    UPDATE "${schema}".schema_migrations SET version = 1 WHERE component = 'durable_queue';`);
    const second = new PostgresQueueStore({
      connectionString: connectionString!,
      schema,
      maxPoolSize: 1,
    });
    try {
      await second.migrate();
      assert.equal(
        (
          await admin.query(
            `SELECT COUNT(*)::int AS count FROM "${schema}".outbox_deduplication`,
          )
        ).rows[0].count,
        0,
      );
      await admin.query(`CREATE FUNCTION "${schema}".fail_retention() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'retention_injected_failure'; END $$;
      CREATE TRIGGER fail_retention BEFORE DELETE ON "${schema}".outbox FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_retention();`);
      await assert.rejects(
        second.outboxRetention.pruneDeliveredOutbox({
          ...policy,
          maxBatchSize: 2,
        }),
      );
      assert.equal(
        (
          await admin.query(
            `SELECT COUNT(*)::int AS count FROM "${schema}".outbox`,
          )
        ).rows[0].count,
        2,
      );
      assert.equal(
        (
          await admin.query(
            `SELECT COUNT(*)::int AS count FROM "${schema}".outbox_deduplication`,
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await admin.query(
            `SELECT next_due = '-infinity' AS initial FROM "${schema}".outbox_maintenance`,
          )
        ).rows[0].initial,
        true,
      );
      await admin.query(`DROP TRIGGER fail_retention ON "${schema}".outbox`);
      assert.equal(
        (
          await second.outboxRetention.pruneDeliveredOutbox({
            ...policy,
            maxBatchSize: 2,
          })
        ).deletedMessages,
        2,
      );
      assert.deepEqual(await store.commitRun(input), {
        ...original,
        disposition: "replayed",
      });
      await assert.rejects(
        store.commitRun(reuseRetiredId(input)),
        /outbox_message_conflict/,
      );
    } finally {
      await second.close();
    }
  },
);

test(
  "PostgreSQL maintenance is shared, skips locked delivered rows and releases its connection",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await open(context, "PostgreSQL");
    const { store, admin, schema } = fixture;
    assert.ok(admin);
    await seedThread(store);
    await store.commitRun(notifications(4));
    await acknowledge(store, 4);
    await fixture.ageDelivered();
    const blocker = await admin.connect();
    const second = new PostgresQueueStore({
      connectionString: connectionString!,
      schema,
      maxPoolSize: 1,
    });
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT message_id FROM "${schema}".outbox WHERE message_id = 'notification-0' FOR UPDATE`,
      );
      const [firstResult, secondResult] = await Promise.all([
        store.outboxRetention.pruneDeliveredOutbox(policy),
        second.outboxRetention.pruneDeliveredOutbox(policy),
      ]);
      assert.equal(
        firstResult.deletedMessages + secondResult.deletedMessages,
        1,
      );
      assert.ok(
        [firstResult, secondResult].some(
          (result) => result.disposition === "deferred",
        ),
      );
      assert.equal(
        (
          await admin.query(
            `SELECT COUNT(*)::int AS count FROM "${schema}".outbox WHERE message_id = 'notification-0'`,
          )
        ).rows[0].count,
        1,
      );
      await blocker.query("ROLLBACK");
      await fixture.nextMaintenance();
      assert.equal(
        (await second.outboxRetention.pruneDeliveredOutbox(policy))
          .deletedMessages,
        1,
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await second.close();
    }
  },
);

test(
  "PostgreSQL identity registration fences an insert racing the retirement commit",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await open(context, "PostgreSQL");
    const { store, admin, schema } = fixture;
    assert.ok(admin);
    await seedThread(store);
    const input = notifications(1);
    await store.commitRun(input);
    await acknowledge(store, 1);
    await fixture.ageDelivered();
    // Model an old row that predates lazy identity registration.
    await admin.query(`DELETE FROM "${schema}".outbox_deduplication`);
    let removed!: () => void;
    const afterDelete = new Promise<void>((done) => {
      removed = done;
    });
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const query = Client.prototype.query;
    context.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(query, this, args);
      if (
        typeof args[0] !== "string" ||
        !args[0].startsWith(`DELETE FROM "${schema}".outbox AS original`)
      )
        return result;
      return Promise.resolve(result).then(async (value) => {
        removed();
        await gate;
        return value;
      });
    } as typeof query);
    const writer = await admin.connect();
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const cleanup = store.outboxRetention.pruneDeliveredOutbox(policy);
    let insertion: Promise<unknown> | undefined;
    try {
      await Promise.race([
        afterDelete,
        cleanup.then(() => {
          throw new Error("retirement_did_not_reach_delete");
        }),
      ]);
      const message = input.outbox[0]!;
      insertion = writer.query(
        `INSERT INTO "${schema}".outbox
      (message_id, tenant_id, run_id, topic, message_json, created_at, available_at)
      VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
        [
          message.messageId,
          message.tenantId,
          message.runId,
          message.topic,
          message,
          message.createdAt,
        ],
      );
      const rejected = assert.rejects(insertion, /outbox_message_conflict/);
      const deadline = Date.now() + 4_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const activity = await admin.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [writerPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          waiting = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(
        waiting,
        true,
        "writer must wait on the actual uncommitted identity registration",
      );
      release();
      assert.equal((await cleanup).deletedMessages, 1);
      await rejected;
      assert.equal(
        (
          await admin.query(
            `SELECT COUNT(*)::int AS count FROM "${schema}".outbox`,
          )
        ).rows[0].count,
        0,
      );
    } finally {
      release();
      await cleanup.catch(() => {});
      await insertion?.catch(() => {});
      writer.release();
    }
  },
);

test(
  "PostgreSQL aged candidate range uses the partial index without sorting or scanning young deliveries",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await open(context, "PostgreSQL");
    const { store, admin, schema } = fixture;
    assert.ok(admin);
    await seedThread(store);
    await store.commitRun(notifications(1));
    await admin.query(`INSERT INTO "${schema}".outbox
    (message_id, tenant_id, run_id, topic, message_json, created_at, available_at, status, delivered_at)
    SELECT 'scale-' || id, 'tenant-1', 'run-store-1', 'run.updated', '{}', clock_timestamp(), clock_timestamp(), 'delivered',
      CASE WHEN id <= 100 THEN clock_timestamp() - interval '2 days' ELSE clock_timestamp() END
    FROM generate_series(1, 10000) AS id;
    ANALYZE "${schema}".outbox;`);
    const plan = await admin.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT message_id FROM "${schema}".outbox
    WHERE status = 'delivered' AND delivered_at <= statement_timestamp() - $1 * interval '1 millisecond'
    ORDER BY delivered_at, outbox_order LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [86_400_000, 5],
    );
    const encoded = JSON.stringify(plan.rows[0]["QUERY PLAN"]);
    assert.match(encoded, /outbox_delivered_retention_idx/);
    assert.match(encoded, /Index Cond/);
    assert.doesNotMatch(encoded, /Seq Scan|"Node Type":"Sort"/);
    assert.equal(
      (
        await store.outboxRetention.pruneDeliveredOutbox({
          ...policy,
          retentionMs: 86_400_000,
          maxBatchSize: 5,
        })
      ).deletedMessages,
      5,
    );
  },
);

function notifications(count: number): CommitRunInput {
  const input = createRunningCommitFixture();
  return {
    ...input,
    outbox: Array.from({ length: count }, (_, index) => ({
      ...input.outbox[0]!,
      messageId: `notification-${index}`,
    })),
  };
}

function reuseRetiredId(input: CommitRunInput): CommitRunInput {
  return {
    ...input,
    idempotency: { ...input.idempotency, key: "different-command" },
    events: input.events.map((event) => ({
      ...event,
      identity: { runId: "different-run" },
      eventId: `different-${event.eventId}`,
    })),
    outbox: [{ ...input.outbox[0]!, runId: "different-run" }],
    workItems: input.workItems.map((item) => ({
      ...item,
      workItemId: `different-${item.workItemId}`,
      runId: "different-run",
    })),
  };
}

async function acknowledge(
  store: InMemoryRunStore | SqliteRunStore | PostgresDomainStore,
  count: number,
) {
  for (let index = 0; index < count; index++) {
    const claim = await store.claimNextOutbox({
      ownerId: "dispatcher",
      leaseId: `lease-${index}`,
      leaseDurationMs: 60_000,
    });
    assert.ok(claim);
    await store.acknowledgeOutbox({
      messageId: claim.message.messageId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    });
  }
}

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-outbox-retention-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function open(context: TestContext, backend: Backend) {
  const clock = new ManualLeaseClock();
  const path =
    backend === "SQLite"
      ? join(temporaryDirectory(context), "store.db")
      : undefined;
  let admin: Pool | undefined;
  const schema = `retention_${randomUUID().replaceAll("-", "_")}`;
  let store: InMemoryRunStore | SqliteRunStore | PostgresDomainStore;
  if (backend === "PostgreSQL") {
    assert.ok(connectionString);
    admin = new Pool({ connectionString, max: 2 });
    store = await PostgresDomainStore.open({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
  } else
    store =
      path === undefined
        ? new InMemoryRunStore({ clock })
        : new SqliteRunStore(path, { clock });
  context.after(async () => {
    await store.close();
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
  return {
    store,
    clock,
    path,
    admin,
    schema,
    async ageDelivered() {
      clock.advance(5_000);
      if (admin)
        await admin.query(
          `UPDATE "${schema}".outbox SET delivered_at = clock_timestamp() - interval '5 seconds' WHERE status = 'delivered'`,
        );
    },
    async nextMaintenance() {
      clock.advance(1_000);
      if (admin)
        await admin.query(
          `UPDATE "${schema}".outbox_maintenance SET next_due = '-infinity'`,
        );
    },
  };
}
