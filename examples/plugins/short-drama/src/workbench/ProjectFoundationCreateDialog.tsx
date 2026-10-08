import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X, Upload } from "lucide-react";
import {
  parseProjectFoundationParameters,
  type ProjectFoundationSourceUpload,
  type ProjectFoundationCreationParameters,
} from "@crewon/plugin-sdk/project-foundation-ui";
import {
  ProjectCreationParametersFields,
  defaultCreationParameters,
} from "./ProjectCreationParametersFields";
import { ProjectFoundationFeedback } from "./ProjectFoundationFeedback";
import type { ProjectFoundationController } from "./ProjectFoundationController";
import { ProjectSourceFileUploadError } from "./ProjectSourceFileUpload";
import type { ProjectSourceUploadUiPort } from "./ProjectSourceUploadUiPort";
import { validTitle, validBrief } from "./creative-project-controller";
import { usePluginDialog } from "./usePluginDialog";
export type CreativeCreationDraft = Readonly<{
  title: string;
  reference: string;
  parameters: ProjectFoundationCreationParameters;
  direct: boolean;
}>;
export const emptyCreationDraft = (
  origin: "creative" | "novel",
): CreativeCreationDraft => ({
  title: "",
  reference: "",
  parameters: defaultCreationParameters(origin),
  direct: false,
});
/** One plugin-owned dialog. No browser top-layer takeover and no client-side parsing or invented upload receipt. */
export function ProjectFoundationCreateDialog({
  controller,
  origin,
  idea,
  upload,
  onClose,
  onCreated,
  initialDraft,
  onDraftChange,
}: {
  controller: ProjectFoundationController;
  origin: "creative" | "novel";
  idea: string;
  upload?: ProjectSourceUploadUiPort;
  onClose(): void;
  onCreated(): void;
  initialDraft?: CreativeCreationDraft;
  onDraftChange?(draft: CreativeCreationDraft): void;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [title, setTitle] = useState(
    initialDraft?.title ||
      Array.from(idea.trim().split(/\r?\n/u)[0] ?? "")
        .slice(0, 60)
        .join(""),
  );
  const [brief, setBrief] = useState(idea);
  const [reference, setReference] = useState(initialDraft?.reference ?? "");
  const [parameters, setParameters] = useState(
    initialDraft?.parameters ?? defaultCreationParameters(origin),
  );
  const [direct, setDirect] = useState(initialDraft?.direct ?? false);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<ProjectFoundationSourceUpload | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  usePluginDialog(dialog, true);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    onDraftChange?.({ title, reference, parameters, direct });
  }, [title, reference, parameters, direct, onDraftChange]);
  const text =
    origin === "novel"
      ? brief.trim() ||
        `将《${title.trim()}》改编为短剧，先讨论取舍并确认改编方案。`
      : reference.trim()
        ? `${brief}\n\n参考文字：\n${reference}`
        : brief;
  let parametersValid = true;
  try {
    parseProjectFoundationParameters(parameters, origin);
  } catch {
    parametersValid = false;
  }
  const locked = controller.locked || cancelling;
  const canCreate =
    snapshot.available &&
    !locked &&
    !uploading &&
    validTitle(title) &&
    validBrief(text) &&
    parametersValid &&
    (origin === "creative" || source !== null);
  const close = () => {
    if (!locked) {
      request.current?.abort();
      onClose();
    }
  };
  const chooseFile = (selected: File | null) => {
    request.current?.abort();
    request.current = null;
    setUploading(false);
    setSource(null);
    setProgress("");
    setError(null);
    setFile(selected);
    if (selected && !title.trim())
      setTitle(
        Array.from(selected.name.replace(/\.(txt|md|markdown|html|htm)$/iu, ""))
          .slice(0, 160)
          .join(""),
      );
  };
  async function importFile() {
    if (!file || !upload || uploading || locked) return;
    if (
      !/\.(txt|md|markdown|html|htm)$/iu.test(file.name) ||
      file.size < 1 ||
      file.size > 20_000_000
    ) {
      setError("请选择不超过 20MB 的 TXT、Markdown 或 HTML 文件。");
      return;
    }
    const active = new AbortController();
    request.current = active;
    setUploading(true);
    setError(null);
    setProgress("正在上传原文…");
    try {
      const prepared = await upload.uploadFile({
        file,
        signal: active.signal,
        progress: (value) => {
          if (request.current !== active || active.signal.aborted) return;
          setProgress(
            value.phase === "preparing"
              ? "正在整理原文和章节…"
              : `正在上传原文 ${Math.round((value.sentBytes / Math.max(1, value.totalBytes)) * 100)}%`,
          );
        },
      });
      if (request.current !== active || active.signal.aborted) return;
      setSource(prepared);
      setProgress("原文已准备好");
    } catch (cause) {
      if (request.current === active && !active.signal.aborted)
        setError(
          cause instanceof ProjectSourceFileUploadError
            ? cause.message
            : "原文导入未完成，请检查格式、编码或连接后重试。",
        );
    } finally {
      if (request.current === active) {
        request.current = null;
        setUploading(false);
      }
    }
  }
  async function cancelImport() {
    if (!upload?.cancelUpload || cancelling || controller.locked) return;
    request.current?.abort();
    setCancelling(true);
    setError(null);
    try {
      await upload.cancelUpload();
      setSource(null);
      setProgress("已取消导入");
    } catch {
      setError("取消结果尚未确认，请重试取消。");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="drama-dialog-layer">
      <dialog
        ref={dialog}
        className="modal drama-creation-modal"
        aria-labelledby="drama-foundation-create-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="modal-header">
          <h2 id="drama-foundation-create-title">
            {origin === "novel" ? "创建小说短剧" : "创建创意短剧"}
          </h2>
          <button
            type="button"
            className="button icon"
            aria-label="关闭创建弹窗"
            disabled={locked}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate)
              void controller
                .create({
                  title,
                  briefText: text,
                  origin,
                  parameters,
                  creativeStartMode:
                    origin === "creative"
                      ? direct
                        ? "direct-script"
                        : "confirm-plan"
                      : null,
                  sourceUpload: origin === "novel" ? source : null,
                })
                .then((saved) => {
                  if (saved) onCreated();
                });
          }}
        >
          <label className="form-field">
            项目名称
            <input
              data-dialog-autofocus
              required
              value={title}
              disabled={locked}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="给这个故事起个名字"
            />
          </label>
          {origin === "novel" && (
            <section className="drama-source-import" aria-label="小说原文">
              <label className="form-field">
                小说文件
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.html,.htm"
                  disabled={locked || uploading}
                  onChange={(event) =>
                    chooseFile(event.target.files?.[0] ?? null)
                  }
                />
              </label>
              <p className="detail-note">
                TXT、Markdown 或 HTML，最多 20MB（20,000,000 字节）。
              </p>
              {!upload && (
                <p className="detail-note">
                  此设备尚未接入小说文件上传，暂时不能导入。
                </p>
              )}
              {file && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={
                    !upload ||
                    !snapshot.available ||
                    uploading ||
                    locked ||
                    source !== null
                  }
                  onClick={() => void importFile()}
                >
                  <Upload size={15} />
                  {source ? "原文已准备好" : "导入原文"}
                </button>
              )}
              {upload?.cancelUpload && (uploading || progress || error) && (
                <button
                  className="text-button"
                  type="button"
                  disabled={locked}
                  onClick={() => void cancelImport()}
                >
                  {cancelling ? "正在取消…" : "取消导入"}
                </button>
              )}
              {progress && (
                <p className="detail-note" role="status">
                  {progress}
                </p>
              )}
            </section>
          )}
          <label className="form-field">
            {origin === "creative" ? "创作想法" : "改编目标（可选）"}
            <textarea
              value={brief}
              required={origin === "creative"}
              disabled={locked}
              onChange={(event) => setBrief(event.target.value)}
              placeholder={
                origin === "creative"
                  ? "故事讲什么？想让观众感受到什么？"
                  : "例如：保留人物关系，突出悬疑和反转。"
              }
            />
          </label>
          {origin === "creative" && (
            <label className="form-field">
              参考文字（可选）
              <textarea
                className="drama-short-input"
                value={reference}
                disabled={locked}
                onChange={(event) => setReference(event.target.value)}
                placeholder="补充参考故事、风格或画面要求"
              />
            </label>
          )}
          <ProjectCreationParametersFields
            origin={origin}
            value={parameters}
            disabled={locked}
            onChange={setParameters}
          />
          {origin === "creative" && (
            <fieldset className="drama-start-choice">
              <legend>从哪里开始</legend>
              <label>
                <input
                  type="radio"
                  name="creative-start"
                  checked={!direct}
                  disabled={locked}
                  onChange={() => setDirect(false)}
                />
                先确认创作方案
              </label>
              <label>
                <input
                  type="radio"
                  name="creative-start"
                  checked={direct}
                  disabled={locked}
                  onChange={() => setDirect(true)}
                />
                跳过方案，直接写剧本
              </label>
            </fieldset>
          )}
          <p className="detail-note">
            {origin === "novel"
              ? "先确认故事取舍，再开展分集和后续制作。"
              : direct
                ? "保存直接创作选择后，在项目原 Agent 对话中开始写剧本。"
                : "建立项目后，与 Agent 完善方案，也可以手动填写并确认。"}
          </p>
          {!snapshot.available && (
            <p className="detail-note">
              新的项目创建服务尚未接入，请稍后重试。
            </p>
          )}
          {(!parametersValid ||
            (!validBrief(text) && Boolean(text.trim()))) && (
            <p className="detail-note" role="alert">
              请检查集数、时长及内容长度后继续。
            </p>
          )}
          {error && (
            <p className="detail-note" role="alert">
              {error}
            </p>
          )}
          <ProjectFoundationFeedback
            controller={controller}
            snapshot={snapshot}
            onRetried={onCreated}
          />
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={locked}
              onClick={close}
            >
              取消
            </button>
            <button className="button primary" disabled={!canCreate}>
              {snapshot.saving ? "正在保存…" : "创建项目"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
