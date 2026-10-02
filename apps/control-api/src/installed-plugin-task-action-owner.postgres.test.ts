import assert from "node:assert/strict";
import test from "node:test";
import {
  actor,
  creditScope,
  deferred,
  ownedActionFixture,
  scope,
} from "./installed-plugin-task-action-owner.test-support.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";

const skip = !process.env.CREWON_TEST_POSTGRES_URL;

test(
  "owned PostgreSQL actions persist the exact installed v1 admission and paid hold through actual services",
  { skip },
  async (t) => {
    const f = await ownedActionFixture(t, { backend: "postgres" });
    const before = await f.counts();
    const output = (await f.invoke()) as Record<string, unknown>;
    const accepted = f.state.accepted[0]!;
    assert.equal(output.disposition, "committed");
    assert.equal(output.runId, accepted.binding.runId);
    const admission = await f.second.store.loadPluginTaskAdmission(
      accepted.binding,
    );
    assert.ok(admission);
    assert.equal(admission.packageDigest, f.installed.packageDigest);
    assert.equal(admission.selectionRevision, f.installed.selection.revision);
    assert.equal(admission.principalId, actor.principalId);
    assert.equal(admission.profileId, f.profile.profileId);
    const after = await f.counts();
    for (const table of Object.keys(before))
      assert.equal(after[table], before[table]! + 1, table);
    const paid = await f.second.store.loadExtensionCreditAdmission(
      accepted.binding,
    );
    assert.deepEqual(paid, accepted.creditAdmission);
    assert.equal(
      (await f.credits.getAccount(creditScope))?.reservedCredits,
      "30",
    );
    await f.owner.close();
    assert.equal(f.state.disposals, 1);
  },
);

test(
  "an independent actual PostgreSQL disable during pricing invalidates the synchronous bridge projection before COMMIT",
  { skip },
  async (t) => {
    const f = await ownedActionFixture(t, { backend: "postgres" });
    const before = await f.counts();
    const entered = deferred();
    const release = deferred();
    f.state.quoteEntered = entered.resolve;
    f.state.quoteGate = release.promise;
    const invoking = f.invoke();
    void invoking.catch(() => {});
    try {
      await Promise.race([
        entered.promise,
        invoking.then(() => {
          throw new Error("fixture_quote_did_not_wait");
        }),
      ]);
      const independent = f.second.parent.pluginInstallationStore();
      const current = await independent.loadSelection({
        scope: f.profile,
        pluginId: scope.pluginId,
      });
      assert.ok(current);
      await independent.commitSelection(
        selectionRecipe(current, "independent-postgres-disable", {
          actor,
          state: "disabled",
        }),
      );
    } finally {
      release.resolve();
    }
    await assert.rejects(invoking);
    assert.deepEqual(await f.counts(), before);
    assert.equal(f.state.accepted.length, 0);
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(
      (await f.credits.getAccount(creditScope))?.availableCredits,
      "100",
    );
    await f.owner.close();
    assert.equal(f.state.disposals, 1);
  },
);

test(
  "concurrent PostgreSQL actions share one actual scoped Node setup and refresh live selection independently",
  { skip },
  async (t) => {
    const f = await ownedActionFixture(t, { backend: "postgres" });
    const entered = deferred();
    const release = deferred();
    f.state.setupEntered = entered.resolve;
    f.state.setupGate = release.promise;
    const first = f.invoke("image.read", null);
    void first.catch(() => {});
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("fixture_setup_did_not_wait");
      }),
    ]);
    const second = f.invoke("image.read", null);
    void second.catch(() => {});
    release.resolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results, [
      { value: "installed-read" },
      { value: "installed-read" },
    ]);
    assert.equal(f.state.setups, 1);
    assert.equal(f.state.calls, 2);
    assert.equal(f.state.quoteCalls, 0);
    await f.owner.close();
    assert.equal(f.state.disposals, 1);
  },
);
