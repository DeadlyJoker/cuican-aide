import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
  captureCreativeProjectCommitAuthority,
} from "./creative-project-commit-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";

function fixture() {
  const { pin, context } = committedTaskContext(
    committedUiFixture().detachedContext(),
  );
  const calls = { full: 0, transaction: 0, active: 0 };
  const transaction = {
    version: "crewon.creative-project-plugin-commit.v1" as const,
    pin: { ...pin },
    selection: { ...context.selection },
    package: { ...context.package },
    async assertCurrent() {
      assert.equal(this, transaction);
      calls.transaction++;
    },
  };
  const authority = {
    transaction,
    async assertCurrent() {
      assert.equal(this, authority);
      calls.full++;
    },
    assertActive() {
      assert.equal(this, authority);
      calls.active++;
    },
  };
  return { calls, authority, transaction };
}

test("captures the complete detached installation snapshots and bound transaction receiver", async () => {
  const f = fixture();
  const captured = captureCreativeProjectCommitAuthority({
    authority: f.authority,
  })!;
  const original = structuredClone({
    pin: f.transaction.pin,
    selection: f.transaction.selection,
    package: f.transaction.package,
  });
  f.transaction.pin.action = "changed.action";
  f.transaction.selection.updatedByActorId = "changed-audit-actor";
  f.transaction.package.installedAt = "2026-10-04T00:00:00.000Z";
  f.transaction.assertCurrent = async () => {
    throw new Error("replacement must not run");
  };
  f.authority.assertCurrent = async () => {
    throw new Error("replacement must not run");
  };
  assert.deepEqual(captured.transaction!.pin, original.pin);
  assert.deepEqual(captured.transaction!.selection, original.selection);
  assert.deepEqual(captured.transaction!.package, original.package);
  for (const value of [
    captured,
    captured.transaction,
    captured.transaction!.pin,
    captured.transaction!.selection,
    captured.transaction!.package,
  ])
    assert.equal(Object.isFrozen(value), true);
  await assertCreativeProjectCommitCurrent(captured);
  await assertCreativeProjectCommitTransactionCurrent(captured);
  assertCreativeProjectCommitActive(captured);
  assert.deepEqual(f.calls, { full: 1, transaction: 1, active: 1 });
});

test("keeps legacy two-method authorities on their original current path", async () => {
  const f = fixture();
  const { transaction: _transaction, ...authority } = f.authority;
  authority.assertCurrent = async function () {
    assert.equal(this, authority);
    f.calls.full++;
  };
  const captured = captureCreativeProjectCommitAuthority({ authority })!;
  assert.equal(Object.hasOwn(captured, "transaction"), false);
  await assertCreativeProjectCommitTransactionCurrent(captured);
  assert.equal(f.calls.full, 1);
  await assertCreativeProjectCommitTransactionCurrent(undefined);
});

test("rejects transaction accessors, inherited fields, missing methods and JSON recipes without reading getters", () => {
  let getters = 0;
  const f = fixture();
  const bad: unknown[] = [
    { ...f.transaction, version: "crewon.creative-project-plugin-commit.v2" },
    { ...f.transaction, extra: true },
    structuredClone(JSON.parse(JSON.stringify(f.transaction))),
    Object.assign(Object.create(f.transaction), {}),
  ];
  for (const key of ["version", "pin", "selection", "package", "assertCurrent"])
    bad.push(
      Object.defineProperty({ ...f.transaction }, key, {
        enumerable: true,
        get() {
          getters++;
          throw new Error("must remain unread");
        },
      }),
    );
  for (const transaction of bad)
    assert.throws(
      () =>
        captureCreativeProjectCommitAuthority({
          authority: { ...f.authority, transaction } as never,
        }),
      { message: "creative_project_commit_authority_invalid" },
    );
  const accessor = Object.defineProperty({ ...f.authority }, "transaction", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("must remain unread");
    },
  });
  assert.throws(
    () => captureCreativeProjectCommitAuthority({ authority: accessor }),
    {
      message: "creative_project_commit_authority_invalid",
    },
  );
  assert.equal(getters, 0);
});

test("checks all installation scopes and pin identities before lending a transaction fence", () => {
  for (const changes of [
    { pin: { tenantId: "another-tenant" } },
    { pin: { spaceId: "another-space" } },
    { pin: { profileId: "another-profile" } },
    { pin: { pluginId: "another.plugin" } },
    { pin: { publisherId: "another.publisher" } },
    { pin: { version: "9.0.0" } },
    { pin: { selectionRevision: 99 } },
    { selection: { state: "disabled" } },
    { selection: { selectedPackageDigest: `sha256:${"b".repeat(64)}` } },
    { selection: { updatedAt: "invalid-timestamp" } },
    { package: { packageDigest: `sha256:${"c".repeat(64)}` } },
    { package: { installedAt: "invalid-timestamp" } },
  ]) {
    const f = fixture();
    const transaction = {
      ...f.transaction,
      pin: { ...f.transaction.pin, ...changes.pin },
      selection: { ...f.transaction.selection, ...changes.selection },
      package: { ...f.transaction.package, ...changes.package },
    };
    assert.throws(
      () =>
        captureCreativeProjectCommitAuthority({
          authority: { ...f.authority, transaction } as never,
        }),
      { message: "creative_project_commit_authority_invalid" },
    );
  }
});

test("a non-void transaction callback and asynchronous active check fail closed", async () => {
  const f = fixture();
  const captured = captureCreativeProjectCommitAuthority({
    authority: {
      ...f.authority,
      transaction: {
        ...f.transaction,
        assertCurrent: async () => true as unknown as void,
      },
      assertActive: () => Promise.resolve() as unknown as void,
    },
  })!;
  await assert.rejects(
    assertCreativeProjectCommitTransactionCurrent(captured),
    {
      message: "creative_project_commit_authority_async_result_invalid",
    },
  );
  assert.throws(() => assertCreativeProjectCommitActive(captured), {
    message: "creative_project_commit_authority_sync_required",
  });
});
