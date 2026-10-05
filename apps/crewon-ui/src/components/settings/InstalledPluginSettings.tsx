import { useEffect, useState } from "react";
import type {
  PluginPackageListResponse,
  PluginSelectionView,
} from "@crewon/contracts";
import type { Locale } from "../../lib/i18n";
import {
  pluginInstallationError,
  usePluginInstallationSettings,
  type PluginInstallationSettingsClient,
} from "../../lib/plugins/usePluginInstallationSettings";
import { Button } from "../ui/button";
import type { InstalledPluginConfigurationClient } from "../../lib/plugins/useInstalledPluginConfiguration";
import { InstalledPluginConfigurationPanel } from "./InstalledPluginConfigurationPanel";
import type { DesktopLocalPluginExecutionSetupAccess } from "../../lib/desktop/desktopLocalPluginExecutionSetupProtocol";
import { currentLocalPluginExecutionSetupPluginId } from "../../lib/plugins/localPluginExecutionSetupRecovery";
import "./InstalledPluginSettings.css";

export function InstalledPluginSettings({
  client,
  configurationClient,
  executionSetup,
  locale,
}: {
  client: PluginInstallationSettingsClient;
  configurationClient?: InstalledPluginConfigurationClient;
  executionSetup?: DesktopLocalPluginExecutionSetupAccess | null;
  locale: Locale;
}) {
  const state = usePluginInstallationSettings(client, locale);
  const [versionPlugin, setVersionPlugin] = useState<string | null>(null);
  const [configurationPlugin, setConfigurationPlugin] = useState<string | null>(
    () =>
      executionSetup
        ? currentLocalPluginExecutionSetupPluginId(executionSetup)
        : null,
  );
  const zh = locale === "zh";
  const disabled = state.busy || state.loading || state.retryable;
  return (
    <section
      className="installed-plugin-settings"
      aria-label={zh ? "插件管理" : "Plugin management"}
    >
      <header>
        <div>
          <h2>{zh ? "插件" : "Plugins"}</h2>
          <p>
            {zh
              ? "安装新的功能模块，管理已安装版本。"
              : "Install feature modules and manage installed versions."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={state.busy}
          onClick={state.refresh}
        >
          {zh ? "刷新插件" : "Refresh plugins"}
        </Button>
      </header>
      {state.error && <p role="alert">{state.error}</p>}
      {state.feedback && <p role="status">{state.feedback}</p>}
      {state.retryable && (
        <Button
          type="button"
          variant="outline"
          disabled={state.busy}
          onClick={() => void state.retry()}
        >
          {zh ? "重试上次操作" : "Retry last operation"}
        </Button>
      )}
      {state.loading && (
        <p role="status">{zh ? "正在读取插件…" : "Loading plugins…"}</p>
      )}
      {state.catalog && (
        <>
          <section aria-label={zh ? "可安装插件" : "Available plugins"}>
            <h3>{zh ? "可安装" : "Available"}</h3>
            {state.catalog.sources.sources.length === 0 && (
              <p>
                {zh
                  ? "暂无可安装的插件。"
                  : "No plugins are available to install."}
              </p>
            )}
            {state.catalog.sources.sources.map((source) => (
              <article className="installed-plugin-card" key={source.sourceId}>
                <header>
                  <div>
                    <h4>{source.title}</h4>
                    <p>
                      {source.publisherId} · {source.version}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`${zh ? "安装" : "Install"} ${source.title} ${source.version}`}
                    onClick={() => void state.install(source)}
                  >
                    {zh ? "安装" : "Install"}
                  </Button>
                </header>
                <p className="installed-plugin-description">
                  {source.description}
                </p>
              </article>
            ))}
            <PluginPages
              locale={locale}
              page={state.sourcePage}
              next={state.catalog.sources.next !== null}
              disabled={disabled}
              onPrevious={state.previousSources}
              onNext={state.nextSources}
            />
          </section>
          <section aria-label={zh ? "已安装插件" : "Installed plugins"}>
            <h3>{zh ? "已安装" : "Installed"}</h3>
            {state.catalog.selections.selections.length === 0 && (
              <p>
                {zh ? "还没有安装插件。" : "No plugins have been installed."}
              </p>
            )}
            {state.catalog.selections.selections.map((selection) => (
              <article
                className="installed-plugin-card"
                key={selection.pluginId}
              >
                <header>
                  <div>
                    <h4>{selection.pluginId}</h4>
                    <p>{selection.publisherId}</p>
                  </div>
                  <span>
                    {selection.state === "enabled"
                      ? zh
                        ? "已启用"
                        : "Enabled"
                      : selection.state === "disabled"
                        ? zh
                          ? "已停用"
                          : "Disabled"
                        : zh
                          ? "已卸载"
                          : "Uninstalled"}
                  </span>
                </header>
                <div className="installed-plugin-actions">
                  {configurationClient && selection.state !== "uninstalled" && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disabled}
                      aria-expanded={configurationPlugin === selection.pluginId}
                      aria-controls={`plugin-configuration-${selection.pluginId}`}
                      onClick={() =>
                        setConfigurationPlugin(
                          configurationPlugin === selection.pluginId
                            ? null
                            : selection.pluginId,
                        )
                      }
                    >
                      {zh ? "业务配置" : "Business configuration"}
                    </Button>
                  )}
                  {selection.state !== "uninstalled" && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          void state.select(selection, {
                            state:
                              selection.state === "enabled"
                                ? "disabled"
                                : "enabled",
                            selectedPackageDigest:
                              selection.selectedPackageDigest,
                          })
                        }
                      >
                        {selection.state === "enabled"
                          ? zh
                            ? "停用"
                            : "Disable"
                          : zh
                            ? "启用"
                            : "Enable"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          void state.select(selection, {
                            state: "uninstalled",
                            selectedPackageDigest: null,
                          })
                        }
                      >
                        {zh ? "卸载" : "Uninstall"}
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    aria-expanded={versionPlugin === selection.pluginId}
                    onClick={() =>
                      setVersionPlugin(
                        versionPlugin === selection.pluginId
                          ? null
                          : selection.pluginId,
                      )
                    }
                  >
                    {zh ? "管理版本" : "Manage versions"}
                  </Button>
                </div>
                {configurationClient &&
                  selection.state !== "uninstalled" &&
                  configurationPlugin === selection.pluginId && (
                    <div id={`plugin-configuration-${selection.pluginId}`}>
                      <InstalledPluginConfigurationPanel
                        key={JSON.stringify([
                          selection.pluginId,
                          selection.publisherId,
                          selection.selectedPackageDigest,
                          selection.revision,
                          selection.state,
                        ])}
                        client={configurationClient}
                        selection={selection}
                        locale={locale}
                        disabled={disabled}
                        executionSetup={executionSetup}
                      />
                    </div>
                  )}
                {versionPlugin === selection.pluginId && (
                  <PluginVersions
                    key={`${selection.pluginId}:${selection.revision}`}
                    client={client}
                    selection={selection}
                    locale={locale}
                    disabled={disabled}
                    onSelect={(packageDigest) =>
                      void state.select(selection, {
                        state:
                          selection.state === "enabled"
                            ? "enabled"
                            : "disabled",
                        selectedPackageDigest: packageDigest,
                      })
                    }
                  />
                )}
              </article>
            ))}
            <PluginPages
              locale={locale}
              page={state.selectionPage}
              next={state.catalog.selections.next !== null}
              disabled={disabled}
              onPrevious={state.previousSelections}
              onNext={state.nextSelections}
            />
            <p>
              {zh
                ? "停用会撤下功能入口。卸载保留历史任务和业务数据。启用状态不代表生成服务已可用。"
                : "Disabling removes the module entry. Uninstalling preserves historical tasks and business data. Enabling does not confirm generation availability."}
            </p>
          </section>
        </>
      )}
    </section>
  );
}

function PluginPages({
  locale,
  page,
  next,
  disabled,
  onPrevious,
  onNext,
}: {
  locale: Locale;
  page: number;
  next: boolean;
  disabled: boolean;
  onPrevious(): void;
  onNext(): void;
}) {
  if (page === 1 && !next) return null;
  return (
    <div className="installed-plugin-actions">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || page === 1}
        onClick={onPrevious}
      >
        {locale === "zh" ? "上一页" : "Previous"}
      </Button>
      <span>{locale === "zh" ? `第 ${page} 页` : `Page ${page}`}</span>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !next}
        onClick={onNext}
      >
        {locale === "zh" ? "下一页" : "Next"}
      </Button>
    </div>
  );
}

function PluginVersions({
  client,
  selection,
  locale,
  disabled,
  onSelect,
}: {
  client: PluginInstallationSettingsClient;
  selection: PluginSelectionView;
  locale: Locale;
  disabled: boolean;
  onSelect(packageDigest: string): void;
}) {
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [page, setPage] = useState<PluginPackageListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors.at(-1)!;
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError(null);
    void client
      .listPackages(
        { pluginId: selection.pluginId, afterPackageDigest: cursor, limit: 10 },
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15_000),
          ]),
        },
      )
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(pluginInstallationError(cause, locale));
      });
    return () => controller.abort();
  }, [client, selection.pluginId, cursor, locale]);
  const zh = locale === "zh";
  return (
    <section
      className="installed-plugin-versions"
      aria-label={zh ? "安装版本" : "Installed versions"}
    >
      {error ? (
        <p role="alert">{error}</p>
      ) : !page ? (
        <p role="status">{zh ? "正在读取版本…" : "Loading versions…"}</p>
      ) : (
        <>
          {page.packages.map((pkg) => (
            <div className="installed-plugin-version" key={pkg.packageDigest}>
              <span>
                {pkg.version}
                {pkg.packageDigest === selection.selectedPackageDigest
                  ? zh
                    ? " · 当前版本"
                    : " · Current version"
                  : ""}
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={
                  disabled ||
                  pkg.packageDigest === selection.selectedPackageDigest
                }
                onClick={() => onSelect(pkg.packageDigest)}
              >
                {zh ? "使用此版本" : "Use this version"}
              </Button>
            </div>
          ))}
          <PluginPages
            locale={locale}
            page={cursors.length}
            next={page.next !== null}
            disabled={disabled}
            onPrevious={() => setCursors((values) => values.slice(0, -1))}
            onNext={() => {
              if (page.next) setCursors((values) => [...values, page.next]);
            }}
          />
        </>
      )}
    </section>
  );
}
