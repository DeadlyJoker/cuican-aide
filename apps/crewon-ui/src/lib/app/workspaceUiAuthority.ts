import type { AppWorkspaceCapabilityHandlers } from "./handlers/appWorkspaceCapabilityHandlers";

export type WorkspaceUiAuthority = "control" | "legacy";

type LegacyWorkspaceCapabilityHandlers = Pick<
  AppWorkspaceCapabilityHandlers,
  "attachWorkspaceContext" | "readWorkspaceDiff" | "readWorkspaceFiles"
>;

/** Selects one complete workspace surface without crossing its path authority. */
export function workspaceCapabilityHandlersForAuthority(input: {
  authority: WorkspaceUiAuthority;
  control: LegacyWorkspaceCapabilityHandlers;
  legacy: LegacyWorkspaceCapabilityHandlers;
}): LegacyWorkspaceCapabilityHandlers {
  return input.authority === "legacy" ? input.legacy : input.control;
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
