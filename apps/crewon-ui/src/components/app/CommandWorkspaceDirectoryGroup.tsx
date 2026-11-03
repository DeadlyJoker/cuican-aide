import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { classNames } from "./commandWorkspaceUtils";

/** Shared directory row for native workspaces and plugin-owned project groups. */
export function CommandWorkspaceDirectoryGroup({
  id,
  name,
  current = false,
  initiallyCollapsed = false,
  actions,
  children,
  onOpen,
  onExpand,
}: {
  id: string;
  name: string;
  current?: boolean;
  initiallyCollapsed?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
  onExpand?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  useEffect(() => {
    if (current) setCollapsed(false);
  }, [current]);
  const toggle = () => {
    setCollapsed(!collapsed);
    if (collapsed) onExpand?.();
  };
  const disclosure = <ChevronRight aria-hidden="true" />;
  const folder = current ? (
    <FolderOpen aria-hidden="true" />
  ) : (
    <Folder aria-hidden="true" />
  );
  return (
    <div
      className={classNames(
        "space-node real-workspace-node",
        current && "current",
        collapsed && "collapsed",
      )}
      data-workspace-id={id}
    >
      <div className="space-title real-workspace-title">
        {onOpen ? (
          <>
            <button
              className="workspace-directory-disclosure"
              type="button"
              aria-label={`${collapsed ? "展开" : "收起"}${name}`}
              aria-expanded={!collapsed}
              aria-controls={`workspace-threads-${id}`}
              onClick={toggle}
            >
              {disclosure}
            </button>
            <button
              className="workspace-title-toggle"
              type="button"
              onClick={() => {
                setCollapsed(false);
                onExpand?.();
                onOpen();
              }}
            >
              {folder}
              <strong>{name}</strong>
            </button>
          </>
        ) : (
          <button
            className="workspace-title-toggle"
            type="button"
            aria-label={`${collapsed ? "展开" : "收起"}${name}`}
            aria-expanded={!collapsed}
            aria-controls={`workspace-threads-${id}`}
            onClick={toggle}
          >
            {disclosure}
            {folder}
            <strong>{name}</strong>
          </button>
        )}
        <span className="workspace-row-actions">{actions}</span>
      </div>
      <div
        className="conversation-list recent-thread-list"
        id={`workspace-threads-${id}`}
        hidden={collapsed}
      >
        {children}
      </div>
    </div>
  );
}
