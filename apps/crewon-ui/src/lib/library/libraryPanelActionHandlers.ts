import type { LibraryPanelAction } from "../domain/crewonDomain";
import {
  handleLibraryAgentAction,
  type LibraryAgentActionParams,
} from "./libraryAgentActions";
import {
  handleLibraryAutomationCreateAction,
  type LibraryAutomationCreateActionParams,
} from "./libraryAutomationCreateActions";
import {
  handleLibraryAutomationRunAction,
  type LibraryAutomationRunActionParams,
} from "./libraryAutomationRunActions";
import {
  handleLibraryDraftAction,
  type LibraryDraftActionParams,
} from "./libraryDraftActions";
import {
  handleLibraryFileAction,
  type LibraryFileActionParams,
} from "./libraryFileActions";
import {
  handleKnowledgeLibraryAction,
  type KnowledgeLibraryActionParams,
} from "./libraryKnowledgeActions";
import {
  handleLibraryMaintenanceAction,
  type LibraryMaintenanceActionParams,
} from "./libraryMaintenanceActions";
import {
  handleLibraryMcpAction,
  type LibraryMcpActionParams,
} from "./libraryMcpActions";
import {
  handleLibraryOfficeAction,
  type LibraryOfficeActionParams,
} from "./libraryOfficeActions";
import {
  handleLibraryOfficeRecruitAction,
  type LibraryOfficeRecruitActionParams,
} from "./libraryOfficeRecruitActions";
import type { LibraryPanelActionHandler } from "./libraryPanelActionFlow";
import {
  handleLibraryPluginAction,
  type LibraryPluginActionParams,
} from "./libraryPluginActions";
import {
  handleLibrarySkillAction,
  type LibrarySkillActionParams,
} from "./librarySkillActions";
import {
  handleLibraryThreadAction,
  type LibraryThreadActionParams,
} from "./libraryThreadActions";

type WithoutAction<TParams> = Omit<TParams, "action">;

export type LibraryPanelActionHandlers = {
  connectedHandlers: LibraryPanelActionHandler[];
  deferredHandlers: LibraryPanelActionHandler[];
  immediateHandlers: LibraryPanelActionHandler[];
};

export type LibraryPanelActionHandlersParams = {
  action: LibraryPanelAction;
  agent: WithoutAction<LibraryAgentActionParams>;
  automationCreate: WithoutAction<LibraryAutomationCreateActionParams>;
  automationRun: WithoutAction<LibraryAutomationRunActionParams>;
  draft: WithoutAction<LibraryDraftActionParams>;
  file: WithoutAction<LibraryFileActionParams>;
  knowledge: WithoutAction<KnowledgeLibraryActionParams>;
  maintenance: WithoutAction<LibraryMaintenanceActionParams>;
  mcp: WithoutAction<LibraryMcpActionParams>;
  office: WithoutAction<LibraryOfficeActionParams>;
  officeRecruit: WithoutAction<LibraryOfficeRecruitActionParams>;
  plugin: WithoutAction<LibraryPluginActionParams>;
  skill: WithoutAction<LibrarySkillActionParams>;
  thread: WithoutAction<LibraryThreadActionParams>;
};

export function createLibraryPanelActionHandlers({
  action,
  agent,
  automationCreate,
  automationRun,
  draft,
  file,
  knowledge,
  maintenance,
  mcp,
  office,
  officeRecruit,
  plugin,
  skill,
  thread,
}: LibraryPanelActionHandlersParams): LibraryPanelActionHandlers {
  return {
    immediateHandlers: [
      () => handleKnowledgeLibraryAction({ action, ...knowledge }),
      () => handleLibraryThreadAction({ action, ...thread }),
      () => handleLibraryOfficeRecruitAction({ action, ...officeRecruit }),
    ],
    connectedHandlers: [
      () => handleLibraryOfficeAction({ action, ...office }),
      () => handleLibraryAutomationCreateAction({ action, ...automationCreate }),
      () => handleLibraryAgentAction({ action, ...agent }),
      () => handleLibraryDraftAction({ action, ...draft }),
    ],
    deferredHandlers: [
      () => handleLibraryFileAction({ action, ...file }),
      () => handleLibraryMaintenanceAction({ action, ...maintenance }),
      () => handleLibraryAutomationRunAction({ action, ...automationRun }),
      () => handleLibraryMcpAction({ action, ...mcp }),
      () => handleLibrarySkillAction({ action, ...skill }),
      () => handleLibraryPluginAction({ action, ...plugin }),
    ],
  };
}
