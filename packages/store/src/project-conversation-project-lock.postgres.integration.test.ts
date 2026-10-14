import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { workspaceNamespaceFixture } from "./plugin-project-workspace.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
import { pluginProjectNamespaceLock } from "./plugin-project-workspace-store-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

test(
  "postgres: actual protected Conversation waits for Project before holding Namespace and then commits and cold-replays once",
  { skip: connectionString === undefined, timeout: 15_000 },
  async (t) => {
    const f = await workspaceNamespaceFixture(t, "postgres");
    await f.parent.migratePluginProjectWorkspaceNamespaces();
    await (await f.mounted()).write();
    const prepared = await f.prepare(randomUUID(), "workspace-isolated");
    const schema = f.prefix.slice(1, -2);
    const metadata = await foundationMetadataFixture(t, {
      backend: "postgres",
      path: f.databasePath,
      schema,
      prefix: f.prefix,
    });
    await metadata.migrate();
    await metadata.mark(f.reference.projectId, f.namespaceScope);
    const projectKey = JSON.stringify([
      "creative-project-project",
      schema,
      f.actor.tenantId,
      f.actor.spaceId,
      f.reference.projectId,
    ]);
    const namespaceKey = pluginProjectNamespaceLock(f.namespaceOwner());
    const blocker = new Client({ connectionString });
    const observer = new Client({ connectionString });
    const probe = new Client({ connectionString });
    await Promise.all([blocker.connect(), observer.connect(), probe.connect()]);
    const gate = observeProjectRequest(projectKey, namespaceKey);
    let binding: ReturnType<typeof f.store.commitBinding> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [projectKey],
      );
      const blockerPid = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      gate.arm();
      binding = f.second.parent
        .projectConversationStore()
        .commitBinding(prepared, {
          authority: f.authority,
        });
      void binding.catch(() => {});
      const bindingPid = await Promise.race([
        gate.requested,
        binding.then(() =>
          assert.fail("binding bypassed the held Project lock"),
        ),
      ]);
      await waitBlocked(observer, blockerPid, bindingPid);
      assert.equal(gate.namespaceRequests(bindingPid), 0);

      // A paired transaction can still obtain Namespace while the original
      // Conversation is waiting for Project. This proves no opposite lock edge
      // exists; a timeout or a successful single-threaded write would not.
      await probe.query("BEGIN");
      const available = await probe.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [namespaceKey],
      );
      assert.equal(available.rows[0]?.acquired, true);
      await probe.query("ROLLBACK");
      await blocker.query("COMMIT");

      const committed = await binding;
      assert.equal(committed.disposition, "committed");
      assert.equal(committed.binding.workspaceId, "workspace-isolated");
      assert.ok(gate.namespaceRequests(bindingPid) > 0);
      const replay = await f.store.commitBinding(prepared, {
        authority: f.authority,
      });
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.binding, committed.binding);
      assert.equal(await f.count("project_conversation_bindings"), 1);
      assert.equal(await f.count("project_conversation_receipts"), 1);
      assert.equal(
        (
          await f.parent.loadThread({
            tenantId: f.actor.tenantId,
            threadId: prepared.binding.threadId,
          })
        )?.workspaceId,
        "workspace-isolated",
      );
    } finally {
      await Promise.allSettled([
        blocker.query("ROLLBACK"),
        probe.query("ROLLBACK"),
      ]);
      await Promise.allSettled([binding]);
      gate.restore();
      await Promise.all([blocker.end(), observer.end(), probe.end()]);
    }
  },
);

/** Observe only actual original SQL requests. No query, lock result or authority is fabricated. */
function observeProjectRequest(projectKey: string, namespaceKey: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Client.prototype,
    "query",
  )!;
  let armed = false;
  let resolve!: (pid: number) => void;
  const requested = new Promise<number>((complete) => {
    resolve = complete;
  });
  const namespaces = new Map<number, number>();
  Object.defineProperty(Client.prototype, "query", {
    ...descriptor,
    value: function (this: object, ...args: unknown[]) {
      const result = Reflect.apply(descriptor.value, this, args);
      const pid = Reflect.get(this, "processID") as unknown;
      const sql = args[0];
      if (
        armed &&
        typeof pid === "number" &&
        typeof sql === "string" &&
        /^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,\s*0\)\)$/u.test(
          sql,
        ) &&
        Array.isArray(args[1])
      ) {
        if (args[1][0] === projectKey) resolve(pid);
        if (args[1][0] === namespaceKey)
          namespaces.set(pid, (namespaces.get(pid) ?? 0) + 1);
      }
      return result;
    },
  });
  return {
    requested,
    arm: () => {
      armed = true;
    },
    namespaceRequests: (pid: number) => namespaces.get(pid) ?? 0,
    restore: () => Object.defineProperty(Client.prototype, "query", descriptor),
  };
}

async function waitBlocked(
  observer: Client,
  blockerPid: number,
  bindingPid: number,
) {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const state = await observer.query<{ blocked: boolean }>(
      "SELECT $2::integer=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1::integer AND wait_event_type='Lock'",
      [bindingPid, blockerPid],
    );
    if (state.rows[0]?.blocked) return;
    await delay(5);
  }
  assert.fail(
    "the actual original Conversation never waited on the Project holder",
  );
}
