import type { SettingsSection } from "./settingsCatalog";

export type SettingsRefreshAction =
  | "appearance"
  | "appSnapshots"
  | "browserApps"
  | "computerControl"
  | "config"
  | "connections"
  | "environment"
  | "git"
  | "hooks"
  | "integrations"
  | "keyboard"
  | "mcpSettings"
  | "personalization"
  | "worktrees";

export type SettingsSaveAction = "appearance" | "config" | "personalization";

export type WorktreeDemoAction = "created" | "forked" | "refreshed";

export type SettingsSectionRefreshHandlers = {
  account: () => void | Promise<void>;
  appearance: () => void | Promise<void>;
  appSnapshots: () => void | Promise<void>;
  browser: () => void | Promise<void>;
  computerControl: () => void | Promise<void>;
  config: () => void | Promise<void>;
  connections: () => void | Promise<void>;
  environment: () => void | Promise<void>;
  git: () => void | Promise<void>;
  hooks: () => void | Promise<void>;
  keyboard: () => void | Promise<void>;
  mcpServers: () => void | Promise<void>;
  personalization: () => void | Promise<void>;
  worktrees: () => void | Promise<void>;
};

export async function refreshSettingsSectionAction(
  section: SettingsSection,
  handlers: SettingsSectionRefreshHandlers,
): Promise<void> {
  switch (section) {
    case "account":
      return await handlers.account();
    case "appearance":
      return await handlers.appearance();
    case "app-snapshots":
      return await handlers.appSnapshots();
    case "browser":
      return await handlers.browser();
    case "computer-control":
      return await handlers.computerControl();
    case "config":
      return await handlers.config();
    case "connections":
      return await handlers.connections();
    case "environment":
      return await handlers.environment();
    case "git":
      return await handlers.git();
    case "hooks":
      return await handlers.hooks();
    case "keyboard":
      return await handlers.keyboard();
    case "mcp-servers":
      return await handlers.mcpServers();
    case "personalization":
      return await handlers.personalization();
    case "worktrees":
      return await handlers.worktrees();
  }
}

export function settingsRefreshActionForActionId(
  actionId: string,
): SettingsRefreshAction | null {
  switch (actionId) {
    case "refresh-config":
      return "config";
    case "refresh-appearance":
      return "appearance";
    case "refresh-personalization":
      return "personalization";
    case "refresh-keyboard":
      return "keyboard";
    case "refresh-integrations":
      return "integrations";
    case "refresh-hooks":
      return "hooks";
    case "refresh-mcp-settings":
      return "mcpSettings";
    case "refresh-browser-apps":
      return "browserApps";
    case "refresh-environment":
      return "environment";
    case "refresh-computer-control":
      return "computerControl";
    case "refresh-app-snapshots":
      return "appSnapshots";
    case "refresh-connections":
      return "connections";
    case "refresh-git":
      return "git";
    case "refresh-worktrees":
      return "worktrees";
    default:
      return null;
  }
}

export function settingsSaveActionForActionId(
  actionId: string,
): SettingsSaveAction | null {
  switch (actionId) {
    case "save-appearance":
      return "appearance";
    case "save-config":
      return "config";
    case "save-personalization":
      return "personalization";
    default:
      return null;
  }
}

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
