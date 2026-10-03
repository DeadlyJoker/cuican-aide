import { useSyncExternalStore } from "react";
import { Image, Plus } from "lucide-react";
import type { ConceptController } from "./ConceptController";
import { ConceptEditor } from "./ConceptEditor";
import type { ProjectDetails } from "./creative-project-controller";

/** Shows persisted inputs and immutable history; no generation or selected-result records. */
export function ConceptWorkbench({
  controller,
  details,
  blocked,
}: {
  controller: ConceptController;
  details: ProjectDetails;
  blocked: boolean;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const archived = details.project.state === "archived";
  const locked = blocked || controller.locked;
  return (
    <section className="concept-panel" aria-label="概念输入">
      <div className="panel-heading">
        <h2>
          <Image size={17} />
          概念图
        </h2>
        {!snapshot.draft && (
          <button
            className="text-button"
            disabled={locked || archived || snapshot.opening}
            onClick={() => controller.startNew()}
          >
            <Plus size={14} />
            新建概念输入
          </button>
        )}
      </div>
      {snapshot.opening && (
        <p className="detail-note" role="status">
          正在读取概念修订…
        </p>
      )}
      {snapshot.draft ? (
        <ConceptEditor
          controller={controller}
          snapshot={snapshot}
          details={details}
          blocked={blocked}
        />
      ) : (
        <>
          {snapshot.phase === "loading" && (
            <p className="detail-note" role="status">
              正在读取概念列表…
            </p>
          )}
          {snapshot.assets.map((asset) => (
            <button
              className="version-card"
              key={asset.assetId}
              disabled={locked || snapshot.opening}
              onClick={() => void controller.openAsset(asset.assetId)}
            >
              <strong>{asset.name}</strong>
              <span>输入 v{asset.latestAssetRevision}</span>
            </button>
          ))}
          {snapshot.phase === "ready" &&
            snapshot.assets.length === 0 &&
            !snapshot.opening && (
              <div className="empty-state">
                <Image size={32} />
                <h2>还没有概念输入</h2>
                <p>把画面描述保存下来，逐步积累不同修订。</p>
              </div>
            )}
          {snapshot.nextAfterAssetId !== null && (
            <button
              className="button secondary"
              disabled={locked || snapshot.phase === "loading"}
              onClick={() => void controller.loadAssets(true)}
            >
              加载更多概念
            </button>
          )}
          {snapshot.phase === "unavailable" && (
            <button
              className="button secondary"
              disabled={locked}
              onClick={() => void controller.loadAssets()}
            >
              重新读取概念列表
            </button>
          )}
        </>
      )}
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.failure === "uncertain" && (
        <button
          className="button secondary"
          disabled={snapshot.saving || blocked}
          onClick={() => void controller.retry()}
        >
          重试原概念请求
        </button>
      )}
      {snapshot.failure === "conflict" && (
        <div className="detail-actions">
          {!snapshot.conflictRefreshed ? (
            <button
              className="button secondary"
              disabled={snapshot.opening || blocked}
              onClick={() => void controller.refreshConflict()}
            >
              重新读取概念版本
            </button>
          ) : (
            <button
              className="button primary"
              disabled={blocked || !controller.canSave}
              onClick={() => void controller.save()}
            >
              按最新版本保存概念修订
            </button>
          )}
          <button
            className="text-button"
            disabled={snapshot.saving || snapshot.opening}
            onClick={() => controller.dismissConflict()}
          >
            取消本次保存，保留草稿
          </button>
        </div>
      )}
      {snapshot.notice && (
        <p className="detail-note" role="status">
          {snapshot.notice}
        </p>
      )}
      {snapshot.loadingHistory && (
        <p className="detail-note" role="status">
          正在读取概念历史…
        </p>
      )}
      {snapshot.revisions.map((revision) => (
        <div className="version-card" key={revision.assetRevision}>
          <strong>
            输入 v{revision.assetRevision} · 需求 v{revision.briefRevision}
            {revision.briefRevision !== details.project.latestBriefRevision
              ? " · 旧需求"
              : ""}
          </strong>
          <p style={{ whiteSpace: "pre-wrap" }}>{revision.prompt}</p>
          <button
            className="text-button"
            disabled={locked || snapshot.opening}
            onClick={() =>
              void controller.openAsset(
                revision.assetId,
                revision.assetRevision,
              )
            }
          >
            查看修订 v{revision.assetRevision}
          </button>
        </div>
      ))}
      {snapshot.nextAfterAssetRevision !== null && (
        <button
          className="button secondary"
          disabled={locked || snapshot.loadingHistory}
          onClick={() => void controller.loadHistory(true)}
        >
          加载更多输入修订
        </button>
      )}
      <p className="detail-note">
        这里只保存概念描述和来源需求，尚无生成图片。
      </p>
    </section>
  );
}
