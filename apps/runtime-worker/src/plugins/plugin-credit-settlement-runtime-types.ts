import type {
  PluginCreditSettlementAuthority,
  PluginCreditSettlementRecoveryScope,
} from "@crewon/application";

/** Separate financial deployment authority; execution permission cannot supply it. */
export interface PluginCreditSettlementDeploymentAuthority
  extends PluginCreditSettlementAuthority {
  authorize(signal: AbortSignal): Promise<void>;
  /** Synchronous captured epoch/expiry/lifetime fence, checked inside every Store transaction. */
  assertCurrent(): void;
  close(): Promise<void>;
}
export type PluginCreditSettlementRuntimeConfig = Readonly<{
  scope: PluginCreditSettlementRecoveryScope;
  authority: PluginCreditSettlementDeploymentAuthority;
  batchSize: number;
  intervalMs: number;
  maxRoundMs: number;
  migrate: boolean;
}>;

export interface PluginCreditSettlementMaintenancePort {
  /** Nonblocking scheduling: one bounded physical round may be in flight. */
  poll(): Promise<void>;
  close(): Promise<void>;
}
