import type { CreditAccount, CreditScope } from "@crewon/domain";
import type { PluginCreditEntry } from "./plugin-credit-store-port.ts";

export type PluginCreditAccountListInput = Readonly<{
  tenantId: string;
  principalId: string;
  afterPoolId: string | null;
  limit: number;
}>;
export type PluginCreditEntriesReadInput = Readonly<{
  scope: CreditScope;
  afterRevision: number;
  limit: number;
}>;
export type PluginCreditAccountsReadResult = Readonly<{
  state: "unconfigured" | "ready";
  accounts: readonly CreditAccount[];
  nextPoolId: string | null;
}>;
export type PluginCreditEntriesReadResult = Readonly<{
  state: "unconfigured" | "ready";
  account: CreditAccount | null;
  entries: readonly PluginCreditEntry[];
  nextRevision: number | null;
}>;

/** Read-only original personal ledger. Reads never migrate or create funded accounts. */
export interface PluginCreditReadStore {
  listAccounts(
    input: PluginCreditAccountListInput,
  ): Promise<PluginCreditAccountsReadResult>;
  readEntries(
    input: PluginCreditEntriesReadInput,
  ): Promise<PluginCreditEntriesReadResult>;
}
