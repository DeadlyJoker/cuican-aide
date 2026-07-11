import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentPlatformAuthScreen,
  SetPasswordDialog,
  clearWeComCallbackParams,
} from "../auth/AgentPlatformAuthGate";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import type { CommandHomeSlots } from "./commandWorkspaceState";
import { AgentsView, KnowledgeCatalogView } from "./CommandWorkspaceViews";
import {
  AgentDetail,
  KnowledgeDetail,
  McpDetail,
  SkillDetail,
} from "../catalog/CatalogResourceDialog";

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
      downloaded: true,
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
      downloaded: true,
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
      downloaded: true,
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
      downloaded: true,
    },
  ],
  mcpTools: [],
  workflows: [],
};

describe("CrewON resource catalog MVP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("snapshots registration and first password setup states", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentPlatformAuthScreen
          busy={false}
          error={null}
          mode="register"
          notice={null}
          onModeChange={() => {}}
          onSubmit={() => {}}
          onWeComLogin={() => {}}
          wecomConfig={{ enabled: false, provider: "wecom", label: "企业微信" }}
        />
        <SetPasswordDialog
          busy={false}
          error={null}
          onClose={() => {}}
          onSubmit={() => {}}
        />
      </>,
    );

    expect(markup).toMatchSnapshot();
  });

  it("removes WeCom callback parameters while preserving the current page", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      history: { replaceState },
      location: { hash: "#view-command", pathname: "/workspace" },
    });

    clearWeComCallbackParams(
      new URLSearchParams("code=auth-code&state=signed-state&source=desktop"),
    );

    expect(replaceState).toHaveBeenCalledWith(
      {},
      "",
      "/workspace?source=desktop#view-command",
    );
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

  it("snapshots friendly downloaded resource details", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentDetail
          resourceId={12}
          detail={{
            id: 12,
            description: "回答企业授信业务问题",
            invocation: {
              authenticated: {
                input: { inputs: { query: "string" }, channel: "crewon" },
                output: { request_id: "string", status: "string", outputs: {} },
              },
            },
          }}
        />
        <SkillDetail
          resourceId={21}
          detail={{
            id: 21,
            skill_md: {
              content:
                "---\nname: risk-check\n---\n# 风险校验\n\n校验输入并输出风险提示。",
            },
          }}
        />
        <McpDetail
          detail={{
            id: 31,
            description: "查询风险信号",
            endpoint: "https://mcp.example.com/risk",
            url: "https://upstream.example.com/risk",
            tools: [
              {
                id: 1,
                name: "lookup_risk",
                description: "按企业名称查询风险",
                input_schema: {
                  type: "object",
                  required: ["company"],
                  properties: {
                    company: { type: "string", description: "企业名称" },
                  },
                },
              },
            ],
          }}
        />
        <KnowledgeDetail
          detail={{
            id: 41,
            documents: [
              {
                id: 1,
                title: "授信规则",
                content: "# 授信规则\n\n申请材料必须完整。",
              },
            ],
          }}
        />
      </>,
    );

    expect(markup).toMatchSnapshot();
  });
});
