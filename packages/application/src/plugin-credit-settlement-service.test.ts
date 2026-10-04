import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreditAccount,
  grantCreditAccount,
  reserveCreditAccount,
  settleCreditReservation,
} from "@crewon/domain";
import type {
  PluginCreditSettlementAuthority,
  PluginCreditSettlementEvidence,
  PluginCreditSettlementFinalization,
  PluginCreditSettlementStore,
} from "./plugin-credit-settlement-port.ts";
import { PluginCreditSettlementService } from "./plugin-credit-settlement-service.ts";

const locator = Object.freeze({
  tenantId: "settlement-test-tenant",
  runId: "settlement-test-run",
});
const digest = `sha256:${"a".repeat(64)}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const calls: string[] = [];
  const scope = {
    tenantId: locator.tenantId,
    principalId: "named-test-payer",
    poolId: "named-test-pool",
  };
  const hold = reserveCreditAccount(
    grantCreditAccount(createCreditAccount(scope), "100"),
    {
      scope,
      reservationId: locator.runId,
      idempotencyKey: "named-test-key",
      requestDigest: digest,
      pluginId: "example.plugin",
      priceRevision: 7,
      quotedCredits: "30",
    },
  );
  const evidence: PluginCreditSettlementEvidence = {
    schemaVersion: "crewon.plugin-credit-settlement-evidence.v1",
    locator,
    spaceId: "space",
    actorId: "actor",
    pluginId: "example.plugin",
    bindingDigest: digest,
    admissionDigest: digest,
    taskReceiptDigest: digest,
    installedAdmissionDigest: null,
    scope,
    reservationId: locator.runId,
    priceRevision: 7,
    quotedCredits: "30",
    run: {
      revision: 3,
      status: "completed",
      terminalAt: "2026-10-04T00:00:00.000Z",
      cancelRequested: false,
    },
    operations: [],
    mutationReceipts: [],
    attempts: [],
    workItems: [],
    readyToFinalize: true,
    evidenceDigest: digest,
  };
  const decision = {
    schemaVersion: "crewon.plugin-credit-settlement-decision.v1" as const,
    evidenceDigest: digest,
    authorityId: "named-test-authority",
    authorityRevision: "named-test-policy",
    decisionId: "named-test-decision",
    outcome: { kind: "settle" as const, actualCredits: "18" },
  };
  const next = settleCreditReservation(hold.account, hold.reservation, "18");
  const finalization: PluginCreditSettlementFinalization = {
    schemaVersion: "crewon.plugin-credit-settlement-finalization.v1",
    locator,
    scope,
    reservationId: locator.runId,
    bindingDigest: digest,
    admissionDigest: digest,
    priceRevision: 7,
    quotedCredits: "30",
    decision,
    ...next,
  };
  const store: PluginCreditSettlementStore = {
    async migrate() {
      calls.push("migrate");
    },
    async getFinalization() {
      calls.push("get");
      return null;
    },
    async loadEvidence() {
      calls.push("load");
      return evidence;
    },
    async finalize() {
      calls.push("finalize");
      return { disposition: "committed", finalization };
    },
  };
  const authority: PluginCreditSettlementAuthority = {
    async decide() {
      calls.push("authority");
      return decision;
    },
  };
  let current = true;
  const service = new PluginCreditSettlementService({
    store,
    authority,
    async assertCurrent() {
      calls.push("current");
      if (!current) throw new Error("authority-withdrawn");
    },
  });
  return {
    calls,
    evidence,
    decision,
    finalization,
    store,
    authority,
    service,
    withdraw() {
      current = false;
    },
  };
}

test("missing settlement authority performs no billing reads, migrations, or mutations", async () => {
  const f = fixture();
  const service = new PluginCreditSettlementService({
    store: f.store,
    async assertCurrent() {
      throw new Error("must not authorize without authority");
    },
  });
  assert.deepEqual(await service.reconcile(locator), {
    disposition: "disabled",
  });
  assert.deepEqual(f.calls, []);
  await service.close();
  await assert.rejects(service.reconcile(locator), /settlement_closed/);
});

test("unfinished supplier evidence and explicit authority hold preserve the original reservation", async () => {
  const f = fixture();
  f.store.loadEvidence = async () => ({
    ...f.evidence,
    readyToFinalize: false,
  });
  assert.deepEqual(await f.service.reconcile(locator), {
    disposition: "not_ready",
  });
  assert.equal(f.calls.includes("authority"), false);
  assert.equal(f.calls.includes("finalize"), false);
  f.store.loadEvidence = async () => f.evidence;
  f.authority.decide = async () => ({ kind: "hold" });
  assert.deepEqual(await f.service.reconcile(locator), { disposition: "hold" });
  assert.equal(f.calls.includes("finalize"), false);
  await f.service.close();
});

test("a saved financial decision is read without asking the authority to decide again", async () => {
  const f = fixture();
  f.store.getFinalization = async () => f.finalization;
  assert.deepEqual(await f.service.reconcile(locator), {
    disposition: "existing",
    finalization: f.finalization,
  });
  assert.equal(f.calls.includes("authority"), false);
  assert.equal(f.calls.includes("load"), false);
  assert.equal(f.calls.includes("finalize"), false);
  await f.service.close();
});

test("concurrent reconciliation coalesces while physical authority close prevents a late financial mutation", async () => {
  const f = fixture();
  const entered = deferred<void>(),
    response = deferred<typeof f.decision>();
  f.authority.decide = async () => {
    f.calls.push("authority");
    entered.resolve();
    return response.promise;
  };
  const pending = f.service.reconcile(locator);
  const rejected = assert.rejects(pending);
  assert.equal(f.service.reconcile(locator), pending);
  await entered.promise;
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  response.resolve(f.decision);
  await rejected;
  await closing;
  assert.equal(closed, true);
  assert.equal(f.calls.filter((v) => v === "authority").length, 1);
  assert.equal(f.calls.includes("finalize"), false);
});

test("policy withdrawal after a remote decision prevents commit; a confirmed commit remains success during late close", async () => {
  const f = fixture();
  f.authority.decide = async () => {
    f.withdraw();
    return f.decision;
  };
  await assert.rejects(f.service.reconcile(locator), /authority-withdrawn/);
  assert.equal(f.calls.includes("finalize"), false);
  await f.service.close();
  const g = fixture();
  const entered = deferred<void>(),
    response =
      deferred<Awaited<ReturnType<PluginCreditSettlementStore["finalize"]>>>();
  g.store.finalize = async () => {
    entered.resolve();
    return response.promise;
  };
  const committing = g.service.reconcile(locator);
  await entered.promise;
  const closing = g.service.close();
  response.resolve({ disposition: "committed", finalization: g.finalization });
  assert.deepEqual(await committing, {
    disposition: "committed",
    finalization: g.finalization,
  });
  await closing;
});

test("authority responses must refer to the actual evidence and never execute locator or digest getters", async () => {
  const f = fixture();
  let getterCalls = 0;
  assert.throws(
    () =>
      f.service.reconcile({
        get tenantId() {
          getterCalls++;
          return locator.tenantId;
        },
        runId: locator.runId,
      }),
    /locator_invalid/,
  );
  f.authority.decide = async () => ({
    ...f.decision,
    get evidenceDigest() {
      getterCalls++;
      return digest;
    },
  });
  await assert.rejects(
    f.service.reconcile(locator),
    /authority_evidence_mismatch/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(f.calls.includes("finalize"), false);
  f.authority.decide = async () => ({
    ...f.decision,
    evidenceDigest: `sha256:${"b".repeat(64)}`,
  });
  await assert.rejects(
    f.service.reconcile(locator),
    /authority_evidence_mismatch/,
  );
  await f.service.close();
});
