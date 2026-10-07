import { parseProjectAssetV2WriteRequest } from "@crewon/contracts/project-asset-recovery-v2";
import { parseProjectAssetUiIntentScope } from "@crewon/domain";
import type {
  ProjectAssetCommitAuthority,
  ProjectAssetMutationIdentity,
  ProjectAssetMutationResult,
} from "@crewon/application";
import {
  beginAssetVtwoRecoveryCommit,
  assetVtwoReceiptLock,
  acceptAssetVtwoRecovery,
} from "./project-asset-vtwo-recovery-plan.ts";
import {
  assetReceipt,
  type AssetDialect,
  type AssetSql,
  type AssetRows,
} from "./project-asset-store-support.ts";
import { beginAssetIntentCommit } from "./project-asset-ui-intent-plan.ts";
import { verifyProjectAssetMutationReference } from "./project-asset-reference-proof-plan.ts";
import type { ProjectGenerationImageResultVerifier } from "@crewon/application";
export type AssetCommitPlan<T> = Generator<
  | AssetSql
  | Readonly<{ assetVtwoRecoverySchema: "optional" }>
  | Readonly<{ mediaOperationSchema: true }>
  | Readonly<{ mediaResultSchema: true }>,
  T,
  AssetRows
>;
export function* beginAssetVtwoMutation(
  d: AssetDialect,
  identity: ProjectAssetMutationIdentity,
  authority: ProjectAssetCommitAuthority | undefined,
) {
  const tx = authority?.uiTransaction;
  const v2 = tx?.version === "crewon.project-asset-plugin-commit.v2";
  return yield* beginAssetVtwoRecoveryCommit(
    d,
    identity,
    tx?.v2RecoveryRef,
    v2
      ? parseProjectAssetUiIntentScope({
          actor: tx.actor,
          installation: tx.installation,
          contributionId: tx.contributionId,
        })
      : undefined,
    v2
      ? parseProjectAssetV2WriteRequest({
          action: tx.actionId,
          input: tx.input,
        })
      : undefined,
  );
}
/** Receipt lookup is a commit path too: cancellation and recovery fencing also apply to replays. */
export function* loadAssetMutationReceiptPlan(
  d: AssetDialect,
  identity: ProjectAssetMutationIdentity,
  authority: ProjectAssetCommitAuthority | undefined,
  verifier: ProjectGenerationImageResultVerifier | undefined,
  journalAvailable: boolean,
): AssetCommitPlan<ProjectAssetMutationResult | null> {
  yield* assetVtwoReceiptLock(d, identity);
  yield* beginAssetIntentCommit(
    d,
    journalAvailable,
    authority?.uiTransaction,
    identity,
  );
  const intent = yield* beginAssetVtwoMutation(d, identity, authority);
  const result = yield* assetReceipt(d, identity);
  if (result?.referenceRevision)
    yield* verifyProjectAssetMutationReference(
      d,
      identity.actor,
      result.referenceRevision,
      verifier,
      authority,
    );
  if (result) yield* acceptAssetVtwoRecovery(d, intent, result.asset.updatedAt);
  return result;
}
