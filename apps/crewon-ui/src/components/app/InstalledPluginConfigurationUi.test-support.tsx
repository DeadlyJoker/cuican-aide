/** Named Web acceptance fixture: the actual shell and settings route, not App/authentication acceptance. */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ControlApiClient } from "@crewon/control-client";
import { DesktopWindowFrame } from "../DesktopWindowFrame";
import { AppCommandShellRoute } from "./AppCommandShellRoute";
import { CommandSettingsRoute } from "./CommandSettingsRoute";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import { emptyTerminalOutputStream } from "../../lib/terminal/terminalOutputStream";
import { detectPlatform, detectRuntimeSurface } from "../../lib/platform";
import type { CommandScene } from "../../lib/scene/sceneCatalog";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";

const unavailable = () => {};
const platformSnapshot = async () => emptyAgentPlatformSnapshot;

function ConfigurationUiProof({ client }: { client: ControlApiClient }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [scene, setScene] = useState<CommandScene>("office");
  const [composer, setComposer] = useState("");
  return (
    <DesktopWindowFrame locale="zh">
      {settingsOpen ? (
        <CommandSettingsRoute
          controlClient={client}
          activeSection={section}
          dataMode="live"
          disabled={false}
          locale="zh"
          notice={null}
          panel={null}
          platform={detectPlatform()}
          onBack={() => setSettingsOpen(false)}
          onDismissNotice={unavailable}
          onPanelAction={unavailable}
          onPanelFieldChange={unavailable}
          onPanelFieldCommit={unavailable}
          onSectionChange={setSection}
        />
      ) : (
        <AppCommandShellRoute
          capabilityDrawer={{
            busyToolId: null,
            commandValue: "",
            disabled: true,
            locale: "zh",
            open: false,
            panel: null,
            scene,
            terminalCwd: null,
            terminalOutput: emptyTerminalOutputStream,
            terminalProcessId: null,
            onClose: unavailable,
            onCommandChange: unavailable,
            onCommandSubmit: unavailable,
            onFiles: unavailable,
            onOpen: unavailable,
            onPanelAction: unavailable,
            onPanelFieldChange: unavailable,
            onPanelItem: unavailable,
            onReview: unavailable,
            onSideChat: unavailable,
            onTerminal: unavailable,
            onTerminalResize: unavailable,
            onTerminalStart: unavailable,
            onTerminalStop: unavailable,
            onTerminalWrite: unavailable,
          }}
          composerValue={composer}
          confirmDialog={{
            locale: "zh",
            request: null,
            onCancel: unavailable,
            onConfirm: unavailable,
          }}
          connectionState="disconnected"
          locale="zh"
          cwd=""
          isSending={false}
          platform={detectPlatform()}
          platformSnapshotLoader={platformSnapshot}
          workMode="office"
          workspaceAuthority="control"
          showSignedOutAccount
          onAttachContext={unavailable}
          onChangeComposerValue={setComposer}
          onModeChange={unavailable}
          onOpenSettings={() => setSettingsOpen(true)}
          onRetryConnection={unavailable}
          onSceneChange={setScene}
          onSend={unavailable}
          onSendAssistant={unavailable}
          onSendNewThread={unavailable}
        />
      )}
    </DesktopWindowFrame>
  );
}

// This visual override does not create a Native bridge or authenticated platform account.
document.documentElement.dataset.surface = detectRuntimeSurface();
document.documentElement.dataset.theme = "light";
document.documentElement.lang = "zh-CN";
try {
  const response = await fetch("/control-api/session", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("named_web_session_unavailable");
  const session: unknown = await response.json();
  if (
    session === null ||
    typeof session !== "object" ||
    Object.keys(session).sort().join(",") !== "baseUrl,csrfToken" ||
    !("baseUrl" in session) ||
    session.baseUrl !== "/" ||
    !("csrfToken" in session) ||
    typeof session.csrfToken !== "string"
  )
    throw new Error("named_web_session_invalid");
  const client = new ControlApiClient({
    baseUrl: location.origin,
    origin: location.origin,
    csrfToken: session.csrfToken,
  });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ConfigurationUiProof client={client} />
    </StrictMode>,
  );
} catch {
  document.body.dataset.proofError = "named_web_fixture_bootstrap_failed";
}
