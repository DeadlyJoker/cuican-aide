import type { LibraryItem } from "../domain/crewonDomain";
import {
  openAgentConfigAction,
  type OpenAgentConfigActionParams,
} from "../agent-config/agentConfigActions";
import {
  openAutomationDetailAction,
  type OpenAutomationDetailActionParams,
} from "../automation/automationDetailActions";
import {
  openExternalAgentImportAction,
  type OpenExternalAgentImportActionParams,
} from "../external-agent/externalAgentImportActions";
import type { LibraryItemOpenHandlers } from "./libraryItemActionFlow";
import {
  openMcpDetailAction,
  type OpenMcpDetailActionParams,
} from "../mcp/mcpDetailActions";
import {
  openOfficeDetailAction,
  type OpenOfficeDetailActionParams,
} from "../office/officeDetailActions";
import {
  openPluginDetailAction,
  type OpenPluginDetailActionParams,
} from "../plugin/pluginDetailActions";
import {
  openPluginSkillDetailAction,
  openSkillFileDetailAction,
  type OpenPluginSkillDetailActionParams,
  type OpenSkillFileDetailActionParams,
} from "../skill/skillDetailActions";

type WithoutAction<TParams> = Omit<TParams, "action">;

export type LibraryItemOpenHandlersParams = {
  agentConfig: WithoutAction<OpenAgentConfigActionParams>;
  automationDetail: WithoutAction<OpenAutomationDetailActionParams>;
  externalAgentImport: Omit<OpenExternalAgentImportActionParams, "item">;
  mcpDetail: WithoutAction<OpenMcpDetailActionParams>;
  officeDetail: WithoutAction<OpenOfficeDetailActionParams>;
  plugin: WithoutAction<OpenPluginDetailActionParams>;
  pluginSkill: Omit<OpenPluginSkillDetailActionParams, "action" | "fallbackTitle">;
  skillFile: {
    open: WithoutAction<OpenSkillFileDetailActionParams>;
    refreshAction: (
      action: Parameters<LibraryItemOpenHandlers["skillFile"]>[0],
    ) => Promise<OpenSkillFileDetailActionParams["action"]>;
  };
};

export function createLibraryItemOpenHandlers({
  agentConfig,
  automationDetail,
  externalAgentImport,
  mcpDetail,
  officeDetail,
  plugin,
  pluginSkill,
  skillFile,
}: LibraryItemOpenHandlersParams): LibraryItemOpenHandlers {
  return {
    agentConfig: (action) => openAgentConfigAction({ action, ...agentConfig }),
    automationDetail: (action) =>
      openAutomationDetailAction({ action, ...automationDetail }),
    externalAgentImport: (action) =>
      openExternalAgentImportAction({
        item: action.item,
        ...externalAgentImport,
      }),
    mcpDetail: (action) => openMcpDetailAction({ action, ...mcpDetail }),
    officeDetail: (action) => openOfficeDetailAction({ action, ...officeDetail }),
    plugin: (action) => openPluginDetailAction({ action, ...plugin }),
    pluginSkill: (action, item: LibraryItem) =>
      openPluginSkillDetailAction({
        action,
        fallbackTitle: item.title,
        ...pluginSkill,
      }),
    skillFile: async (action) => {
      const refreshedAction = await skillFile.refreshAction(action);
      await openSkillFileDetailAction({
        action: refreshedAction,
        ...skillFile.open,
      });
    },
  };
}
