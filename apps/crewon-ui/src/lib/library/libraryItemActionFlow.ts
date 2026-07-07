import type { LibraryItem, LibraryItemAction } from "../domain/crewonDomain";

type AgentConfigAction = Extract<LibraryItemAction, { type: "agent-config" }>;
type AutomationDetailAction = Extract<
  LibraryItemAction,
  { type: "automation-detail" }
>;
type ExternalAgentImportAction = Extract<
  LibraryItemAction,
  { type: "external-agent-import" }
>;
type McpDetailAction = Extract<LibraryItemAction, { type: "mcp-detail" }>;
type OfficeDetailAction = Extract<LibraryItemAction, { type: "office-detail" }>;
type PluginAction = Extract<LibraryItemAction, { type: "plugin" }>;
type PluginSkillAction = Extract<LibraryItemAction, { type: "plugin-skill" }>;
type SkillFileAction = Extract<LibraryItemAction, { type: "skill-file" }>;

export type LibraryItemActionGateParams = {
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  item: LibraryItem;
  markLibraryLoad: () => void;
};

export type LibraryItemOpenHandlers = {
  agentConfig: (action: AgentConfigAction) => unknown | Promise<unknown>;
  automationDetail: (
    action: AutomationDetailAction,
  ) => unknown | Promise<unknown>;
  externalAgentImport: (
    action: ExternalAgentImportAction,
  ) => unknown | Promise<unknown>;
  mcpDetail: (action: McpDetailAction) => unknown | Promise<unknown>;
  officeDetail: (action: OfficeDetailAction) => unknown | Promise<unknown>;
  plugin: (action: PluginAction) => unknown | Promise<unknown>;
  pluginSkill: (
    action: PluginSkillAction,
    item: LibraryItem,
  ) => unknown | Promise<unknown>;
  skillFile: (action: SkillFileAction) => unknown | Promise<unknown>;
};

export type OpenLibraryItemActionParams = LibraryItemActionGateParams & {
  handlers: LibraryItemOpenHandlers;
};

export function isLocalLibraryItemAction(action: LibraryItemAction): boolean {
  switch (action.type) {
    case "agent-config":
    case "automation-detail":
    case "mcp-detail":
    case "office-detail":
      return true;
    case "external-agent-import":
    case "plugin":
    case "plugin-skill":
    case "skill-file":
      return false;
  }
}

export function libraryItemActionForOpen({
  isConnected,
  isDemo,
  isDemoPreview,
  item,
  markLibraryLoad,
}: LibraryItemActionGateParams): LibraryItemAction | null {
  if (!item.action) {
    return null;
  }

  const action = item.action;
  const isLocalLibraryAction = isLocalLibraryItemAction(action);
  if (!isConnected && !isDemo && !(isDemoPreview && isLocalLibraryAction)) {
    return null;
  }

  markLibraryLoad();

  if (isDemo && !isLocalLibraryAction) {
    return null;
  }

  return action;
}

export async function openLibraryItemAction({
  handlers,
  ...gateParams
}: OpenLibraryItemActionParams): Promise<boolean> {
  const action = libraryItemActionForOpen(gateParams);
  if (!action) {
    return false;
  }

  switch (action.type) {
    case "agent-config":
      await handlers.agentConfig(action);
      return true;
    case "automation-detail":
      await handlers.automationDetail(action);
      return true;
    case "external-agent-import":
      await handlers.externalAgentImport(action);
      return true;
    case "mcp-detail":
      await handlers.mcpDetail(action);
      return true;
    case "office-detail":
      await handlers.officeDetail(action);
      return true;
    case "plugin":
      await handlers.plugin(action);
      return true;
    case "plugin-skill":
      await handlers.pluginSkill(action, gateParams.item);
      return true;
    case "skill-file":
      await handlers.skillFile(action);
      return true;
  }
}
