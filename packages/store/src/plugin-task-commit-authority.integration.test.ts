import assert from "node:assert/strict";
import test from "node:test";
import { actor, pluginQueryFixture } from "./plugin-query-task.test-support.ts";
import {
  authorityCounts,
  liveHostAuthority,
  pluginTaskCommitFixture,
  withdrawAfterActualInsert,
  withdrawn,
} from "./plugin-task-commit-authority.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: generation withdraw after actual receipt INSERT rolls back the original paid transaction`,
    options,
    async (t) => {
      const f = await pluginTaskCommitFixture(t, backend);
      const authority = liveHostAuthority(f.actor, f.pin);
      const before = await authorityCounts(f.count);
      const hook = withdrawAfterActualInsert(
        backend,
        "plugin_task_admissions",
        authority.withdraw,
      );
      try {
        await assert.rejects(
          f.service.createTaskFromPlugin(
            f.actor,
            f.command,
            f.pin,
            authority.port,
          ),
          withdrawn,
        );
        assert.equal(hook.inserted(), 1);
      } finally {
        hook.restore();
      }
      assert.ok(authority.activeCalls() > 0);
      assert.deepEqual(await authorityCounts(f.count), before);
      assert.equal(
        (await f.first.parent.pluginCreditStore().getAccount(f.creditScope))
          ?.reservedCredits,
        "0",
      );
    },
  );
  test(
    `${backend}: query withdraw after actual admission INSERT rolls back the original query transaction`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend);
      const authority = liveHostAuthority(actor, f.queryPin);
      const before = await authorityCounts(f.count);
      const hook = withdrawAfterActualInsert(
        backend,
        "plugin_query_task_admissions",
        authority.withdraw,
      );
      try {
        await assert.rejects(
          f
            .create(f.first.store, f.first.parent, f.host)
            .createQueryTaskFromPlugin(
              actor,
              f.command(),
              f.queryPin,
              authority.port,
            ),
          withdrawn,
        );
        assert.equal(hook.inserted(), 1);
      } finally {
        hook.restore();
      }
      assert.deepEqual(await authorityCounts(f.count), before);
    },
  );
  test(
    `${backend}: the confirmed paid receipt and existing authority-only Host remain compatible`,
    options,
    async (t) => {
      const f = await pluginTaskCommitFixture(t, backend);
      const authority = liveHostAuthority(f.actor, f.pin);
      const accepted = await f.service.createTaskFromPlugin(
        f.actor,
        f.command,
        f.pin,
        authority.port,
      );
      assert.equal(accepted.run.disposition, "committed");
      const after = await authorityCounts(f.count);
      assert.equal(
        (await f.first.parent.pluginCreditStore().getAccount(f.creditScope))
          ?.reservedCredits,
        "7",
      );
      const calls = authority.activeCalls();
      authority.withdraw();
      const replay = await f.service.createTaskFromPlugin(
        f.actor,
        f.command,
        f.pin,
        authority.port,
      );
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, accepted.binding);
      assert.deepEqual(replay.creditAdmission, accepted.creditAdmission);
      assert.equal(authority.activeCalls(), calls);
      assert.deepEqual(await authorityCounts(f.count), after);
      const legacy = await f.service.createTaskFromPlugin(
        f.actor,
        f.command,
        f.pin,
        { async assertCurrent() {} },
      );
      assert.deepEqual(legacy.binding, accepted.binding);
      assert.deepEqual(await authorityCounts(f.count), after);
    },
  );
}
