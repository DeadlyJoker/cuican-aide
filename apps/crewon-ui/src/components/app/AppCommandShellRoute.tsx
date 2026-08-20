import type { ComponentProps } from "react";

import { AppConfirmDialog } from "./AppConfirmDialog";
import { CommandWorkspace } from "./CommandWorkspace";
import {
  CommandWorkspaceCapabilityDrawer,
  type CommandWorkspaceCapabilityDrawerProps,
} from "./CommandWorkspaceCapabilityDrawer";

type AppCommandShellRouteProps = ComponentProps<typeof CommandWorkspace> & {
  capabilityDrawer: CommandWorkspaceCapabilityDrawerProps;
  confirmDialog: ComponentProps<typeof AppConfirmDialog>;
};

export function AppCommandShellRoute({
  capabilityDrawer,
  confirmDialog,
  ...commandWorkspaceProps
}: AppCommandShellRouteProps) {
  return (
    <div
      className="command-shell-route"
      data-capability-sidebar-open={capabilityDrawer.open ? "true" : "false"}
    >
      <CommandWorkspace {...commandWorkspaceProps} />
      <CommandWorkspaceCapabilityDrawer
        {...capabilityDrawer}
        onSelectThread={commandWorkspaceProps.onSelectLinkedThread}
        selectedThreadId={commandWorkspaceProps.selectedThreadId}
        taskThreads={commandWorkspaceProps.linkedThreads}
      />
      <AppConfirmDialog {...confirmDialog} />
    </div>
  );
}
