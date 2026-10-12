import assert from "node:assert/strict";
import test from "node:test";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  installedRunContextFixture,
  target,
  signal,
} from "./installed-plugin-run-context.test-support.ts";

test("original runtime context authorizes before Foundation metadata reads and rechecks withdrawal during that await", async (t) => {
  const f = await installedRunContextFixture(t);
  let reads = 0,
    withdraw = false;
  const reader = new InstalledPluginRunContext({
    ...f.dependencies,
    foundationRuns: {
      async readRequiredFoundationDigest() {
        assert.ok(f.controls.requests.some((r) => r.action === "run:execute"));
        assert.ok(
          f.controls.requests.some((r) => r.action === "extension:run"),
        );
        reads++;
        if (withdraw) f.controls.denied = "run:execute";
        return null;
      },
      async loadFoundationRunAdmission() {
        reads++;
        return null;
      },
    },
  });
  const load = () =>
    reader.load({
      locator: f.locator,
      expectedTarget: target,
      purpose: "submit",
      signal: signal(),
    });
  const before = await f.counts();
  f.controls.denied = "run:execute";
  await assert.rejects(load(), /execution_access_denied/u);
  assert.equal(reads, 0);
  f.controls.denied = null;
  const snapshot = await load();
  assert.ok(snapshot);
  assert.equal(reads, 2);
  f.controls.denied = "run:execute";
  await assert.rejects(
    reader.assertCurrent(snapshot, "submit", signal()),
    /execution_access_denied/u,
  );
  assert.equal(reads, 2);
  f.controls.denied = null;
  withdraw = true;
  await assert.rejects(load(), /execution_access_denied/u);
  assert.equal(reads, 4);
  assert.deepEqual(await f.counts(), before);
});
