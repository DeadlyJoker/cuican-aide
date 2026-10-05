import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { Client } from "pg";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: create Thread and binding atomically, replay and cold parent retain immutable workspace`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      const before = await f.creditObjects();
      assert.equal(
        await f.parent.loadThread({
          tenantId: f.actor.tenantId,
          threadId: p.binding.threadId,
        }),
        null,
      );
      const result = await f.store.commitBinding(p, { authority: f.authority });
      assert.equal(result.disposition, "committed");
      const thread = await f.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: p.binding.threadId,
      });
      assert.ok(thread);
      assert.equal(thread.workspaceId, p.binding.workspaceId);
      assert.equal(
        (await f.store.commitBinding(p, { authority: f.authority }))
          .disposition,
        "replayed",
      );
      const second = f.second.parent.projectConversationStore();
      assert.deepEqual(
        await second.loadBinding({ ...f.owner, threadId: p.binding.threadId }),
        p.binding,
      );
      assert.equal(
        await second.hasThreadBinding({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          threadId: p.binding.threadId,
        }),
        true,
      );
      assert.equal(
        await second.loadBinding({
          ...f.owner,
          actor: { ...f.actor, actorId: "different-actor" },
          threadId: p.binding.threadId,
        }),
        null,
      );
      assert.deepEqual(await f.creditObjects(), before);
    },
  );
  test(
    `${backend}: final owner withdrawal rolls back Thread, binding and receipt together`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      f.state.withdrawAfterChecks = 1;
      await assert.rejects(
        f.store.commitBinding(p, { authority: f.authority }),
        /owner_withdrawn/u,
      );
      assert.equal(
        await f.parent.loadThread({
          tenantId: f.actor.tenantId,
          threadId: p.binding.threadId,
        }),
        null,
      );
      assert.equal(
        await f.store.hasThreadBinding({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          threadId: p.binding.threadId,
        }),
        false,
      );
      assert.equal(
        await f.store.loadMutationReceipt({ ...f.owner, receipt: p.receipt }),
        null,
      );
    },
  );
  test(
    `${backend}: CAS refresh, revocation and known-package/current selection fences`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      const refresh = f.mutate(p.binding, "refresh-source");
      await f.store.commitBinding(refresh, { authority: f.authority });
      await assert.rejects(
        f.store.commitBinding(f.mutate(p.binding, "set-state"), {
          authority: f.authority,
        }),
        /revision_conflict/u,
      );
      const revoked = f.mutate(refresh.binding, "set-state");
      await f.store.commitBinding(revoked, { authority: f.authority });
      assert.equal(
        (
          await f.store.loadBinding({
            ...f.owner,
            threadId: p.binding.threadId,
          })
        )?.state,
        "revoked",
      );
      await f.installs.commitSelection(
        selectionRecipe(f.enabled.selection, "disable-conversation", {
          actor: f.actor,
          state: "disabled",
        }),
      );
      await assert.rejects(
        f.store.commitBinding(p, { authority: f.authority }),
        /pin_conflict/u,
      );
    },
  );
  test(
    `${backend}: bounded exact-owner Thread pagination and getter capture`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend);
      let getterCalls = 0;
      const bad = {
        get kind() {
          getterCalls++;
          return "create";
        },
      };
      await assert.rejects(
        f.store.commitBinding(bad as never, { authority: f.authority }),
      );
      assert.equal(getterCalls, 0);
      const all = [];
      for (let i = 0; i < 3; i++) {
        const p = await f.prepare();
        await f.store.commitBinding(p, { authority: f.authority });
        all.push(p.binding.threadId);
      }
      all.sort();
      const first = await f.store.listBindings({
        ...f.owner,
        projectId: f.reference.projectId,
        afterThreadId: null,
        limit: 2,
      });
      assert.deepEqual(
        first.bindings.map((b) => b.threadId),
        all.slice(0, 2),
      );
      assert.equal(first.nextThreadId, all[1]);
      const last = await f.store.listBindings({
        ...f.owner,
        projectId: f.reference.projectId,
        afterThreadId: first.nextThreadId,
        limit: 2,
      });
      assert.deepEqual(
        last.bindings.map((b) => b.threadId),
        all.slice(2),
      );
      assert.equal(last.nextThreadId, null);
      await assert.rejects(
        f.store.listBindings({
          ...f.owner,
          projectId: f.reference.projectId,
          afterThreadId: null,
          limit: 17,
        }),
        /limit_invalid/u,
      );
    },
  );
}

test(
  "postgres: actual project lock waiter rechecks withdrawn PDP before COMMIT on a single-connection parent",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15000 },
  async (t) => {
    const f = await conversationFixture(t, "postgres"),
      p = await f.prepare();
    const gate = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await gate.connect();
    t.after(() => gate.end());
    await gate.query("BEGIN");
    const gatePid = (
      await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify([
        "creative-project-project",
        f.prefix.slice(1, -2),
        f.actor.tenantId,
        f.actor.spaceId,
        f.reference.projectId,
      ]),
    ]);
    const pending = f.store.commitBinding(p, { authority: f.authority }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      let waited = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await f.rows(
          `SELECT pid FROM pg_catalog.pg_stat_activity WHERE ${gatePid}=ANY(pg_catalog.pg_blocking_pids(pid))`,
        );
        if (rows.length > 0) {
          waited = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waited,
        true,
        "observe actual blocking PID before withdrawing policy",
      );
      f.state.current = false;
    } finally {
      await gate.query("ROLLBACK");
    }
    const outcome = await pending;
    assert.ok("error" in outcome);
    assert.match(
      String(outcome.error),
      /named_project_conversation_pdp_denied/u,
    );
    assert.equal(
      await f.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: p.binding.threadId,
      }),
      null,
    );
    assert.equal(
      await f.store.loadMutationReceipt({ ...f.owner, receipt: p.receipt }),
      null,
    );
  },
);
