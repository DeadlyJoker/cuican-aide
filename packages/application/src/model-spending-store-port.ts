import type { ModelSpendingAccount, ModelSpendingScope } from "@crewon/domain";
export type SetModelSpendingInput = ModelSpendingScope &
  Readonly<{
    expectedRevision: number;
    currency: string;
    /** Total configured text-token ceiling since activation, never a fresh per-Run allowance. */
    limitPicounits: string;
  }>;
export interface ModelSpendingStore {
  get(scope: ModelSpendingScope): Promise<ModelSpendingAccount | null>;
  /** New accounts require this Goal to still belong to the Thread in the same transaction. */
  set(input: SetModelSpendingInput): Promise<ModelSpendingAccount>;
}
