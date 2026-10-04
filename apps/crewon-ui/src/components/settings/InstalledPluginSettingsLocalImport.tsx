import { useLocalPluginSourceImport } from "../../lib/plugins/useLocalPluginSourceImport";
import type { DesktopLocalPluginSourceImportClient } from "../../lib/desktop/desktopLocalPluginSourceImportProtocol";
import type { Locale } from "../../lib/i18n";
import { Button } from "../ui/button";
import "./InstalledPluginSettings.css";

export function InstalledPluginSettingsLocalImport({
  client,
  ownerKey,
  locale,
}: Readonly<{
  client: DesktopLocalPluginSourceImportClient;
  ownerKey: string;
  locale: Locale;
}>) {
  const state = useLocalPluginSourceImport({ client, ownerKey, locale });
  const zh = locale === "zh";
  const preview = state.preview;
  const busy = !state.available || state.busy;
  return (
    <section
      className="installed-plugin-settings"
      aria-label={zh ? "添加本地插件" : "Add a local plugin"}
    >
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void state.previewDirectory()}
      >
        {zh ? "选择本机插件目录" : "Choose a local plugin directory"}
      </Button>
      {state.error && <p role="alert">{state.error}</p>}
      {state.feedback && <p role="status">{state.feedback}</p>}
      {state.busy && (
        <p role="status">
          {zh ? "正在处理本地插件…" : "Processing the local plugin…"}
        </p>
      )}
      {preview && (
        <article
          className="installed-plugin-card"
          aria-label={zh ? "本地插件预览" : "Local plugin preview"}
        >
          <header>
            <h4>{preview.title}</h4>
          </header>
          <p>{preview.description}</p>
          <p>
            {zh ? "插件：" : "Plugin: "}
            {preview.pluginId}
          </p>
          <p>
            {zh
              ? "发布者（包内声明）："
              : "Publisher (declared by the package): "}
            {preview.publisherId}
          </p>
          <p>
            {zh ? "版本：" : "Version: "}
            {preview.version}
          </p>
          <p>
            {zh ? "完整摘要：" : "Full digest: "}
            {preview.packageDigest}
          </p>
          <p>
            {zh ? "文件数：" : "Files: "}
            {preview.fileCount} · {preview.totalBytes} bytes
          </p>
          {preview.nodeEntry !== null && (
            <>
              <p>
                {zh ? "Node 入口：" : "Node entry: "}
                {preview.nodeEntry}
              </p>
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={state.trustNodeExecution}
                  onChange={(event) =>
                    state.setNodeTrust(event.currentTarget.checked)
                  }
                />{" "}
                {zh
                  ? "我信任此包的 Node 代码。启用后，它可在宿主 Node 进程中执行。"
                  : "I trust this package's Node code. When enabled, it can execute in the host Node process."}
              </label>
            </>
          )}
          {preview.uiEntry?.mode === "trustedModule" && (
            <section aria-label={zh ? "公开界面资源" : "Public UI assets"}>
              <p>
                {zh
                  ? "选择界面入口及其需要的资源。仅选中的文件会公开；不选择资源只添加安装来源。"
                  : "Select the UI entry and the assets it needs. Only selected files become public; selecting none adds an installation source only."}
              </p>
              {preview.publicAssetCandidates.map((path) => (
                <div key={path}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={state.publicAssets.includes(path)}
                      onChange={(event) =>
                        state.setPublicAsset(path, event.currentTarget.checked)
                      }
                    />{" "}
                    {path}
                    {path === preview.uiEntry?.path
                      ? zh
                        ? "（界面入口）"
                        : " (UI entry)"
                      : ""}
                  </label>
                </div>
              ))}
              {state.publicAssets.length !== 0 &&
                !state.publicAssets.includes(preview.uiEntry.path) && (
                  <p role="alert">
                    {zh
                      ? "公开界面资源必须包含界面入口。"
                      : "Public UI assets must include the UI entry."}
                  </p>
                )}
              {state.publicAssets.length !== 0 && (
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={state.trustUiModule}
                    onChange={(event) =>
                      state.setUiTrust(event.currentTarget.checked)
                    }
                  />{" "}
                  {zh
                    ? "我信任此包的界面代码。它与 CrewON 主界面共享 Renderer 权限。"
                    : "I trust this package's UI code. It shares the CrewON main renderer's permissions."}
                </label>
              )}
            </section>
          )}
          {preview.uiEntry?.mode === "isolatedWeb" && (
            <p>
              {zh
                ? "此界面模式尚不能加载，可仅添加安装来源。"
                : "This UI mode cannot be loaded yet. You can add an installation source only."}
            </p>
          )}
          <p>
            {zh
              ? "添加来源不会安装或启用插件，也不会授予业务调用或计费权限。"
              : "Adding a source does not install or enable the plugin, or grant business execution or billing permissions."}
          </p>
          <p>
            {zh
              ? "确认添加会重启本机运行环境，正在运行的任务可能中断。"
              : "Adding the source restarts the local runtime and may interrupt active tasks."}
          </p>
          <div className="installed-plugin-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy || !state.canConfirm}
              onClick={() => void state.confirmPreview()}
            >
              {zh ? "确认信任并添加来源" : "Trust and add source"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy}
              onClick={state.closePreview}
            >
              {zh ? "关闭预览" : "Close preview"}
            </Button>
          </div>
        </article>
      )}
    </section>
  );
}
