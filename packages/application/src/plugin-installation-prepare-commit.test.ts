import assert from "node:assert/strict";
import test from "node:test";
import type { PluginPreparedSelection } from "./plugin-installation-host-port.ts";
import { checkedPreparedSelection } from "./plugin-installation-application-support.ts";
import {
  actor,
  deferred,
  installCommand,
  installationFixture,
  selectCommand,
} from "./plugin-installation.test-support.ts";

test("optional prepareCommit awaits current authority only after durable COMMIT, then publishes", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const original = f.host.prepareSelection;
  const entered = deferred<void>();
  const release = deferred<void>();
  f.host.prepareSelection = async (input) => {
    const handle = await original(input);
    return Object.freeze({
      ...handle,
      async prepareCommit({ selection }) {
        assert.deepEqual(
          await f.store.loadSelection({
            scope: input.scope,
            pluginId: selection.pluginId,
          }),
          selection,
        );
        assert.equal(f.state.commits, 0);
        entered.resolve();
        await release.promise;
      },
    });
  };
  const pending = f.service.select(actor, selectCommand);
  await entered.promise;
  assert.equal(f.state.commits, 0);
  release.resolve();
  const result = await pending;
  assert.equal(result.mutation.disposition, "committed");
  assert.equal(result.projection.outcome, "applied");
  assert.equal(f.state.commits, 1);
});

test("post-COMMIT refresh denial preserves durable receipt, aborts candidate and returns pending", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const original = f.host.prepareSelection;
  let refreshes = 0;
  f.host.prepareSelection = async (input) => ({
    ...(await original(input)),
    async prepareCommit() {
      refreshes++;
      throw new Error("current epoch was revoked");
    },
  });
  const result = await f.service.select(actor, selectCommand);
  assert.equal(result.mutation.selection.state, "enabled");
  assert.equal(result.projection.outcome, "pending");
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.aborts, 1);
  const replay = await f.service.select(actor, selectCommand);
  assert.equal(replay.mutation.disposition, "replayed");
  assert.equal(replay.projection.outcome, "unchanged");
  assert.equal(refreshes, 1);
  assert.equal(f.state.prepares.length, 1);
});

test("failed database mutation never refreshes or publishes", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const original = f.host.prepareSelection;
  let refreshes = 0;
  f.host.prepareSelection = async (input) => ({
    ...(await original(input)),
    async prepareCommit() {
      refreshes++;
    },
  });
  f.store.commitFailure = new Error("database failed");
  await assert.rejects(f.service.select(actor, selectCommand));
  assert.equal(refreshes, 0);
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.aborts, 1);
});

test("strict old two-method handles and extended handles retain actual receivers and captured methods", async () => {
  const calls: string[] = [];
  const legacy = {
    commit() {
      assert.equal(this, legacy);
      calls.push("commit");
    },
    async abort() {
      assert.equal(this, legacy);
      calls.push("abort");
    },
  };
  const checked = checkedPreparedSelection(legacy);
  legacy.commit = () => {
    throw new Error("replacement");
  };
  checked.commit({ selection: {} as never });
  await checked.abort();
  assert.equal(checked.prepareCommit, undefined);
  const extended = {
    commit() {
      assert.equal(this, extended);
      calls.push("newcommit");
    },
    async abort() {
      assert.equal(this, extended);
    },
    async prepareCommit() {
      assert.equal(this, extended);
      calls.push("refresh");
    },
  };
  const next = checkedPreparedSelection(extended);
  await next.prepareCommit!({ selection: {} as never });
  next.commit({ selection: {} as never });
  assert.deepEqual(calls, ["commit", "abort", "refresh", "newcommit"]);
});

test("prepareCommit must be an own enumerable data function without invoking getters", () => {
  let getters = 0;
  const legacy = { commit() {}, async abort() {} };
  const accessor = Object.defineProperty({ ...legacy }, "prepareCommit", {
    enumerable: true,
    get() {
      getters++;
      return async () => {};
    },
  });
  for (const input of [
    accessor,
    { ...legacy, prepareCommit: undefined },
    { ...legacy, prepareCommit: true },
    { ...legacy, extra: true },
    Object.assign(Object.create({ prepareCommit: async () => {} }), legacy),
  ])
    assert.throws(() =>
      checkedPreparedSelection(input as PluginPreparedSelection),
    );
  assert.equal(getters, 0);
});
