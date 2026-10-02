import { useRef, useState, type MouseEvent } from "react";
import { PanelLeft } from "lucide-react";
import { toast } from "sonner";
import { CommandWorkspace } from "./CommandWorkspace";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import { ShortDramaWorkbenchPreview } from "../short-drama/ShortDramaWorkbenchPreview";
import "./ShortDramaPluginPreview.css";

// The preview host supplies its own reader. The business module gets no session or execution client.
async function readPreviewPlatformSnapshot() {
  return emptyAgentPlatformSnapshot;
}

function previewNotice() {
  toast("当前为页面预览，不连接账号、执行任务或调用外部服务。");
}

/** Preview-only composition of the existing CrewON shell and one trusted business module. */
export function ShortDramaPluginPreview({
  referenceImage,
}: {
  referenceImage: string;
}) {
  const [composerValue, setComposerValue] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  function closeNavigation() {
    setNavigationOpen(false);
    navigationTrigger.current?.focus();
  }
  function handleHostNavigation(event: MouseEvent<HTMLDivElement>) {
    if (window.innerWidth > 860 || !(event.target instanceof Element)) return;
    if (event.target.closest("[data-sidebar-collapse]")) {
      // The preview drawer closes through the host's existing sidebar control.
      event.preventDefault();
      event.stopPropagation();
      closeNavigation();
    } else if (event.target.closest(".sidebar-nav button, .sidebar-brand")) {
      closeNavigation();
    }
  }
  return (
    <div
      className="command-shell-route short-drama-plugin-preview"
      data-preview-navigation-open={navigationOpen}
      onClickCapture={handleHostNavigation}
      onKeyDown={(event) => {
        if (event.key === "Escape" && navigationOpen) closeNavigation();
      }}
    >
      <button
        ref={navigationTrigger}
        aria-label="打开导航"
        aria-expanded={navigationOpen}
        className="sidebar-tool short-drama-preview-navigation-trigger"
        type="button"
        onClick={() => setNavigationOpen(true)}
      >
        <PanelLeft aria-hidden="true" />
      </button>
      {navigationOpen ? (
        <button
          aria-label="关闭导航"
          className="short-drama-preview-navigation-scrim"
          type="button"
          onClick={closeNavigation}
        />
      ) : null}
      <CommandWorkspace
        composerValue={composerValue}
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
        platform="web"
        platformSnapshotLoader={readPreviewPlatformSnapshot}
        workMode="office"
        workspaceAuthority="control"
        onAttachContext={previewNotice}
        onChangeComposerValue={setComposerValue}
        onModeChange={previewNotice}
        onOpenSettings={previewNotice}
        onRetryConnection={previewNotice}
        onSend={previewNotice}
        onSendAssistant={previewNotice}
        onSendNewThread={previewNotice}
      />
    </div>
  );
}
