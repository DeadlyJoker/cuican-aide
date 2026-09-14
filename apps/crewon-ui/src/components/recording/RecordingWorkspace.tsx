import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  RecordingBridge,
  RecordingState,
} from "../../lib/desktop/recordingBridge";
import "./recording.css";

declare global {
  interface Window {
    readonly crewonRecording?: RecordingBridge;
  }
}

type Recording = NonNullable<RecordingState["recording"]>;
type Step = Recording["steps"][number];

const statusLabels: Record<Recording["status"], string> = {
  "recording": "正在录制",
  "paused": "已暂停",
  "completed": "已结束",
  "interrupted": "录制已中断",
  "budget-exceeded": "已达到录制上限",
};
const kindLabels: Record<Step["kind"], string> = {
  navigate: "导航",
  click: "点击",
  input: "输入",
  select: "选择 / 筛选",
  download: "下载",
  unsupported: "无法采集",
};
const outcomeLabels: Record<Step["outcome"], string> = {
  observed: "已观察",
  completed: "已完成",
  cancelled: "已取消",
  unknown: "结果未知",
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    recording_revision_conflict: "录制已更新，本次修改未保存。请稍后重试。",
    recording_pause_before_export: "请先暂停或结束录制，再导出。",
    recording_pause_before_edit: "请先暂停或结束录制，再修改步骤。",
    recording_finish_current_first: "请先结束当前录制，再开始或选择其他录制。",
    recording_note_sensitive_or_too_long:
      "说明包含敏感信息或过长，请修改后重试。",
    recording_catalog_limit: "已达到 20 份本地录制上限，请先删除不需要的录制。",
    recording_edit_limit: "这份录制的修改次数已达上限，已保存内容仍可导出。",
    recording_origin_invalid: "请先打开教学页面，再继续录制。",
    recording_url_invalid: "请输入不含账号密码的完整 http(s) 地址。",
    recording_page_load_failed:
      "教学页面加载失败。已停止采集，请检查地址后重试。",
    recording_page_crashed: "教学页面意外关闭，已保存步骤仍可回看。",
    recording_capture_failed:
      "本次操作未能保存，录制已中断。已保存步骤仍可回看。",
    recording_navigation_failed: "页面导航未能保存，录制已中断。",
    recording_source_overflow: "页面操作过于密集，已停止采集并保留已保存步骤。",
    recording_source_invalid: "页面发送了无法识别的操作，已停止采集。",
    recording_download_save_failed:
      "下载状态未能保存，请勿将未知状态视为下载完成。",
    recording_evidence_missing: "这一步的画面暂不可用。",
    recording_evidence_mismatch: "画面完整性检查未通过，无法展示。",
  };
  const code = Object.keys(messages).find((key) => message.includes(key));
  return code ? messages[code]! : message;
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    "source-rate-limit": "页面操作过于密集，部分操作未采集。",
    "iframe-not-supported": "页面包含框架，框架内部操作无法采集。",
    "frame-content-unavailable": "框架内部操作无法采集。",
    "target-unavailable": "无法识别这次操作的对象。",
    "target-unlocatable": "无法稳定定位这次操作的对象。",
    "shadow-dom-not-supported": "此封装控件内部的操作无法采集。",
    "embedded-content-not-supported": "嵌入内容内部的操作无法采集。",
    "contenteditable-not-supported": "富文本编辑区域的输入无法采集。",
    "control-not-supported": "此控件类型暂不支持采集。",
    "file-input-not-supported": "文件选择操作无法采集。",
    "multiple-select-not-supported": "多选控件的操作暂不支持采集。",
    "new-window-not-recorded": "新窗口已拦截，当前教学仅支持一个页面。",
    "unsupported-navigation": "此页面地址类型无法采集。",
    "sensitive-or-unbounded-input-omitted":
      "敏感或过长输入已省略，运行时另行提供。",
    "screenshot-unavailable": "未获得安全控件截图；可用时仅提供辅助定位图。",
  };
  return labels[reason] ?? reason;
}

function teachingUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("请输入不含账号密码的完整 http(s) 地址。");
  }
  return url.toString();
}

function StepReview({
  step,
  busy,
  onEdit,
  onEvidence,
}: {
  step: Step;
  busy: boolean;
  onEdit: (
    stepId: string,
    operation: "delete" | "annotate",
    note: string | null,
  ) => void;
  onEvidence: (evidenceId: string) => void;
}) {
  const [note, setNote] = useState(step.note ?? "");
  useEffect(() => setNote(step.note ?? ""), [step.note]);
  return (
    <li
      className="recording-step"
      data-unsupported={step.kind === "unsupported" || undefined}
    >
      <div className="recording-step-heading">
        <strong>
          <span className="recording-step-number">{step.sequence}</span>
          {kindLabels[step.kind]}
        </strong>
        <span>{outcomeLabels[step.outcome]}</span>
      </div>
      <p className="recording-step-target">
        {step.target?.accessibleName ||
          step.target?.description ||
          step.page.routeTemplate}
      </p>
      {step.target ? (
        <code className="recording-selector">{step.target.selector}</code>
      ) : null}
      {step.input ? (
        <p>
          {step.input.classification === "runtime-required" ? (
            "敏感输入未采集；运行时提供"
          ) : (
            <>
              输入：<span>{step.input.value}</span>
              {step.input.classification === "parameter-candidate"
                ? " · 候选变量"
                : ""}
            </>
          )}
        </p>
      ) : null}
      {step.reason ? (
        <p className="recording-step-reason">{reasonLabel(step.reason)}</p>
      ) : null}
      {step.relatedStepId ? (
        <p>
          关联操作：<code>{step.relatedStepId}</code>
        </p>
      ) : null}
      <div className="recording-step-actions">
        {step.evidenceIds.map((id, index) => (
          <button
            key={id}
            type="button"
            disabled={busy}
            onClick={() => onEvidence(id)}
          >
            定位画面{step.evidenceIds.length > 1 ? ` ${index + 1}` : ""}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          aria-label={`删去第 ${step.sequence} 步`}
          onClick={() => onEdit(step.stepId, "delete", null)}
        >
          删去此步
        </button>
      </div>
      <form
        className="recording-note"
        onSubmit={(event) => {
          event.preventDefault();
          onEdit(step.stepId, "annotate", note.trim() || null);
        }}
      >
        <input
          aria-label={`第 ${step.sequence} 步说明`}
          maxLength={500}
          placeholder="补充说明（勿填写敏感信息）"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button type="submit" disabled={busy || note === (step.note ?? "")}>
          保存说明
        </button>
      </form>
    </li>
  );
}

export function RecordingWorkspace({
  bridge = window.crewonRecording,
}: {
  bridge?: RecordingBridge;
}) {
  const [state, setState] = useState<RecordingState>({
    recording: null,
    recordings: [],
    pageOrigin: null,
    error: null,
    skillImportAvailable: false,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{
    id: string;
    image: string;
  } | null>(null);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const actionPending = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const recording = state.recording;
  const active =
    recording?.status === "recording" || recording?.status === "paused";
  const sessionOpen = active || recording?.status === "interrupted";
  const resumable =
    recording?.status === "paused" || recording?.status === "interrupted";
  const disabled = busy || loading || !bridge;

  useEffect(() => {
    mounted.current = true;
    if (!bridge) {
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }
    let live = true;
    let reading = false;
    async function refresh() {
      if (!bridge || reading || actionPending.current) return;
      reading = true;
      const requestedGeneration = generation.current;
      try {
        const next = await bridge.state();
        if (live && requestedGeneration === generation.current) {
          setState(next);
          setConnectionError(null);
        }
      } catch (readError) {
        if (live && requestedGeneration === generation.current)
          setConnectionError(errorMessage(readError));
      } finally {
        reading = false;
        if (live) setLoading(false);
      }
    }
    void refresh();
    const poll = window.setInterval(() => void refresh(), 1000);
    return () => {
      live = false;
      mounted.current = false;
      window.clearInterval(poll);
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !viewport.current) return;
    let live = true;
    let pending = false;
    let last = "";
    async function syncBounds() {
      if (!bridge || !live || pending || !viewport.current) return;
      const rect = viewport.current.getBoundingClientRect();
      const bounds = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      const key = JSON.stringify(bounds);
      if (key === last) return;
      pending = true;
      try {
        await bridge.bounds(bounds);
        if (live) last = key;
      } catch (boundsError) {
        if (live) setError(errorMessage(boundsError));
      } finally {
        pending = false;
      }
    }
    void syncBounds();
    const observer = new ResizeObserver(() => void syncBounds());
    observer.observe(viewport.current);
    const poll = window.setInterval(() => void syncBounds(), 1000);
    return () => {
      live = false;
      observer.disconnect();
      window.clearInterval(poll);
    };
  }, [bridge]);

  async function run(
    action: () => Promise<RecordingState | void>,
    success?: string,
  ) {
    if (actionPending.current || !bridge) return;
    actionPending.current = true;
    generation.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (!mounted.current) return;
      if (next) setState(next);
      if (success) setNotice(success);
    } catch (actionError) {
      if (mounted.current) setError(errorMessage(actionError));
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function control(command: "pause" | "resume" | "finish") {
    if (!recording || !bridge) return;
    void run(() =>
      bridge.control({
        command,
        recordingId: recording.recordingId,
        expectedRevision: recording.revision,
      }),
    );
  }

  function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bridge || disabled) return;
    void run(async () => {
      let url: string;
      try {
        url = teachingUrl(address);
      } catch {
        throw new Error("请输入不含账号密码的完整 http(s) 地址。");
      }
      const next = sessionOpen
        ? await bridge.navigate(url)
        : await bridge.start(url);
      // Retain only the authorized origin in the control UI after navigation.
      setAddress(next.pageOrigin ?? new URL(url).origin);
      setEvidence(null);
      setDeleteRequested(false);
      return next;
    });
  }

  const elapsedSeconds = recording
    ? Math.max(
        0,
        Math.floor(
          ((active ? Date.now() : Date.parse(recording.updatedAt)) -
            Date.parse(recording.startedAt)) /
            1000,
        ),
      )
    : 0;
  const usedBytes = recording
    ? new TextEncoder().encode(JSON.stringify(recording)).byteLength +
      recording.evidence.reduce((total, item) => total + item.byteLength, 0)
    : 0;
  const visibleError =
    error ||
    connectionError ||
    (state.error ? errorMessage(state.error) : null);

  return (
    <main className="recording-workspace">
      <header className="recording-header">
        <div>
          <span className="recording-brand">CrewON</span>
          <h1>浏览器教学</h1>
        </div>
        <span
          className="recording-status"
          data-status={recording?.status ?? "idle"}
          role="status"
        >
          {loading
            ? "正在读取录制…"
            : recording
              ? statusLabels[recording.status]
              : "尚未开始"}
        </span>
      </header>
      <section className="recording-boundary" aria-label="录制范围">
        <p>
          仅记录下方受控页面的导航、点击、普通输入、选择 /
          筛选和下载关联。开始录制即授权此窗口采集当前网站。
        </p>
        <details>
          <summary>采集边界与用量</summary>
          <p>
            密码、令牌和 Cookie
            不采集。框架内操作、弹窗、文件选择与特殊控件无法完整采集，会明确标记。安全控件保留局部截图；无法安全截取时仅保留辅助定位图。
          </p>
          <p>
            每次最多 200 步、30 分钟（含暂停）、2 MiB；单事件 8 KiB、单画面 16
            KiB。每步自动保存，跨网站暂停并等待重新授权。
          </p>
        </details>
        {!bridge ? (
          <p role="alert">请从 CrewON 桌面应用的浏览器菜单打开教学窗口。</p>
        ) : null}
      </section>
      <div className="recording-toolbar">
        <form className="recording-address" onSubmit={submitAddress}>
          <input
            aria-label="教学页面地址"
            type="url"
            placeholder="https://…"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            required
          />
          <button
            className={!sessionOpen ? "recording-primary" : undefined}
            type="submit"
            disabled={disabled}
          >
            {sessionOpen ? "打开页面" : "开始录制"}
          </button>
        </form>
        <div className="recording-controls">
          <button
            type="button"
            disabled={disabled || recording?.status !== "recording"}
            onClick={() => control("pause")}
          >
            暂停
          </button>
          <button
            type="button"
            disabled={disabled || !resumable || !state.pageOrigin}
            onClick={() => control("resume")}
          >
            继续
          </button>
          <button
            type="button"
            disabled={
              disabled || (!active && recording?.status !== "interrupted")
            }
            onClick={() => control("finish")}
          >
            结束录制
          </button>
        </div>
      </div>
      <div className="recording-message" aria-live="polite">
        {visibleError ? <p role="alert">{visibleError}</p> : null}
        {notice ? <p>{notice}</p> : null}
        {resumable ? (
          <p>
            {recording?.status === "interrupted"
              ? "上次录制意外中断，已保存步骤仍可回看。请先输入地址打开页面，再继续。"
              : "暂停期间不采集。"}
            继续将授权当前网站{state.pageOrigin ? ` ${state.pageOrigin}` : ""}。
          </p>
        ) : null}
      </div>
      <div className="recording-content">
        <section className="recording-page" aria-label="受控教学页面">
          <div className="recording-page-label">
            <span>教学页面</span>
            <span>{state.pageOrigin ?? "等待开始"}</span>
          </div>
          <div className="recording-viewport" ref={viewport}>
            <p>
              {recording
                ? "受控浏览器页面"
                : "输入地址并开始录制，在这里演示你的工作步骤。"}
            </p>
          </div>
        </section>
        <aside className="recording-review" aria-label="录制回看">
          <div className="recording-review-heading">
            <h2>步骤回看</h2>
            <span>{recording?.steps.length ?? 0} / 200 步</span>
          </div>
          <div className="recording-saved">
            <label htmlFor="recording-saved-select">本地已保存</label>
            <select
              id="recording-saved-select"
              disabled={disabled || active}
              value={recording?.recordingId ?? ""}
              onChange={(event) => {
                const id = event.target.value;
                if (id && bridge)
                  void run(async () => {
                    const next = await bridge.select(id);
                    setEvidence(null);
                    setDeleteRequested(false);
                    setAddress(next.pageOrigin ?? "");
                    return next;
                  });
              }}
            >
              <option value="" disabled>
                选择录制
              </option>
              {state.recordings.map((item) => (
                <option key={item.recordingId} value={item.recordingId}>
                  {item.startedAt.replace("T", " ").slice(0, 19)} ·{" "}
                  {statusLabels[item.status]}
                </option>
              ))}
            </select>
            <div className="recording-saved-actions">
              <button
                type="button"
                disabled={
                  disabled || !recording || recording.status === "recording"
                }
                onClick={() => {
                  if (!bridge) return;
                  void run(async () => {
                    const result = await bridge.export();
                    if (mounted.current)
                      setNotice(
                        result.cancelled ? "已取消导出。" : "录制已导出。",
                      );
                  });
                }}
              >
                导出 JSON
              </button>
              <button
                type="button"
                disabled={
                  disabled ||
                  !recording?.steps.length ||
                  recording.status === "recording" ||
                  !state.skillImportAvailable
                }
                title={
                  !state.skillImportAvailable
                    ? "需要已连接的 Skill 导入入口"
                    : undefined
                }
                onClick={() => {
                  if (!bridge) return;
                  void run(async () => {
                    const result = await bridge.handoff();
                    if (!result.ok) throw new Error(result.message);
                    if (mounted.current) setNotice(result.message);
                  });
                }}
              >
                生成 Skill 草稿
              </button>
              <button
                type="button"
                disabled={disabled || !recording || active}
                onClick={() => setDeleteRequested(true)}
              >
                删除录制
              </button>
            </div>
            {deleteRequested && recording ? (
              <div className="recording-delete-confirm">
                <p>删除这份录制及其定位画面？此操作无法撤销。</p>
                <code>{recording.recordingId}</code>
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (bridge)
                        void run(async () => {
                          const next = await bridge.remove(
                            recording.recordingId,
                          );
                          setEvidence(null);
                          setDeleteRequested(false);
                          return next;
                        }, "录制已删除。");
                    }}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteRequested(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          {recording?.status === "recording" ? (
            <p className="recording-empty">
              暂停后可回看画面、修改步骤和导出。
            </p>
          ) : null}
          {evidence ? (
            <figure className="recording-evidence">
              <figcaption>
                {evidence.image.startsWith("data:image/png;")
                  ? "控件截图"
                  : "辅助定位图"}
                <button type="button" onClick={() => setEvidence(null)}>
                  收起
                </button>
              </figcaption>
              <img
                src={evidence.image}
                alt={
                  evidence.image.startsWith("data:image/png;")
                    ? "安全采集的操作控件局部截图"
                    : "仅显示页面范围和操作对象位置的辅助定位图"
                }
              />
              <p>
                {evidence.image.startsWith("data:image/png;")
                  ? "仅保存通过安全检查的控件区域。"
                  : "此图仅用于定位，不是网页截图。"}
              </p>
            </figure>
          ) : null}
          <ol className="recording-steps" aria-label="录制步骤">
            {recording?.steps.map((step) => (
              <StepReview
                key={`${recording.recordingId}:${step.stepId}`}
                step={step}
                busy={disabled || recording.status === "recording"}
                onEdit={(stepId, operation, note) => {
                  if (bridge)
                    void run(async () => {
                      const next = await bridge.edit({
                        stepId,
                        operation,
                        note,
                        expectedRevision: recording.revision,
                      });
                      if (operation === "delete") setEvidence(null);
                      return next;
                    });
                }}
                onEvidence={(id) => {
                  if (bridge)
                    void run(async () => {
                      const image = await bridge.evidence(id);
                      if (
                        !/^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(
                          image,
                        )
                      )
                        throw new Error("定位画面的格式不受支持。");
                      if (mounted.current) setEvidence({ id, image });
                    });
                }}
              />
            ))}
          </ol>
          {!recording?.steps.length ? (
            <p className="recording-empty">
              录制开始后，已保存的步骤会显示在这里。
            </p>
          ) : null}
        </aside>
      </div>
      <footer className="recording-footer">
        <span>
          {recording ? `已保存 · 修订 ${recording.revision}` : "本地保存"}
        </span>
        <span>
          {Math.floor(elapsedSeconds / 60)}:
          {String(elapsedSeconds % 60).padStart(2, "0")} / 30:00 ·{" "}
          {(usedBytes / 1024).toFixed(1)} / 2048 KiB
        </span>
      </footer>
    </main>
  );
}
