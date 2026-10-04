import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type { PluginCreditSettlementRecoveryPage } from "@crewon/application";
import {
  capturePluginCreditSettlementRuntimeConfig,
  createPluginCreditSettlementMaintenance,
} from "./plugins/plugin-credit-settlement-maintenance.ts";
import type { PluginCreditSettlementRuntimeConfig } from "./plugins/plugin-credit-settlement-runtime-types.ts";
import {
  deferred,
  maintenanceFixture,
  until,
} from "./plugin-credit-settlement-maintenance.test-support.ts";

test("financial configuration capture is synchronous, exact, frozen and does not invoke accessors", () => {
  const f = maintenanceFixture();
  const original = f.config();
  const captured = capturePluginCreditSettlementRuntimeConfig(original);
  assert.deepEqual(f.calls, []);
  assert.notEqual(captured, original);
  assert.notEqual(captured.scope, original.scope);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.scope));
  assert.ok(Object.isFrozen(captured.authority));
  let getterCalls = 0;
  const accessor = { ...original };
  Object.defineProperty(accessor, "migrate", {
    enumerable: true,
    get() {
      getterCalls++;
      return false;
    },
  });
  assert.throws(
    () => capturePluginCreditSettlementRuntimeConfig(accessor),
    /configuration_invalid/,
  );
  const scopeAccessor = { ...original.scope };
  Object.defineProperty(scopeAccessor, "tenantId", {
    enumerable: true,
    get() {
      getterCalls++;
      return "unexpected";
    },
  });
  assert.throws(
    () =>
      capturePluginCreditSettlementRuntimeConfig({
        ...original,
        scope: scopeAccessor,
      }),
    /configuration_invalid/,
  );
  const authorityAccessor = { ...f.authority };
  Object.defineProperty(authorityAccessor, "authorize", {
    enumerable: true,
    get() {
      getterCalls++;
      return f.authority.authorize;
    },
  });
  assert.throws(
    () =>
      capturePluginCreditSettlementRuntimeConfig({
        ...original,
        authority: authorityAccessor,
      }),
    /configuration_invalid/,
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(f.calls, []);
});

test("financial configuration has explicit safe ranges and no inferred scope, authority or migration defaults", () => {
  const f = maintenanceFixture();
  for (const options of [
    { batchSize: 0 },
    { batchSize: 17 },
    { batchSize: 1.5 },
    { intervalMs: 0 },
    { intervalMs: 3_600_001 },
    { intervalMs: Infinity },
    { maxRoundMs: 0 },
    { maxRoundMs: 30_001 },
    { maxRoundMs: NaN },
    { migrate: "true" },
    { authority: undefined },
    { scope: { tenantId: "", spaceId: "space", profileId: "profile" } },
    { scope: { tenantId: "tenant", spaceId: "space" } },
    {
      scope: {
        tenantId: "tenant",
        spaceId: "space",
        profileId: "profile",
        actorId: "payer",
      },
    },
  ]) {
    assert.throws(
      () =>
        capturePluginCreditSettlementRuntimeConfig({
          ...f.config(),
          ...options,
        } as PluginCreditSettlementRuntimeConfig),
      /configuration_invalid/,
    );
  }
  assert.throws(
    () =>
      capturePluginCreditSettlementRuntimeConfig({
        ...f.config(),
        extra: true,
      } as PluginCreditSettlementRuntimeConfig),
    /configuration_invalid/,
  );
  assert.throws(
    () =>
      capturePluginCreditSettlementRuntimeConfig(
        Object.assign({ ...f.config() }, { [Symbol("hidden")]: true }),
      ),
    /configuration_invalid/,
  );
  assert.deepEqual(f.calls, []);
});

test("captured authority preserves its original receiver and cannot be replaced through mutable input", async () => {
  const f = maintenanceFixture();
  const receiver = {
    ...f.authority,
    marker: "original",
    authorize: async function (this: { marker: string }, signal: AbortSignal) {
      assert.equal(this.marker, "original");
      signal.throwIfAborted();
    },
  };
  const original = f.config({ authority: receiver });
  const captured = capturePluginCreditSettlementRuntimeConfig(original);
  receiver.authorize = async () => {
    throw new Error("replacement must not be called");
  };
  await captured.authority.authorize(new AbortController().signal);
  assert.deepEqual(f.calls, []);
});

test("preparation authorizes before creating Store ownership and migrates only when explicitly enabled", async () => {
  const f = maintenanceFixture();
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config(),
    storeFactory: f.factory,
  });
  assert.equal(f.calls[0], "authorize");
  assert.ok(f.calls.indexOf("factory") > f.calls.indexOf("authorize"));
  assert.equal(f.calls.includes("migrate"), false);
  assert.equal(f.calls.includes("migrate-recovery"), false);
  assert.equal(f.scans.length, 0);
  await owner.close();
  assert.equal(f.state.parentClosed, false);
  assert.throws(() => f.assertOwner());
  const enabled = maintenanceFixture();
  const prepared = await createPluginCreditSettlementMaintenance({
    config: enabled.config({ migrate: true }),
    storeFactory: enabled.factory,
  });
  assert.ok(
    enabled.calls.indexOf("migrate") > enabled.calls.indexOf("factory"),
  );
  assert.ok(
    enabled.calls.indexOf("migrate-recovery") >
      enabled.calls.indexOf("migrate"),
  );
  assert.equal(enabled.calls.filter((call) => call === "authorize").length, 3);
  await prepared.close();
  assert.equal(enabled.state.parentClosed, false);
});

test("denied preparation never creates a Store and failure cleanup physically joins authority close", async () => {
  const closed = deferred();
  const f = maintenanceFixture({ closeAuthority: () => closed.promise });
  f.state.allowed = false;
  let settled = false;
  const pending = createPluginCreditSettlementMaintenance({
    config: f.config({ migrate: true }),
    storeFactory: f.factory,
  });
  const rejected = assert.rejects(pending, /authority deny/).then(() => {
    settled = true;
  });
  await until(() => f.calls.includes("close-authority"));
  assert.equal(settled, false);
  assert.equal(f.state.factoryCalls, 0);
  assert.equal(f.calls.includes("migrate"), false);
  assert.equal(f.calls.includes("migrate-recovery"), false);
  closed.resolve();
  await rejected;
  assert.equal(f.state.parentClosed, false);
});

test("migration failure withdraws captured transaction ownership, joins cleanup and leaves parent Store open", async () => {
  const migration = deferred();
  const closing = deferred();
  const f = maintenanceFixture({
    migrate: () => migration.promise,
    closeAuthority: () => closing.promise,
  });
  let settled = false;
  const pending = createPluginCreditSettlementMaintenance({
    config: f.config({ migrate: true }),
    storeFactory: f.factory,
  });
  const rejected = assert
    .rejects(pending, /named migration failure/)
    .then(() => {
      settled = true;
    });
  await until(() => f.calls.includes("migrate"));
  f.assertOwner();
  migration.reject(new Error("named migration failure"));
  await until(() => f.calls.includes("close-authority"));
  assert.throws(() => f.assertOwner());
  assert.equal(settled, false);
  assert.equal(f.calls.includes("migrate-recovery"), false);
  closing.resolve();
  await rejected;
  assert.equal(f.state.parentClosed, false);
});

test("poll immediately releases ordinary work and retains one physical scan across repeated polling", async () => {
  const scan = deferred<PluginCreditSettlementRecoveryPage>();
  const f = maintenanceFixture({ scan: () => scan.promise });
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config(),
    storeFactory: f.factory,
  });
  await owner.poll();
  await until(() => f.scans.length === 1);
  let ordinaryWorkCompleted = false;
  await Promise.resolve().then(() => {
    ordinaryWorkCompleted = true;
  });
  await Promise.all(Array.from({ length: 100 }, () => owner.poll()));
  assert.equal(ordinaryWorkCompleted, true);
  assert.equal(f.scans.length, 1);
  assert.equal(owner.snapshot().pending, true);
  scan.resolve({ items: [f.locator()], nextRunId: null });
  await until(() => !owner.snapshot().pending);
  assert.equal(owner.snapshot().committed, 1);
  assert.equal(f.ledger.size, 1);
  await owner.close();
  assert.equal(f.state.parentClosed, false);
});

test("a round budget abort does not release its physical slot or let close detach a slow scan", async () => {
  const scan = deferred<PluginCreditSettlementRecoveryPage>();
  const f = maintenanceFixture({ scan: () => scan.promise });
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config({ maxRoundMs: 2 }),
    storeFactory: f.factory,
  });
  await owner.poll();
  await until(() => f.scans.length === 1);
  await setTimeout(20);
  assert.equal(owner.snapshot().budgetExpirations, 1);
  assert.equal(owner.snapshot().pending, true);
  await Promise.all(Array.from({ length: 100 }, () => owner.poll()));
  assert.equal(f.scans.length, 1);
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  assert.equal(owner.snapshot().closed, true);
  assert.throws(() => f.assertOwner());
  assert.ok(f.authorizationSignals.every((signal) => signal.aborted));
  await Promise.resolve();
  assert.equal(closed, false);
  scan.resolve({ items: [f.locator()], nextRunId: null });
  await closing;
  assert.equal(owner.snapshot().pending, false);
  assert.equal(f.ledger.size, 0);
  assert.equal(
    f.calls.some((call) => call.startsWith("finalize:")),
    false,
  );
  assert.equal(f.state.parentClosed, false);
});

test("hold, unfinished evidence and corrupt execution candidates all advance the bounded metadata page", async () => {
  const f = maintenanceFixture();
  f.hooks.scan = async (input) =>
    input.afterRunId === null
      ? {
          items: [f.locator("run-a"), f.locator("run-b"), f.locator("run-c")],
          nextRunId: "run-d",
        }
      : { items: [f.locator("run-e")], nextRunId: null };
  f.hooks.decide = async ({ evidence }) =>
    evidence.locator.runId === "run-a"
      ? { kind: "hold" }
      : f.decision(evidence);
  f.hooks.load = async (value) => {
    if (value.runId === "run-c")
      throw new Error(
        "private supplier or corrupt execution text must not escape",
      );
    return { ...f.evidence(value), readyToFinalize: value.runId !== "run-b" };
  };
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config(),
    storeFactory: f.factory,
  });
  await owner.poll();
  await until(() => !owner.snapshot().pending);
  assert.equal(owner.snapshot().inspected, 3);
  assert.equal(owner.snapshot().held, 1);
  assert.equal(owner.snapshot().notReady, 1);
  assert.equal(owner.snapshot().failures, 1);
  assert.equal(owner.snapshot().afterRunId, "run-d");
  assert.equal(f.ledger.size, 0);
  assert.equal(
    JSON.stringify(owner.snapshot()).includes("private supplier"),
    false,
  );
  await setTimeout(2);
  await owner.poll();
  await until(() => !owner.snapshot().pending);
  assert.equal(f.scans.length, 2);
  assert.equal(f.scans[1]?.afterRunId, "run-d");
  assert.equal(owner.snapshot().afterRunId, null);
  assert.equal(owner.snapshot().committed, 1);
  assert.ok(f.ledger.has("run-e"));
  await owner.close();
});

test("a budget-interrupted candidate retains the page tail until a later round instead of starving its neighbors", async () => {
  const load =
    deferred<ReturnType<ReturnType<typeof maintenanceFixture>["evidence"]>>();
  const f = maintenanceFixture();
  let blocked = false;
  f.hooks.scan = async () => ({
    items: [f.locator("run-a"), f.locator("run-b"), f.locator("run-c")],
    nextRunId: "run-d",
  });
  f.hooks.load = async (value) => {
    if (value.runId === "run-b" && !blocked) {
      blocked = true;
      return load.promise;
    }
    return f.evidence(value);
  };
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config({ maxRoundMs: 10 }),
    storeFactory: f.factory,
  });
  await owner.poll();
  await until(() => blocked);
  await setTimeout(20);
  assert.equal(owner.snapshot().pending, true);
  assert.equal(owner.snapshot().inspected, 1);
  assert.equal(owner.snapshot().afterRunId, "run-a");
  load.resolve(f.evidence(f.locator("run-b")));
  await until(() => !owner.snapshot().pending);
  assert.equal(owner.snapshot().retainedCandidates, 2);
  await setTimeout(2);
  await owner.poll();
  await until(() => !owner.snapshot().pending);
  assert.equal(f.scans.length, 1);
  assert.equal(owner.snapshot().committed, 3);
  assert.equal(owner.snapshot().inspected, 3);
  assert.equal(owner.snapshot().afterRunId, "run-d");
  await owner.close();
});

test("explicit scope and batch are captured before scheduling and cannot be changed by caller mutation", async () => {
  const f = maintenanceFixture();
  const scope: { tenantId: string; spaceId: string; profileId: string } = {
    ...f.recoveryScope,
  };
  const original = { ...f.config({ batchSize: 1 }), scope };
  const owner = await createPluginCreditSettlementMaintenance({
    config: original,
    storeFactory: f.factory,
  });
  original.batchSize = 16;
  scope.spaceId = "changed-space";
  await owner.poll();
  await until(() => !owner.snapshot().pending);
  assert.deepEqual(f.scans[0], {
    scope: f.recoveryScope,
    afterRunId: null,
    limit: 1,
  });
  assert.equal(owner.snapshot().committed, 1);
  await owner.close();
});

test("expired or withdrawn synchronous financial authority permanently stops this owner before any scan", async () => {
  const f = maintenanceFixture();
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config(),
    storeFactory: f.factory,
  });
  f.state.current = false;
  await owner.poll();
  assert.equal(owner.snapshot().withdrawn, true);
  assert.equal(owner.snapshot().lastFailureCode, "authorization_unavailable");
  assert.equal(f.scans.length, 0);
  assert.throws(() => f.assertOwner());
  f.state.current = true;
  await owner.poll();
  assert.equal(f.scans.length, 0);
  await owner.close();
});

test("a fresh authorization deny stops recovery with zero reads or financial decisions and cannot be silently retried", async () => {
  const f = maintenanceFixture();
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config(),
    storeFactory: f.factory,
  });
  f.state.allowed = false;
  await owner.poll();
  await until(() => !owner.snapshot().pending);
  assert.equal(owner.snapshot().withdrawn, true);
  assert.equal(f.scans.length, 0);
  assert.equal(
    f.calls.some(
      (call) =>
        call.startsWith("get:") ||
        call.startsWith("load:") ||
        call.startsWith("decide:") ||
        call.startsWith("finalize:"),
    ),
    false,
  );
  f.state.allowed = true;
  await setTimeout(2);
  await owner.poll();
  assert.equal(f.scans.length, 0);
  assert.equal(f.ledger.size, 0);
  await owner.close();
});

test("close withdraws immediately and joins a supplier decision plus authority body before completing", async () => {
  const decision =
    deferred<ReturnType<ReturnType<typeof maintenanceFixture>["decision"]>>();
  const body = deferred();
  const f = maintenanceFixture({
    decide: () => decision.promise,
    closeAuthority: () => body.promise,
  });
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config(),
    storeFactory: f.factory,
  });
  await owner.poll();
  await until(() => f.decisionSignals.length === 1);
  let closed = false;
  const originalClose = owner.close();
  assert.equal(owner.close(), originalClose);
  const closing = originalClose.then(() => {
    closed = true;
  });
  assert.ok(f.decisionSignals[0]?.aborted);
  assert.throws(() => f.assertOwner());
  await Promise.resolve();
  assert.equal(closed, false);
  decision.resolve(f.decision());
  await until(() => !owner.snapshot().pending);
  assert.equal(closed, false);
  assert.equal(f.ledger.size, 0);
  body.resolve();
  await closing;
  assert.equal(f.calls.filter((call) => call === "close-authority").length, 1);
  assert.equal(f.state.parentClosed, false);
});

test("a confirmed atomic commit retains its original result while close joins the original transaction", async () => {
  const commit = deferred();
  const f = maintenanceFixture();
  f.hooks.finalize = async (input) => {
    const finalization = f.finalization(
      f.evidence(input.locator),
      input.decision,
    );
    f.ledger.set(input.locator.runId, finalization);
    await commit.promise;
    return { disposition: "committed", finalization };
  };
  const owner = await createPluginCreditSettlementMaintenance({
    config: f.config(),
    storeFactory: f.factory,
  });
  await owner.poll();
  await until(() => f.ledger.size === 1);
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  commit.resolve();
  await closing;
  assert.equal(owner.snapshot().committed, 1);
  assert.equal(owner.snapshot().inspected, 1);
  assert.equal(f.ledger.size, 1);
});

test("malformed, cross-tenant or oversized pages fail closed without consulting execution or financial authority", async () => {
  const f = maintenanceFixture();
  let getterCalls = 0;
  const malformed = { items: [], nextRunId: null };
  Object.defineProperty(malformed, "items", {
    enumerable: true,
    get() {
      getterCalls++;
      return [f.locator()];
    },
  });
  const pages = [
    malformed,
    { items: [{ tenantId: "other-tenant", runId: "run-a" }], nextRunId: null },
    { items: [f.locator("run-a"), f.locator("run-b")], nextRunId: null },
  ];
  for (const page of pages) {
    const fixture = maintenanceFixture({ scan: async () => page });
    const owner = await createPluginCreditSettlementMaintenance({
      config: fixture.config({ batchSize: 1 }),
      storeFactory: fixture.factory,
    });
    await owner.poll();
    await until(() => !owner.snapshot().pending);
    assert.equal(owner.snapshot().failures, 1);
    assert.equal(owner.snapshot().lastFailureCode, "scan_failed");
    assert.equal(owner.snapshot().afterRunId, null);
    assert.equal(
      fixture.calls.some(
        (call) =>
          call.startsWith("get:") ||
          call.startsWith("decide:") ||
          call.startsWith("finalize:"),
      ),
      false,
    );
    await owner.close();
  }
  assert.equal(getterCalls, 0);
});
