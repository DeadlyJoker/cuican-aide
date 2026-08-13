import type { ConversationSummary } from "@crewon-ui-model/ConversationSummary";
import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

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
  thread: Thread | null;
  threadGoal: ThreadGoalView | null;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
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
  thread,
  threadGoal,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
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
            panel={capabilityPanel}
            onPanelAction={onPanelAction}
            onPanelFieldChange={onPanelFieldChange}
            onPanelItem={onPanelItem}
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
