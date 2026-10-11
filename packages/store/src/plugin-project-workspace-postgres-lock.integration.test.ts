import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import { ThreadApplicationService } from "@crewon/application";
import { workspaceNamespaceFixture } from "./plugin-project-workspace.test-support.ts";
import { pluginProjectNamespaceLock } from "./plugin-project-workspace-store-support.ts";
import { hasPostgresConversationSchema } from "./project-conversation-schema.ts";
import { unmeteredFixture } from "./plugin-task-unmetered.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const table = "plugin_project_workspace_namespaces";

test(
  "postgres: unmigrated Conversation schema remains absent after namespace opt-in and ordinary Thread creation",
  { skip: connectionString === undefined },
  async (t) => {
    const f = await unmeteredFixture(t, "postgres");
    const schemaMatch = /^"([a-z0-9_]+)"\.$/u.exec(f.prefix);
    assert.ok(
      schemaMatch?.[1],
      "the original PostgreSQL fixture supplies its real schema prefix",
    );
    const schema = schemaMatch[1];
    const observerPool = new Pool({ connectionString, max: 1 });
    const observer = await observerPool.connect();
    try {
      const catalog = async () => {
        const tables = (
          await observer.query<{ relname: string }>(
            "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname",
            [
              schema,
              [
                "project_conversation_schema_version",
                "project_conversation_bindings",
                "project_conversation_receipts",
                "project_stage_run_admissions",
              ],
            ],
          )
        ).rows;
        const markers = (
          await observer.query<{ attname: string }>(
            "SELECT a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='threads' AND a.attname='project_conversation_binding_id' AND a.attnum>0 AND NOT a.attisdropped",
            [schema],
          )
        ).rows;
        return { tables, markers };
      };
      const before = await catalog();
      assert.deepEqual(before, { tables: [], markers: [] });
      await f.first.parent.migratePluginProjectWorkspaceNamespaces();
      assert.equal(
        await hasPostgresConversationSchema(observer, schema),
        false,
      );
      const threads = new ThreadApplicationService({
        store: f.first.parent,
        authorization: {
          async authorize() {
            return { outcome: "allow" as const };
          },
        },
        clock: { now: () => timestamp },
        ids: { nextId: () => randomUUID() },
        digester: extensionStoreDigester,
      });
      const created = await threads.createThread(f.actor, {
        kind: "thread.create",
        title: "Original ordinary conversation",
        workspaceId: null,
        idempotencyKey: randomUUID(),
      });
      assert.equal(created.disposition, "committed");
      assert.equal(created.state.workspaceId, null);
      assert.deepEqual(
        await f.first.parent.loadThread({
          tenantId: f.actor.tenantId,
          threadId: created.state.threadId,
        }),
        created.state,
      );
      assert.equal(
        await hasPostgresConversationSchema(observer, schema),
        false,
      );
      assert.deepEqual(await catalog(), before);
    } finally {
      observer.release();
      await observerPool.end();
    }
  },
);

for (const scenario of [
  "withdraw-null",
  "commit-null",
  "commit-ordinary",
] as const) {
  test(
    `postgres: actual project occupancy lock serializes namespace INSERT and original binding (${scenario})`,
    { skip: connectionString === undefined, timeout: 15_000 },
    async (t) => {
      const f = await workspaceNamespaceFixture(t, "postgres");
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const mount = await f.mounted();
      const workspaceId =
        scenario === "commit-ordinary" ? "workspace-original" : null;
      const prepared = await f.prepare(undefined, workspaceId);
      const owner = f.namespaceOwner();
      const key = pluginProjectNamespaceLock(owner);
      assert.deepEqual(JSON.parse(key).slice(1), [
        owner.tenantId,
        owner.spaceId,
        owner.principalId,
        owner.actorId,
        owner.profileId,
        owner.projectId,
      ]);
      const gate = observeNamespaceInsert(f.prefix, key);
      t.after(() => {
        gate.release();
        gate.restore();
      });
      const observer = new Client({ connectionString });
      await observer.connect();
      const saving = mount.write();
      void saving.catch(() => {});
      let binding: ReturnType<typeof f.store.commitBinding> | undefined;
      try {
        const namespacePid = await Promise.race([
          gate.entered,
          saving.then(() =>
            assert.fail("namespace completed without the actual INSERT gate"),
          ),
        ]);
        binding = f.second.parent
          .projectConversationStore()
          .commitBinding(prepared, {
            authority: f.authority,
          });
        void binding.catch(() => {});
        const bindingPid = await Promise.race([
          gate.bindingRequested,
          binding.then(() =>
            assert.fail(
              "binding completed without requesting the occupancy lock",
            ),
          ),
        ]);
        await waitBlocked(observer, namespacePid, bindingPid);
        assert.notEqual(bindingPid, namespacePid);
        assert.equal(gate.lockRequests.get(bindingPid), key);
        assert.equal(gate.inserted(), 1);

        if (scenario === "withdraw-null") f.namespaceState.allowed = false;
        gate.release();
        if (scenario === "withdraw-null") {
          await assert.rejects(saving);
          assert.equal((await binding).disposition, "committed");
          assert.equal(await f.count(table), 0);
          assert.equal(await f.count("project_conversation_bindings"), 1);
          assert.equal(await f.count("project_conversation_receipts"), 1);
          assert.equal(
            (
              await f.parent.loadThread({
                tenantId: f.actor.tenantId,
                threadId: prepared.binding.threadId,
              })
            )?.workspaceId,
            null,
          );
        } else {
          await saving;
          await assert.rejects(
            binding,
            /plugin_project_workspace_scope_conflict/u,
          );
          assert.equal(await f.count(table), 1);
          assert.equal(await f.count("project_conversation_bindings"), 0);
          assert.equal(await f.count("project_conversation_receipts"), 0);
          assert.equal(
            await f.parent.loadThread({
              tenantId: f.actor.tenantId,
              threadId: prepared.binding.threadId,
            }),
            null,
          );
        }
        const namespace = await f.parent
          .pluginProjectWorkspaceNamespaces()
          .loadNamespace({ owner });
        if (scenario === "withdraw-null") assert.equal(namespace, null);
        else {
          assert.equal(namespace?.workspaceId, "workspace-isolated");
          assert.deepEqual(namespace?.owner, owner);
        }
      } finally {
        gate.release();
        await Promise.allSettled([saving, binding]);
        gate.restore();
        await observer.end();
      }
    },
  );
}

/** Preserve the actual INSERT result and pause its original transaction before the final authority check/COMMIT. */
function observeNamespaceInsert(prefix: string, occupancyKey: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Client.prototype,
    "query",
  )!;
  const entered = deferred<number>();
  const resumed = deferred<void>();
  const bindingRequested = deferred<number>();
  const lockRequests = new Map<number, string>();
  let inserted = 0;
  let namespacePid: number | null = null;
  Object.defineProperty(Client.prototype, "query", {
    ...descriptor,
    value: function (this: object, ...args: unknown[]) {
      const result = Reflect.apply(descriptor.value, this, args);
      const pid = Reflect.get(this, "processID") as unknown;
      const sql = args[0];
      if (
        typeof pid === "number" &&
        sql === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))" &&
        Array.isArray(args[1]) &&
        args[1][0] === occupancyKey
      ) {
        lockRequests.set(pid, occupancyKey);
        if (namespacePid !== null && pid !== namespacePid)
          bindingRequested.resolve(pid);
      }
      if (
        typeof sql !== "string" ||
        !sql.startsWith(`INSERT INTO ${prefix}${table}(`)
      )
        return result;
      return Promise.resolve(result).then(async (value) => {
        assert.equal(typeof pid, "number");
        inserted++;
        namespacePid = pid as number;
        entered.resolve(pid as number);
        await resumed.promise;
        return value;
      });
    },
  });
  return {
    entered: entered.promise,
    bindingRequested: bindingRequested.promise,
    lockRequests,
    inserted: () => inserted,
    release: () => resumed.resolve(),
    restore: () => Object.defineProperty(Client.prototype, "query", descriptor),
  };
}

/** Observe the actual PostgreSQL wait dependency; elapsed time alone is not evidence of serialization. */
async function waitBlocked(
  observer: Client,
  blockerPid: number,
  bindingPid: number,
): Promise<void> {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const rows = (
      await observer.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE pid=$1::integer AND $2::integer=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock' AND query=$3",
        [
          bindingPid,
          blockerPid,
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ],
      )
    ).rows;
    assert.ok(
      rows.length <= 1,
      "only the original binding may wait on this namespace transaction",
    );
    if (rows.length === 1) return;
    await delay(5);
  }
  assert.fail(
    `original binding did not wait on namespace backend ${blockerPid}`,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
