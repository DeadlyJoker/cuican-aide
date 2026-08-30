import type { AppServerClient } from "../app-server/appServer";
import {
  mcpConfigForEditorDraft,
  type CapabilityEditorDraft,
} from "./capabilityCatalog";
import {
  buildMcpDraftPayload,
  buildSkillDraftPayload,
} from "../draft/draftSavePayloads";
import { saveOrUpdateToolConfig } from "../domain/domainToolPersistence";
import type { Locale } from "../i18n";

export async function saveCapabilityEditorDraft(params: {
  client: AppServerClient;
  cwd: string;
  draft: CapabilityEditorDraft;
  locale: Locale;
}): Promise<{
  authorizationUrl?: string;
  kind: "mcp" | "skill";
  name: string;
}> {
  const { client, cwd, draft, locale } = params;
  if (draft.kind === "mcp") {
    const { config, oauth } = mcpConfigForEditorDraft(draft);
    const result = buildMcpDraftPayload(
      [
        { id: "mcp-draft-name", label: "MCP", value: draft.name },
        {
          id: "mcp-draft-config",
          label: "Config",
          value: JSON.stringify(config),
        },
      ],
      locale,
    );
    if (result.type === "error") {
      throw new Error(result.message);
    }
    const { serverConfig, serverName, toolRecord } = result.payload;
    const saveResponse = await client.saveMcpServerConfig({
      name: serverName,
      config: serverConfig,
      reload: true,
    });
    await saveOrUpdateToolConfig(client, cwd, toolRecord);
    if (saveResponse.reloadError && !oauth) {
      throw new Error(
        `服务配置已保存，但连接失败：${saveResponse.reloadError}`,
      );
    }
    if (oauth) {
      const login = await client.startMcpOauthLogin(serverName);
      return {
        authorizationUrl: login.authorizationUrl,
        kind: "mcp",
        name: serverName,
      };
    }
    return { kind: "mcp", name: serverName };
  }

  const result = buildSkillDraftPayload(
    [
      { id: "skill-draft-name", label: "Skill", value: draft.name },
      {
        id: "skill-draft-description",
        label: "Description",
        value: draft.description,
      },
      {
        id: "skill-draft-workflow",
        label: "Workflow",
        value: draft.workflow,
      },
    ],
    cwd,
    locale,
  );
  if (result.type === "error") {
    throw new Error(result.message);
  }
  const created = await client.createSkill(result.payload);
  await saveOrUpdateToolConfig(client, cwd, {
    kind: "skill",
    title: created.skill.name,
    name: created.skill.name,
    description: created.skill.description,
    path: created.skill.path,
    enabled: created.skill.enabled,
  });
  return { kind: "skill", name: created.skill.name };
}
