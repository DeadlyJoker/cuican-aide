import type { PluginProjectAssetUiClient } from "../project-assets-v2-service";
import type { ProjectAssetRecoveryIntent } from "../project-asset-recovery-v2-service";
import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import type { AssetSnapshot } from "./ProjectAssetController.types";
import { readAssetDraftScript } from "./ProjectAssetDraftSources";

/** Cold recovery is read-only and retains the exact request for an explicit retry. */
export async function reviewAssetRecovery(
  input: Readonly<{
    record: ProjectAssetRecoveryIntent;
    client: PluginProjectAssetUiClient;
    texts: Pick<PluginProjectTextUiClient, "getArtifact" | "getRevision">;
    signal: AbortSignal;
    isCurrent(): boolean;
    readAsset(assetId: string, contentRevision?: number): Promise<void>;
    publish(patch: Partial<AssetSnapshot>): void;
  }>,
) {
  const { record } = input,
    projectId = record.request.input.projectId;
  const original = record.request;
  const assetId =
    record.phase === "accepted"
      ? record.confirmed.assetId
      : original.input.assetId;
  let reference = null;
  if (
    record.phase === "accepted" &&
    record.confirmed.referenceRevision !== null
  ) {
    const result = await input.client.getReferenceRevision(
      {
        projectId,
        assetId: record.confirmed.assetId,
        referenceRevision: record.confirmed.referenceRevision,
      },
      { signal: input.signal },
    );
    if (!input.isCurrent()) return;
    reference = result.referenceRevision;
  }
  if (assetId !== null)
    await input.readAsset(
      assetId,
      record.phase === "accepted"
        ? (record.confirmed.contentRevision ??
            reference?.assetContentRevision ??
            undefined)
        : undefined,
    );
  if (!input.isCurrent()) return;
  if (original.action === "crewon.project-assets.v2.saveCandidate") {
    const script = await readAssetDraftScript({
      texts: input.texts,
      projectId,
      source: original.input.request.script,
      signal: input.signal,
    });
    if (!input.isCurrent()) return;
    input.publish({
      draft: {
        kind: original.input.request.kind,
        briefRevision: original.input.request.briefRevision,
        script,
        content: { ...original.input.request.content },
      },
      dirty: record.phase === "cancelled",
      ...(assetId === null
        ? { view: null, content: null, history: [], references: [] }
        : {}),
    });
  }
  input.publish({
    ...(reference ? { references: [reference] } : {}),
    phase: "ready",
    pending: record.phase === "pending" ? structuredClone(original) : null,
    presentedRecovery: `${record.intentId}:${record.revision}`,
    notice:
      record.phase === "accepted"
        ? "已找回原保存结果；这是历史回执，当前选用以重新读取的状态为准。"
        : record.phase === "cancelled"
          ? "原请求已取消，草稿保留。核对后可按当前版本继续编辑。"
          : "已找回原请求，请核对后用原请求重试。",
  });
}
