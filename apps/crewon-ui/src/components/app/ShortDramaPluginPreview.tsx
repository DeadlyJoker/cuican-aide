import { useState } from "react";
import { toast } from "sonner";
import { AppCommandShellRoute } from "./AppCommandShellRoute";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import { ShortDramaWorkbenchPreview } from "../short-drama/ShortDramaWorkbenchPreview";
import { DesktopWindowFrame } from "../DesktopWindowFrame";
import { Toaster } from "../ui/sonner";
import { emptyTerminalOutputStream } from "../../lib/terminal/terminalOutputStream";
import type { CommandScene } from "../../lib/scene/sceneCatalog";
import { detectPlatform, detectRuntimeSurface } from "../../lib/platform";

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
  return (
    <DesktopWindowFrame>
      <div className="short-drama-plugin-preview">
        <AppCommandShellRoute
          capabilityDrawer={{
            busyToolId: null,
            commandValue: "",
            disabled: true,
            locale: "zh",
            open: workbenchOpen,
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
            locale: "zh",
            request: null,
            onCancel: previewNotice,
            onConfirm: previewNotice,
          }}
          connectionState="disconnected"
          cwd=""
          hostModule={{
            id: "crewon.short-drama",
            label: "AI 短剧",
            content: (
              <ShortDramaWorkbenchPreview referenceImage={referenceImage} />
            ),
          }}
          isSending={false}
          platform={detectPlatform()}
          platformSnapshotLoader={readPreviewPlatformSnapshot}
          workMode="office"
          workspaceAuthority="control"
          onAttachContext={previewNotice}
          onChangeComposerValue={setComposerValue}
          onModeChange={previewNotice}
          onOpenSettings={previewNotice}
          onRetryConnection={previewNotice}
          onSceneChange={setScene}
          onSend={previewNotice}
          onSendAssistant={previewNotice}
          onSendNewThread={previewNotice}
        />
      </div>
      <Toaster closeButton gap={6} offset={52} position="top-right" />
    </DesktopWindowFrame>
  );
}
