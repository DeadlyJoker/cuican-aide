import type { RefObject } from "react";
import { Sparkles, X } from "lucide-react";
import type {
  ConceptPreview,
  DramaProjectPreview,
} from "./short-drama-preview-data";
import { Status, stateName } from "./ShortDramaPreviewPresentation";

export type ShortDramaPreviewDialog =
  | "new"
  | "brief-history"
  | "record"
  | "settings"
  | null;

/** Pure dialog content. The parent owns native-dialog lifetime and demo state. */
export function ShortDramaPreviewDialogs({
  dialog,
  dialogRef,
  project,
  concept,
  newTitle,
  newBrief,
  onTitleChange,
  onBriefChange,
  onCreate,
  onClose,
}: {
  dialog: ShortDramaPreviewDialog;
  dialogRef: RefObject<HTMLDialogElement | null>;
  project: DramaProjectPreview;
  concept: ConceptPreview | null;
  newTitle: string;
  newBrief: string;
  onTitleChange(value: string): void;
  onBriefChange(value: string): void;
  onCreate(): void;
  onClose(): void;
}) {
  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby="drama-modal-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <h2 id="drama-modal-title">
          {dialog === "new"
            ? "新的创作项目"
            : dialog === "brief-history"
              ? "需求版本"
              : dialog === "record"
                ? "生成记录"
                : "生成服务设置"}
        </h2>
        <button
          className="button icon"
          aria-label="关闭弹窗"
          onClick={() => onClose()}
        >
          <X size={18} />
        </button>
      </div>
      {dialog === "new" ? (
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate();
          }}
        >
          <p className="subtle">先留住故事，再慢慢找到它的画面。</p>
          <label className="form-field">
            项目名称
            <input
              autoFocus
              maxLength={160}
              required
              value={newTitle}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="给这个故事起个名字"
            />
          </label>
          <label className="form-field">
            创作需求
            <textarea
              required
              maxLength={8192}
              value={newBrief}
              onChange={(event) => onBriefChange(event.target.value)}
              placeholder="故事讲什么？想让观众感受到什么？"
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => onClose()}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={!newTitle.trim() || !newBrief.trim()}
            >
              创建项目
            </button>
          </div>
        </form>
      ) : dialog === "brief-history" ? (
        <div className="modal-form">
          {[...project.briefs].reverse().map((text, index) => (
            <div className="version-card" key={project.briefs.length - index}>
              <strong>
                需求 v{project.briefs.length - index}
                {index === 0 && <span>当前版本</span>}
              </strong>
              <p>{text}</p>
            </div>
          ))}
        </div>
      ) : dialog === "record" && concept ? (
        <div className="modal-form">
          <p className="subtle">演示记录 · 不代表新的真实供应商任务</p>
          <div className="status-stack">
            <Status label="来源需求" value={`v${concept.briefVersion}`} />
            <Status label="概念图修订" value={`v${concept.version}`} />
            <Status label="CrewON 调用" value="已结束" />
            <Status
              label="外部生成"
              value={stateName(concept.state)}
              positive={concept.state === "succeeded"}
            />
          </div>
          <div className="version-card">
            <strong>确认的生成描述</strong>
            <p>{concept.prompt}</p>
          </div>
          <p className="subtle">
            图片展示为已有测试样例，不是本次演示生成的结果。
          </p>
        </div>
      ) : dialog === "settings" ? (
        <div className="modal-form">
          <div className="service-heading">
            <span className="service-icon">
              <Sparkles size={22} />
            </span>
            <span>
              <strong>Krea2 文生图</strong>
              <small>ComfyUI · 外部生成能力</small>
            </span>
            <span className="preview-tag">预览模式</span>
          </div>
          <p>
            创作页面只需要确认输入；服务地址、配置和执行 Agent 在这里单独管理。
          </p>
          <div className="version-card">
            <Status label="页面连接" value="演示数据" />
            <Status label="实际生图" value="本预览不会调用" />
          </div>
          <p className="subtle">
            正式配置与启用继续使用现有业务插件入口。此处仅预览工作台的服务设置位置。
          </p>
        </div>
      ) : null}
    </dialog>
  );
}
