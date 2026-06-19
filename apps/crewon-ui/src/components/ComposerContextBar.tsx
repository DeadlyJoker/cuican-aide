import { Circle, FolderOpen, RefreshCw, Settings2 } from "lucide-react";

export function ComposerContextBar({
  connectionStatusLabel,
  connectionTone,
  cwd,
  noWorkspaceSelectedLabel,
  retryConnectionLabel,
  threadSettingsLabel,
  onRetryConnection,
  onThreadSettings,
}: {
  connectionStatusLabel: string;
  connectionTone: "connected" | "connecting" | "demo";
  cwd: string;
  noWorkspaceSelectedLabel: string;
  retryConnectionLabel: string;
  threadSettingsLabel: string;
  onRetryConnection: () => void;
  onThreadSettings: () => void;
}) {
  return (
    <div className="composer-context">
      <span
        className="composer-workspace-chip"
        title={cwd || noWorkspaceSelectedLabel}
      >
        <FolderOpen size={14} />
        {cwd || noWorkspaceSelectedLabel}
      </span>
      <div className="composer-context-actions">
        <span
          className="composer-status-pill"
          data-tone={connectionTone}
          title={connectionStatusLabel}
        >
          <Circle size={8} fill="currentColor" />
          {connectionStatusLabel}
        </span>
        {connectionTone === "demo" ? (
          <button
            className="composer-retry-button"
            type="button"
            title={retryConnectionLabel}
            onClick={onRetryConnection}
          >
            <RefreshCw size={13} />
            {retryConnectionLabel}
          </button>
        ) : null}
        <button
          className="icon-button"
          type="button"
          aria-label={threadSettingsLabel}
          title={threadSettingsLabel}
          onClick={onThreadSettings}
        >
          <Settings2 size={16} />
        </button>
      </div>
    </div>
  );
}
