import type {
  CreditAccount,
  CreditReservation,
  CreditScope,
  RunState,
} from "@crewon/domain";

export type PluginCreditSettlementLocator = Readonly<{
  tenantId: string;
  runId: string;
}>;

/** Explicit deployment recovery scope. It never selects or changes the original payer. */
export type PluginCreditSettlementRecoveryScope = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
}>;
export type PluginCreditSettlementRecoveryScan = Readonly<{
  scope: PluginCreditSettlementRecoveryScope;
  afterRunId: string | null;
  limit: number;
}>;
export type PluginCreditSettlementRecoveryPage = Readonly<{
  items: readonly PluginCreditSettlementLocator[];
  /** Last checked original metadata slot; null denotes the end of this pass. */
  nextRunId: string | null;
}>;
export type PluginCreditSettlementEvidence = Readonly<{
  schemaVersion: "crewon.plugin-credit-settlement-evidence.v1";
  locator: PluginCreditSettlementLocator;
  spaceId: string;
  actorId: string;
  pluginId: string;
  bindingDigest: string;
  admissionDigest: string;
  taskReceiptDigest: string;
  installedAdmissionDigest: string | null;
  scope: CreditScope;
  reservationId: string;
  priceRevision: number;
  quotedCredits: string;
  run: Readonly<{
    revision: number;
    status: RunState["status"];
    terminalAt: string | null;
    cancelRequested: boolean;
  }>;
  operations: readonly Readonly<{
    operationId: string;
    revision: number;
    status: string;
    recordDigest: string;
  }>[];
  mutationReceipts: readonly Readonly<{
    receiptId: string;
    status: string;
    revision: number;
    dispatchedAt: string | null;
    resultDigest: string | null;
    recordDigest: string;
  }>[];
  attempts: readonly Readonly<{
    attemptId: string;
    status: string;
    recordDigest: string;
  }>[];
  workItems: readonly Readonly<{
    workItemId: string;
    status: string;
    leaseEpoch: number;
    recordDigest: string;
  }>[];
  /** Conservative execution fence, independent of the authority's charging policy. */
  readyToFinalize: boolean;
  evidenceDigest: string;
}>;

export type PluginCreditSettlementDecision = Readonly<{
  schemaVersion: "crewon.plugin-credit-settlement-decision.v1";
  evidenceDigest: string;
  authorityId: string;
  authorityRevision: string;
  decisionId: string;
  outcome:
    | Readonly<{ kind: "settle"; actualCredits: string }>
    | Readonly<{ kind: "release" }>;
}>;

export type PluginCreditSettlementFinalization = Readonly<{
  schemaVersion: "crewon.plugin-credit-settlement-finalization.v1";
  locator: PluginCreditSettlementLocator;
  scope: CreditScope;
  reservationId: string;
  bindingDigest: string;
  admissionDigest: string;
  priceRevision: number;
  quotedCredits: string;
  decision: PluginCreditSettlementDecision;
  account: CreditAccount;
  reservation: CreditReservation;
}>;

export type PluginCreditSettlementCommitResult =
  | Readonly<{
      disposition: "committed" | "replayed";
      finalization: PluginCreditSettlementFinalization;
    }>
  | Readonly<{ disposition: "evidence_changed" | "not_ready" }>;

/** Server-owned adapter sharing the original Run/credit transaction and lifetime. No funding or price defaults. */
export interface PluginCreditSettlementStore {
  migrate(): Promise<void>;
  loadEvidence(
    locator: PluginCreditSettlementLocator,
  ): Promise<PluginCreditSettlementEvidence | null>;
  getFinalization(
    locator: PluginCreditSettlementLocator,
  ): Promise<PluginCreditSettlementFinalization | null>;
  finalize(
    input: Readonly<{
      locator: PluginCreditSettlementLocator;
      decision: PluginCreditSettlementDecision;
    }>,
  ): Promise<PluginCreditSettlementCommitResult>;
}

/** Indexed metadata paging only; execution and finance are still proven by the atomic adapter. */
export interface PluginCreditSettlementRecoveryStore
  extends PluginCreditSettlementStore {
  migrateRecovery(): Promise<void>;
  scanRecovery(
    input: PluginCreditSettlementRecoveryScan,
  ): Promise<PluginCreditSettlementRecoveryPage>;
}

/** Explicit server authority; neither the model nor UI can supply a financial decision. */
export interface PluginCreditSettlementAuthority {
  decide(
    input: Readonly<{
      evidence: PluginCreditSettlementEvidence;
      signal: AbortSignal;
    }>,
  ): Promise<PluginCreditSettlementDecision | Readonly<{ kind: "hold" }>>;
}
