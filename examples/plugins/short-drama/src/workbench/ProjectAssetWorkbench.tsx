import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ProjectAssetController } from "./ProjectAssetController";
import type { ConceptImageSelectionController } from "./ConceptImageSelectionController";
import type { ProjectDetails } from "./creative-project-controller";
import type { ProjectAssetKind } from "../project-assets-v2-service";
import type { ConceptController } from "./ConceptController";
import { ProjectAssetConceptActions } from "./ProjectAssetConceptActions";
const labels: Record<ProjectAssetKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
};

/** This plugin's shared assets use the existing module's forms and theme. */
export function ProjectAssetWorkbench({
  controller,
  page,
  onPageChange,
  images,
  details,
  blocked,
  concepts,
  onOpenConcept,
}: {
  controller: ProjectAssetController;
  page: "characters" | "art";
  onPageChange(page: "characters" | "art"): void;
  images: ConceptImageSelectionController;
  details: ProjectDetails;
  blocked: boolean;
  concepts: ConceptController;
  onOpenConcept(): void;
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
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setEditing(false);
  }, [details.project.projectId, view?.asset.assetId]);
  const editorVisible = editing || state.dirty || !content;
  useEffect(() => {
    if (editing) nameInput.current?.focus();
  }, [editing]);
  const knownRevisions = [
    content,
    view?.selectedContentRevision,
    ...state.history,
  ].filter((revision) => revision !== null && revision !== undefined);
  const knownNames = new Map(
    state.assets.map((asset) => [
      asset.assetId,
      knownRevisions.find(
        (revision) =>
          revision.assetId === asset.assetId &&
          revision.contentRevision ===
            (asset.selectedContentRevision ?? asset.latestContentRevision),
      )?.content.name,
    ]),
  );
  const matchesPage = (kind: ProjectAssetKind) =>
    page === "characters" ? kind === "character" : kind !== "character";
  const visibleAssets = state.assets.filter((asset) => matchesPage(asset.kind));
  const otherDraft = Boolean(
    draft &&
      !matchesPage(draft.kind) &&
      state.dirty &&
      Object.values(draft.content).some((value) => value.length > 0),
  );
  const choice = imageState.phase === "ready" ? imageState.current : null;
  const reference = choice?.current;
  const sameProjectImage =
    reference?.reference.projectId === details.project.projectId;
  return (
    <section className="text-editor" aria-label="共享资产">
      <div className="panel-heading">
        <h2>{page === "characters" ? "角色" : "美术 · 场景与道具"}</h2>
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
        {(Object.keys(labels) as ProjectAssetKind[])
          .filter(matchesPage)
          .map((kind) => (
            <button
              key={kind}
              className="button secondary"
              disabled={!editable || otherDraft}
              onClick={() => controller.newAsset(kind)}
            >
              新建{labels[kind]}
            </button>
          ))}
      </div>
      <div className="detail-actions" aria-label="资产列表">
        {visibleAssets.map((asset, index) => (
          <button
            key={asset.assetId}
            className="button secondary"
            disabled={!readable || otherDraft}
            aria-pressed={view?.asset.assetId === asset.assetId}
            onClick={() => void controller.open(asset.assetId)}
          >
            {knownNames.get(asset.assetId) ??
              `${labels[asset.kind]} ${index + 1}`}{" "}
            ·{" "}
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
      {otherDraft && draft && (
        <p className="detail-note" role="status">
          另一个页面有未保存的{labels[draft.kind]}设定。
          <button
            className="text-button"
            onClick={() =>
              onPageChange(draft.kind === "character" ? "characters" : "art")
            }
          >
            返回继续编辑
          </button>
          先保存该候选，再创建或打开其他资产。
        </p>
      )}
      {state.phase === "ready" && visibleAssets.length === 0 && (
        <p className="detail-note">
          已加载资产中暂无{page === "characters" ? "角色" : "场景或道具"}。
          {state.nextAssetId !== null
            ? "可继续加载更多资产。"
            : "可以新建设定，或让项目 Agent 帮你创作。"}
        </p>
      )}
      {content && matchesPage(content.kind) && (
        <article className="drama-output-document" aria-label="资产正文">
          <div className="panel-heading">
            <h3>{content.content.name}</h3>
            <span className="version-chip">
              {view?.asset.selectedContentRevision === content.contentRevision
                ? "已采用"
                : "待确认"}{" "}
              · v{content.contentRevision}
            </span>
            <button
              className="button secondary"
              disabled={!editable || editorVisible}
              aria-expanded={editorVisible}
              aria-controls={editorId}
              onClick={() => {
                setEditing(true);
              }}
            >
              编辑设定
            </button>
          </div>
          <p className="drama-readable-text">{content.content.setting}</p>
          {content.content.visualPrompt && (
            <>
              <h4>画面描述</h4>
              <p className="drama-readable-text">
                {content.content.visualPrompt}
              </p>
            </>
          )}
        </article>
      )}
      {draft && matchesPage(draft.kind) && (
        <>
          <section
            id={editorId}
            className="brief-panel text-editor"
            aria-label="资产设定"
            hidden={!editorVisible}
            style={{ display: editorVisible ? undefined : "none" }}
          >
            <div className="panel-heading">
              <h3>{labels[draft.kind]}设定</h3>
              <span className="version-chip">
                {content ? `候选 v${content.contentRevision}` : "新资产"}
              </span>
            </div>
            <label className="form-field">
              名称
              <input
                ref={nameInput}
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
            </div>
          </section>
          {view && (
            <section className="detail-panel" aria-label="设定与参考图采用">
              <div className="detail-actions">
                {content && (
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
                <button
                  className="button secondary"
                  disabled={!editable}
                  onClick={() => void controller.setLocked()}
                >
                  {view.asset.locked ? "解除资产锁定" : "锁定选用版本"}
                </button>
              </div>
              <ProjectAssetConceptActions
                assets={controller}
                concepts={concepts}
                details={details}
                blocked={blocked}
                onOpen={onOpenConcept}
              />
              <h3>参考图</h3>
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
                {view.referenceState === "stale" && " · 设定已改变，请重新确认"}
              </p>
              {view.selectedReferenceRevision && (
                <p className="detail-note">
                  {view.selectedReferenceRevision.source.kind === "media-result"
                    ? "角色四视图"
                    : "概念图"}
                  {" · "}结果{" "}
                  {view.selectedReferenceRevision.source.resultIndex + 1}
                  {" · "}设定 v
                  {view.selectedReferenceRevision.assetContentRevision}
                </p>
              )}
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
                      !editable || state.dirty || !view.selectedContentRevision
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
              {!sameProjectImage && !view.selectedReferenceRevision && (
                <p className="detail-note">
                  先探索并选用一张概念图，再关联为这项设定的参考图。
                </p>
              )}
            </section>
          )}
          <details className="drama-secondary-disclosure">
            <summary>来源与输入</summary>
            <section
              className="detail-panel text-editor"
              aria-label="资产来源与参考图"
            >
              <h3>来源</h3>
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
            </section>
          </details>
        </>
      )}
      {draft && matchesPage(draft.kind) && view && (
        <details className="drama-secondary-disclosure">
          <summary>设定与参考图历史</summary>
          <button
            className="text-button"
            disabled={!readable}
            onClick={() => void controller.loadHistory()}
          >
            读取设定与参考图历史
          </button>
          <div className="detail-actions" aria-label="资产设定历史">
            {state.history.map((revision) => (
              <button
                className="button secondary"
                key={revision.contentRevision}
                disabled={!readable}
                onClick={() =>
                  void controller.open(
                    revision.assetId,
                    revision.contentRevision,
                  )
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
                  {revision.source.kind === "media-result"
                    ? `角色四视图 · 输入 v${revision.source.inputRevision}`
                    : revision.source.pluginVersion}
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
        </details>
      )}
    </section>
  );
}
