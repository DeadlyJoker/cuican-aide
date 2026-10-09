import type {
  ProjectConversationCommitAuthority,
  ProjectAssetStageCommitAuthority,
  ProjectMediaInputStageCommitAuthority,
} from "@crewon/application";
type Stage = Readonly<{
  authority:
    | ProjectConversationCommitAuthority
    | ProjectAssetStageCommitAuthority
    | ProjectMediaInputStageCommitAuthority;
}> | null;
/** Retains each original authority's order and same-connection transaction hook. */
export async function assertProjectStageTurnCurrent(
  stages: readonly Stage[],
  phase: "before" | "before-sqlite-transaction",
) {
  for (const stage of stages) {
    if (stage === null) continue;
    await stage.authority.assertCurrent();
    if (phase === "before-sqlite-transaction")
      await stage.authority.assertTransactionCurrent();
    stage.authority.assertActive();
  }
}
