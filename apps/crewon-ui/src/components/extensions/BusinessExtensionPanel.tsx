import { useId } from "react";
import { ExternalLink, ImagePlus, RefreshCw, Save } from "lucide-react";
import type {
  GetExtensionActivationResponse,
  GetExtensionConfigurationResponse,
} from "@crewon/contracts";

import type { RunView } from "@crewon/contracts";
import type { Locale } from "../../lib/i18n";
import { Button } from "../ui/button";
import "./BusinessExtensionPanel.css";

type ExtensionActivation = NonNullable<
  GetExtensionActivationResponse["activation"]
>;
type ExtensionConfiguration = NonNullable<
  GetExtensionConfigurationResponse["configuration"]
>;

export type ExtensionAgentOption = Readonly<{
  agentVersionId: string;
  label: string;
  available: boolean;
  reason?: string;
}>;

export type ExtensionOperationProjection = Readonly<{
  /** Authoritative owner of this operation, including on a later query Run. */
  sourceRunId: string;
  operationId: string;
  status:
    | "submitting"
    | "submitted"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "unknownOutcome";
  images: readonly Readonly<{ filename: string; url: string }>[];
  observedAt?: string;
}>;

export type ExtensionTaskProjection = Readonly<{
  runId: string;
  configurationRevision: number;
  runStatus: RunView["status"] | "unavailable";
  operations: readonly ExtensionOperationProjection[];
  failureCode?: string | null;
  truncated?: boolean;
}>;

export type BusinessExtensionPanelProps = Readonly<{
  locale: Locale;
  title: string;
  description: string;
  phase: "loading" | "ready" | "unavailable";
  unavailableReason?: string;
  configuration: ExtensionConfiguration | null;
  activation: ExtensionActivation | null;
  baseUrl: string;
  onBaseUrlChange(value: string): void;
  agentVersions: readonly ExtensionAgentOption[];
  selectedAgentVersionId: string | null;
  /** Exact selected version/configuration readiness returned by the host. */
  selectedAgentReady: boolean;
  readyReason?: string;
  onAgentVersionChange(agentVersionId: string | null): void;
  prompt: string;
  onPromptChange(value: string): void;
  tasks: readonly ExtensionTaskProjection[];
  busy: "saving" | "enabling" | "disabling" | "generating" | "querying" | null;
  error: string | null;
  pendingTask?: "retrySubmission" | "resumeAccepted" | null;
  onSave(): void;
  onEnable(agentVersionId: string): void;
  onDisable(): void;
  onGenerate(): void;
  onQuery(input: Readonly<{ sourceRunId: string; operationId: string }>): void;
  onRefresh(): void;
  onOpenRun?(runId: string): void;
}>;

/** Pure presentation: all saved state and provider outcomes come from the host. */
export function BusinessExtensionPanel(props: BusinessExtensionPanelProps) {
  const { locale, configuration, activation } = props;
  const zh = locale === "zh";
  const id = useId();
  const readOnly =
    props.phase !== "ready" || props.busy !== null || props.pendingTask != null;
  const dirty = configuration?.parameters.baseUrl !== props.baseUrl;
  const selectedAgent = props.agentVersions.find(
    (agent) => agent.agentVersionId === props.selectedAgentVersionId,
  );
  const currentActivation = Boolean(
    configuration &&
      activation?.state === "enabled" &&
      activation.configurationRevision === configuration.revision &&
      activation.configurationDigest === configuration.contentDigest &&
      activation.target !== null,
  );
  const validBaseUrl = extensionBaseUrlValid(props.baseUrl);
  const validPrompt =
    props.prompt.trim().length > 0 && props.prompt.length <= 2_000;
  const canEnable = Boolean(
    !readOnly &&
      configuration &&
      !dirty &&
      selectedAgent?.available &&
      props.selectedAgentReady,
  );

  return (
    <section
      className="business-extension-panel"
      aria-label={props.title}
      aria-busy={props.phase === "loading" || props.busy !== null}
    >
      <header className="business-extension-header">
        <div>
          <small>{zh ? "业务插件" : "Business plugin"}</small>
          <h2>{props.title}</h2>
          <p>{props.description}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy !== null || props.phase === "loading"}
          onClick={() => props.onRefresh()}
        >
          <RefreshCw aria-hidden="true" />
          {zh ? "刷新状态" : "Refresh status"}
        </Button>
      </header>

      {props.phase !== "ready" && (
        <p className="business-extension-notice" role="status">
          {props.phase === "loading"
            ? zh
              ? "正在读取插件配置与状态…"
              : "Loading plugin configuration and status…"
            : props.unavailableReason ||
              (zh
                ? "插件暂不可用，请刷新后重试。"
                : "Plugin unavailable. Refresh to try again.")}
        </p>
      )}
      {props.error && (
        <p className="business-extension-error" role="alert">
          {props.error}
        </p>
      )}

      <div className="business-extension-grid">
        <section
          className="business-extension-card"
          aria-labelledby={`${id}-configuration`}
        >
          <header>
            <h3 id={`${id}-configuration`}>
              {zh ? "服务配置" : "Service configuration"}
            </h3>
            <span className="business-extension-status">
              {configuration
                ? zh
                  ? `已保存 · 版本 ${configuration.revision}`
                  : `Saved · revision ${configuration.revision}`
                : zh
                  ? "尚未保存"
                  : "Not saved"}
            </span>
          </header>
          <label htmlFor={`${id}-base-url`}>
            {zh ? "ComfyUI 服务地址" : "ComfyUI service URL"}
          </label>
          <input
            id={`${id}-base-url`}
            type="url"
            value={props.baseUrl}
            onChange={(event) => props.onBaseUrlChange(event.target.value)}
            disabled={readOnly}
            placeholder="https://comfyui.example.com/"
            maxLength={2_048}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={`${id}-configuration-help`}
            aria-invalid={props.baseUrl.length > 0 && !validBaseUrl}
          />
          <p id={`${id}-configuration-help`}>
            {zh
              ? "填写 HTTPS 服务根地址。此服务无需鉴权。"
              : "Enter the HTTPS service root URL. This service does not require authentication."}
          </p>
          <div className="business-extension-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={readOnly || !validBaseUrl || !dirty}
              onClick={() => props.onSave()}
            >
              <Save aria-hidden="true" />
              {props.busy === "saving"
                ? zh
                  ? "保存中…"
                  : "Saving…"
                : zh
                  ? "保存配置"
                  : "Save configuration"}
            </Button>
          </div>
          <p className="business-extension-note" role="status">
            {dirty && configuration
              ? zh
                ? "有未保存的修改；任务仍使用已启用的配置版本。"
                : "Unsaved changes. Tasks still use the enabled configuration revision."
              : zh
                ? "保存配置后，还需选择执行 Agent 并启用。"
                : "After saving, select an execution Agent and enable the plugin."}
          </p>

          <div className="business-extension-activation">
            <header>
              <h3>{zh ? "插件启用" : "Plugin activation"}</h3>
              <span
                className="business-extension-status"
                data-state={activation?.state ?? "disabled"}
              >
                {activation?.state === "enabled"
                  ? zh
                    ? "已启用"
                    : "Enabled"
                  : activation?.state === "revoked"
                    ? zh
                      ? "已撤销"
                      : "Revoked"
                    : zh
                      ? "未启用"
                      : "Disabled"}
              </span>
            </header>
            {activation && (
              <p>
                {zh
                  ? `使用配置版本 ${activation.configurationRevision}`
                  : `Uses configuration revision ${activation.configurationRevision}`}
              </p>
            )}
            <label htmlFor={`${id}-agent`}>
              {zh ? "执行 Agent" : "Execution Agent"}
            </label>
            <select
              id={`${id}-agent`}
              value={selectedAgent?.agentVersionId ?? ""}
              disabled={readOnly || !configuration}
              onChange={(event) =>
                props.onAgentVersionChange(event.target.value || null)
              }
            >
              <option value="">
                {zh
                  ? "选择已部署的生图 Agent"
                  : "Select a deployed image Agent"}
              </option>
              {props.agentVersions.map((agent) => (
                <option
                  key={agent.agentVersionId}
                  value={agent.agentVersionId}
                  disabled={!agent.available}
                >
                  {agent.label}
                  {!agent.available
                    ? ` · ${agent.reason || (zh ? "不可用" : "Unavailable")}`
                    : ""}
                </option>
              ))}
            </select>
            {!props.agentVersions.some((agent) => agent.available) && (
              <p className="business-extension-note">
                {zh
                  ? "暂无可用的生图 Agent。配置保存后，需完成部署才能启用。"
                  : "No image Agent is available. Complete its deployment after saving to enable the plugin."}
              </p>
            )}
            {selectedAgent && !props.selectedAgentReady && (
              <p className="business-extension-note" role="status">
                {props.readyReason ||
                  (zh
                    ? "执行能力尚未确认可用，暂不能启用。"
                    : "Execution availability is unconfirmed. Enabling is unavailable.")}
              </p>
            )}
            <div className="business-extension-actions">
              <Button
                type="button"
                size="sm"
                disabled={!canEnable}
                onClick={() => {
                  if (canEnable && selectedAgent)
                    props.onEnable(selectedAgent.agentVersionId);
                }}
              >
                {props.busy === "enabling"
                  ? zh
                    ? "启用中…"
                    : "Enabling…"
                  : zh
                    ? "启用插件"
                    : "Enable plugin"}
              </Button>
              {activation?.state === "enabled" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => props.onDisable()}
                >
                  {props.busy === "disabling"
                    ? zh
                      ? "停用中…"
                      : "Disabling…"
                    : zh
                      ? "停用插件"
                      : "Disable plugin"}
                </Button>
              )}
            </div>
            {activation?.state === "enabled" && !currentActivation && (
              <p className="business-extension-note">
                {zh
                  ? "已保存的配置与启用版本不同。请重新启用后创建新任务。"
                  : "The saved configuration differs from the enabled revision. Enable it again before creating tasks."}
              </p>
            )}
          </div>
        </section>

        <section
          className="business-extension-card"
          aria-labelledby={`${id}-generate`}
        >
          <header>
            <h3 id={`${id}-generate`}>
              {zh ? "生成图片" : "Generate an image"}
            </h3>
          </header>
          <label htmlFor={`${id}-prompt`}>
            {zh ? "画面描述" : "Image description"}
          </label>
          <textarea
            id={`${id}-prompt`}
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            rows={5}
            disabled={readOnly}
            maxLength={2_000}
            placeholder={
              zh
                ? "描述主体、场景、光线与画面风格…"
                : "Describe the subject, scene, lighting, and visual style…"
            }
            aria-describedby={`${id}-task-help`}
          />
          <p id={`${id}-task-help`}>
            {zh
              ? "新任务会提交到已启用的外部生图服务。"
              : "A new task submits to the enabled external image service."}
          </p>
          <div className="business-extension-actions">
            <Button
              type="button"
              size="sm"
              disabled={
                props.pendingTask != null
                  ? props.phase !== "ready" || props.busy !== null
                  : readOnly ||
                    !currentActivation ||
                    !validPrompt ||
                    dirty ||
                    !props.selectedAgentReady ||
                    props.selectedAgentVersionId !==
                      activation?.target?.agentVersionId
              }
              onClick={() => props.onGenerate()}
            >
              <ImagePlus aria-hidden="true" />
              {props.busy === "generating"
                ? zh
                  ? "创建中…"
                  : "Creating…"
                : props.pendingTask === "retrySubmission"
                  ? zh
                    ? "重试同一次提交"
                    : "Retry the same submission"
                  : props.pendingTask === "resumeAccepted"
                    ? zh
                      ? "恢复已提交任务"
                      : "Resume submitted task"
                    : zh
                      ? "开始生图"
                      : "Generate image"}
            </Button>
          </div>
          {props.pendingTask && (
            <p className="business-extension-note" role="status">
              {props.pendingTask === "retrySubmission"
                ? zh
                  ? "提交结果待确认。重试会沿用同一次提交，不创建重复生图请求。"
                  : "Submission is unconfirmed. Retry uses the same submission and does not create a duplicate generation request."
                : zh
                  ? "任务已提交，可恢复会话并读取状态。"
                  : "The task was submitted. Resume its conversation and read its status."}
            </p>
          )}
          {!currentActivation && (
            <p className="business-extension-note">
              {zh
                ? "请先保存配置并启用生图 Agent。"
                : "Save the configuration and enable an image Agent first."}
            </p>
          )}
        </section>
      </div>

      <section
        className="business-extension-tasks"
        aria-labelledby={`${id}-tasks`}
      >
        <header>
          <h3 id={`${id}-tasks`}>{zh ? "任务与结果" : "Tasks and results"}</h3>
          <p>
            {zh
              ? "会话完成与图片生成状态分别记录，结果以服务返回为准。"
              : "Conversation and image generation states are separate. Results come from the service."}
          </p>
        </header>
        {props.tasks.length === 0 ? (
          <p className="business-extension-empty">
            {zh ? "还没有插件任务。" : "No plugin tasks yet."}
          </p>
        ) : (
          props.tasks.map((task) => (
            <article className="business-extension-task" key={task.runId}>
              <header>
                <h4>{zh ? "插件任务" : "Plugin task"}</h4>
                <span className="business-extension-status">
                  {extensionRunStatusLabel(task.runStatus, locale)}
                </span>
              </header>
              <p className="business-extension-identifiers">
                {zh ? "任务" : "Task"} <code>{task.runId}</code> ·{" "}
                {zh ? "配置版本" : "Configuration revision"}{" "}
                {task.configurationRevision}
              </p>
              {props.onOpenRun && (
                <button
                  className="business-extension-text-action"
                  type="button"
                  onClick={() => props.onOpenRun?.(task.runId)}
                >
                  {zh ? "查看任务会话" : "Open task conversation"}
                </button>
              )}
              {task.failureCode && (
                <p className="business-extension-error">
                  {zh ? "任务未完成" : "Task did not complete"} ·{" "}
                  {task.failureCode}
                </p>
              )}
              {task.operations.length === 0 && (
                <p className="business-extension-note">
                  {zh
                    ? "尚无外部生成记录，不能确认图片已生成。"
                    : "No external operation is recorded. Image generation is unconfirmed."}
                </p>
              )}
              {task.operations.map((operation) => (
                <div
                  className="business-extension-operation"
                  key={`${operation.sourceRunId}:${operation.operationId}`}
                >
                  <strong data-state={operation.status}>
                    {extensionOperationStatusLabel(operation.status, locale)}
                  </strong>
                  {operation.observedAt && (
                    <p>
                      {zh ? "记录更新" : "Record updated"} ·{" "}
                      <time dateTime={operation.observedAt}>
                        {operation.observedAt}
                      </time>
                    </p>
                  )}
                  <p className="business-extension-identifiers">
                    {zh ? "原任务" : "Source task"}{" "}
                    <code>{operation.sourceRunId}</code> ·{" "}
                    {zh ? "生成记录" : "Operation"}{" "}
                    <code>{operation.operationId}</code>
                  </p>
                  {operation.status === "unknownOutcome" && (
                    <p className="business-extension-note">
                      {zh
                        ? "外部请求可能已被接收。请查询原任务，避免重复提交。"
                        : "The external request may have been accepted. Query the source task to avoid duplicate submission."}
                    </p>
                  )}
                  {operation.status === "succeeded" &&
                    operation.images.length === 0 && (
                      <p className="business-extension-note">
                        {zh
                          ? "服务已返回完成状态，但没有可用的图片链接。"
                          : "The service reports completion but no image link is available."}
                      </p>
                    )}
                  {operation.status === "succeeded" &&
                    operation.images.map((image, index) => {
                      const url = extensionResultUrl(image.url);
                      return url ? (
                        <a
                          className="business-extension-result"
                          key={`${image.url}:${index}`}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {image.filename ||
                            (zh ? `图片 ${index + 1}` : `Image ${index + 1}`)}
                          <ExternalLink size={14} aria-hidden="true" />
                        </a>
                      ) : (
                        <p className="business-extension-note" key={index}>
                          {zh ? "结果链接不可用" : "Result link unavailable"}
                        </p>
                      );
                    })}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      readOnly ||
                      !operation.sourceRunId ||
                      !operation.operationId ||
                      activation?.state === "revoked"
                    }
                    onClick={() =>
                      props.onQuery({
                        sourceRunId: operation.sourceRunId,
                        operationId: operation.operationId,
                      })
                    }
                  >
                    <RefreshCw aria-hidden="true" />
                    {props.busy === "querying"
                      ? zh
                        ? "查询中…"
                        : "Querying…"
                      : zh
                        ? "查询原任务结果"
                        : "Query source task result"}
                  </Button>
                </div>
              ))}
              {task.truncated && (
                <p className="business-extension-note">
                  {zh
                    ? "生成记录较多，此处只展示部分记录。"
                    : "Only part of the operation history is shown."}
                </p>
              )}
            </article>
          ))
        )}
      </section>
    </section>
  );
}

export function extensionBaseUrlValid(value: string): boolean {
  if (
    value.length > 2_048 ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f]/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function extensionResultUrl(value: string): string | null {
  if (
    value.length > 2_048 ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f]/u.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function extensionOperationStatusLabel(
  status: ExtensionOperationProjection["status"],
  locale: Locale,
): string {
  const labels =
    locale === "zh"
      ? {
          submitting: "外部请求提交中",
          submitted: "外部请求已提交",
          queued: "外部生成排队中",
          running: "外部生成中",
          succeeded: "服务已确认生成完成",
          failed: "外部生成失败",
          unknownOutcome: "外部结果待确认",
        }
      : {
          submitting: "Submitting external request",
          submitted: "External request submitted",
          queued: "External generation queued",
          running: "External generation running",
          succeeded: "Generation confirmed by the service",
          failed: "External generation failed",
          unknownOutcome: "External outcome unconfirmed",
        };
  return labels[status];
}

export function extensionRunStatusLabel(
  status: ExtensionTaskProjection["runStatus"],
  locale: Locale,
): string {
  const labels =
    locale === "zh"
      ? {
          queued: "会话排队中",
          running: "会话执行中",
          waitingApproval: "等待审批",
          suspended: "会话已暂停",
          reconciling: "会话恢复中",
          completed: "会话已完成",
          failed: "会话失败",
          canceled: "会话已取消",
          unavailable: "会话状态暂不可用",
        }
      : {
          queued: "Conversation queued",
          running: "Conversation running",
          waitingApproval: "Awaiting approval",
          suspended: "Conversation suspended",
          reconciling: "Conversation recovering",
          completed: "Conversation completed",
          failed: "Conversation failed",
          canceled: "Conversation canceled",
          unavailable: "Conversation status unavailable",
        };
  return labels[status];
}
