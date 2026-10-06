import { useSyncExternalStore } from "react";
import { ProjectMediaInputController } from "./ProjectMediaInputController";
import type {
  MediaInputRole,
  MediaInputWorkflowId,
} from "../project-media-inputs-ui-client";

export const mediaWorkflowNames: Record<MediaInputWorkflowId, string> = {
  "krea2-reference-four-view": "T10 · 角色参考四视图",
  "flux2-three-reference-storyboard": "D18 · 三素材分镜探索",
};
const roleNames: Record<MediaInputRole, string> = {
  character: "角色参考",
  scene: "场景参考",
  characterOne: "角色一",
  characterTwo: "角色二",
};

/** This module reuses the original plugin form styles; no global shell or theme changes. */
export function ProjectMediaInputWorkbench({
  controller,
  blocked,
}: {
  controller: ProjectMediaInputController;
  blocked: boolean;
}) {
  const s = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const d = s.draft,
    editable = controller.canEdit && !blocked,
    readable = controller.canRead && !blocked;
  const roles: MediaInputRole[] =
    d?.workflowId === "flux2-three-reference-storyboard"
      ? ["scene", "characterOne", "characterTwo"]
      : ["character"];
  return (
    <section
      className="text-editor media-input-workbench"
      aria-label="参考工作流确认输入"
    >
      <div className="panel-heading">
        <h2>参考图与分镜探索</h2>
        <button
          className="text-button"
          disabled={!readable}
          onClick={() => void controller.refresh()}
        >
          刷新输入与素材
        </button>
      </div>
      <p className="detail-note">
        从已采用的素材确定制作输入。这里保存描述和参考版本，生成任务随后使用这一版输入。
      </p>
      {s.error && (
        <p className="detail-note" role="alert">
          {s.error}
        </p>
      )}
      {s.notice && (
        <p className="detail-note" role="status">
          {s.notice}
        </p>
      )}
      {s.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取确认输入与已采用素材…
        </p>
      )}
      {s.phase === "unavailable" && (
        <button
          className="button secondary"
          disabled={s.reading || s.saving || blocked}
          onClick={() => void controller.refresh()}
        >
          重新连接输入服务
        </button>
      )}
      {s.pending && (
        <button
          className="button secondary"
          disabled={s.saving || blocked}
          onClick={() => void controller.retry()}
        >
          用原请求确认保存
        </button>
      )}
      <div className="detail-actions">
        {(Object.keys(mediaWorkflowNames) as MediaInputWorkflowId[]).map(
          (id) => (
            <button
              key={id}
              className="button secondary"
              disabled={!editable || !s.configuration?.workflows.includes(id)}
              onClick={() => controller.newInput(id)}
            >
              新建{mediaWorkflowNames[id]}
            </button>
          ),
        )}
      </div>
      {s.phase === "ready" && !s.configuration && (
        <p className="detail-note" role="status">
          尚未配置已审查的参考工作流，请先在原插件设置中配置。
        </p>
      )}
      <div className="detail-actions" aria-label="已保存媒体输入">
        {s.inputs.map((input) => (
          <button
            key={input.mediaInputId}
            className="button secondary"
            disabled={!readable}
            aria-pressed={s.input?.mediaInputId === input.mediaInputId}
            onClick={() => void controller.open(input.mediaInputId)}
          >
            {mediaWorkflowNames[input.workflowId]} ·{" "}
            {input.item.kind === "character-reference"
              ? (s.assets.find(
                  (a) =>
                    a.reference.assetId ===
                    (input.item.kind === "character-reference"
                      ? input.item.assetId
                      : ""),
                )?.label ?? "角色参考")
              : (s.scripts.find(
                  (script) =>
                    script.episodeId ===
                    (input.item.kind === "storyboard-frame-exploration"
                      ? input.item.episodeId
                      : ""),
                )?.label ?? "分集画面")}{" "}
            · v{input.latestInputRevision}
          </button>
        ))}
        {s.nextMediaInputId !== null && (
          <button
            className="text-button"
            disabled={!readable}
            onClick={() => void controller.refresh({ moreInputs: true })}
          >
            更多确认输入
          </button>
        )}
      </div>
      {d && (
        <div className="concept-grid">
          <section className="brief-panel" aria-label="媒体画面描述">
            <div className="panel-heading">
              <h3>{mediaWorkflowNames[d.workflowId]}</h3>
              <span className="version-chip">
                {s.input ? `输入 v${s.input.inputRevision}` : "新输入"}
              </span>
            </div>
            <label className="form-field">
              画面描述
              <textarea
                aria-label="媒体画面描述"
                value={d.prompt}
                disabled={!editable}
                onChange={(e) => controller.setPrompt(e.target.value)}
                placeholder={
                  d.workflowId === "krea2-reference-four-view"
                    ? "描述角色的正面、侧面及背面，明确要保留的外貌特征。"
                    : "描述这一集要探索的画面、人物动作、环境与构图。"
                }
              />
            </label>
            <p className="detail-note">
              {new TextEncoder().encode(d.prompt).byteLength} / 8,192 字节
            </p>
            <div className="detail-actions">
              <button
                className="button primary"
                disabled={!controller.canSave || blocked}
                onClick={() => void controller.save()}
              >
                {s.saving
                  ? "正在保存…"
                  : s.input
                    ? "保存输入新版本"
                    : "保存确认输入"}
              </button>
            </div>
            {s.input && (
              <>
                <p className="detail-note">
                  需求 v{d.briefRevision} · 输入历史最新 v
                  {s.latestInputRevision}
                </p>
                <div className="detail-actions">
                  {s.input.inputRevision > 1 && (
                    <button
                      className="text-button"
                      disabled={!readable}
                      onClick={() =>
                        void controller.open(
                          s.input!.mediaInputId,
                          s.input!.inputRevision - 1,
                        )
                      }
                    >
                      查看上一版输入
                    </button>
                  )}
                  {s.input.inputRevision !== s.latestInputRevision && (
                    <button
                      className="text-button"
                      disabled={!readable}
                      onClick={() =>
                        void controller.open(s.input!.mediaInputId)
                      }
                    >
                      返回最新输入
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
          <section className="detail-panel" aria-label="媒体输入参考来源">
            <h3>已采用来源</h3>
            {roles.map((role) => (
              <label key={role} className="form-field">
                {roleNames[role]}
                <select
                  aria-label={roleNames[role]}
                  value={d.characters[role] ?? ""}
                  disabled={!editable}
                  onChange={(e) =>
                    controller.chooseReference(role, e.target.value)
                  }
                >
                  <option value="">
                    选择已采用参考图的{role === "scene" ? "场景" : "角色"}
                  </option>
                  {s.assets
                    .filter(
                      (a) =>
                        a.reference.kind ===
                        (role === "scene" ? "scene" : "character"),
                    )
                    .map((a) => (
                      <option
                        key={a.reference.assetId}
                        value={a.reference.assetId}
                      >
                        {a.label} · 设定 v{a.reference.contentRevision} / 参考 v
                        {a.reference.referenceRevision}
                      </option>
                    ))}
                </select>
                {d.references[role] && (
                  <small>
                    本输入：设定 v{d.references[role]!.contentRevision} / 参考 v
                    {d.references[role]!.referenceRevision}
                  </small>
                )}
              </label>
            ))}
            {
              <label className="form-field">
                分集剧本
                {d.workflowId === "krea2-reference-four-view" ? "（可选）" : ""}
                <select
                  aria-label="分集剧本"
                  value={d.scriptId}
                  disabled={!editable}
                  onChange={(e) => controller.chooseScript(e.target.value)}
                >
                  <option value="">
                    {d.workflowId === "krea2-reference-four-view"
                      ? "不关联剧本"
                      : "选择已采用剧本"}
                  </option>
                  {s.scripts.map((script) => (
                    <option key={script.artifactId} value={script.artifactId}>
                      {script.label} · v{script.contentRevision}
                    </option>
                  ))}
                </select>
                {d.script && (
                  <small>本输入：剧本 v{d.script.contentRevision}</small>
                )}
              </label>
            }
            {s.nextAssetId !== null || s.nextArtifactId !== null ? (
              <button
                className="text-button"
                disabled={!readable}
                onClick={() => void controller.refresh({ moreSources: true })}
              >
                加载更多已采用素材
              </button>
            ) : null}
            <p className="detail-note">
              只提供当前需求下已采用的设定、参考图和剧本。缺少素材时，先在角色与场景或大纲与剧本中完成采用。
            </p>
            {d.workflowId === "flux2-three-reference-storyboard" && (
              <p className="detail-note">
                角色一与角色二必须不同。D18用于三素材画面探索，完整镜头表随后接入。
              </p>
            )}
            {controller.stale && (
              <p className="detail-note" role="alert">
                当前需求或配置已变化，请明确更新来源后保存。
              </p>
            )}
            <button
              className="button secondary"
              disabled={!editable}
              onClick={() => controller.useCurrentSources()}
            >
              使用当前需求和已采用版本
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
