import type { AppWorkspaceCapabilityHandlers } from "./handlers/appWorkspaceCapabilityHandlers";

export type WorkspaceUiAuthority = "control" | "legacy";

type LegacyWorkspaceCapabilityHandlers = Pick<
  AppWorkspaceCapabilityHandlers,
  "attachWorkspaceContext" | "readWorkspaceDiff" | "readWorkspaceFiles"
>;

/**
 * Cuts the legacy AppServer filesystem surface out of a configured Control
 * cohort. The unavailable callback is presentation-only; it cannot receive or
 * recover a caller-provided path.
 */
export function workspaceCapabilityHandlersForAuthority(input: {
  authority: WorkspaceUiAuthority;
  legacy: LegacyWorkspaceCapabilityHandlers;
  onUnavailable: () => void;
}): LegacyWorkspaceCapabilityHandlers {
  if (input.authority === "legacy") {
    return input.legacy;
  }
  const unavailable = async () => {
    input.onUnavailable();
  };
  return {
    attachWorkspaceContext: unavailable,
    readWorkspaceDiff: unavailable,
    readWorkspaceFiles: unavailable,
  };
}

export function workspaceCwdForAuthority(
  authority: WorkspaceUiAuthority,
  cwd: string,
): string | null {
  return authority === "legacy" ? cwd.trim() || null : null;
}

export function isLegacyWorkspacePanelItem(input: {
  action?: unknown;
  intent?: string;
  kind?: string;
  path?: string;
}): boolean {
  return Boolean(
    input.path &&
      (input.intent === "attach-context" ||
        (!input.action &&
          (input.kind === "directory" || input.kind === "file"))),
  );
}
