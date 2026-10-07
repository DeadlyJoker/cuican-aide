import { useSyncExternalStore } from "react";
import type { ProjectAssetController } from "./ProjectAssetController";
import type { CreativeProjectController } from "./creative-project-controller";

/** Cross-project recovery remains visible before opening any project. */
export function ProjectAssetRecoveryActions({
  assets,
  projects,
  onRestore,
}: {
  assets: ProjectAssetController;
  projects: CreativeProjectController;
  onRestore(): void;
}) {
  const state = useSyncExternalStore(
    assets.subscribe,
    assets.getSnapshot,
    assets.getSnapshot,
  );
  const recovery = useSyncExternalStore(
    assets.recovery.subscribe,
    assets.recovery.getSnapshot,
    assets.recovery.getSnapshot,
  );
  const record = recovery.intent;
  if (!assets.activated)
    return (
      <button className="text-button" onClick={() => assets.activate()}>
        检查资产保存记录
      </button>
    );
  if (recovery.phase === "ready" && !record) return null;
  const presented =
    record &&
    state.presentedRecovery === `${record.intentId}:${record.revision}`;
  return (
    <section className="detail-panel" aria-label="资产保存恢复">
      <div className="panel-heading">
        <h2>资产保存记录</h2>
        <button
          className="text-button"
          disabled={
            state.saving || recovery.acknowledging || recovery.cancelling
          }
          onClick={() => void assets.recovery.check()}
        >
          重新检查保存记录
        </button>
      </div>
      {recovery.error && (
        <p className="detail-note" role="alert">
          {recovery.error}
        </p>
      )}
      {record ? (
        <>
          <p className="detail-note">
            {record.phase === "pending"
              ? "原保存结果尚未确认"
              : record.phase === "accepted"
                ? "原保存已确认"
                : "原保存已取消"}
            ，请核对后继续。
          </p>
          <div className="detail-actions">
            <button
              className="button secondary"
              disabled={
                state.saving ||
                state.opening ||
                recovery.acknowledging ||
                recovery.cancelling
              }
              onClick={() =>
                void (async () => {
                  await projects.openProject(record.request.input.projectId);
                  const details = projects.getSnapshot().details;
                  if (
                    !details ||
                    details.project.projectId !== record.request.input.projectId
                  )
                    return;
                  assets.setProject(details);
                  await assets.restoreRecovery();
                  onRestore();
                })()
              }
            >
              打开原项目并核对
            </button>
            {record.phase === "pending" && (
              <button
                className="button secondary"
                disabled={!presented || state.saving || recovery.cancelling}
                onClick={() => void assets.retry()}
              >
                用原请求重试
              </button>
            )}
            {record.phase === "pending" && (
              <button
                className="button secondary"
                disabled={
                  !presented ||
                  state.saving ||
                  state.opening ||
                  recovery.cancelling
                }
                onClick={() => void assets.cancelPendingRecovery()}
              >
                {recovery.cancelling ? "正在取消…" : "取消这次待处理操作"}
              </button>
            )}
            {record.phase !== "pending" && (
              <button
                className="button secondary"
                disabled={
                  !presented ||
                  state.saving ||
                  state.opening ||
                  recovery.acknowledging ||
                  recovery.cancelling
                }
                onClick={() => void assets.acknowledgeRecovery()}
              >
                已核对这次保存
              </button>
            )}
          </div>
          {state.error && (
            <p className="detail-note" role="alert">
              {state.error}
            </p>
          )}
          {state.notice && (
            <p className="detail-note" role="status">
              {state.notice}
            </p>
          )}
        </>
      ) : recovery.phase === "loading" || recovery.phase === "waiting" ? (
        <p className="detail-note" role="status">
          正在检查上次资产保存的结果…
        </p>
      ) : null}
    </section>
  );
}
