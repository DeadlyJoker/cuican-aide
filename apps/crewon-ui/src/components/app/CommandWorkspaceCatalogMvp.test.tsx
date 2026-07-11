import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentPlatformAuthScreen,
  SetPasswordDialog,
  clearWeComCallbackParams,
} from "../auth/AgentPlatformAuthGate";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import { AgentsView, KnowledgeCatalogView } from "./CommandWorkspaceViews";
import {
  AgentDetail,
  KnowledgeDetail,
  McpDetail,
  SkillDetail,
} from "../catalog/CatalogResourceDialog";

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
      new URLSearchParams("wecom_ticket=one-time-ticket&source=web"),
    );

    expect(replaceState).toHaveBeenCalledWith(
      {},
      "",
      "/workspace?source=web#view-command",
    );
  });

  it("snapshots employee, skill, service, and knowledge cards", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentsView
          active
          catalogFilter="all"
          catalogSearch=""
          platformState="ready"
          snapshot={snapshot}
          onReload={async () => {}}
          onCatalogFilterChange={() => {}}
          onCatalogSearchChange={() => {}}
        />
        <KnowledgeCatalogView
          active
          platformState="ready"
          snapshot={snapshot}
          onReload={async () => {}}
        />
      </>,
    );

    expect(markup).toMatchSnapshot();
  });

  it("snapshots loading, empty-account, and unavailable catalog states", () => {
    const emptySnapshot: AgentPlatformSnapshot = {
      agents: [],
      skills: [],
      mcpServers: [],
      knowledgeBases: [],
      mcpTools: [],
      workflows: [],
    };
    const renderAgents = (platformState: "loading" | "ready" | "fallback") => (
      <AgentsView
        active
        catalogFilter="all"
        catalogSearch=""
        platformState={platformState}
        snapshot={emptySnapshot}
        onReload={async () => {}}
        onCatalogFilterChange={() => {}}
        onCatalogSearchChange={() => {}}
      />
    );

    const markup = renderToStaticMarkup(
      <>
        {renderAgents("loading")}
        {renderAgents("ready")}
        {renderAgents("fallback")}
        <KnowledgeCatalogView
          active
          platformState="loading"
          snapshot={emptySnapshot}
          onReload={async () => {}}
        />
        <KnowledgeCatalogView
          active
          platformState="ready"
          snapshot={emptySnapshot}
          onReload={async () => {}}
        />
      </>,
    );

    expect(markup).not.toContain("产品审阅智能体");
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
              {
                id: 2,
                name: "score_risk",
                description: "输出结构化风险等级",
                input_schema: {
                  type: "object",
                  properties: { company: { type: "string" } },
                },
                output_schema: {
                  type: "object",
                  required: ["risk_level"],
                  properties: {
                    risk_level: { type: "string", description: "风险等级" },
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

    expect(markup).toContain("tool_id");
    expect(markup).toContain("structuredContent");
    expect(markup).toContain("risk_level");
    expect(markup).not.toContain("无额外字段");
    expect(markup).toMatchSnapshot();
  });
});
