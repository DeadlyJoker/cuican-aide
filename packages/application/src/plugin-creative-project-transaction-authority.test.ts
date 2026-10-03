import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitTransactionCurrent,
  captureCreativeProjectCommitAuthority,
} from "./creative-project-commit-authority.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import {
  creativeActionFixture,
  creativeCreateInput,
} from "./plugin-creative-project-action.test-support.ts";
import { uiTestActor } from "./plugin-ui.test-support.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";

type Fixture = ReturnType<typeof creativeActionFixture>;

/** Application consumer only: model a held Store connection and forbid a second installation borrow. */
function borrowTransaction(
  f: Fixture,
  before: (
    authority: CreativeProjectCommitAuthority,
  ) => Promise<void> = async () => {},
) {
  const store = f.projects.store as CreativeProjectStore;
  const commit = store.commitProjectCreation.bind(store);
  const loadSelection = f.ui.store.loadSelection.bind(f.ui.store);
  const loadPackage = f.ui.store.loadPackage.bind(f.ui.store);
  let borrowed = false;
  let captured: CreativeProjectCommitAuthority | undefined;
  let installationReadsDuringTransaction = 0;
  f.ui.store.loadSelection = async (input) => {
    if (borrowed) {
      installationReadsDuringTransaction++;
      throw new Error("a second installation connection cannot be borrowed");
    }
    return loadSelection(input);
  };
  f.ui.store.loadPackage = async (input) => {
    if (borrowed) {
      installationReadsDuringTransaction++;
      throw new Error("a second installation connection cannot be borrowed");
    }
    return loadPackage(input);
  };
  store.commitProjectCreation = async (input, options) => {
    captured = captureCreativeProjectCommitAuthority(options);
    assert.ok(captured?.transaction);
    borrowed = true;
    try {
      await before(captured);
      await assertCreativeProjectCommitTransactionCurrent(captured);
      assertCreativeProjectCommitActive(captured);
      return await commit(input);
    } finally {
      borrowed = false;
    }
  };
  return {
    authority: () => captured!,
    installationReadsDuringTransaction: () =>
      installationReadsDuringTransaction,
  };
}

test("actual metadata invocation carries its full source pin/snapshots without borrowing the installation pool in COMMIT", async () => {
  const f = creativeActionFixture();
  const tx = borrowTransaction(f, async (authority) => {
    const qualification = authority.transaction!;
    assert.equal(
      qualification.version,
      "crewon.creative-project-plugin-commit.v1",
    );
    assert.equal(
      qualification.pin.action,
      "crewon.creative-projects.v1.createProject",
    );
    assert.equal(qualification.pin.pluginId, f.ui.state.descriptor.pluginId);
    assert.equal(qualification.pin.principalId, uiTestActor.principalId);
    assert.equal(qualification.pin.actorId, uiTestActor.actorId);
    assert.deepEqual(qualification.selection, f.ui.state.selection);
    assert.deepEqual(qualification.package, f.ui.state.package);
    assert.equal(Object.isFrozen(qualification.selection), true);
    assert.equal(Object.isFrozen(qualification.package), true);
    // The installation connection is already held. This uses external current-policy checks only.
    const calls = [...f.ui.state.calls];
    const hostCalls = f.state.hostCalls;
    await assertCreativeProjectCommitTransactionCurrent(authority);
    assert.deepEqual(f.ui.state.calls, calls);
    assert.ok(
      f.state.hostCalls > hostCalls,
      "Host HTTP identity/profile approval remains checked",
    );
  });
  const output = await f.invoke("createProject", creativeCreateInput());
  assert.equal((output as Record<string, unknown>).disposition, "committed");
  assert.equal(f.projects.store.commits.length, 1);
  assert.equal(tx.installationReadsDuringTransaction(), 0);
  assert.ok(
    f.ui.state.calls.includes("selection"),
    "preflight still checks actual installation records",
  );
  await assert.rejects(tx.authority().transaction!.assertCurrent(), {
    code: "plugin_ui_invocation_unavailable",
  });
  assert.throws(
    () => capturePluginUiInvocationCommitAuthority({ ...f.state.context! }),
    { code: "plugin_ui_invocation_unavailable" },
  );
});

for (const withdrawal of [
  "policy",
  "epoch",
  "profile",
  "mount",
  "host",
  "owner",
] as const)
  test(`transaction ${withdrawal} withdrawal rejects before metadata publication without an installation borrow`, async () => {
    const f = creativeActionFixture();
    let ownerClosed: Promise<void> | undefined;
    const tx = borrowTransaction(f, async () => {
      switch (withdrawal) {
        case "policy":
          f.ui.state.allowed.delete("invoke");
          break;
        case "epoch":
          f.ui.state.epoch = "changed-policy-epoch";
          break;
        case "profile":
          f.ui.state.scope = {
            ...f.ui.state.scope,
            profileId: "changed-profile",
          };
          break;
        case "mount":
          await f.service.closeMount(uiTestActor, {
            mountRef: f.state.context!.lease.mountRef,
          });
          break;
        case "host":
          f.state.hostAllowed = false;
          break;
        case "owner":
          ownerClosed = f.owner.close();
          break;
      }
    });
    await assert.rejects(() =>
      f.invoke("createProject", creativeCreateInput()),
    );
    await ownerClosed;
    assert.equal(f.projects.store.commits.length, 0);
    assert.equal(tx.installationReadsDuringTransaction(), 0);
    assert.throws(() => tx.authority().assertActive());
  });

test("confirmed metadata COMMIT remains acknowledged after later policy and owner withdrawal", async () => {
  const f = creativeActionFixture();
  const tx = borrowTransaction(f);
  let closed: Promise<void> | undefined;
  f.state.afterAction = () => {
    f.ui.state.allowed.delete("invoke");
    f.ui.state.epoch = "after-commit-revocation";
    closed = f.owner.close();
  };
  const output = await f.invoke("createProject", creativeCreateInput());
  await closed;
  assert.equal((output as Record<string, unknown>).disposition, "committed");
  assert.equal(f.projects.store.commits.length, 1);
  assert.equal(tx.installationReadsDuringTransaction(), 0);
});

test("ordinary UI actions retain the original two-method invocation authority", async () => {
  const f = creativeActionFixture();
  const lease = await f.open();
  f.state.rawOverride = { ordinary: true };
  f.state.afterAction = (context) => {
    const authority = capturePluginUiInvocationCommitAuthority(context);
    assert.equal(Object.hasOwn(authority, "transaction"), false);
  };
  assert.deepEqual(
    await f.service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: "ordinary action with spaces",
      input: null,
    }),
    { ordinary: true },
  );
});
