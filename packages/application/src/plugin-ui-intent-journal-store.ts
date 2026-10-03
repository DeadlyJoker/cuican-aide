import type {
  PluginTaskAdmissionPin,
  PluginUiIntentJournalAccount,
  PluginUiIntentKind,
  PluginUiIntentRecord,
} from "@crewon/domain";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
/** Captured synchronous, pure protocol validation. No database or policy reads inside a Store transaction. */
export interface PluginUiIntentPayloadVerifier {
  verifyRequest(
    input: Readonly<{
      kind: PluginUiIntentKind;
      action: string;
      requestJson: string;
    }>,
  ): void;
  verifyReceipt(
    input: Readonly<{
      kind: PluginUiIntentKind;
      action: string;
      requestJson: string;
      receiptJson: string;
    }>,
  ): Readonly<{ receiptIdentityDigest: string }>;
}
export type PluginUiIntentJournalWriteOptions = Readonly<{
  authority: CreativeProjectCommitAuthority;
}>;
export interface PluginUiIntentJournalStore {
  readonly uiIntentJournalVersion:
    | "crewon.plugin-ui-intent-journal.v1"
    | undefined;
  readonly uiIntentJournalReadVersion:
    | "crewon.plugin-ui-intent-journal-read.v1"
    | undefined;
  /** Created once by explicit migration, persisted with the database; never caller-derived. */
  readonly uiIntentJournalRealmId: string | undefined;
  stageUiIntent(
    input: Readonly<{
      account: PluginUiIntentJournalAccount;
      sourcePin: PluginTaskAdmissionPin;
      requestJson: string;
      at: string;
    }>,
    options: PluginUiIntentJournalWriteOptions,
  ): Promise<
    Readonly<{
      disposition: "created" | "replayed";
      intent: PluginUiIntentRecord;
    }>
  >;
  listUiIntentHints(
    input: Readonly<{ account: PluginUiIntentJournalAccount }>,
  ): Promise<readonly PluginUiIntentRecord[]>;
  markUiIntentDispatched(
    input: Readonly<{
      account: PluginUiIntentJournalAccount;
      intentId: string;
      sourcePin: PluginTaskAdmissionPin;
      requestJson: string;
      at: string;
    }>,
    options: PluginUiIntentJournalWriteOptions,
  ): Promise<
    Readonly<{ intent: PluginUiIntentRecord; dispatchAttemptCount: number }>
  >;
  /** Private trusted original business-owner completion, never a browser phase/receipt update endpoint. */
  confirmUiIntentAccepted(
    input: Readonly<{
      account: PluginUiIntentJournalAccount;
      intentId: string;
      requestDigest: string;
      receiptJson: string;
      at: string;
    }>,
  ): Promise<PluginUiIntentRecord>;
  refuseUiIntentFirstDispatch(
    input: Readonly<{
      account: PluginUiIntentJournalAccount;
      intentId: string;
      requestDigest: string;
      expectedDispatchAttemptCount: 1;
      reasonCode: string;
      at: string;
    }>,
  ): Promise<PluginUiIntentRecord>;
}
