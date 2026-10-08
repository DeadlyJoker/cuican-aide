import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitCurrent,
  assertProjectFoundationCommitTransactionCurrent,
  captureProjectFoundationCommitAuthority,
  PROJECT_FOUNDATION_MUTATION_ACTIONS,
  qualifyProjectFoundationPluginCommit,
} from "./project-foundation-commit-authority.ts";
import type { ProjectFoundationMutationKind } from "./project-foundation-store-port.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";

function fixture(kind: ProjectFoundationMutationKind = "create-project") {
  const { pin, context } = committedTaskContext(
    committedUiFixture().detachedContext(),
  );
  const calls = { full: 0, transaction: 0, active: 0 };
  const state = { active: true };
  const transaction = {
    version: "crewon.project-foundation-plugin-commit.v1" as const,
    pin: { ...pin, action: PROJECT_FOUNDATION_MUTATION_ACTIONS[kind] },
    selection: { ...context.selection },
    package: { ...context.package },
    async assertCurrent() {
      assert.equal(this, transaction);
      calls.transaction++;
      if (!state.active) throw new Error("foundation_original_withdrawn");
    },
  };
  const authority = {
    transaction,
    async assertCurrent() {
      assert.equal(this, authority);
      calls.full++;
      if (!state.active) throw new Error("foundation_original_withdrawn");
    },
    assertActive() {
      assert.equal(this, authority);
      calls.active++;
      if (!state.active) throw new Error("foundation_original_withdrawn");
    },
  };
  return { calls, state, authority, transaction, actor: context.actor };
}

test("foundation capture detaches installation snapshots and retains original callbacks and receivers", async () => {
  const f = fixture();
  const captured = captureProjectFoundationCommitAuthority({
    authority: f.authority,
  })!;
  const original = structuredClone({
    pin: f.transaction.pin,
    selection: f.transaction.selection,
    package: f.transaction.package,
  });
  f.transaction.pin.action = "crewon.creative-projects.v1.createProject";
  f.transaction.selection.updatedByActorId = "replacement-actor";
  f.transaction.package.installedAt = "2026-10-08T00:00:00.000Z";
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
  await assertProjectFoundationCommitCurrent(captured);
  await assertProjectFoundationCommitTransactionCurrent(captured);
  assertProjectFoundationCommitActive(captured);
  assert.deepEqual(f.calls, { full: 1, transaction: 1, active: 1 });
  qualifyProjectFoundationPluginCommit(captured, f.actor, "create-project");
});

test("every new mutation requires its own action pin and the exact actor identity", () => {
  const kinds = Object.keys(
    PROJECT_FOUNDATION_MUTATION_ACTIONS,
  ) as ProjectFoundationMutationKind[];
  for (const kind of kinds) {
    const f = fixture(kind);
    const captured = captureProjectFoundationCommitAuthority({
      authority: f.authority,
    })!;
    const qualified = qualifyProjectFoundationPluginCommit(
      captured,
      f.actor,
      kind,
    );
    assert.equal(
      qualified!.pin.action,
      PROJECT_FOUNDATION_MUTATION_ACTIONS[kind],
    );
    for (const other of kinds.filter((value) => value !== kind))
      assert.throws(
        () => qualifyProjectFoundationPluginCommit(captured, f.actor, other),
        { message: "project_foundation_plugin_commit_pin_mismatch" },
      );
    for (const key of [
      "tenantId",
      "spaceId",
      "principalId",
      "actorId",
    ] as const)
      assert.throws(
        () =>
          qualifyProjectFoundationPluginCommit(
            captured,
            { ...f.actor, [key]: "foreign-identity" },
            kind,
          ),
        { message: "project_foundation_plugin_commit_pin_mismatch" },
      );
    assert.throws(
      () =>
        qualifyProjectFoundationPluginCommit(
          captured,
          f.actor,
          "toString" as never,
        ),
      { message: "project_foundation_plugin_commit_pin_mismatch" },
    );
  }
});

test("legacy project pins, unsupported versions and mixed protocols cannot qualify foundation writes", () => {
  const f = fixture();
  for (const transaction of [
    { ...f.transaction, version: "crewon.creative-project-plugin-commit.v1" },
    { ...f.transaction, version: "crewon.project-foundation-plugin-commit.v2" },
    {
      ...f.transaction,
      pin: {
        ...f.transaction.pin,
        action: "crewon.creative-projects.v1.createProject",
      },
    },
    {
      ...f.transaction,
      pin: {
        ...f.transaction.pin,
        action: "crewon.project-foundation.v1.unknown",
      },
    },
  ])
    assert.throws(
      () =>
        captureProjectFoundationCommitAuthority({
          authority: { ...f.authority, transaction } as never,
        }),
      { message: "project_foundation_commit_authority_invalid" },
    );
  for (const key of ["runTransaction", "textUiTransaction", "planTransaction"])
    assert.throws(
      () =>
        captureProjectFoundationCommitAuthority({
          authority: { ...f.authority, [key]: {} } as never,
        }),
      { message: "project_foundation_commit_authority_invalid" },
    );
  assert.throws(
    () =>
      qualifyProjectFoundationPluginCommit(
        {
          ...f.authority,
          transaction: {
            ...f.transaction,
            version: "crewon.creative-project-plugin-commit.v1",
          } as never,
        },
        f.actor,
        "create-project",
      ),
    { message: "project_foundation_commit_authority_invalid" },
  );
});

test("strict own data capture refuses getters, inherited methods, symbols and serialization recipes without executing them", () => {
  const f = fixture();
  let getters = 0;
  for (const key of ["version", "pin", "selection", "package", "assertCurrent"])
    assert.throws(() =>
      captureProjectFoundationCommitAuthority({
        authority: {
          ...f.authority,
          transaction: Object.defineProperty({ ...f.transaction }, key, {
            enumerable: true,
            get() {
              getters++;
              throw new Error("must not run");
            },
          }),
        },
      }),
    );
  for (const key of ["assertCurrent", "assertActive", "transaction"])
    assert.throws(() =>
      captureProjectFoundationCommitAuthority({
        authority: Object.defineProperty({ ...f.authority }, key, {
          enumerable: true,
          get() {
            getters++;
            throw new Error("must not run");
          },
        }),
      }),
    );
  for (const authority of [
    Object.assign(Object.create(f.authority), {}),
    { ...f.authority, [Symbol("extra")]: true },
    JSON.parse(JSON.stringify(f.authority)),
    { ...f.authority, assertCurrent: undefined },
    Object.defineProperty({ ...f.authority }, "assertActive", {
      enumerable: false,
      value: f.authority.assertActive,
    }),
  ])
    assert.throws(() => captureProjectFoundationCommitAuthority({ authority }));
  const options = Object.defineProperty({}, "authority", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("must not run");
    },
  });
  assert.throws(() => captureProjectFoundationCommitAuthority(options));
  const pin = Object.defineProperty({ ...f.transaction.pin }, "action", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("must not run");
    },
  });
  assert.throws(() =>
    captureProjectFoundationCommitAuthority({
      authority: { ...f.authority, transaction: { ...f.transaction, pin } },
    }),
  );
  assert.equal(getters, 0);
});

test("installation snapshots must identify the current enabled package and selection", () => {
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
    { selection: { updatedAt: "invalid" } },
    { package: { packageDigest: `sha256:${"c".repeat(64)}` } },
    { package: { installedAt: "invalid" } },
  ]) {
    const f = fixture();
    assert.throws(
      () =>
        captureProjectFoundationCommitAuthority({
          authority: {
            ...f.authority,
            transaction: {
              ...f.transaction,
              pin: { ...f.transaction.pin, ...changes.pin },
              selection: { ...f.transaction.selection, ...changes.selection },
              package: { ...f.transaction.package, ...changes.package },
            },
          } as never,
        }),
      { message: "project_foundation_commit_authority_invalid" },
    );
  }
});

test("original withdrawal remains visible after callback replacement on caller objects", async () => {
  const f = fixture();
  const captured = captureProjectFoundationCommitAuthority({
    authority: f.authority,
  })!;
  f.transaction.assertCurrent = async () => {};
  f.authority.assertCurrent = async () => {};
  f.authority.assertActive = () => {};
  f.state.active = false;
  await assert.rejects(
    assertProjectFoundationCommitCurrent(captured),
    /original_withdrawn/,
  );
  await assert.rejects(
    assertProjectFoundationCommitTransactionCurrent(captured),
    /original_withdrawn/,
  );
  assert.throws(
    () => assertProjectFoundationCommitActive(captured),
    /original_withdrawn/,
  );
});

test("a non-void async policy result or asynchronous active check fails closed without touching then getters", async () => {
  const f = fixture();
  const captured = captureProjectFoundationCommitAuthority({
    authority: {
      ...f.authority,
      assertCurrent: async () => true as unknown as void,
      transaction: {
        ...f.transaction,
        assertCurrent: async () => true as unknown as void,
      },
      assertActive: () =>
        Promise.reject(new Error("observed rejection")) as unknown as void,
    },
  })!;
  await assert.rejects(assertProjectFoundationCommitCurrent(captured), {
    message: "project_foundation_commit_authority_async_result_invalid",
  });
  await assert.rejects(
    assertProjectFoundationCommitTransactionCurrent(captured),
    {
      message: "project_foundation_commit_authority_async_result_invalid",
    },
  );
  assert.throws(() => assertProjectFoundationCommitActive(captured), {
    message: "project_foundation_commit_authority_sync_required",
  });
  let getters = 0;
  const thenable = Object.defineProperty({}, "then", {
    get() {
      getters++;
      throw new Error("must not run");
    },
  });
  assert.throws(() =>
    assertProjectFoundationCommitActive({
      assertCurrent: async () => {},
      assertActive: () => thenable as unknown as void,
    }),
  );
  assert.equal(getters, 0);
});

test("trusted non-plugin callers keep their explicit current callback without gaining an installation pin", async () => {
  let calls = 0;
  const authority = {
    async assertCurrent() {
      assert.equal(this, authority);
      calls++;
    },
    assertActive() {},
  };
  const captured = captureProjectFoundationCommitAuthority({ authority })!;
  assert.equal(Object.hasOwn(captured, "transaction"), false);
  assert.equal(
    qualifyProjectFoundationPluginCommit(
      captured,
      fixture().actor,
      "create-project",
    ),
    undefined,
  );
  await assertProjectFoundationCommitTransactionCurrent(captured);
  assert.equal(calls, 1);
  assert.equal(captureProjectFoundationCommitAuthority(undefined), undefined);
  assert.equal(captureProjectFoundationCommitAuthority({}), undefined);
  await assertProjectFoundationCommitCurrent(undefined);
  await assertProjectFoundationCommitTransactionCurrent(undefined);
  assertProjectFoundationCommitActive(undefined);
});
