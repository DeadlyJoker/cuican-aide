import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreditAccount,
  grantCreditAccount,
  reserveCreditAccount,
  settleCreditReservation,
  type CreditAccount,
  type CreditScope,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import { PluginCreditReadApplicationService } from "./plugin-credit-read-application-service.ts";
import type { PluginCreditReadAuthorizationRequest } from "./plugin-credit-read-authorization-port.ts";
import type {
  PluginCreditAccountsReadResult,
  PluginCreditEntriesReadResult,
  PluginCreditReadStore,
} from "./plugin-credit-read-store-port.ts";
import type {
  PluginCreditEntry,
  PluginCreditStore,
} from "./plugin-credit-store-port.ts";

const actor: ActorContext = {
  principalId: "person",
  actorId: "session",
  tenantId: "tenant",
  spaceId: "space",
};
const scope: CreditScope = {
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId: "创作/个人",
};
const grant = grantCreditAccount(createCreditAccount(scope), "100");
const reserved = reserveCreditAccount(grant, {
  scope,
  reservationId: "hold",
  idempotencyKey: "key",
  requestDigest: `sha256:${"a".repeat(64)}`,
  pluginId: "example.report",
  priceRevision: 1,
  quotedCredits: "30",
});
const settled = settleCreditReservation(
  reserved.account,
  reserved.reservation,
  "18",
);
const entry = (
  account: CreditAccount,
  kind: PluginCreditEntry["kind"],
  credits: string,
): PluginCreditEntry => ({
  scope: account.scope,
  revision: account.revision,
  kind,
  credits,
  grantId: kind === "grant" ? "named-grant" : null,
  reservationId: kind === "grant" ? null : "hold",
  account,
});
const ledger = [
  entry(grant, "grant", "100"),
  entry(reserved.account, "reserve", "30"),
  entry(settled.account, "settle", "18"),
];
const accountsQuery = { afterPoolId: null, limit: 16 };
const entriesQuery = { poolId: scope.poolId, afterRevision: 0, limit: 50 };

function fixture() {
  const permissions: PluginCreditReadAuthorizationRequest[] = [],
    calls: unknown[] = [];
  let accounts: PluginCreditAccountsReadResult = {
    state: "ready",
    accounts: [settled.account],
    nextPoolId: null,
  };
  let entries: PluginCreditEntriesReadResult = {
    state: "ready",
    account: settled.account,
    entries: ledger,
    nextRevision: null,
  };
  let policy: (
    input: PluginCreditReadAuthorizationRequest,
  ) => Promise<AuthorizationDecision> = async () => ({ outcome: "allow" });
  let beforeRead: () => Promise<void> = async () => {};
  const store: PluginCreditReadStore = {
    async listAccounts(input) {
      calls.push(input);
      await beforeRead();
      return accounts;
    },
    async readEntries(input) {
      calls.push(input);
      await beforeRead();
      return entries;
    },
  };
  const authorization = {
    async authorize(input: PluginCreditReadAuthorizationRequest) {
      permissions.push(input);
      return policy(input);
    },
  };
  const service = new PluginCreditReadApplicationService({
    store,
    authorization,
  });
  return {
    service,
    store,
    authorization,
    permissions,
    calls,
    setAccounts(value: unknown) {
      accounts = value as PluginCreditAccountsReadResult;
    },
    setEntries(value: unknown) {
      entries = value as PluginCreditEntriesReadResult;
    },
    setPolicy(value: typeof policy) {
      policy = value;
    },
    setBeforeRead(value: typeof beforeRead) {
      beforeRead = value;
    },
  };
}
const error =
  (category: ApplicationError["category"], code?: string) => (value: unknown) =>
    value instanceof ApplicationError &&
    value.category === category &&
    (code === undefined || value.code === code);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("reads derive exact personal scope and preserve real historical balances without financial mutations", async () => {
  const f = fixture();
  const page = await f.service.listAccounts(actor, accountsQuery);
  const history = await f.service.getEntries(actor, entriesQuery);
  assert.deepEqual(page.accounts, [settled.account]);
  assert.deepEqual(history.entries, ledger);
  assert.equal(history.account!.availableCredits, "82");
  assert.equal(history.entries[1]!.account.availableCredits, "70");
  assert.deepEqual(f.calls, [
    { tenantId: "tenant", principalId: "person", ...accountsQuery },
    { scope, afterRevision: 0, limit: 50 },
  ]);
  assert.equal(f.permissions.length, 4);
  for (const permission of f.permissions) {
    assert.equal(permission.action, "pluginCredit:read");
    assert.deepEqual(permission.actor, actor);
    assert.equal(permission.resource.principalId, actor.principalId);
    assert.equal(permission.resource.spaceId, actor.spaceId);
    assert.ok(
      Object.isFrozen(permission) &&
        Object.isFrozen(permission.actor) &&
        Object.isFrozen(permission.resource),
    );
  }
  assert.equal(f.permissions[0]!.resource.poolId, null);
  assert.equal(f.permissions[2]!.resource.poolId, scope.poolId);
  assert.ok(
    Object.isFrozen(history.entries) &&
      Object.isFrozen(history.entries[0]!) &&
      Object.isFrozen(history.account),
  );
});

test("cross-principal and cross-tenant account or ledger facts never leave the application", async () => {
  for (const foreign of [
    { ...scope, tenantId: "other" },
    { ...scope, principalId: "other" },
  ]) {
    const f = fixture(),
      foreignAccount = { ...settled.account, scope: foreign };
    f.setAccounts({
      state: "ready",
      accounts: [foreignAccount],
      nextPoolId: null,
    });
    await assert.rejects(
      f.service.listAccounts(actor, accountsQuery),
      error("internal", "plugin_credit_read_store_invalid"),
    );
    f.setEntries({
      state: "ready",
      account: foreignAccount,
      entries: [],
      nextRevision: null,
    });
    await assert.rejects(
      f.service.getEntries(actor, entriesQuery),
      error("internal"),
    );
    for (const corrupted of [
      { ...ledger[0], scope: foreign },
      { ...ledger[0], account: { ...grant, scope: foreign } },
    ]) {
      f.setEntries({
        state: "ready",
        account: settled.account,
        entries: [corrupted],
        nextRevision: null,
      });
      await assert.rejects(
        f.service.getEntries(actor, entriesQuery),
        error("internal"),
      );
    }
  }
});

test("unconfigured and ready empty are distinct and neither invents a zero balance", async () => {
  const f = fixture();
  f.setAccounts({ state: "unconfigured", accounts: [], nextPoolId: null });
  f.setEntries({
    state: "unconfigured",
    account: null,
    entries: [],
    nextRevision: null,
  });
  assert.equal(
    (await f.service.listAccounts(actor, accountsQuery)).state,
    "unconfigured",
  );
  assert.deepEqual(await f.service.getEntries(actor, entriesQuery), {
    state: "unconfigured",
    account: null,
    entries: [],
    nextRevision: null,
  });
  f.setAccounts({ state: "ready", accounts: [], nextPoolId: null });
  assert.deepEqual(await f.service.listAccounts(actor, accountsQuery), {
    state: "ready",
    accounts: [],
    nextPoolId: null,
  });
  f.setEntries({
    state: "ready",
    account: null,
    entries: [],
    nextRevision: null,
  });
  await assert.rejects(
    f.service.getEntries(actor, entriesQuery),
    error("notFound", "plugin_credit_account_not_found"),
  );
});

test("PDP denial precedes Store IO and late withdrawal suppresses already-read data", async () => {
  const f = fixture();
  f.setPolicy(async () => ({ outcome: "deny", reasonCode: "revoked" }));
  await assert.rejects(
    f.service.listAccounts(actor, accountsQuery),
    error("authorization"),
  );
  assert.equal(f.calls.length, 0);
  f.setPolicy(async () => ({ outcome: "allow" }));
  const entered = deferred(),
    release = deferred();
  f.setBeforeRead(async () => {
    entered.resolve();
    await release.promise;
  });
  const read = f.service.getEntries(actor, entriesQuery);
  await entered.promise;
  f.setPolicy(async () => ({ outcome: "deny", reasonCode: "revoked" }));
  release.resolve();
  await assert.rejects(
    read,
    error("authorization", "plugin_credit_read_forbidden"),
  );
  assert.equal(f.calls.length, 1);
});

test("actor and query cannot be substituted while a real policy promise is pending", async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  f.setPolicy(async () => {
    if (f.permissions.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return { outcome: "allow" };
  });
  const mutableActor = { ...actor },
    mutableQuery = { ...entriesQuery };
  const read = f.service.getEntries(mutableActor, mutableQuery);
  await entered.promise;
  mutableActor.tenantId = "foreign";
  mutableActor.principalId = "foreign";
  mutableQuery.poolId = "foreign";
  mutableQuery.limit = 1;
  release.resolve();
  assert.equal((await read).account!.scope.principalId, actor.principalId);
  assert.deepEqual(f.calls[0], { scope, afterRevision: 0, limit: 50 });
  assert.deepEqual(f.permissions[0], f.permissions[1]);
});

test("late revocation also protects unknown-account existence and unconfigured results", async () => {
  for (const state of ["ready", "unconfigured"] as const) {
    const f = fixture();
    f.setEntries({ state, account: null, entries: [], nextRevision: null });
    f.setPolicy(async () =>
      f.permissions.length === 1
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "revoked" },
    );
    await assert.rejects(
      f.service.getEntries(actor, entriesQuery),
      error("authorization"),
    );
  }
});

test("pages enforce requested bounds, UTF-8 keyset order and truthful continuations", async () => {
  const f = fixture(),
    first = { ...settled.account, scope: { ...scope, poolId: "\ue000" } },
    second = { ...settled.account, scope: { ...scope, poolId: "𐀀" } };
  f.setAccounts({
    state: "ready",
    accounts: [first],
    nextPoolId: first.scope.poolId,
  });
  assert.equal(
    (await f.service.listAccounts(actor, { afterPoolId: null, limit: 1 }))
      .nextPoolId,
    first.scope.poolId,
  );
  f.setAccounts({ state: "ready", accounts: [second], nextPoolId: null });
  assert.equal(
    (
      await f.service.listAccounts(actor, {
        afterPoolId: first.scope.poolId,
        limit: 1,
      })
    ).accounts[0]!.scope.poolId,
    second.scope.poolId,
  );
  f.setEntries({
    state: "ready",
    account: settled.account,
    entries: ledger.slice(0, 1),
    nextRevision: grant.revision,
  });
  assert.equal(
    (await f.service.getEntries(actor, { ...entriesQuery, limit: 1 }))
      .nextRevision,
    grant.revision,
  );
  f.setEntries({
    state: "ready",
    account: settled.account,
    entries: [],
    nextRevision: null,
  });
  assert.deepEqual(
    (
      await f.service.getEntries(actor, {
        ...entriesQuery,
        afterRevision: settled.account.revision,
      })
    ).entries,
    [],
  );
  for (const bad of [
    { state: "ready", accounts: [second, first], nextPoolId: null },
    { state: "ready", accounts: [first], nextPoolId: "unseen" },
  ]) {
    f.setAccounts(bad);
    await assert.rejects(
      f.service.listAccounts(actor, accountsQuery),
      error("internal"),
    );
  }
});

test("malformed money, revisions, snapshots, ledger references and unconfigured data are rejected", async () => {
  const f = fixture();
  for (const corrupted of [
    { ...settled.account, availableCredits: "83" },
    { ...settled.account, grantedCredits: 100 },
    { ...settled.account, revision: "4" },
    { ...settled.account, schemaVersion: "future" },
  ]) {
    f.setAccounts({ state: "ready", accounts: [corrupted], nextPoolId: null });
    await assert.rejects(
      f.service.listAccounts(actor, accountsQuery),
      error("internal"),
    );
  }
  for (const corrupted of [
    { ...ledger[0], grantId: null },
    { ...ledger[1], grantId: "unexpected" },
    { ...ledger[1], revision: 4 },
    { ...ledger[1], credits: "01" },
    {
      ...ledger[2],
      account: {
        ...settled.account,
        availableCredits: "81",
        spentCredits: "19",
      },
    },
  ]) {
    f.setEntries({
      state: "ready",
      account: settled.account,
      entries: [corrupted],
      nextRevision: null,
    });
    await assert.rejects(
      f.service.getEntries(actor, entriesQuery),
      error("internal"),
    );
  }
  f.setAccounts({
    state: "unconfigured",
    accounts: [settled.account],
    nextPoolId: null,
  });
  await assert.rejects(
    f.service.listAccounts(actor, accountsQuery),
    error("internal"),
  );
  f.setEntries({
    state: "unconfigured",
    account: settled.account,
    entries: [],
    nextRevision: null,
  });
  await assert.rejects(
    f.service.getEntries(actor, entriesQuery),
    error("internal"),
  );
});

test("large exact balances remain strings through both read paths", async () => {
  const f = fixture(),
    huge = grantCreditAccount(
      createCreditAccount(scope),
      "999999999999999999999999999999999999999999999999",
    );
  f.setAccounts({ state: "ready", accounts: [huge], nextPoolId: null });
  f.setEntries({
    state: "ready",
    account: huge,
    entries: [entry(huge, "grant", huge.grantedCredits)],
    nextRevision: null,
  });
  assert.equal(
    (await f.service.listAccounts(actor, accountsQuery)).accounts[0]!
      .availableCredits,
    huge.availableCredits,
  );
  assert.equal(
    (await f.service.getEntries(actor, entriesQuery)).entries[0]!.credits,
    huge.grantedCredits,
  );
});

test("original Control session and space identity bounds are not replaced by pool-ID bounds", async () => {
  const f = fixture(),
    originalActor = {
      ...actor,
      actorId: "a".repeat(512),
      spaceId: "s".repeat(512),
    };
  await f.service.listAccounts(originalActor, accountsQuery);
  assert.deepEqual(f.permissions[0]!.actor, originalActor);
  assert.equal(f.permissions[0]!.resource.spaceId, originalActor.spaceId);
  await assert.rejects(
    f.service.listAccounts(
      { ...originalActor, actorId: "a".repeat(513) },
      accountsQuery,
    ),
    error("validation"),
  );
});

test("invalid commands never call policy or Store, and accessor hooks never execute", async () => {
  const f = fixture();
  let invoked = 0;
  const getter = Object.defineProperty({ ...actor }, "principalId", {
    enumerable: true,
    get() {
      invoked++;
      return actor.principalId;
    },
  });
  await assert.rejects(
    f.service.listAccounts(getter, accountsQuery),
    error("validation"),
  );
  for (const query of [
    { ...accountsQuery, tenantId: "forged" },
    { ...accountsQuery, limit: 17 },
    { ...accountsQuery, afterPoolId: "" },
  ])
    await assert.rejects(
      f.service.listAccounts(actor, query),
      error("validation"),
    );
  for (const query of [
    { ...entriesQuery, principalId: "forged" },
    { ...entriesQuery, limit: 51 },
    { ...entriesQuery, afterRevision: -1 },
  ])
    await assert.rejects(
      f.service.getEntries(actor, query),
      error("validation"),
    );
  assert.equal(invoked, 0);
  assert.equal(f.permissions.length, 0);
  assert.equal(f.calls.length, 0);
  const damaged = Object.defineProperty(
    { ...settled.account },
    "availableCredits",
    {
      enumerable: true,
      get() {
        invoked++;
        return "82";
      },
    },
  );
  f.setAccounts({ state: "ready", accounts: [damaged], nextPoolId: null });
  await assert.rejects(
    f.service.listAccounts(actor, accountsQuery),
    error("internal"),
  );
  assert.equal(invoked, 0);
});

test("captured read and policy methods cannot be replaced after composition", async () => {
  const f = fixture();
  f.store.listAccounts = async () => {
    throw new Error("replacement");
  };
  f.authorization.authorize = async () => ({
    outcome: "deny",
    reasonCode: "replacement",
  });
  assert.equal(
    (await f.service.listAccounts(actor, accountsQuery)).accounts[0]!
      .availableCredits,
    "82",
  );
  let invoked = 0;
  const store = Object.defineProperty({}, "listAccounts", {
    get() {
      invoked++;
      return f.store.listAccounts;
    },
  });
  assert.throws(
    () =>
      new PluginCreditReadApplicationService({
        store: store as PluginCreditReadStore,
        authorization: f.authorization,
      }),
  );
  assert.equal(invoked, 0);
});

test("Store and malformed policy failures return no financial data", async () => {
  const f = fixture();
  f.setBeforeRead(async () => {
    throw new Error("schema missing or owner closed");
  });
  await assert.rejects(
    f.service.getEntries(actor, entriesQuery),
    error("internal", "plugin_credit_read_store_unavailable"),
  );
  f.setBeforeRead(async () => {});
  f.setPolicy(
    async () =>
      ({ outcome: "allow", grant: "forged" }) as AuthorizationDecision,
  );
  await assert.rejects(
    f.service.listAccounts(actor, accountsQuery),
    error("internal", "plugin_credit_read_authorization_invalid"),
  );
});

test("the original mutation port remains source compatible without either new read method", async () => {
  const legacy: PluginCreditStore = {
    async migrate() {},
    async getAccount() {
      return null;
    },
    async getReservation() {
      return null;
    },
    async grant() {
      throw new Error("not used");
    },
    async reserve() {
      throw new Error("not used");
    },
    async settle() {
      throw new Error("not used");
    },
    async release() {
      throw new Error("not used");
    },
    async listEntries() {
      return [];
    },
  };
  assert.equal(await legacy.getAccount(scope), null);
  assert.equal("listAccounts" in legacy, false);
  assert.equal("readEntries" in legacy, false);
});
