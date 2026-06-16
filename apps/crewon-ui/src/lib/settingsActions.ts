import type { SettingsSection } from "./settingsCatalog";

export type WorktreeDemoAction = "created" | "forked" | "refreshed";

export function demoSettingsSectionForAction(
  actionId: string,
): SettingsSection | null {
  switch (actionId) {
    case "refresh-account":
      return "account";
    case "refresh-config":
      return "config";
    case "refresh-keyboard":
      return "keyboard";
    case "refresh-integrations":
    case "refresh-mcp-settings":
    case "reload-tools":
      return "mcp-servers";
    case "refresh-browser-apps":
      return "browser";
    case "refresh-app-snapshots":
      return "app-snapshots";
    case "refresh-connections":
      return "connections";
    case "refresh-git":
      return "git";
    case "refresh-hooks":
      return "hooks";
    default:
      if (
        actionId === "refresh-environment" ||
        actionId.startsWith("setup-windows-sandbox-")
      ) {
        return "environment";
      }
      if (isComputerControlDemoAction(actionId)) {
        return "computer-control";
      }
      return null;
  }
}

export function isAuthDemoAction(actionId: string): boolean {
  return (
    actionId === "login-chatgpt" ||
    actionId === "login-device-code" ||
    actionId === "logout-account"
  );
}

export function isComputerControlDemoAction(actionId: string): boolean {
  return (
    actionId === "refresh-computer-control" ||
    actionId === "enable-remote-control" ||
    actionId === "disable-remote-control" ||
    actionId === "start-remote-pairing" ||
    actionId === "revoke-remote-client"
  );
}

export function worktreeDemoAction(actionId: string): WorktreeDemoAction | null {
  switch (actionId) {
    case "refresh-worktrees":
      return "refreshed";
    case "fork-worktree":
      return "forked";
    case "create-worktree-session":
      return "created";
    default:
      return null;
  }
}
