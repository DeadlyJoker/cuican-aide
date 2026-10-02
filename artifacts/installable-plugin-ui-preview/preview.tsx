import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  parsePluginUiLease,
  type PluginUiLease,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import { TrustedPluginUiLoader } from "../../apps/crewon-ui/src/lib/plugins/trustedPluginUiLoader";
import { PluginModuleMount } from "../../apps/crewon-ui/src/components/plugins/PluginModuleMount";
import { AppCommandShellRoute } from "../../apps/crewon-ui/src/components/app/AppCommandShellRoute";
import { DesktopWindowFrame } from "../../apps/crewon-ui/src/components/DesktopWindowFrame";
import { emptyAgentPlatformSnapshot } from "../../apps/crewon-ui/src/components/app/commandWorkspaceState";
import { emptyTerminalOutputStream } from "../../apps/crewon-ui/src/lib/terminal/terminalOutputStream";
import { initializeShortDramaPreviewSurface } from "../../apps/crewon-ui/src/components/app/ShortDramaPluginPreview";
import { getInitialTheme } from "../../apps/crewon-ui/src/lib/theme";
import { setAppliedAppearance } from "../../apps/crewon-ui/src/lib/appearance/appearanceRuntime";
import { readLocalAppearance } from "../../apps/crewon-ui/src/lib/appearance/localAppearanceStore";
import {
  resolveThemeMode,
  systemPrefersDark,
} from "../../apps/crewon-ui/src/lib/appearance/applyAppearance";
import "../../apps/crewon-ui/src/styles/tailwind.css";
import "../../apps/crewon-ui/src/styles/neutral-scale.css";
import "../../apps/crewon-ui/src/styles/app.css";
import "../../apps/crewon-ui/src/styles/original-shell-overrides.css";
import "../../apps/crewon-ui/src/styles/team-workspace.css";
import "../../apps/crewon-ui/src/styles/appearance.css";

initializeShortDramaPreviewSurface();
const appearance = readLocalAppearance();
const themeOverride = new URLSearchParams(window.location.search).get("theme");
if (appearance) setAppliedAppearance(appearance);
document.documentElement.dataset.theme =
  appearance && themeOverride !== "light" && themeOverride !== "dark"
    ? resolveThemeMode(appearance.themeMode, systemPrefersDark())
    : getInitialTheme();

async function request<T>(
  name: string,
  command: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/fixture-ui/${name}`, {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result === "object" && result !== null && "error" in result
        ? String(result.error)
        : "fixture_request_failed",
    );
  return result as T;
}
const diagnostics: string[] = [];
const loader = new TrustedPluginUiLoader({
  assetBasePath: "/fixture-ui/assets/",
  ports: {
    validateMount: async (lease, signal) => {
      const current = parsePluginUiLease(
        await request("validate", { mountRef: lease.mountRef }, signal),
      );
      if (JSON.stringify(current) !== JSON.stringify(lease))
        throw new Error("fixture_lease_changed");
    },
    invoke: (lease, input) =>
      request<PluginJsonValue>(
        "invoke",
        { mountRef: lease.mountRef, action: input.action, input: input.input },
        input.signal,
      ),
    closeMount: (lease) => request<void>("close", { mountRef: lease.mountRef }),
    onDiagnostic: (error) => {
      diagnostics.push(String(error));
      console.error(error);
    },
  },
});
type CatalogItem = {
  descriptor: PluginPackageDescriptor;
  packageDigest: string;
  selectionRevision: number;
  publicAssets: readonly string[];
};

function FixtureModule({ active }: { active: boolean }) {
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [visible, setVisible] = useState(true);
  const [data, setData] = useState("首次投影：界面来自实际安装包。");
  const [message, setMessage] = useState("");
  const [disposals, setDisposals] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    const catalog = await request<{ plugins: CatalogItem[] }>("catalog", {});
    setItem(catalog.plugins[0] ?? null);
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setMessage(String(error)));
  }, [refresh]);
  useEffect(() => {
    const listener = (event: Event) =>
      setDisposals((old) => [...old, String((event as CustomEvent).detail)]);
    document.addEventListener("independent-ui-fixture-disposed", listener);
    return () =>
      document.removeEventListener("independent-ui-fixture-disposed", listener);
  }, []);
  const acquireMount = useCallback(
    async (_signal: AbortSignal): Promise<PluginUiLease> => {
      if (!item) throw new Error("fixture_no_selection");
      // Do not abort this small allocation response: a cancelled effect still receives its own ref and closes it.
      // The loader checks the effect signal before mounting, and never reuses a previous generation's reference.
      const lease = parsePluginUiLease(
        await request("open", {
          pluginId: item.descriptor.pluginId,
          contributionId: "studio",
          expectedSelectionRevision: item.selectionRevision,
          expectedPackageDigest: item.packageDigest,
        }),
      );
      return lease;
    },
    [item],
  );
  const props = useMemo<PluginUiProps>(
    () => ({
      schemaVersion: "crewon.plugin-ui-props.v1",
      contributionId: "studio",
      theme: {
        mode:
          document.documentElement.dataset.theme === "light" ? "light" : "dark",
        tokens: {},
      },
      data,
    }),
    [data],
  );
  async function upgrade() {
    await request("upgrade", {});
    await refresh();
  }
  async function disable() {
    await request("disable", {});
    setVisible(false);
    await refresh();
  }
  return (
    <div style={{ padding: 24 }}>
      <p>本地安装验证 · 仅使用确定性测试能力，不连接模型或外部生成服务</p>
      <div
        style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}
      >
        <button
          onClick={() => setData("更新后的投影：需求修订 v2。")}
          type="button"
        >
          更新投影
        </button>
        <button
          onClick={() =>
            void upgrade().catch((error) => setMessage(String(error)))
          }
          type="button"
        >
          升级到 v2
        </button>
        <button onClick={() => setVisible((old) => !old)} type="button">
          {visible ? "卸载界面" : "重新挂载"}
        </button>
        <button
          onClick={() =>
            void disable().catch((error) => setMessage(String(error)))
          }
          type="button"
        >
          停用插件
        </button>
        <button
          onClick={() =>
            void request("revoke", {}).then(() => setMessage("权限已撤销"))
          }
          type="button"
        >
          撤销测试授权
        </button>
      </div>
      {item && visible ? (
        <PluginModuleMount
          loader={loader}
          active={active}
          acquireMount={acquireMount}
          mountKey={`${item.packageDigest}/${item.selectionRevision}`}
          props={props}
          onError={(error) => setMessage(String(error))}
        />
      ) : (
        <p>界面未挂载</p>
      )}
      <p aria-live="polite">{message}</p>
      <p aria-label="界面清理记录">
        界面清理：{disposals.join("、") || "暂无"}
      </p>
    </div>
  );
}
function FixtureHost() {
  const [composer, setComposer] = useState("");
  const [workbench, setWorkbench] = useState(false);
  const notice = () => undefined;
  return (
    <DesktopWindowFrame>
      <AppCommandShellRoute
        capabilityDrawer={{
          busyToolId: null,
          commandValue: "",
          disabled: true,
          locale: "zh",
          open: workbench,
          panel: null,
          scene: "office",
          terminalCwd: null,
          terminalOutput: emptyTerminalOutputStream,
          terminalProcessId: null,
          onClose: () => setWorkbench(false),
          onOpen: () => setWorkbench(true),
          onCommandChange: notice,
          onCommandSubmit: notice,
          onFiles: notice,
          onPanelAction: notice,
          onPanelFieldChange: notice,
          onPanelItem: notice,
          onReview: notice,
          onSideChat: notice,
          onTerminal: notice,
          onTerminalResize: notice,
          onTerminalStart: notice,
          onTerminalStop: notice,
          onTerminalWrite: notice,
        }}
        confirmDialog={{
          locale: "zh",
          request: null,
          onCancel: notice,
          onConfirm: notice,
        }}
        composerValue={composer}
        onChangeComposerValue={setComposer}
        connectionState="disconnected"
        cwd=""
        hostModule={{
          id: "example.ui-story",
          label: "独立插件验证",
          content: ({ active }) => <FixtureModule active={active} />,
        }}
        isSending={false}
        platform="mac"
        platformSnapshotLoader={async () => emptyAgentPlatformSnapshot}
        workMode="office"
        workspaceAuthority="control"
        onAttachContext={notice}
        onModeChange={notice}
        onOpenSettings={notice}
        onRetryConnection={notice}
        onSend={notice}
        onSendAssistant={notice}
        onSendNewThread={notice}
      />
    </DesktopWindowFrame>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FixtureHost />
  </StrictMode>,
);
