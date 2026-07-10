import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentPlatformAuthScreen } from "../auth/AgentPlatformAuthGate";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import type { CommandHomeSlots } from "./commandWorkspaceState";
import { AgentsView, KnowledgeCatalogView } from "./CommandWorkspaceViews";

const slots: CommandHomeSlots = {
  agent: {
    label: "Agent",
    title: "Fallback Agent",
    detail: "Fallback",
    value: "agent",
  },
  workflow: { label: "Workflow", title: "Flow", detail: "Flow", value: "flow" },
  knowledge: { label: "空间", title: "Space", detail: "Space", value: "space" },
  skills: [
    { label: "Skill", title: "Skill A", detail: "A", value: "a" },
    { label: "Skill", title: "Skill B", detail: "B", value: "b" },
  ],
  mcps: [
    { label: "MCP", title: "MCP A", detail: "A", value: "a" },
    { label: "MCP", title: "MCP B", detail: "B", value: "b" },
  ],
  model: "qwen-plus",
};

const snapshot: AgentPlatformSnapshot = {
  agents: [
    {
      id: 12,
      name: "授信业务智能客服",
      description: "回答企业授信业务问题",
      model_info: { model_name: "deepseek-chat" },
      owner_username: "admin",
      api_enabled: true,
      is_active: true,
    },
  ],
  skills: [
    {
      id: 21,
      name: "风险校验 Skill",
      description: "校验授信输入并输出风险提示",
      owner_username: "test",
      category: "风控",
      file_count: 4,
      has_scripts: true,
    },
  ],
  mcpServers: [
    {
      id: 31,
      name: "risk-tools",
      alias: "风控服务",
      description: "查询风险信号",
      owner_username: "admin",
      tool_count: 3,
      is_connected: true,
    },
  ],
  knowledgeBases: [
    {
      id: 41,
      name: "企业授信风控",
      description: "授信规则、材料与常见问答",
      owner_username: "admin",
      document_count: 8,
      chunk_count: 126,
      embedding_model: "text-embedding-v2",
    },
  ],
  mcpTools: [],
  workflows: [],
};

describe("CrewON resource catalog MVP", () => {
  it("snapshots the agent-platform login and registration entry", () => {
    const markup = renderToStaticMarkup(
      <AgentPlatformAuthScreen
        busy={false}
        error={null}
        mode="login"
        notice={null}
        onModeChange={() => {}}
        onSubmit={() => {}}
        onWeComLogin={() => {}}
        wecomConfig={{
          enabled: true,
          provider: "wecom",
          label: "企业微信",
        }}
      />,
    );

    expect(markup).toMatchSnapshot();
  });

  it("snapshots employee, skill, service, and knowledge cards", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentsView
          active
          catalogFilter="all"
          catalogSearch=""
          slots={slots}
          snapshot={snapshot}
          onReload={async () => {}}
          onCatalogFilterChange={() => {}}
          onCatalogSearchChange={() => {}}
        />
        <KnowledgeCatalogView
          active
          snapshot={snapshot}
          onReload={async () => {}}
        />
      </>,
    );

    expect(markup).toMatchSnapshot();
  });
});
