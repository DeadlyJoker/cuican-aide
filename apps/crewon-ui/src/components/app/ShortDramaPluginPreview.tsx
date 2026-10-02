import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppCommandShellRoute } from "./AppCommandShellRoute";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import { ShortDramaWorkbenchPreview } from "../short-drama/ShortDramaWorkbenchPreview";
import { DesktopWindowFrame } from "../DesktopWindowFrame";
import { ShortDramaPreviewSettings } from "./ShortDramaPreviewSettings";
import { Toaster } from "../ui/sonner";
import { emptyTerminalOutputStream } from "../../lib/terminal/terminalOutputStream";
import type { CommandScene } from "../../lib/scene/sceneCatalog";
import { detectPlatform, detectRuntimeSurface } from "../../lib/platform";
import { getInitialLocale } from "../../lib/i18n";

// The preview host supplies its own reader. The business module gets no session or execution client.
async function readPreviewPlatformSnapshot() {
  return emptyAgentPlatformSnapshot;
}

function previewNotice() {
  toast("当前为页面预览，不连接账号、执行任务或调用外部服务。");
}

/** Uses the existing visual override, without claiming a native execution bridge. */
export function initializeShortDramaPreviewSurface(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("surface", "desktop");
  url.searchParams.set("platform", "mac");
  url.searchParams.set("os", "mac");
  window.history.replaceState(window.history.state, "", url);
  document.documentElement.dataset.surface = detectRuntimeSurface();
}

/** Preview-only composition of the existing CrewON shell and one trusted business module. */
export function ShortDramaPluginPreview({
  referenceImage,
}: {
  referenceImage: string;
}) {
  const [composerValue, setComposerValue] = useState("");
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [scene, setScene] = useState<CommandScene>("office");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [locale, setLocale] = useState(getInitialLocale);
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);
  return (
    <DesktopWindowFrame locale={locale}>
      <div className="short-drama-plugin-preview" hidden={settingsOpen}>
        <AppCommandShellRoute
          capabilityDrawer={{
            busyToolId: null,
            commandValue: "",
            disabled: true,
            locale,
            // Suspend the drawer's document shortcuts while the existing shell stays mounted.
            open: workbenchOpen && !settingsOpen,
            panel: null,
            scene,
            terminalCwd: null,
            terminalOutput: emptyTerminalOutputStream,
            terminalProcessId: null,
            onClose: () => setWorkbenchOpen(false),
            onCommandChange: previewNotice,
            onCommandSubmit: previewNotice,
            onFiles: previewNotice,
            onOpen: () => setWorkbenchOpen(true),
            onPanelAction: previewNotice,
            onPanelFieldChange: previewNotice,
            onPanelItem: previewNotice,
            onReview: previewNotice,
            onSideChat: previewNotice,
            onTerminal: previewNotice,
            onTerminalResize: previewNotice,
            onTerminalStart: previewNotice,
            onTerminalStop: previewNotice,
            onTerminalWrite: previewNotice,
          }}
          composerValue={composerValue}
          confirmDialog={{
            locale,
            request: null,
            onCancel: previewNotice,
            onConfirm: previewNotice,
          }}
          connectionState="disconnected"
          locale={locale}
          cwd=""
          hostModule={{
            id: "crewon.short-drama",
            label: locale === "zh" ? "AI 短剧" : "AI drama",
            content: (
              <ShortDramaWorkbenchPreview referenceImage={referenceImage} />
            ),
          }}
          isSending={false}
          platform={detectPlatform()}
          platformSnapshotLoader={readPreviewPlatformSnapshot}
          workMode="office"
          workspaceAuthority="control"
          showSignedOutAccount
          onAttachContext={previewNotice}
          onChangeComposerValue={setComposerValue}
          onModeChange={previewNotice}
          onOpenSettings={() => {
            setSettingsVisited(true);
            setSettingsOpen(true);
          }}
          onRetryConnection={previewNotice}
          onSceneChange={setScene}
          onSend={previewNotice}
          onSendAssistant={previewNotice}
          onSendNewThread={previewNotice}
        />
      </div>
      {settingsVisited ? (
        <div hidden={!settingsOpen}>
          <ShortDramaPreviewSettings
            locale={locale}
            onLocaleChange={setLocale}
            onBack={() => setSettingsOpen(false)}
          />
        </div>
      ) : null}
      <Toaster closeButton gap={6} offset={52} position="top-right" />
    </DesktopWindowFrame>
  );
}
