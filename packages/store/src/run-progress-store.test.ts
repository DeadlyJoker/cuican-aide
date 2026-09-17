import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";
import type {
  AppendRunProgressEventsInput,
  DomainStore,
} from "@crewon/application";
import type { LeaseClock } from "./lease-clock.ts";

type Backend = "memory" | "sqlite" | "postgres";
async function fixture(context: TestContext, backend: Backend) {
  const stores: DomainStore[] = [];
  const root = mkdtempSync(join(tmpdir(), "crewon-progress-")),
    path = join(root, "store.sqlite");
  const schema = `progress_${randomUUID().replaceAll("-", "_")}`;
  const admin =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        })
      : null;
  let clock!: LeaseClock;
  const open = async () => {
    const store =
      backend === "memory"
        ? new InMemoryRunStore({ clock })
        : backend === "sqlite"
          ? new SqliteRunStore(path, { clock })
          : await PostgresDomainStore.open({
              connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
              schema,
              maxPoolSize: 2,
            });
    stores.push(store);
    return store;
  };
  context.after(async () => {
    for (const store of stores) await store.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const f = await outputFixture(context, async (value) => {
    clock = value;
    return open();
  });
  const query = async (sql: string) => {
    if (admin)
      return (await admin.query(sql.replaceAll("TABLE.", `"${schema}".`))).rows;
    const db = new DatabaseSync(path);
    try {
      return db.prepare(sql.replaceAll("TABLE.", "")).all();
    } finally {
      db.close();
    }
  };
  const input = (
    sequences: number[],
    revision: number,
    notification: string,
  ): AppendRunProgressEventsInput => ({
    ...f.input([], revision, notification),
    entries: sequences.map((sequence) => {
      const type =
        sequence === 1
          ? ("segment.started" as const)
          : ("usage.recorded" as const);
      const segment = { segmentId: "segment-1", segmentSequence: sequence };
      const event = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: "run-store-1" },
        eventId: `${notification}-${sequence}`,
        sequence: 999,
        occurredAt: "2026-08-08T00:01:01Z",
        ...(type === "segment.started"
          ? { type, data: { ...segment, attempt: 1 } }
          : {
              type,
              data: {
                ...segment,
                inputTokens: 100,
                cachedInputTokens: 80,
                cachedInputTokensReported: true,
                outputTokens: 10,
                totalTokens: 110,
              },
            }),
      };
      return {
        event,
        idempotency: {
          scope: "progress-fixture",
          key: `agent:segment-1:${sequence}`,
          requestFingerprint: JSON.stringify({ type, data: event.data }),
        },
      };
    }),
  });
  return {
    ...f,
    open,
    query,
    progressInput: input,
    progress: (value: AppendRunProgressEventsInput) =>
      f.store.appendRunProgressEvents!(value),
    schema,
    path,
    admin,
  };
}

for (const backend of ["memory", "sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };
  test(
    `${backend}: progress and output share source ordering and replay without full response receipts`,
    options,
    async (context) => {
      const f = await fixture(context, backend);
      await f.progress(f.progressInput([1], 2, "start"));
      await f.append(f.input([2], 3, "output"));
      await f.progress(f.progressInput([3], 4, "usage"));
      const replay = await f.progress(f.progressInput([1, 3], 2, "replay"));
      assert.equal(replay.replayedCount, 2);
      assert.equal(replay.appendedEvents.length, 0);
      assert.equal(replay.state.lastSequence, 5);
      assert.equal(
        (await f.store.listPendingOutbox(100)).filter(
          (x) => x.topic === "run.events.available",
        ).length,
        3,
      );
      const events = await f.events();
      assert.deepEqual(
        events.slice(2).map((x) => x.type),
        ["segment.started", "model.output.delta", "usage.recorded"],
      );
      const usage = events.at(-1)!;
      assert.ok(usage.type === "usage.recorded");
      assert.equal(usage.data.cachedInputTokens, 80);
      assert.equal(usage.data.cachedInputTokensReported, true);
      if (backend !== "memory") {
        assert.equal(
          Number(
            (
              await f.query("SELECT count(*) n FROM TABLE.run_output_receipts")
            )[0]!.n,
          ),
          3,
        );
        assert.equal(
          Number(
            (
              await f.query(
                "SELECT count(*) n FROM TABLE.idempotency_receipts WHERE scope='progress-fixture'",
              )
            )[0]!.n,
          ),
          0,
        );
      }
    },
  );
  test(
    `${backend}: mixed legacy receipts remain exact and old writers cannot duplicate new progress`,
    options,
    async (context) => {
      const f = await fixture(context, backend),
        old = f.progressInput([1], 2, "old");
      const commit = {
        tenantId: old.tenantId,
        expectedRevision: 2,
        idempotency: old.entries[0]!.idempotency,
        events: [{ ...old.entries[0]!.event, sequence: 3 }],
        outbox: [],
        workItems: [],
      };
      const exact = await f.store.commitLeasedRun({
        lease: old.lease,
        history: null,
        commit,
      });
      const mixed = await f.progress(f.progressInput([1, 2], 3, "new"));
      assert.equal(mixed.replayedCount, 1);
      assert.equal(mixed.appendedEvents.length, 1);
      assert.deepEqual(
        await f.store.commitLeasedRun({
          lease: old.lease,
          history: null,
          commit,
        }),
        { ...exact, disposition: "replayed" },
      );
      const entry = f.progressInput([2], 4, "duplicate").entries[0]!;
      await assert.rejects(
        f.store.commitLeasedRun({
          lease: old.lease,
          history: null,
          commit: {
            ...commit,
            expectedRevision: 4,
            idempotency: entry.idempotency,
            events: [{ ...entry.event, sequence: 5 }],
          },
        }),
        /run_output_replay_requires_stream_append/,
      );
      if (backend !== "memory") {
        const reopened = await f.open();
        assert.equal(
          (
            await reopened.appendRunProgressEvents!(
              f.progressInput([1, 2], 2, "reopen"),
            )
          ).replayedCount,
          2,
        );
        assert.deepEqual(
          await reopened.commitLeasedRun({
            lease: old.lease,
            history: null,
            commit,
          }),
          { ...exact, disposition: "replayed" },
        );
      }
      assert.equal((await f.events()).length, 4);
    },
  );
  test(
    `${backend}: duplicate progress converges, but altered content, old leases and invalid batches fail closed`,
    options,
    async (context) => {
      const f = await fixture(context, backend),
        second = backend === "memory" ? f.store : await f.open();
      const outcomes = await Promise.all([
        f.progress(f.progressInput([1, 2], 2, "one")),
        second.appendRunProgressEvents!(f.progressInput([1, 2], 2, "two")),
      ]);
      assert.deepEqual(
        outcomes.map((x) => x.appendedEvents.length).sort(),
        [0, 2],
      );
      const changed = f.progressInput([2], 4, "changed"),
        entry = changed.entries[0]!;
      assert.ok(entry.event.type === "usage.recorded");
      await assert.rejects(
        f.progress({
          ...changed,
          entries: [
            {
              ...entry,
              event: {
                ...entry.event,
                data: {
                  ...entry.event.data,
                  cachedInputTokens: 0,
                  cachedInputTokensReported: false,
                },
              },
            },
          ],
        }),
        /idempotency_conflict/,
      );
      await assert.rejects(
        f.progress({
          ...changed,
          lease: { ...changed.lease, leaseEpoch: changed.lease.leaseEpoch + 1 },
        }),
        /stale_lease/,
      );
      const invalid = f.progressInput([3, 4], 4, "invalid");
      await assert.rejects(
        f.progress({
          ...invalid,
          entries: invalid.entries.map((item, index) =>
            index === 0 || item.event.type !== "usage.recorded"
              ? item
              : {
                  ...item,
                  event: {
                    ...item.event,
                    data: { ...item.event.data, inputTokens: -1 },
                  },
                },
          ),
        }),
      );
      await assert.rejects(
        f.store.appendRunOutputEvents!(changed as never),
        /run_output_batch_invalid/,
      );
      await assert.rejects(
        f.progress(f.input([3], 4, "wrong-kind") as never),
        /run_output_batch_invalid/,
      );
      assert.equal((await f.events()).length, 4);
    },
  );
  test(
    `${backend}: progress obeys budgets and tenant isolation and cannot undo cancellation`,
    options,
    async (context) => {
      const f = await fixture(context, backend);
      await assert.rejects(
        f.progress(
          f.progressInput(
            Array.from({ length: 33 }, (_, index) => index + 1),
            2,
            "count",
          ),
        ),
        /run_output_batch_invalid/,
      );
      const large = f.progressInput([1], 2, "bytes");
      await assert.rejects(
        f.progress({
          ...large,
          entries: large.entries.map((entry) => ({
            ...entry,
            idempotency: {
              ...entry.idempotency,
              requestFingerprint: "x".repeat(300 * 1024),
            },
          })),
        }),
        /run_output_batch_too_large/,
      );
      await f.progress(f.progressInput([1], 2, "start"));
      await assert.rejects(
        f.progress({
          ...f.progressInput([1], 3, "foreign"),
          tenantId: "tenant-other",
        }),
        /work_item_scope_mismatch/,
      );
      await f.store.commitRun({
        tenantId: "tenant-1",
        expectedRevision: 3,
        idempotency: {
          scope: "cancel",
          key: "cancel",
          requestFingerprint: "cancel",
        },
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: "run-store-1" },
            eventId: "cancel",
            sequence: 4,
            occurredAt: "2026-08-08T00:01:02Z",
            type: "run.cancel.requested",
            data: { actorId: "actor-1" },
          },
        ],
        outbox: [],
        workItems: [],
      });
      await assert.rejects(
        f.progress(f.progressInput([2], 4, "canceled")),
        /execution_cancel_pending/,
      );
      const replay = await f.progress(f.progressInput([1], 2, "replay"));
      assert.equal(replay.state.cancelRequested, true);
      assert.equal(replay.replayedCount, 1);
      assert.equal((await f.events()).length, 4);
    },
  );
  if (backend !== "memory")
    test(
      `${backend}: previous schema upgrades without rewriting old receipt bodies`,
      options,
      async (context) => {
        const f = await fixture(context, backend),
          input = f.progressInput([1], 2, "old");
        await f.store.commitLeasedRun({
          lease: input.lease,
          history: null,
          commit: {
            tenantId: input.tenantId,
            expectedRevision: 2,
            idempotency: input.entries[0]!.idempotency,
            events: [{ ...input.entries[0]!.event, sequence: 3 }],
            outbox: [],
            workItems: [],
          },
        });
        const before = await f.query(
          "SELECT fingerprint,result_json FROM TABLE.idempotency_receipts ORDER BY scope,idempotency_key",
        );
        await f.store.close();
        if (f.admin)
          await f.admin.query(
            `DROP TRIGGER run_progress_receipt_duplicate_guard ON "${f.schema}".run_events; UPDATE "${f.schema}".schema_migrations SET version=5 WHERE component='run_authority'`,
          );
        else {
          const db = new DatabaseSync(f.path);
          db.exec(
            "DROP TRIGGER run_progress_receipt_duplicate_guard; PRAGMA user_version=35",
          );
          db.close();
        }
        const reopened = await f.open();
        assert.deepEqual(
          await f.query(
            "SELECT fingerprint,result_json FROM TABLE.idempotency_receipts ORDER BY scope,idempotency_key",
          ),
          before,
        );
        const after = await reopened.appendRunProgressEvents!(
          f.progressInput([1, 2], 3, "upgraded"),
        );
        assert.equal(after.replayedCount, 1);
        assert.equal(after.appendedEvents.length, 1);
        const duplicate = f.progressInput([2], 4, "old-writer").entries[0]!;
        await assert.rejects(
          reopened.commitLeasedRun({
            lease: input.lease,
            history: null,
            commit: {
              tenantId: input.tenantId,
              expectedRevision: 4,
              idempotency: duplicate.idempotency,
              events: [{ ...duplicate.event, sequence: 5 }],
              outbox: [],
              workItems: [],
            },
          }),
          /run_output_replay_requires_stream_append/,
        );
      },
    );
}
