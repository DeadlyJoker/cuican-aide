import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import { checkedPreparedSelection } from "./plugin-installation-application-support.ts";
import type { PluginPreparedSelection } from "./plugin-installation-host-port.ts";
import {
  actor,
  installCommand,
  installationFixture,
  scope,
  selectCommand,
} from "./plugin-installation.test-support.ts";

test("Application forwards captured synchronous local fence to Store beforeCommit and preserves pre-write, post-COMMIT and publication order", async () => {
  const f = installationFixture();
  const initial = await f.service.install(actor, installCommand);
  const events: string[] = [];
  const originalPrepare = f.host.prepareSelection;
  const originalMutation = f.store.commitSelection.bind(f.store);
  f.host.prepareSelection = async (input) => {
    const previous = await originalPrepare(input);
    const handle = {
      assertBeforeSelectionCommit({
        selection,
      }: Parameters<
        NonNullable<PluginPreparedSelection["assertBeforeSelectionCommit"]>
      >[0]) {
        assert.equal(this, handle);
        assert.deepEqual(selection, input.nextSelection);
        assert.deepEqual([...f.store.selections.values()], [initial.selection]);
        assert.equal(f.state.commits, 0);
        events.push("before");
      },
      async prepareCommit() {
        assert.equal(this, handle);
        assert.deepEqual(
          [...f.store.selections.values()],
          [input.nextSelection],
        );
        events.push("after");
      },
      commit(input: Parameters<PluginPreparedSelection["commit"]>[0]) {
        assert.equal(this, handle);
        events.push("publish");
        previous.commit(input);
      },
      async abort() {
        await previous.abort();
      },
    };
    return handle;
  };
  f.store.commitSelection = async (input) => {
    assert.equal(typeof input.beforeCommit, "function");
    input.beforeCommit!({ selection: input.selection });
    return originalMutation(input);
  };
  const applied = await f.service.select(actor, selectCommand);
  assert.equal(applied.projection.outcome, "applied");
  assert.deepEqual(events, ["before", "after", "publish"]);
  const replay = await f.service.select(actor, selectCommand);
  assert.equal(replay.mutation.disposition, "replayed");
  assert.deepEqual(events, ["before", "after", "publish"]);
  assert.equal(f.state.prepares.length, 1);
});

test("Application aborts original candidate after Store local-fence denial without projection or an enabled receipt", async () => {
  const f = installationFixture();
  const initial = await f.service.install(actor, installCommand);
  const prepare = f.host.prepareSelection;
  const mutate = f.store.commitSelection.bind(f.store);
  f.host.prepareSelection = async (input) => ({
    ...(await prepare(input)),
    assertBeforeSelectionCommit() {
      throw new ApplicationError(
        "conflict",
        "desktop_plugin_candidate_configuration_changed",
      );
    },
  });
  f.store.commitSelection = async (input) => {
    input.beforeCommit!({ selection: input.selection });
    return mutate(input);
  };
  await assert.rejects(f.service.select(actor, selectCommand), {
    category: "conflict",
    code: "desktop_plugin_candidate_configuration_changed",
  });
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.aborts, 1);
  assert.equal(f.state.projection, null);
  assert.deepEqual(
    await f.store.loadSelection({ scope, pluginId: selectCommand.pluginId }),
    initial.selection,
  );
  assert.equal(f.store.receipts.size, 1);
});

test("local selection fence is an exact optional own data function, with captured receiver and no getter evaluation", () => {
  const base = { commit() {}, async abort() {} };
  let getters = 0;
  let calls = 0;
  const input = {
    ...base,
    assertBeforeSelectionCommit() {
      assert.equal(this, input);
      calls++;
    },
  };
  const captured = checkedPreparedSelection(input);
  input.assertBeforeSelectionCommit = () => {
    throw new Error("replaced method must not run");
  };
  captured.assertBeforeSelectionCommit!({ selection: {} as never });
  assert.equal(calls, 1);
  const getter = Object.defineProperty(
    { ...base },
    "assertBeforeSelectionCommit",
    {
      enumerable: true,
      get() {
        getters++;
        return () => {};
      },
    },
  );
  for (const invalid of [
    getter,
    { ...base, assertBeforeSelectionCommit: undefined },
    { ...base, assertBeforeSelectionCommit: true },
    Object.assign(Object.create({ assertBeforeSelectionCommit() {} }), base),
    { ...base, assertBeforeSelectionCommit() {}, extra: true },
  ])
    assert.throws(() => checkedPreparedSelection(invalid));
  assert.equal(getters, 0);
  assert.equal(
    checkedPreparedSelection(base).assertBeforeSelectionCommit,
    undefined,
  );
});
