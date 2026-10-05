import { useEffect, useId } from "react";
import type {
  DesktopLocalPluginExecutionIdentity,
  DesktopLocalPluginExecutionSetupAccess,
} from "../../lib/desktop/desktopLocalPluginExecutionSetupProtocol";
import type { Locale } from "../../lib/i18n";
import type { ExecutionSetupParameters } from "../../lib/plugins/localPluginExecutionSetupValidation";
import { useLocalPluginExecutionSetup } from "../../lib/plugins/useLocalPluginExecutionSetup";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

/** Shares only the original panel's scoped settings presentation. */
export function InstalledPluginExecutionSetup(
  props: Readonly<{
    access: DesktopLocalPluginExecutionSetupAccess;
    identity: DesktopLocalPluginExecutionIdentity;
    parameters: ExecutionSetupParameters;
    disabled: boolean;
    locale: Locale;
    onMutationPendingChange?(pending: boolean): void;
  }>,
) {
  const state = useLocalPluginExecutionSetup(props);
  const consentId = useId();
  const zh = props.locale === "zh";
  const preview = state.preview;
  const mutationPending = ["confirming", "pending", "unknown"].includes(
    state.phase,
  );
  useEffect(() => {
    props.onMutationPendingChange?.(mutationPending);
    return () => props.onMutationPendingChange?.(false);
  }, [mutationPending, props.onMutationPendingChange]);
  return (
    <section
      className="installed-plugin-configuration-field"
      aria-label={zh ? "本机执行准备" : "Local execution setup"}
      aria-busy={
        state.phase === "loading" ||
        state.phase === "confirming" ||
        state.phase === "pending"
      }
    >
      <div className="installed-plugin-configuration-field-header">
        <h4>{zh ? "执行环境" : "Execution environment"}</h4>
        {!preview && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!state.canPreview}
            onClick={() => void state.previewExecution()}
          >
            {zh ? "预览执行准备" : "Preview execution setup"}
          </Button>
        )}
      </div>
      <p className="installed-plugin-configuration-hint">
        {zh
          ? "使用已保存的参数准备本机执行环境。准备不会修改插件启用状态或提交生成。"
          : "Prepare the local execution environment from saved parameters. Preparation does not change the plugin's enabled state or submit generation."}
      </p>
      {state.phase === "loading" && (
        <p role="status">
          {zh ? "正在读取执行准备…" : "Reading execution setup…"}
        </p>
      )}
      {(state.phase === "confirming" || state.phase === "pending") && (
        <p role="status">
          {zh
            ? "正在准备执行环境，请等待原准备结果。"
            : "Preparing the execution environment. Wait for its original result."}
        </p>
      )}
      {state.error && (
        <p className="installed-plugin-configuration-error" role="alert">
          {state.error}
        </p>
      )}
      {preview && (
        <>
          <p>
            {preview.pluginId} · {preview.version}
          </p>
          <p>
            {zh ? "保存配置版本：" : "Saved configuration revision: "}
            {preview.configurationRevision}
          </p>
          <p>
            {zh ? "生成服务：" : "Generation service: "}
            {preview.baseUrl}
          </p>
          <p>
            {zh ? "预设：" : "Preset: "}
            {preview.preset === "krea2-portrait"
              ? zh
                ? "Krea2 写实人像（1MP）"
                : "Krea2 portrait (1MP)"
              : zh
                ? "Krea2 角色三视图"
                : "Krea2 character three-view"}
          </p>
          <p>
            {zh ? "允许的网络请求：" : "Allowed network requests: "}
            {preview.networkPaths
              .map(
                (path) =>
                  `${path.method} ${"path" in path ? path.path : `${path.operationPathPrefix}…`}`,
              )
              .join(" · ")}
          </p>
          <div className="installed-plugin-configuration-field-header">
            <label htmlFor={consentId}>
              {zh
                ? "我允许此包在本机执行 Node 代码，并按上列范围访问生成服务。"
                : "I allow this package to execute Node code locally and access the generation service within the listed scope."}
            </label>
            <Switch
              id={consentId}
              size="sm"
              checked={state.consent}
              disabled={props.disabled}
              onCheckedChange={state.setConsent}
            />
          </div>
          {preview.historyQueryAvailability === "unavailable" && (
            <p className="installed-plugin-configuration-hint">
              {zh
                ? "历史图片查询不可用：尚无已批准且已准备的旧查询目标。本次仅准备工作台自身能力，不增加历史查询批准。"
                : "Historical image queries are unavailable: no approved, prepared historical target exists. This prepares the workbench's own capabilities without adding historical query approval."}
            </p>
          )}
          {preview.historyQuery && (
            <>
              <p>
                {zh ? "历史图片查询目标：" : "Historical image query target: "}
                {preview.historyQuery.target.pluginId} ·{" "}
                {preview.historyQuery.target.version}
              </p>
              <p>
                {zh ? "目标包：" : "Target package: "}
                {preview.historyQuery.target.packageDigest}
              </p>
              <p>
                {zh
                  ? "目标当前选择 / 保存配置版本："
                  : "Target selection / saved configuration revision: "}
                {preview.historyQuery.selectionRevision} /{" "}
                {preview.historyQuery.configurationRevision}
              </p>
              <div className="installed-plugin-configuration-field-header">
                <label htmlFor={`${consentId}-history`}>
                  {zh
                    ? "我允许本工作台通过这个已批准的插件查询原有生成结果，仅 GET，不授予新的生成权限。"
                    : "I allow this workbench to query existing generation results through this approved plugin, using GET only, without granting new generation permission."}
                </label>
                <Switch
                  id={`${consentId}-history`}
                  size="sm"
                  checked={state.historicalQueryConsent}
                  disabled={props.disabled}
                  onCheckedChange={state.setHistoricalQueryConsent}
                />
              </div>
            </>
          )}
          <p className="installed-plugin-configuration-hint">
            {zh
              ? "准备会重启本机运行环境，正在运行的任务可能中断。"
              : "Preparation restarts the local runtime and may interrupt active tasks."}
          </p>
          <div className="installed-plugin-configuration-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!state.canConfirm}
              onClick={() => void state.confirm()}
            >
              {zh ? "允许并准备" : "Allow and prepare"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={state.closePreview}
            >
              {zh ? "取消预览" : "Cancel preview"}
            </Button>
          </div>
        </>
      )}
      {state.result && (
        <p role="status">
          {state.result.state === "prepared"
            ? zh
              ? "执行环境已准备；插件启用状态保持原选择。服务连通与出图仍需实际任务验证。"
              : "Execution environment prepared; the plugin's enabled state keeps its original selection. Service connectivity and generated output still require an actual task."
            : zh
              ? "执行批准已保存，仍需重启 CrewON 完成准备；插件启用状态保持原选择，尚未提交生成。"
              : "Execution approval saved. Restart CrewON to finish preparation; the plugin's enabled state keeps its original selection and no generation was submitted."}
        </p>
      )}
      {["pending", "unknown", "failed"].includes(state.phase) && (
        <div className="installed-plugin-configuration-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void state.refreshStatus()}
          >
            {zh ? "重新读取准备状态" : "Reload preparation status"}
          </Button>
        </div>
      )}
      {(state.phase === "committed" || state.phase === "failed") && (
        <Button type="button" variant="ghost" size="sm" onClick={state.dismiss}>
          {zh ? "关闭准备结果" : "Dismiss preparation result"}
        </Button>
      )}
    </section>
  );
}
