import assert from "node:assert/strict";
import { test } from "node:test";
import { projectHistoricalQueryBridgeFixture } from "./plugin-project-historical-query-action-bridge.test-support.ts";
import { bridgeDeferred } from "./plugin-project-generation-action-bridge.test-support.ts";
test("independently issued historical namespace yields original query receipt and does not grant old namespace", async () => {
  const f = await projectHistoricalQueryBridgeFixture(),
    outcome = await f.invoke();
  assert.ok(f.app.committed.isOutcome(outcome));
  const receipt = f.app.committed.verify(f.context, outcome) as {
    runId: string;
  };
  assert.ok(f.app.state.links.has(receipt.runId));
  assert.equal(f.state.calls, 1);
  assert.throws(() => f.app.committed.verify(f.context, outcome));
  await assert.rejects(
    f.actions.invoke({ ...f.context }),
    /project_historical_query_invocation_unavailable/u,
  );
});
test("unknown reserved action is refused; ordinary actions retain fallback", async () => {
  const f = await projectHistoricalQueryBridgeFixture();
  await assert.rejects(
    async () =>
      f.actions.invoke({
        ...f.context,
        action: "crewon.project-historical-queries.v1.generate",
      }),
    /action_invalid/u,
  );
  const other = { ...f.context, action: "ordinary.read" };
  assert.deepEqual(await f.actions.invoke(other), other.input);
  assert.equal(f.state.calls, 0);
});
test("closing joins an admitted dispatch and prevents preCOMMIT work after close", async () => {
  const f = await projectHistoricalQueryBridgeFixture(),
    entered = bridgeDeferred(),
    release = bridgeDeferred();
  f.state.beforeQuery = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.invoke(),
    rejection = assert.rejects(pending, /unavailable/u);
  await entered.promise;
  let joined = false;
  const close = f.bridge.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  release.resolve();
  await rejection;
  await close;
  assert.equal(joined, true);
  assert.equal(f.app.state.links.size, 0);
});
test("confirmed query survives postCOMMIT closure with no new permission", async () => {
  const f = await projectHistoricalQueryBridgeFixture();
  f.state.afterCommit = () => {
    f.state.open = false;
    f.state.allow = false;
  };
  const outcome = await f.invoke();
  assert.ok(f.app.committed.isOutcome(outcome));
  const receipt = f.app.committed.verify(f.context, outcome) as {
    runId: string;
  };
  assert.ok(f.app.state.links.has(receipt.runId));
  await f.bridge.close();
});
