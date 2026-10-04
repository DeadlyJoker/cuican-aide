import type {
  PluginCreditSettlementDecision,
  PluginCreditSettlementEvidence,
} from "@crewon/application";
import { parsePluginCreditSettlementWorkerConfig } from "./plugins/plugin-credit-settlement-worker-config.ts";

export const financialScope = Object.freeze({
  tenantId: "financial-test-tenant",
  spaceId: "financial-test-space",
  profileId: "financial-test-profile",
});
export const financialToken =
  "independent-financial-test-private-token-at-least-32-bytes";
export const financialEnvironment = Object.freeze({
  NAMED_FINANCIAL_AUTHORIZATION_TOKEN: financialToken,
  NAMED_FINANCIAL_DECISION_TOKEN: financialToken + "-decision",
});
/** Pure named protocol data, not real identity, funding or supplier settlement evidence. */
export function financialConfigDocument(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: "crewon.plugin-credit-settlement-worker.v1",
    scope: financialScope,
    authorityId: "financial-test-authority",
    authorityRevision: "financial-test-policy-1",
    authorizationAuthority: {
      url: "https://financial.example/authorize",
      serviceTokenEnvironmentVariable: "NAMED_FINANCIAL_AUTHORIZATION_TOKEN",
    },
    decisionAuthority: {
      url: "https://financial.example/decide",
      serviceTokenEnvironmentVariable: "NAMED_FINANCIAL_DECISION_TOKEN",
    },
    timeoutMs: 1000,
    maxAuthorizationAgeMs: 10_000,
    batchSize: 2,
    intervalMs: 1000,
    maxRoundMs: 5000,
    migrate: false,
    ...patch,
  };
}
export function financialConfig(patch: Record<string, unknown> = {}) {
  return parsePluginCreditSettlementWorkerConfig(
    financialConfigDocument(patch),
    financialEnvironment,
  );
}
export function financialAuthorization(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: "crewon.plugin-credit-settlement-authorization.v1",
    scope: financialScope,
    authorityId: "financial-test-authority",
    authorityRevision: "financial-test-policy-1",
    outcome: "allow",
    authorityEpoch: "financial-test-epoch-1",
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    ...patch,
  };
}
export const financialDigest = `sha256:${"a".repeat(64)}`;
export function financialEvidence(): PluginCreditSettlementEvidence {
  return {
    schemaVersion: "crewon.plugin-credit-settlement-evidence.v1",
    locator: { tenantId: financialScope.tenantId, runId: "financial-test-run" },
    spaceId: financialScope.spaceId,
    actorId: "financial-test-actor",
    pluginId: "example.financial-test",
    bindingDigest: financialDigest,
    admissionDigest: financialDigest,
    taskReceiptDigest: financialDigest,
    installedAdmissionDigest: financialDigest,
    scope: {
      tenantId: financialScope.tenantId,
      principalId: "financial-test-payer",
      poolId: "financial-test-pool",
    },
    reservationId: "financial-test-run",
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
    evidenceDigest: financialDigest,
  };
}
export function financialDecision(
  outcome:
    | PluginCreditSettlementDecision["outcome"]
    | Readonly<{ kind: "hold" }> = { kind: "settle", actualCredits: "12" },
  patch: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "crewon.plugin-credit-settlement-decision.v1",
    evidenceDigest: financialDigest,
    authorityId: "financial-test-authority",
    authorityRevision: "financial-test-policy-1",
    decisionId: "financial-test-decision",
    outcome,
    ...patch,
  };
}
export function financialResponse(
  value: unknown,
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
