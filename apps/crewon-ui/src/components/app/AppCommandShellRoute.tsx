import type { ComponentProps } from "react";
import { AlertTriangle } from "lucide-react";

import type { NoticeState } from "../../lib/shared/noticeState";
import { AppConfirmDialog } from "./AppConfirmDialog";
import { CommandWorkspace } from "./CommandWorkspace";
import {
  CommandWorkspaceCapabilityDrawer,
  type CommandWorkspaceCapabilityDrawerProps,
} from "./CommandWorkspaceCapabilityDrawer";

type AppCommandShellRouteProps = ComponentProps<typeof CommandWorkspace> & {
  capabilityDrawer: CommandWorkspaceCapabilityDrawerProps;
  confirmDialog: ComponentProps<typeof AppConfirmDialog>;
  notice: NoticeState | null;
  onDismissNotice: () => void;
};

export function CommandShellNotice({
  locale,
  notice,
  onDismissNotice,
}: {
  locale: "en" | "zh";
  notice: NoticeState | null;
  onDismissNotice: () => void;
}) {
  if (!notice) return null;
  const dismissLabel = locale === "zh" ? "关闭通知" : "Dismiss notice";
  return (
    <div className="notice-stack command-shell-notice">
      <div className="connection-notice" data-tone={notice.tone} role="status">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>{notice.text}</span>
        <button
          aria-label={dismissLabel}
          title={dismissLabel}
          type="button"
          onClick={onDismissNotice}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}

export function AppCommandShellRoute({
  capabilityDrawer,
  confirmDialog,
  notice,
  onDismissNotice,
  ...commandWorkspaceProps
}: AppCommandShellRouteProps) {
  return (
    <div
      className="command-shell-route"
      data-capability-sidebar-open={capabilityDrawer.open ? "true" : "false"}
    >
      <CommandShellNotice
        locale={commandWorkspaceProps.locale ?? "zh"}
        notice={notice}
        onDismissNotice={onDismissNotice}
      />
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
