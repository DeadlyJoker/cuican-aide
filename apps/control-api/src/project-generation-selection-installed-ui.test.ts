import assert from "node:assert/strict";
import test from "node:test";
import { conceptSelectionInstalledUiFixture } from "./project-generation-selection-route.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} registered source UI selects through original HTTP and same SQL without another Run, quote or credit reservation`,
    options,
    async (t) => {
      const f = await conceptSelectionInstalledUiFixture(t, backend);
      const before = await f.counts(),
        credits = await f.credits.getAccount(f.creditScope);
      const response = await f.invoke();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().output.disposition, "committed");
      assert.equal(response.json().output.selection.filename, "first.png");
      assert.equal(
        f.uiState.context!.action,
        "crewon.project-generation-selections.v1.selectConceptImage",
      );
      assert.equal(f.uiState.context!.lease.descriptor.entrypoints.node, null);
      const replay = await f.invoke();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().output.disposition, "replayed");
      assert.deepEqual(
        replay.json().output.selection,
        response.json().output.selection,
      );
      const current = await f.app.inject({
        url: f.selectionUrl,
        headers: f.selectionHeaders(),
      });
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().current.filename, "first.png");
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
      assert.equal(f.policy.hostCalls, 0);
    },
  );
  test(
    `${backend} confirmed selection COMMIT survives source close and revocation while its single-use outcome preserves original HTTP response`,
    options,
    async (t) => {
      const f = await conceptSelectionInstalledUiFixture(t, backend);
      const before = await f.counts();
      f.uiState.afterOutcome = () => {
        f.uiState.allow = false;
        void f.owner.close();
        void f.ui.closeMount(f.actor, { mountRef: f.mountRef });
      };
      const response = await f.invoke();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().output.disposition, "committed");
      const current = await f.app.inject({
        url: f.selectionUrl,
        headers: f.selectionHeaders(),
      });
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().selectionRevision, 1);
      assert.deepEqual(await f.counts(), before);
      const denied = await f.invoke({
        ...f.selectionBody(1, 1),
        idempotencyKey: "no-after-close",
      });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(denied.json().error.code, "plugin_ui_mount_unavailable");
    },
  );
  test(
    `${backend} precommit source withdrawal is refused without a pointer, Run or charge`,
    options,
    async (t) => {
      const f = await conceptSelectionInstalledUiFixture(t, backend);
      const before = await f.counts(),
        credits = await f.credits.getAccount(f.creditScope);
      f.uiState.allow = false;
      const denied = await f.invoke();
      assert.equal(denied.statusCode, 403, denied.body);
      assert.deepEqual(
        (
          await f.app.inject({
            url: f.selectionUrl,
            headers: f.selectionHeaders(),
          })
        ).json(),
        { selectionRevision: 0, current: null },
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
    },
  );
}
