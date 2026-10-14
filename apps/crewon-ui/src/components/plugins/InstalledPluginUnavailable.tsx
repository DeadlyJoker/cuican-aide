import {
  ControlApiClientError,
  ControlApiProtocolError,
} from "@crewon/control-client";
import { CircleAlert } from "lucide-react";
import type { Locale } from "../../lib/i18n";
import { PluginUiLoaderError } from "../../lib/plugins/pluginUiValidation";
import styles from "./InstalledPluginUnavailable.module.css";

export function InstalledPluginUnavailable({
  error,
  locale,
  onRetry,
}: Readonly<{ error: unknown; locale: Locale; onRetry(): void }>) {
  const rawCode =
    error instanceof ControlApiClientError ||
    error instanceof ControlApiProtocolError ||
    error instanceof PluginUiLoaderError
      ? error.code
      : null;
  // Expose only bounded protocol codes, never an arbitrary exception or URL.
  const code =
    rawCode && /^[a-z][a-z0-9_]{2,95}$/.test(rawCode) ? rawCode : null;
  const zh = locale === "zh";
  const title =
    code === "storage_capacity_low"
      ? zh
        ? "磁盘空间不足，暂时无法打开插件"
        : "Not enough disk space to open this plugin"
      : zh
        ? "模块暂时不可用"
        : "This module is temporarily unavailable";
  const description =
    code === "storage_capacity_low"
      ? zh
        ? "请先释放磁盘空间，至少保留 2 GB 可用空间，然后重新加载。已有项目和任务会保留。"
        : "Free at least 2 GB of disk space, then reload. Existing projects and tasks are preserved."
      : code === "storage_capacity_unknown"
        ? zh
          ? "暂时无法检查磁盘空间，请稍后重新加载。"
          : "Disk space could not be checked. Try reloading shortly."
        : zh
          ? "请重新加载插件；若仍无法打开，可到设置中检查插件状态。"
          : "Reload the plugin. If it remains unavailable, check its status in Settings.";
  return (
    <section
      className={styles.panel}
      role="alert"
      data-plugin-error-code={code ?? undefined}
    >
      <CircleAlert size={24} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {code ? (
        <details>
          <summary>{zh ? "诊断信息" : "Diagnostics"}</summary>
          <code>{code}</code>
        </details>
      ) : null}
      <button type="button" className="button" onClick={onRetry}>
        {zh ? "重新加载插件" : "Reload plugin"}
      </button>
    </section>
  );
}
