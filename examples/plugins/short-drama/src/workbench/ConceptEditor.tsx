import type { ConceptController } from "./ConceptController";
import type { ConceptSnapshot } from "./ConceptController.types";
import type { ProjectDetails } from "./creative-project-controller";

export function ConceptEditor({
  controller,
  snapshot,
  details,
  blocked,
}: {
  controller: ConceptController;
  snapshot: ConceptSnapshot;
  details: ProjectDetails;
  blocked: boolean;
}) {
  const { draft, selection, editing } = snapshot;
  if (!draft) return null;
  const source = editing ? draft.source : selection!.source;
  const old = source.briefRevision !== details.project.latestBriefRevision;
  const archived = details.project.state === "archived";
  const locked = blocked || controller.locked || archived;
  return (
    <>
      <div className="concept-version-bar">
        <strong>
          {selection
            ? `${selection.asset.name} · 输入 v${selection.revision.assetRevision}`
            : "新的概念输入"}
        </strong>
        <button
          className="text-button"
          disabled={controller.locked}
          onClick={() => controller.close()}
        >
          返回概念列表
        </button>
      </div>
      {draft.copiedFromAsset && (
        <p className="detail-note" aria-label="概念描述起点">
          起始画面描述复制自：{draft.copiedFromAsset.name} · 已选设定 v
          {draft.copiedFromAsset.contentRevision}
          。参考图生成后仍需在资产页确认关联。
        </p>
      )}
      {editing && !selection && (
        <label className="form-field">
          概念名称
          <input
            aria-label="概念名称"
            value={draft.name}
            disabled={locked}
            onChange={(event) => controller.setName(event.target.value)}
          />
        </label>
      )}
      <p className="detail-note">
        来源：已保存需求 v{source.briefRevision}
        {old ? " · 旧需求" : " · 当前需求"}
      </p>
      <details className="version-card">
        <summary>查看来源需求 v{source.briefRevision}</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{source.text}</p>
      </details>
      <label className="visually-hidden" htmlFor="concept-prompt">
        概念描述
      </label>
      <textarea
        id="concept-prompt"
        className="description-input"
        value={editing ? draft.prompt : selection!.revision.prompt}
        readOnly={!editing}
        disabled={editing && locked}
        onChange={(event) => controller.setPrompt(event.target.value)}
      />
      <p className="detail-note">
        {(editing ? draft.prompt : selection!.revision.prompt).length} / 2,000
        字符 · 保存原始空格与换行
      </p>
      {editing && old && (
        <>
          <label className="detail-note">
            <input
              type="checkbox"
              aria-label={`确认沿用需求 v${source.briefRevision}`}
              checked={snapshot.confirmedOldBrief}
              disabled={
                blocked ||
                snapshot.saving ||
                archived ||
                (controller.locked && !snapshot.conflictRefreshed)
              }
              onChange={(event) =>
                controller.confirmOldBrief(event.target.checked)
              }
            />
            确认沿用需求 v{source.briefRevision} 保存
          </label>
          <button
            className="text-button"
            disabled={locked}
            onClick={() => controller.useLatestBrief()}
          >
            使用已保存需求 v{details.project.latestBriefRevision}
          </button>
        </>
      )}
      <div className="detail-actions">
        {editing && !snapshot.pendingKind && (
          <button
            className="button primary"
            disabled={blocked || !controller.canSave}
            onClick={() => void controller.save()}
          >
            {snapshot.saving
              ? "正在保存概念…"
              : selection
                ? "保存为新输入修订"
                : "保存概念输入"}
          </button>
        )}
        {!editing && selection && (
          <button
            className="button secondary"
            disabled={locked}
            onClick={() => controller.editRevision()}
          >
            编辑为新修订
          </button>
        )}
        {selection && (
          <button
            className="text-button"
            disabled={blocked || controller.locked || snapshot.loadingHistory}
            onClick={() => void controller.loadHistory()}
          >
            查看输入历史
          </button>
        )}
      </div>
      {draft.prompt.length > 2000 && (
        <p className="detail-note" role="alert">
          概念描述超过 2,000 字符，请缩短后保存。
        </p>
      )}
    </>
  );
}
