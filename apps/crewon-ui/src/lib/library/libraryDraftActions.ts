import type { JsonValue } from "@crewon/app-server-protocol/serde_json/JsonValue";

import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  LibraryPanelAction,
  ToolConfig,
} from "../domain/crewonDomain";
import {
  buildMcpDraftPanel,
  buildMcpDraftPayload,
  buildSkillDraftPanel,
  buildSkillDraftPayload,
  draftPayloadErrorPanel,
  draftTimestampName,
  mcpDraftSavedNotice,
  mcpDraftSavingPanel,
  skillDraftMissingWorkspacePanel,
  skillDraftSavedNotice,
  skillDraftSavingPanel,
} from "../draft/draftSavePayloads";
import type { Locale } from "../i18n";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

type ToolRecordSaveSummary = {
  filePath: string;
  operation: "created" | "updated";
};

type SkillCreateResponse = {
  skill: {
    description: string;
    enabled: boolean;
    name: string;
    path: string;
  };
};

export type LibraryDraftActionParams = {
  action: LibraryPanelAction;
  createSkill: (params: {
    body: string;
    cwd: string;
    description: string;
    name: string;
  }) => Promise<SkillCreateResponse | null | undefined>;
  fields: LibraryPanel["fields"] | null | undefined;
  locale: Locale;
  now: () => Date;
  openToolsLibrary: () => Promise<void>;
  reloadMcpServerConfig: (params: {
    config: Record<string, JsonValue>;
    name: string;
  }) => Promise<void>;
  resolveBackendCwd: () => Promise<string | null>;
  saveOrUpdateToolConfig: (
    cwd: string,
    toolRecord: ToolConfig,
  ) => Promise<ToolRecordSaveSummary>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  writeSkillFile: (path: string, body: string) => Promise<unknown>;
};

export async function handleLibraryDraftAction({
  action,
  createSkill,
  fields,
  locale,
  now,
  openToolsLibrary,
  reloadMcpServerConfig,
  resolveBackendCwd,
  saveOrUpdateToolConfig,
  setLibraryPanel,
  setNotice,
  writeSkillFile,
}: LibraryDraftActionParams): Promise<boolean> {
  if (action.id === "create-mcp") {
    const timestamp = draftTimestamp(now());
    const serverName = draftTimestampName("workspace-mcp", timestamp);
    setLibraryPanel((currentPanel) =>
      buildMcpDraftPanel(currentPanel, {
        locale,
        serverName,
      }),
    );
    return true;
  }

  if (action.id === "create-skill") {
    const skillCwd = await resolveBackendCwd();
    if (!skillCwd) {
      setLibraryPanel((currentPanel) =>
        skillDraftMissingWorkspacePanel(currentPanel, locale),
      );
      return true;
    }

    const timestamp = draftTimestamp(now());
    const skillName = draftTimestampName("workspace-skill", timestamp);
    setLibraryPanel((currentPanel) =>
      buildSkillDraftPanel(currentPanel, {
        cwd: skillCwd,
        locale,
        skillName,
      }),
    );
    return true;
  }

  if (action.id === "save-mcp-draft" || action.id === "save-mcp-config") {
    const draftPayload = buildMcpDraftPayload(fields, locale);
    if (draftPayload.type === "error") {
      setLibraryPanel((currentPanel) =>
        draftPayloadErrorPanel(currentPanel, draftPayload.message),
      );
      return true;
    }

    const { serverConfig, serverName, toolRecord } = draftPayload.payload;
    setLibraryPanel((currentPanel) =>
      mcpDraftSavingPanel(currentPanel, serverName, locale),
    );

    const toolCwd = await resolveBackendCwd();
    if (!toolCwd) {
      throw new Error(
        locale === "zh"
          ? "未连接本地 app-server"
          : "Local app-server is not connected",
      );
    }

    await reloadMcpServerConfig({
      name: serverName,
      config: serverConfig,
    });
    const toolRecordResponse = await saveOrUpdateToolConfig(
      toolCwd,
      toolRecord,
    );
    await openToolsLibrary();
    setNotice(
      mcpDraftSavedNotice({
        locale,
        serverName,
        toolRecord: toolRecordResponse,
      }),
    );
    return true;
  }

  if (action.id === "save-skill-draft") {
    const resolvedSkillCwd = await resolveBackendCwd();
    const draftPayload = buildSkillDraftPayload(
      fields,
      resolvedSkillCwd,
      locale,
    );
    if (draftPayload.type === "error") {
      setLibraryPanel((currentPanel) =>
        draftPayloadErrorPanel(currentPanel, draftPayload.message),
      );
      return true;
    }

    const {
      body: skillBody,
      cwd: skillCwd,
      description,
      name: skillName,
    } = draftPayload.payload;

    setLibraryPanel((currentPanel) =>
      skillDraftSavingPanel(currentPanel, skillName, locale),
    );

    const createResponse = await createSkill({
      cwd: skillCwd,
      name: skillName,
      description,
      body: skillBody,
    });
    if (!createResponse) {
      return true;
    }

    const skillRecord: ToolConfig = {
      kind: "skill",
      title: createResponse.skill.name,
      name: createResponse.skill.name,
      description: createResponse.skill.description,
      path: createResponse.skill.path,
      enabled: createResponse.skill.enabled,
    };
    const toolRecordResponse = await saveOrUpdateToolConfig(
      skillCwd,
      skillRecord,
    );
    await openToolsLibrary();
    setNotice(
      skillDraftSavedNotice({
        locale,
        skillName: createResponse.skill.name,
        toolRecord: toolRecordResponse,
      }),
    );
    return true;
  }

  if (action.id === "save-skill-edit") {
    const skillPath = action.skillPath?.trim();
    const skillBody = fields
      ?.find((field) => field.id === "skill-edit-body")
      ?.value.trim();
    if (!skillPath || !skillBody) {
      setLibraryPanel((currentPanel) =>
        draftPayloadErrorPanel(
          currentPanel,
          locale === "zh"
            ? "Skill 路径和内容不能为空"
            : "Skill path and contents are required",
        ),
      );
      return true;
    }

    await writeSkillFile(skillPath, `${skillBody}\n`);
    await openToolsLibrary();
    setNotice({
      text:
        locale === "zh"
          ? `已更新 Skill：${action.skillName || skillPath}`
          : `Updated Skill: ${action.skillName || skillPath}`,
      tone: "success",
    });
    return true;
  }

  return false;
}

function draftTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace(/[-:T]/g, "");
}
