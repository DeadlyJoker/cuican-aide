import assert from "node:assert/strict";
import test from "node:test";
import { productionConceptSelectionUiFixture } from "./production-project-generation-selection-plugin-runtime.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30000,
  };
  test(
    `${backend} installed selection bytes use actual source mount and original request scopes through same SQL and durable replay`,
    options,
    async (t) => {
      const f = await productionConceptSelectionUiFixture(t, backend),
        mount = await f.mount();
      const before = await f.counts(),
        credits = await f.credits.getAccount(f.creditScope);
      const first = await f.invoke(mount);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().output.disposition, "committed");
      await f.uiRuntime.service.closeMount(f.actor, { mountRef: mount });
      const reopened = await f.mount();
      assert.notEqual(reopened, mount);
      const replay = await f.invoke(reopened);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().output.disposition, "replayed");
      assert.deepEqual(
        replay.json().output.selection,
        first.json().output.selection,
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
      assert.equal(f.state.peerCalls, 0);
      assert.equal(f.state.unknownCalls, 0);
      assert.equal(f.policy.hostCalls, 0);
    },
  );
  test(
    `${backend} installed selection COMMIT stays accepted after actual owner/profile withdrawal and late UI close`,
    options,
    async (t) => {
      const f = await productionConceptSelectionUiFixture(t, backend),
        mount = await f.mount();
      f.state.afterCommit = () => {
        f.state.allowed = false;
        f.state.profile = {
          ...f.state.profile,
          profileId: "withdrawn-profile",
        };
        void f.selectionRuntime.close();
        void f.uiRuntime.service.closeMount(f.actor, { mountRef: mount });
      };
      const response = await f.invoke(mount);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().output.disposition, "committed");
      const current = await f.selections.loadCurrentConceptSelection({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: f.reference.projectId,
        assetId: f.reference.assetId,
      });
      assert.equal(current.selectionRevision, 1);
      assert.equal(f.state.peerCalls, 0);
      assert.equal(f.state.unknownCalls, 0);
    },
  );
  test(
    `${backend} current source PDP or profile denial before send publishes no selection and dispatches no peer`,
    options,
    async (t) => {
      const f = await productionConceptSelectionUiFixture(t, backend),
        mount = await f.mount();
      const before = await f.counts(),
        credits = await f.credits.getAccount(f.creditScope);
      f.state.allowed = false;
      const denied = await f.invoke(mount);
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(
        (
          await f.selections.loadCurrentConceptSelection({
            owner: {
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              principalId: f.actor.principalId,
            },
            projectId: f.reference.projectId,
            assetId: f.reference.assetId,
          })
        ).selectionRevision,
        0,
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
      assert.equal(f.state.peerCalls, 0);
      assert.equal(f.state.unknownCalls, 0);
    },
  );
}
