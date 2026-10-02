import type {
  CreditAccount,
  CreditReservation,
  CreditReservationInput,
  CreditScope,
} from "@crewon/domain";

export type PluginCreditEntry = Readonly<{
  scope: CreditScope;
  revision: number;
  kind: "grant" | "reserve" | "settle" | "release";
  credits: string;
  grantId: string | null;
  reservationId: string | null;
  account: CreditAccount;
}>;

/** Trusted server-side accounting only; this port grants no account or charging authority. */
export interface PluginCreditStore {
  migrate(): Promise<void>;
  getAccount(scope: CreditScope): Promise<CreditAccount | null>;
  getReservation(
    input: Readonly<{
      scope: CreditScope;
      reservationId: string;
    }>,
  ): Promise<CreditReservation | null>;
  /** No default balance. An authorized funding integration must supply the grant. */
  grant(
    input: Readonly<{
      scope: CreditScope;
      grantId: string;
      credits: string;
    }>,
  ): Promise<CreditAccount>;
  /** Replaying the same key returns the original reservation, including its original ID. */
  reserve(input: CreditReservationInput): Promise<CreditReservation>;
  settle(
    input: Readonly<{
      scope: CreditScope;
      reservationId: string;
      actualCredits: string;
    }>,
  ): Promise<CreditReservation>;
  /** Releases an unsettled hold; it is neither a settled refund nor supplier cancellation. */
  release(
    input: Readonly<{
      scope: CreditScope;
      reservationId: string;
    }>,
  ): Promise<CreditReservation>;
  listEntries(
    input: Readonly<{
      scope: CreditScope;
      afterRevision: number;
      limit: number;
    }>,
  ): Promise<readonly PluginCreditEntry[]>;
}
