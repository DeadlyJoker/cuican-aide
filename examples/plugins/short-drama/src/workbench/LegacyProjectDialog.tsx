import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { usePluginDialog } from "./usePluginDialog";
import {
  briefBytes,
  validBrief,
  validTitle,
  type CreativeProjectController,
  type ProjectSnapshot,
  type ProjectDetails,
} from "./creative-project-controller";
/** Original v0 create/history dialog retained unchanged for legacy Host capability. */
export function LegacyProjectDialog({
  dialog,
  locked,
  title,
  brief,
  snapshot,
  controller,
  details,
  onClose,
  onTitleChange,
  onBriefChange,
  onCreate,
  feedback,
}: {
  dialog: "new" | "history" | null;
  locked: boolean;
  title: string;
  brief: string;
  snapshot: ProjectSnapshot;
  controller: CreativeProjectController;
  details: ProjectDetails | null;
  feedback: ReactNode;
  onClose(): void;
  onTitleChange(value: string): void;
  onBriefChange(value: string): void;
  onCreate(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  usePluginDialog(dialogRef, dialog !== null);
  return (
    <div className="drama-dialog-layer" hidden={dialog === null}>
      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby="drama-persistent-modal-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!locked) onClose();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !locked) onClose();
        }}
      >
        <div className="modal-header">
          <h2 id="drama-persistent-modal-title">
            {dialog === "new" ? "新的创作项目" : "需求版本"}
          </h2>
          <button
            className="button icon"
            aria-label="关闭弹窗"
            disabled={locked}
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
                data-dialog-autofocus
                required
                value={title}
                disabled={locked}
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="给这个故事起个名字"
              />
            </label>
            <label className="form-field">
              创作需求
              <textarea
                required
                value={brief}
                disabled={locked}
                onChange={(event) => onBriefChange(event.target.value)}
                placeholder="故事讲什么？想让观众感受到什么？"
              />
            </label>
            <p className="subtle">需求 {briefBytes(brief)} / 8,192 字节</p>
            {!validTitle(title) && Boolean(title.trim()) && (
              <p className="detail-note" role="alert">
                项目名称最多 160 个字符。
              </p>
            )}
            {briefBytes(brief) > 8192 && (
              <p className="detail-note" role="alert">
                需求超过 8,192 字节，请缩短后保存。
              </p>
            )}
            {feedback}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={locked}
                onClick={() => onClose()}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={locked || !validTitle(title) || !validBrief(brief)}
              >
                {snapshot.saving ? "正在保存…" : "创建项目"}
              </button>
            </div>
          </form>
        ) : dialog === "history" ? (
          <div className="modal-form">
            {snapshot.loadingBriefs && (
              <p className="subtle" role="status">
                正在读取需求历史…
              </p>
            )}
            {snapshot.error && (
              <p className="detail-note" role="alert">
                {snapshot.error}
              </p>
            )}
            {snapshot.briefs.map((record) => (
              <div className="version-card" key={record.briefRevision}>
                <strong>
                  需求 v{record.briefRevision}
                  {record.briefRevision ===
                    details?.project.latestBriefRevision && (
                    <span>当前版本</span>
                  )}
                </strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{record.text}</p>
              </div>
            ))}
            {snapshot.nextBriefRevision !== null && (
              <button
                className="button secondary"
                disabled={snapshot.loadingBriefs}
                onClick={() => void controller.loadBriefs(true)}
              >
                加载更多需求版本
              </button>
            )}
            {!snapshot.loadingBriefs && snapshot.error && (
              <button
                className="button secondary"
                onClick={() => void controller.loadBriefs()}
              >
                重新读取需求历史
              </button>
            )}
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
