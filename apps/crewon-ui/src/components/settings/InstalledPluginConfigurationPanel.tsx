import { useId } from "react";
import type { PluginSelectionView } from "@crewon/contracts";
import type { Locale } from "../../lib/i18n";
import {
  useInstalledPluginConfiguration,
  type InstalledPluginConfigurationClient,
} from "../../lib/plugins/useInstalledPluginConfiguration";
import { Button } from "../ui/button";
import { InstalledPluginConfigurationFields } from "./InstalledPluginConfigurationFields";
import "./InstalledPluginConfigurationPanel.css";

export function InstalledPluginConfigurationPanel({
  client,
  selection,
  locale,
  disabled = false,
}: {
  client: InstalledPluginConfigurationClient;
  selection: PluginSelectionView;
  locale: Locale;
  disabled?: boolean;
}) {
  const state = useInstalledPluginConfiguration({ client, selection, locale });
  const idPrefix = useId();
  const zh = locale === "zh";
  const locked = disabled || state.busy || state.retryable;
  return (
    <section
      className="installed-plugin-configuration"
      aria-label={zh ? "插件参数配置" : "Plugin parameters"}
      aria-busy={state.busy || state.status === "loading"}
    >
      <header className="installed-plugin-configuration-header">
        <div>
          <h4>{zh ? "参数配置" : "Parameters"}</h4>
          <p>
            {selection.pluginId}
            {state.package === null ? "" : ` · ${state.package.version}`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked}
          onClick={state.refresh}
        >
          {zh ? "重新读取" : "Reload"}
        </Button>
      </header>
      {state.error !== null && (
        <p className="installed-plugin-configuration-error" role="alert">
          {state.error}
        </p>
      )}
      {state.feedback !== null && <p role="status">{state.feedback}</p>}
      {state.status === "loading" && (
        <p role="status">
          {zh ? "正在读取插件配置…" : "Loading plugin configuration…"}
        </p>
      )}
      {state.status === "unavailable" && (
        <p>
          {zh
            ? "此插件的参数配置暂不可用。"
            : "Parameters for this plugin are currently unavailable."}
        </p>
      )}
      {state.status === "available" &&
        state.schema !== null &&
        state.draft !== null && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && !state.saveDisabled) void state.save();
            }}
          >
            <p className="installed-plugin-configuration-hint">
              {state.configuration === null
                ? zh
                  ? "尚未保存参数。"
                  : "No parameters have been saved."
                : zh
                  ? `已保存版本 ${state.configuration.revision}`
                  : `Saved revision ${state.configuration.revision}`}
            </p>
            {state.configuration !== null &&
              state.package !== null &&
              state.configuration.pluginVersion !== state.package.version && (
                <p
                  className="installed-plugin-configuration-hint"
                  role="status"
                >
                  {zh
                    ? `当前保存的配置来自版本 ${state.configuration.pluginVersion}；请核对当前选中版本 ${state.package.version} 的参数并保存。`
                    : `The current saved configuration comes from version ${state.configuration.pluginVersion}. Review and save the parameters for the selected version ${state.package.version}.`}
                </p>
              )}
            <InstalledPluginConfigurationFields
              schema={state.schema}
              draft={state.draft}
              onChange={state.setDraft}
              locale={locale}
              disabled={locked || state.credentialsUnsupported}
              idPrefix={idPrefix}
              path={[]}
              issues={state.validation?.issues ?? []}
            />
            {state.credentialsUnsupported && (
              <p className="installed-plugin-configuration-error" role="status">
                {zh
                  ? "此插件使用凭据引用。当前面板不接收密钥，也不会移除已有引用；请通过受支持的凭据管理入口修改。"
                  : "This plugin uses credential references. This panel does not collect secrets or remove existing references. Use the supported credential management entry point."}
              </p>
            )}
            {state.validation?.issues.some(
              (issue) => issue.path.length === 0,
            ) && (
              <p
                className="installed-plugin-configuration-field-error"
                role="alert"
              >
                {zh
                  ? "配置内容超过限制或格式不正确，请检查参数。"
                  : "Check the configuration format and size limits."}
              </p>
            )}
            <div className="installed-plugin-configuration-actions">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={disabled || state.saveDisabled}
              >
                {state.busy
                  ? zh
                    ? "正在保存…"
                    : "Saving…"
                  : zh
                    ? "保存参数"
                    : "Save parameters"}
              </Button>
              {state.dirty && (
                <span className="installed-plugin-configuration-hint">
                  {zh ? "有未保存的修改" : "Unsaved changes"}
                </span>
              )}
            </div>
          </form>
        )}
      {state.retryable && (
        <div className="installed-plugin-configuration-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || state.busy}
            onClick={() => void state.retry()}
          >
            {zh ? "重试保存" : "Retry save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || state.busy}
            onClick={state.abandonRetry}
          >
            {zh ? "放弃重试并重新读取" : "Abandon retry and reload"}
          </Button>
        </div>
      )}
    </section>
  );
}
