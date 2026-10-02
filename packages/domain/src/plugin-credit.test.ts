import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreditAccount,
  grantCreditAccount,
  reserveCreditAccount,
  settleCreditReservation,
  releaseCreditReservation,
  validateCreditScope,
  validateCreditAccount,
  validateCreditReservation,
  validateCreditReservationInput,
  type CreditReservationInput,
} from "./plugin-credit.ts";

const scope = {
  tenantId: "tenant-1",
  principalId: "user-1",
  poolId: "plugin-crewon.comfyui-krea2",
};
const request: CreditReservationInput = {
  scope,
  reservationId: "reservation-1",
  idempotencyKey: "request-1",
  requestDigest: `sha256:${"a".repeat(64)}`,
  pluginId: "crewon.comfyui-krea2",
  priceRevision: 1,
  quotedCredits: "30",
};

function funded(credits = "100") {
  return grantCreditAccount(createCreditAccount(scope), credits);
}

test("credit accounts start empty and conserve all granted credits", () => {
  const empty = createCreditAccount(scope);
  assert.deepEqual(empty, {
    schemaVersion: "crewon.plugin-credit-account.v0",
    scope,
    revision: 1,
    availableCredits: "0",
    reservedCredits: "0",
    spentCredits: "0",
    grantedCredits: "0",
  });
  const first = grantCreditAccount(empty, "100");
  const second = grantCreditAccount(first, "7");
  assert.deepEqual(second, {
    ...empty,
    revision: 3,
    availableCredits: "107",
    grantedCredits: "107",
  });
  assert.equal(empty.availableCredits, "0");
  assert.equal(first.availableCredits, "100");
});

test("reservation rejects insufficient funds and moves available credits into a hold", () => {
  const empty = createCreditAccount(scope);
  assert.throws(
    () => reserveCreditAccount(empty, request),
    /plugin_credit_insufficient_balance/u,
  );
  const balance = funded();
  const held = reserveCreditAccount(balance, request);
  assert.deepEqual(held.account, {
    ...balance,
    revision: 3,
    availableCredits: "70",
    reservedCredits: "30",
  });
  assert.deepEqual(held.reservation, {
    ...request,
    schemaVersion: "crewon.plugin-credit-reservation.v0",
    state: "reserved",
    settledCredits: null,
  });
  assert.equal(balance.availableCredits, "100");
});

test("partial settlement spends the actual amount and releases the unused hold", () => {
  const held = reserveCreditAccount(funded(), request);
  const settled = settleCreditReservation(held.account, held.reservation, "18");
  assert.deepEqual(settled.account, {
    ...held.account,
    revision: 4,
    availableCredits: "82",
    reservedCredits: "0",
    spentCredits: "18",
  });
  assert.equal(settled.reservation.state, "settled");
  assert.equal(settled.reservation.settledCredits, "18");
  assert.equal(settled.reservation.quotedCredits, "30");
  assert.equal(settled.reservation.priceRevision, 1);
  assert.equal(held.reservation.state, "reserved");
});

test("zero settlement returns the entire hold and records a terminal zero charge", () => {
  const held = reserveCreditAccount(funded(), request);
  const settled = settleCreditReservation(held.account, held.reservation, "0");
  assert.equal(settled.account.availableCredits, "100");
  assert.equal(settled.account.reservedCredits, "0");
  assert.equal(settled.account.spentCredits, "0");
  assert.equal(settled.reservation.state, "settled");
  assert.equal(settled.reservation.settledCredits, "0");
});

test("release returns an unsettled hold without changing spent credits", () => {
  const first = reserveCreditAccount(funded(), request);
  const spent = settleCreditReservation(first.account, first.reservation, "12");
  const next = reserveCreditAccount(spent.account, {
    ...request,
    reservationId: "reservation-2",
    idempotencyKey: "request-2",
  });
  const released = releaseCreditReservation(next.account, next.reservation);
  assert.equal(released.account.availableCredits, "88");
  assert.equal(released.account.reservedCredits, "0");
  assert.equal(released.account.spentCredits, "12");
  assert.equal(released.reservation.state, "released");
  assert.equal(released.reservation.settledCredits, "0");
});

test("settlement cannot exceed its quote even if more credits are reserved elsewhere", () => {
  const first = reserveCreditAccount(funded(), request);
  const next = reserveCreditAccount(first.account, {
    ...request,
    reservationId: "reservation-2",
    idempotencyKey: "request-2",
    quotedCredits: "50",
  });
  assert.throws(
    () => settleCreditReservation(next.account, first.reservation, "31"),
    /plugin_credit_quote_exceeded/u,
  );
  assert.equal(next.account.reservedCredits, "80");
  const settled = settleCreditReservation(
    next.account,
    first.reservation,
    "30",
  );
  assert.equal(settled.account.reservedCredits, "50");
  assert.equal(settled.account.spentCredits, "30");
});

test("replaying the same terminal decision changes neither balances nor revision", () => {
  const held = reserveCreditAccount(funded(), request);
  const settled = settleCreditReservation(held.account, held.reservation, "18");
  assert.deepEqual(
    settleCreditReservation(settled.account, settled.reservation, "18"),
    settled,
  );
  assert.throws(
    () => settleCreditReservation(settled.account, settled.reservation, "19"),
    /plugin_credit_settlement_conflict/u,
  );
  assert.throws(
    () => releaseCreditReservation(settled.account, settled.reservation),
    /plugin_credit_reservation_terminal_conflict/u,
  );
  const released = releaseCreditReservation(held.account, held.reservation);
  assert.deepEqual(
    releaseCreditReservation(released.account, released.reservation),
    released,
  );
  assert.throws(
    () => settleCreditReservation(released.account, released.reservation, "0"),
    /plugin_credit_reservation_terminal_conflict/u,
  );
});

test("tenant, user and credit pool boundaries are checked before every reservation transition", () => {
  const account = funded();
  const held = reserveCreditAccount(account, request);
  const settled = settleCreditReservation(held.account, held.reservation, "18");
  for (const field of ["tenantId", "principalId", "poolId"] as const) {
    const otherScope = { ...scope, [field]: `${scope[field]}-other` };
    const otherAccount = grantCreditAccount(
      createCreditAccount(otherScope),
      "100",
    );
    assert.throws(
      () => reserveCreditAccount(account, { ...request, scope: otherScope }),
      /plugin_credit_scope_mismatch/u,
    );
    assert.throws(
      () => settleCreditReservation(otherAccount, held.reservation, "18"),
      /plugin_credit_scope_mismatch/u,
    );
    assert.throws(
      () => releaseCreditReservation(otherAccount, held.reservation),
      /plugin_credit_scope_mismatch/u,
    );
    assert.throws(
      () => settleCreditReservation(otherAccount, settled.reservation, "18"),
      /plugin_credit_scope_mismatch/u,
    );
  }
});

test("BigInt accounting preserves exact credits beyond Number precision", () => {
  const total = "123456789012345678901234567890123456789012345678";
  const quote = "9007199254740993";
  const actual = "9007199254740992";
  const held = reserveCreditAccount(funded(total), {
    ...request,
    quotedCredits: quote,
  });
  assert.equal(
    held.account.availableCredits,
    (BigInt(total) - BigInt(quote)).toString(),
  );
  const settled = settleCreditReservation(
    held.account,
    held.reservation,
    actual,
  );
  assert.equal(
    settled.account.availableCredits,
    (BigInt(total) - BigInt(actual)).toString(),
  );
  assert.equal(settled.account.spentCredits, actual);
  assert.equal(settled.account.grantedCredits, total);
});

test("amounts require canonical integer strings bounded to 48 digits", () => {
  for (const amount of [
    "",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    "9".repeat(49),
    1,
    1n,
    NaN,
    Infinity,
    null,
  ]) {
    assert.throws(() =>
      validateCreditAccount({
        ...createCreditAccount(scope),
        availableCredits: amount,
        grantedCredits: amount,
      }),
    );
    assert.throws(() =>
      validateCreditReservationInput({ ...request, quotedCredits: amount }),
    );
  }
  assert.throws(() => grantCreditAccount(funded(), "0"));
  assert.throws(() =>
    reserveCreditAccount(funded(), { ...request, quotedCredits: "0" }),
  );
  const maximum = funded("9".repeat(48));
  assert.throws(
    () => grantCreditAccount(maximum, "1"),
    /plugin_credit_amount_invalid/u,
  );
  assert.equal(maximum.grantedCredits, "9".repeat(48));
});

test("account validators reject unsupported schemas, bad revisions and broken conservation", () => {
  const account = funded();
  for (const patch of [
    { schemaVersion: "crewon.plugin-credit-account.v1" },
    { revision: 0 },
    { revision: 1.5 },
    { revision: "2" },
    { revision: 2_147_483_648 },
    { availableCredits: "99" },
    { reservedCredits: "1" },
    { spentCredits: "1" },
    { grantedCredits: "101" },
    { hiddenBalance: "100" },
  ])
    assert.throws(() => validateCreditAccount({ ...account, ...patch }));
  const maximumRevision = validateCreditAccount({
    ...account,
    revision: 2_147_483_647,
  });
  assert.throws(
    () => grantCreditAccount(maximumRevision, "1"),
    /plugin_credit_revision_invalid/u,
  );
});

test("reservation validation binds schema, frozen pricing metadata and terminal amounts", () => {
  const held = reserveCreditAccount(funded(), request);
  for (const patch of [
    { schemaVersion: "crewon.plugin-credit-reservation.v1" },
    { state: "pending" },
    { settledCredits: "0" },
    { state: "settled", settledCredits: null },
    { state: "settled", settledCredits: "31" },
    { state: "released", settledCredits: null },
    { state: "released", settledCredits: "1" },
    { priceRevision: 0 },
    { priceRevision: 1.5 },
    { pluginId: "Krea2" },
    { requestDigest: "a".repeat(64) },
    { requestDigest: `sha256:${"A".repeat(64)}` },
    { rawPrice: 10 },
  ])
    assert.throws(() =>
      validateCreditReservation({ ...held.reservation, ...patch }),
    );
});

test("scope and IDs reject blank, noncanonical, oversized and malformed values", () => {
  for (const bad of [
    "",
    " ",
    " user-1",
    "user-1 ",
    "user\n1",
    "user\u007f1",
    "x".repeat(129),
    "中".repeat(129),
    "user\ud800",
    1,
    [],
    null,
  ]) {
    for (const field of ["tenantId", "principalId", "poolId"] as const)
      assert.throws(() => validateCreditScope({ ...scope, [field]: bad }));
    for (const field of ["reservationId", "idempotencyKey"] as const)
      assert.throws(() =>
        validateCreditReservationInput({ ...request, [field]: bad }),
      );
  }
  assert.throws(() => validateCreditScope({ ...scope, actorId: "actor-1" }));
  assert.throws(() => validateCreditScope([scope]));
  assert.throws(() => validateCreditScope(new Date()));
});

test("credit identity validation accepts existing 128-character multibyte identities", () => {
  for (const id of ["中".repeat(128), "😀".repeat(64)]) {
    const existingScope = {
      tenantId: id,
      principalId: id,
      poolId: id,
    };
    const account = grantCreditAccount(
      createCreditAccount(existingScope),
      "100",
    );
    assert.deepEqual(account.scope, existingScope);
    const held = reserveCreditAccount(account, {
      ...request,
      scope: existingScope,
      reservationId: id,
      idempotencyKey: id,
    });
    assert.equal(held.account.availableCredits, "70");
    assert.equal(held.reservation.reservationId, id);
    assert.equal(held.reservation.idempotencyKey, id);
  }
});

test("all validators and mutations return frozen snapshots detached from caller objects", () => {
  const callerScope = { ...scope };
  const account = createCreditAccount(callerScope);
  const callerAccount = {
    ...funded(),
    scope: { ...scope },
  };
  const callerRequest = {
    ...request,
    scope: { ...scope },
  };
  const held = reserveCreditAccount(callerAccount, callerRequest);
  const validatedScope = validateCreditScope(callerRequest.scope);
  const validatedInput = validateCreditReservationInput(callerRequest);
  callerScope.principalId = "user-2";
  callerAccount.scope.principalId = "user-2";
  callerAccount.availableCredits = "0";
  callerRequest.scope.poolId = "another-pool";
  callerRequest.quotedCredits = "90";
  assert.deepEqual(account.scope, scope);
  assert.deepEqual(held.account.scope, scope);
  assert.deepEqual(held.reservation.scope, scope);
  assert.deepEqual(validatedScope, scope);
  assert.deepEqual(validatedInput.scope, scope);
  assert.equal(held.account.availableCredits, "70");
  assert.equal(held.reservation.quotedCredits, "30");
  for (const value of [
    account,
    account.scope,
    held,
    held.account,
    held.account.scope,
    held.reservation,
    held.reservation.scope,
    validatedScope,
    validatedInput,
    validatedInput.scope,
  ]) {
    assert.ok(Object.isFrozen(value));
    assert.equal(Reflect.set(value, "extra", "unexpected"), false);
  }
  const callerHold = {
    ...held.reservation,
    scope: { ...scope },
  };
  const detachedHold = validateCreditReservation(callerHold);
  callerHold.scope.tenantId = "tenant-2";
  callerHold.quotedCredits = "90";
  assert.deepEqual(detachedHold.scope, scope);
  assert.equal(detachedHold.quotedCredits, "30");
});

test("validation reads data descriptors without executing caller accessors", () => {
  let invoked = false;
  const withGetter = {
    ...scope,
    get principalId() {
      invoked = true;
      return "user-1";
    },
  };
  assert.throws(() => validateCreditScope(withGetter), /fields_invalid/u);
  assert.equal(invoked, false);
  assert.throws(() =>
    reserveCreditAccount(funded(), {
      ...request,
      get quotedCredits() {
        invoked = true;
        return "30";
      },
    }),
  );
  assert.equal(invoked, false);
  assert.throws(() =>
    validateCreditScope({ ...scope, [Symbol("hidden")]: true }),
  );
  assert.throws(() =>
    validateCreditScope(Object.assign(Object.create(scope), scope)),
  );
});

test("active transitions reject an account that does not contain the quoted hold", () => {
  const account = funded();
  const held = reserveCreditAccount(account, request);
  assert.throws(
    () => settleCreditReservation(account, held.reservation, "18"),
    /plugin_credit_reserved_balance_mismatch/u,
  );
  assert.throws(
    () => releaseCreditReservation(account, held.reservation),
    /plugin_credit_reserved_balance_mismatch/u,
  );
});
