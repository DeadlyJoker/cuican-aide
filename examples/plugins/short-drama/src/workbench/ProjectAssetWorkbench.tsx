import { useSyncExternalStore } from "react";
import { ProjectAssetController } from "./ProjectAssetController";
import type { ConceptImageSelectionController } from "./ConceptImageSelectionController";
import type { ProjectDetails } from "./creative-project-controller";
import type { ProjectAssetKind } from "../project-assets-service";
const labels: Record<ProjectAssetKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
};

/** This plugin's shared assets use the existing module's forms and theme. */
export function ProjectAssetWorkbench({
  controller,
  images,
  details,
  blocked,
}: {
  controller: ProjectAssetController;
  images: ConceptImageSelectionController;
  details: ProjectDetails;
  blocked: boolean;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const imageState = useSyncExternalStore(
    images.subscribe,
    images.getSnapshot,
    images.getSnapshot,
  );
  const editable = controller.canEdit && !blocked;
  const readable = controller.canRead && !blocked;
  const { draft, view, content } = state;
  const choice = imageState.phase === "ready" ? imageState.current : null;
  const reference = choice?.current;
  const sameProjectImage =
    reference?.reference.projectId === details.project.projectId;
  return (
    <section className="text-editor" aria-label="共享资产">
      <div className="panel-heading">
        <h2>角色、场景与道具</h2>
        <button
          className="text-button"
          disabled={state.saving || blocked}
          onClick={() => void controller.refresh()}
        >
          刷新资产
        </button>
      </div>
      <p className="detail-note">
        设定与参考图分别保存版本。先确认设定，再选用参考图；后续分镜引用明确的版本。
      </p>
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
      {state.pending && (
        <button
          className="button secondary"
          disabled={state.saving || blocked}
          onClick={() => void controller.retry()}
        >
          用原请求重试
        </button>
      )}
      {state.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取共享资产…
        </p>
      )}
      <div className="detail-actions">
        {(Object.keys(labels) as ProjectAssetKind[]).map((kind) => (
          <button
            key={kind}
            className="button secondary"
            disabled={!editable}
            onClick={() => controller.newAsset(kind)}
          >
            新建{labels[kind]}
          </button>
        ))}
      </div>
      <div className="detail-actions" aria-label="资产列表">
        {state.assets.map((asset) => (
          <button
            key={asset.assetId}
            className="button secondary"
            disabled={!readable}
            aria-pressed={view?.asset.assetId === asset.assetId}
            onClick={() => void controller.open(asset.assetId)}
          >
            {labels[asset.kind]} · {asset.assetId.slice(0, 8)} ·{" "}
            {asset.selectedContentRevision
              ? `选用 v${asset.selectedContentRevision}`
              : "未选用"}
          </button>
        ))}
        {state.nextAssetId !== null && (
          <button
            className="text-button"
            disabled={!readable}
            onClick={() => void controller.refresh({ more: true })}
          >
            更多资产
          </button>
        )}
      </div>
      {draft && (
        <div className="concept-grid">
          <section className="brief-panel text-editor" aria-label="资产设定">
            <div className="panel-heading">
              <h3>{labels[draft.kind]}设定</h3>
              <span className="version-chip">
                {content ? `候选 v${content.contentRevision}` : "新资产"}
              </span>
            </div>
            <label className="form-field">
              名称
              <input
                aria-label="资产名称"
                value={draft.content.name}
                disabled={!editable}
                onChange={(event) =>
                  controller.setDraft({
                    ...draft.content,
                    name: event.target.value,
                  })
                }
              />
            </label>
            <label className="form-field">
              设定
              <textarea
                aria-label="资产设定"
                value={draft.content.setting}
                disabled={!editable}
                placeholder="角色的外貌、性格与关系；场景的环境与光线；道具的外形与用途。"
                onChange={(event) =>
                  controller.setDraft({
                    ...draft.content,
                    setting: event.target.value,
                  })
                }
              />
            </label>
            <label className="form-field">
              画面描述
              <textarea
                aria-label="资产画面描述"
                value={draft.content.visualPrompt}
                disabled={!editable}
                onChange={(event) =>
                  controller.setDraft({
                    ...draft.content,
                    visualPrompt: event.target.value,
                  })
                }
              />
            </label>
            <p className="detail-note">
              画面描述{" "}
              {new TextEncoder().encode(draft.content.visualPrompt).byteLength}{" "}
              / 2,000 字节
            </p>
            <div className="detail-actions">
              <button
                className="button primary"
                disabled={!editable || !controller.canSave}
                onClick={() => void controller.save()}
              >
                {state.saving ? "正在保存…" : "保存设定候选"}
              </button>
              {view && content && (
                <button
                  className="button secondary"
                  disabled={
                    !editable ||
                    state.dirty ||
                    view.asset.locked ||
                    view.asset.selectedContentRevision ===
                      content.contentRevision
                  }
                  onClick={() => void controller.selectContent()}
                >
                  选用这版设定
                </button>
              )}
              {view && (
                <button
                  className="button secondary"
                  disabled={!editable}
                  onClick={() => void controller.setLocked()}
                >
                  {view.asset.locked ? "解除资产锁定" : "锁定选用版本"}
                </button>
              )}
            </div>
          </section>
          <section
            className="detail-panel text-editor"
            aria-label="资产来源与参考图"
          >
            <h3>来源与选用</h3>
            <p className="detail-note">
              需求 v{draft.briefRevision}
              {draft.briefRevision !== details.brief.briefRevision &&
                " · 旧需求"}
            </p>
            {draft.briefRevision !== details.brief.briefRevision && (
              <button
                className="text-button"
                disabled={!editable}
                onClick={() => controller.useCurrentBrief()}
              >
                改用当前需求，保留设定草稿
              </button>
            )}
            <label className="form-field">
              剧本来源
              <select
                aria-label="资产剧本来源"
                value={draft.script?.artifactId ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  controller.setScript(event.target.value || null)
                }
              >
                <option value="">仅创作需求</option>
                {draft.script &&
                  !state.scripts.some(
                    (item) => item.artifactId === draft.script!.artifactId,
                  ) && (
                    <option value={draft.script.artifactId}>
                      {draft.script.title} · v{draft.script.contentRevision}
                    </option>
                  )}
                {state.scripts.map((source) => (
                  <option key={source.artifactId} value={source.artifactId}>
                    {source.title} · v{source.contentRevision}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="text-button"
              disabled={!readable}
              onClick={() => void controller.loadScripts()}
            >
              读取已选用剧本
            </button>
            {state.nextScriptArtifactId !== null && (
              <button
                className="text-button"
                disabled={!readable}
                onClick={() => void controller.loadScripts({ more: true })}
              >
                读取更多剧本
              </button>
            )}
            {view && (
              <>
                <p className="detail-note">
                  设定：
                  {view.asset.selectedContentRevision
                    ? `选用 v${view.asset.selectedContentRevision}`
                    : "未选用"}
                  {view.dependencyState === "stale" &&
                    " · 来源已改变，请重新确认"}
                  {view.asset.locked && " · 已锁定"}
                </p>
                <p className="detail-note">
                  参考图：
                  {view.asset.selectedReferenceRevision
                    ? `选用 v${view.asset.selectedReferenceRevision}`
                    : "未选用"}
                  {view.referenceState === "stale" &&
                    " · 设定已改变，请重新确认"}
                </p>
                {sameProjectImage && reference && choice && (
                  <div className="version-card">
                    <strong>
                      当前概念图选用 · 结果 {reference.resultIndex + 1}
                    </strong>
                    <p className="detail-note">
                      此图将关联到已选用设定 v
                      {view.asset.selectedContentRevision ?? "—"}。
                    </p>
                    <button
                      className="button secondary"
                      disabled={
                        !editable ||
                        state.dirty ||
                        !view.selectedContentRevision
                      }
                      onClick={() =>
                        void controller.attachReference({
                          conceptAssetId: reference.reference.assetId,
                          selectionRevision: choice.selectionRevision,
                        })
                      }
                    >
                      保存为参考图候选
                    </button>
                  </div>
                )}
                {!sameProjectImage && (
                  <p className="detail-note">
                    先在“项目与概念图”中选用一张项目图片，再回来关联参考图。
                  </p>
                )}
                <button
                  className="text-button"
                  disabled={!readable}
                  onClick={() => void controller.loadHistory()}
                >
                  读取设定与参考图历史
                </button>
              </>
            )}
          </section>
        </div>
      )}
      <div className="detail-actions" aria-label="资产设定历史">
        {state.history.map((revision) => (
          <button
            className="button secondary"
            key={revision.contentRevision}
            disabled={!readable}
            onClick={() =>
              void controller.open(revision.assetId, revision.contentRevision)
            }
          >
            设定 v{revision.contentRevision} · {revision.content.name}
          </button>
        ))}
      </div>
      <div className="detail-actions" aria-label="资产参考图历史">
        {state.references.map((revision) => (
          <div className="version-card" key={revision.referenceRevision}>
            <strong>
              参考图 v{revision.referenceRevision} · 设定 v
              {revision.assetContentRevision}
            </strong>
            <p className="detail-note">
              原图结果 {revision.source.resultIndex + 1} ·{" "}
              {revision.source.pluginVersion}
            </p>
            <button
              className="button secondary"
              disabled={
                !editable ||
                view?.asset.locked ||
                view?.asset.selectedContentRevision !==
                  revision.assetContentRevision ||
                view?.asset.selectedReferenceRevision ===
                  revision.referenceRevision
              }
              onClick={() =>
                void controller.selectReference(revision.referenceRevision)
              }
            >
              选用这版参考图
            </button>
          </div>
        ))}
      </div>
      {(state.nextContentRevision !== null ||
        state.nextReferenceRevision !== null) && (
        <button
          className="text-button"
          disabled={!readable}
          onClick={() => void controller.loadHistory({ more: true })}
        >
          更多历史版本
        </button>
      )}
    </section>
  );
}
