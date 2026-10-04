import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type {
  PluginCreditSettlementCommitResult,
  PluginCreditSettlementDecision,
  PluginCreditSettlementEvidence,
  PluginCreditSettlementFinalization,
  PluginCreditSettlementLocator,
  PluginCreditSettlementRecoveryPage,
  PluginCreditSettlementRecoveryScan,
  PluginCreditSettlementRecoveryStore,
} from "@crewon/application";
import {
  createCreditAccount,
  grantCreditAccount,
  reserveCreditAccount,
  settleCreditReservation,
} from "@crewon/domain";
import type {
  PluginCreditSettlementDeploymentAuthority,
  PluginCreditSettlementRuntimeConfig,
} from "./plugins/plugin-credit-settlement-runtime-types.ts";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (condition()) return;
    await setImmediate();
  }
  assert.ok(condition(), "settlement physical operation did not settle");
}

type Owner = Readonly<{ assertCurrent(): void }>;
type AuthorityDecisionInput = Parameters<
  PluginCreditSettlementDeploymentAuthority["decide"]
>[0];
export type SettlementMaintenanceHooks = {
  authorize?: (signal: AbortSignal) => Promise<void>;
  assertCurrent?: () => void;
  decide?: (
    input: AuthorityDecisionInput,
  ) => Promise<PluginCreditSettlementDecision | Readonly<{ kind: "hold" }>>;
  closeAuthority?: () => Promise<void>;
  migrate?: () => Promise<void>;
  migrateRecovery?: () => Promise<void>;
  scan?: (
    input: PluginCreditSettlementRecoveryScan,
  ) => Promise<PluginCreditSettlementRecoveryPage>;
  get?: (
    locator: PluginCreditSettlementLocator,
  ) => Promise<PluginCreditSettlementFinalization | null>;
  load?: (
    locator: PluginCreditSettlementLocator,
  ) => Promise<PluginCreditSettlementEvidence | null>;
  finalize?: (
    input: Parameters<PluginCreditSettlementRecoveryStore["finalize"]>[0],
  ) => Promise<PluginCreditSettlementCommitResult>;
};

export function maintenanceFixture(hooks: SettlementMaintenanceHooks = {}) {
  const calls: string[] = [];
  const scans: PluginCreditSettlementRecoveryScan[] = [];
  const authorizationSignals: AbortSignal[] = [];
  const decisionSignals: AbortSignal[] = [];
  const state = {
    allowed: true,
    current: true,
    factoryCalls: 0,
    parentClosed: false,
  };
  const recoveryScope = Object.freeze({
    tenantId: "finance-test-tenant",
    spaceId: "finance-test-space",
    profileId: "finance-test-profile",
  });
  const digest = `sha256:${"a".repeat(64)}`;
  const ledger = new Map<string, PluginCreditSettlementFinalization>();
  let owner: Owner | undefined;
  const locator = (runId = "run-a"): PluginCreditSettlementLocator =>
    Object.freeze({ tenantId: recoveryScope.tenantId, runId });
  const evidence = (value = locator()): PluginCreditSettlementEvidence => ({
    schemaVersion: "crewon.plugin-credit-settlement-evidence.v1",
    locator: value,
    spaceId: recoveryScope.spaceId,
    actorId: "named-finance-test-actor",
    pluginId: "finance.test.plugin",
    bindingDigest: digest,
    admissionDigest: digest,
    taskReceiptDigest: digest,
    installedAdmissionDigest: null,
    scope: {
      tenantId: recoveryScope.tenantId,
      principalId: "named-finance-test-payer",
      poolId: "named-finance-test-pool",
    },
    reservationId: value.runId,
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
  });
  const decision = (value = evidence()): PluginCreditSettlementDecision => ({
    schemaVersion: "crewon.plugin-credit-settlement-decision.v1",
    evidenceDigest: value.evidenceDigest,
    authorityId: "named-finance-test-authority",
    authorityRevision: "named-finance-test-policy",
    decisionId: `decision-${value.locator.runId}`,
    outcome: { kind: "settle", actualCredits: "18" },
  });
  const finalization = (
    value = evidence(),
    verdict = decision(value),
  ): PluginCreditSettlementFinalization => {
    const hold = reserveCreditAccount(
      grantCreditAccount(createCreditAccount(value.scope), "100"),
      {
        scope: value.scope,
        reservationId: value.reservationId,
        idempotencyKey: `reservation-${value.locator.runId}`,
        requestDigest: digest,
        pluginId: value.pluginId,
        priceRevision: value.priceRevision,
        quotedCredits: value.quotedCredits,
      },
    );
    assert.equal(verdict.outcome.kind, "settle");
    const settled = settleCreditReservation(
      hold.account,
      hold.reservation,
      verdict.outcome.kind === "settle" ? verdict.outcome.actualCredits : "0",
    );
    return {
      schemaVersion: "crewon.plugin-credit-settlement-finalization.v1",
      locator: value.locator,
      scope: value.scope,
      reservationId: value.reservationId,
      bindingDigest: value.bindingDigest,
      admissionDigest: value.admissionDigest,
      priceRevision: value.priceRevision,
      quotedCredits: value.quotedCredits,
      decision: verdict,
      ...settled,
    };
  };
  const authority: PluginCreditSettlementDeploymentAuthority = {
    async authorize(signal) {
      calls.push("authorize");
      authorizationSignals.push(signal);
      signal.throwIfAborted();
      if (!state.allowed) throw new Error("named authority deny");
      await hooks.authorize?.(signal);
      signal.throwIfAborted();
    },
    assertCurrent() {
      calls.push("fence");
      if (!state.current)
        throw new Error("named authority expired or withdrawn");
      hooks.assertCurrent?.();
    },
    async decide(input) {
      calls.push(`decide:${input.evidence.locator.runId}`);
      decisionSignals.push(input.signal);
      return hooks.decide === undefined
        ? decision(input.evidence)
        : hooks.decide(input);
    },
    async close() {
      calls.push("close-authority");
      state.current = false;
      await hooks.closeAuthority?.();
    },
  };
  const fence = () => {
    assert.ok(owner, "factory must install the captured owner first");
    owner.assertCurrent();
  };
  const store: PluginCreditSettlementRecoveryStore & {
    close(): Promise<void>;
  } = {
    async migrate() {
      fence();
      calls.push("migrate");
      await hooks.migrate?.();
      fence();
    },
    async migrateRecovery() {
      fence();
      calls.push("migrate-recovery");
      await hooks.migrateRecovery?.();
      fence();
    },
    async scanRecovery(input) {
      fence();
      calls.push("scan");
      scans.push(input);
      const page =
        hooks.scan === undefined
          ? { items: [locator()], nextRunId: null }
          : await hooks.scan(input);
      fence();
      return page;
    },
    async getFinalization(value) {
      fence();
      calls.push(`get:${value.runId}`);
      const result =
        hooks.get === undefined
          ? (ledger.get(value.runId) ?? null)
          : await hooks.get(value);
      fence();
      return result;
    },
    async loadEvidence(value) {
      fence();
      calls.push(`load:${value.runId}`);
      const result =
        hooks.load === undefined ? evidence(value) : await hooks.load(value);
      fence();
      return result;
    },
    async finalize(input) {
      fence();
      calls.push(`finalize:${input.locator.runId}`);
      if (hooks.finalize !== undefined) return hooks.finalize(input);
      const result = finalization(evidence(input.locator), input.decision);
      ledger.set(input.locator.runId, result);
      return { disposition: "committed", finalization: result };
    },
    async close() {
      state.parentClosed = true;
      calls.push("close-parent");
    },
  };
  const config = (
    options: Partial<PluginCreditSettlementRuntimeConfig> = {},
  ): PluginCreditSettlementRuntimeConfig => ({
    scope: recoveryScope,
    authority,
    batchSize: 4,
    intervalMs: 1,
    maxRoundMs: 500,
    migrate: false,
    ...options,
  });
  return {
    calls,
    scans,
    authorizationSignals,
    decisionSignals,
    state,
    hooks,
    recoveryScope,
    locator,
    evidence,
    decision,
    finalization,
    ledger,
    authority,
    store,
    config,
    factory(capturedOwner: Owner) {
      calls.push("factory");
      state.factoryCalls++;
      owner = capturedOwner;
      capturedOwner.assertCurrent();
      return store;
    },
    assertOwner() {
      fence();
    },
  };
}
