import type { PoolClient } from "pg";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnResult,
  CommitTurnStartInput,
  CommitTurnStartResult,
  ExtensionMutationReceipt,
} from "@crewon/application";
import type { ExtensionCompositionAdmissionOptions } from "./plugin-query-run-composition-store-support.ts";
import type { ExtensionScope, ExtensionCreditAdmission } from "@crewon/domain";
export type PostgresExtensionTurnHost = Readonly<{
  projectMediaGenerationsEnabled: boolean;
  schema: string;
  unmeteredEnabled: boolean;
  projectGenerationsEnabled: boolean;
  projectQueriesEnabled: boolean;
  projectHistoricalQueriesEnabled: boolean;
  assertOpen(): void;
  transaction(
    scope: ExtensionScope,
    body: (client: PoolClient) => Promise<CommitExtensionTurnResult>,
    options: { beforeCommit(): void },
  ): Promise<CommitExtensionTurnResult>;
  receipt(
    client: PoolClient,
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
  ): Promise<unknown | null>;
  saveReceipt(
    client: PoolClient,
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
    result: unknown,
  ): Promise<void>;
  assertCreditLink(
    client: PoolClient,
    admission: ExtensionCreditAdmission | undefined,
  ): Promise<void>;
  admit(
    client: PoolClient,
    scope: CommitExtensionTurnInput["binding"],
    expectedRevision: number,
    options: ExtensionCompositionAdmissionOptions,
  ): Promise<void>;
  commitTurn(
    client: PoolClient,
    input: CommitTurnStartInput,
  ): Promise<CommitTurnStartResult>;
}>;
