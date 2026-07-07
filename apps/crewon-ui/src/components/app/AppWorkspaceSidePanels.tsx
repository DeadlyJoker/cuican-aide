import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import { CapabilityDock } from "../CapabilityDock";
import { Inspector } from "../Inspector";
import type { AppView } from "../../lib/shared/appView";
import type {
  AccountStatus,
  GitRemoteDiffSummary,
} from "../../lib/shared/statusTypes";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";

type AppWorkspaceSidePanelsProps = {
  accountStatus: AccountStatus | null;
  appView: AppView;
  busyToolId: ToolId | null;
  capabilityDockOpen: boolean;
  capabilityPanel: CapabilityPanel | null;
  conversationSummary: ConversationSummary | null;
  disabled: boolean;
  gitRemoteDiff: GitRemoteDiffSummary | null;
  inspectorOpen: boolean;
  loadedThreadIds: string[];
  locale: Locale;
  serverUrl: string;
  terminalCommand: string;
  thread: Thread | null;
  threadGoal: ThreadGoal | null;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onFiles: () => void;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
  onReview: () => void;
  onSideChat: () => void;
  onTerminal: () => void;
  onWeb: () => void;
};

export function AppWorkspaceSidePanels({
  accountStatus,
  appView,
  busyToolId,
  capabilityDockOpen,
  capabilityPanel,
  conversationSummary,
  disabled,
  gitRemoteDiff,
  inspectorOpen,
  loadedThreadIds,
  locale,
  serverUrl,
  terminalCommand,
  thread,
  threadGoal,
  onCommandChange,
  onCommandSubmit,
  onFiles,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
  onReview,
  onSideChat,
  onTerminal,
  onWeb,
}: AppWorkspaceSidePanelsProps) {
  const showCapabilityDock =
    capabilityDockOpen && capabilityPanel && appView !== "settings";

  return (
    <>
      {showCapabilityDock ? (
        <aside
          className="right-sidebar"
          aria-label={locale === "zh" ? "右栏" : "Right sidebar"}
        >
          <CapabilityDock
            locale={locale}
            disabled={disabled}
            busyToolId={busyToolId}
            commandValue={terminalCommand}
            panel={capabilityPanel}
            onCommandChange={onCommandChange}
            onCommandSubmit={onCommandSubmit}
            onFiles={onFiles}
            onPanelAction={onPanelAction}
            onPanelFieldChange={onPanelFieldChange}
            onPanelItem={onPanelItem}
            onReview={onReview}
            onSideChat={onSideChat}
            onTerminal={onTerminal}
            onWeb={onWeb}
          />
        </aside>
      ) : null}
      {inspectorOpen && appView === "chat" ? (
        <Inspector
          account={accountStatus}
          conversationSummary={conversationSummary}
          gitRemoteDiff={gitRemoteDiff}
          loadedThreadIds={loadedThreadIds}
          locale={locale}
          serverUrl={serverUrl}
          thread={thread}
          threadGoal={threadGoal}
        />
      ) : null}
    </>
  );
}
