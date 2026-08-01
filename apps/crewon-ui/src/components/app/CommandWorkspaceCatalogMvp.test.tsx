import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentPlatformAuthScreen,
  SetPasswordDialog,
  clearWeComCallbackParams,
} from "../auth/AgentPlatformAuthGate";
import type {
  AgentPlatformResourceStates,
  AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import { AgentsView, KnowledgeCatalogView } from "./CommandWorkspaceViews";
import {
  createAgentPlatformResourceStates,
  mergeAgentPlatformSnapshot,
} from "./commandWorkspaceState";
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
      resource_source: "online",
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
      downloaded: false,
      resource_source: "catalog",
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
      resource_source: "online",
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
      resource_source: "online",
    },
  ],
  mcpTools: [],
  workflows: [],
};

const readyResourceStates = createAgentPlatformResourceStates("ready");

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
          resourceStates={readyResourceStates}
          snapshot={snapshot}
          onReload={async () => {}}
          onCatalogFilterChange={() => {}}
          onCatalogSearchChange={() => {}}
        />
        <KnowledgeCatalogView
          active
          platformState="ready"
          resourceStates={readyResourceStates}
          snapshot={snapshot}
          onReload={async () => {}}
        />
      </>,
    );

    expect(markup).toContain("智能体 · 可用");
    expect(markup).toContain("服务 · 已连接");
    expect(markup).toContain("知识库 · 可检索");
    expect(markup).toContain("创建技能");
    expect(markup).toContain("创建服务");
    expect(markup).toContain("表格分析");
    expect(markup).toContain("浏览器自动化");
    expect(markup).toContain("企业微信");
    expect(markup).toContain("飞书套件");
    expect(markup).toContain("运行位置");
    expect(markup).toContain("本地");
    expect(markup).toContain("云端");
    expect(markup).toContain('data-logo="wecom"');
    expect(markup).toContain('data-logo="excel"');
    expect(markup).toContain('data-logo="assistant"');
    expect(markup).toContain('data-logo="knowledge"');
    expect(markup).toContain('data-catalog-filter="knowledge"');
    expect(markup).not.toContain("在线技能");
    expect(markup.match(/aria-label="安装 [^"]+"/g)).toHaveLength(1);
    expect(markup).not.toContain(">测试</button>");
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
        resourceStates={
          platformState === "loading"
            ? createAgentPlatformResourceStates("loading")
            : platformState === "fallback"
              ? createAgentPlatformResourceStates(
                  "error",
                  "agent-platform unavailable",
                )
              : readyResourceStates
        }
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
          resourceStates={createAgentPlatformResourceStates("loading")}
          snapshot={emptySnapshot}
          onReload={async () => {}}
        />
        <KnowledgeCatalogView
          active
          platformState="ready"
          resourceStates={readyResourceStates}
          snapshot={emptySnapshot}
          onReload={async () => {}}
        />
      </>,
    );

    expect(markup).not.toContain("产品审阅智能体");
    expect(markup).toMatchSnapshot();
  });

  it("snapshots category errors without hiding last successful resources", () => {
    const resourceStates: AgentPlatformResourceStates = {
      agents: {
        status: "error",
        error: "agent-platform /api/v1/agents failed: 500",
      },
      skills: { status: "ready", error: null },
      mcp: { status: "loading", error: null },
      knowledge: {
        status: "error",
        error: "agent-platform /api/v1/knowledge failed: 503",
      },
    };
    const markup = renderToStaticMarkup(
      <>
        <AgentsView
          active
          catalogFilter="all"
          catalogSearch=""
          platformState="ready"
          resourceStates={resourceStates}
          snapshot={snapshot}
          onReload={async () => {}}
          onCatalogFilterChange={() => {}}
          onCatalogSearchChange={() => {}}
        />
        <KnowledgeCatalogView
          active
          platformState="ready"
          resourceStates={resourceStates}
          snapshot={snapshot}
          onReload={async () => {}}
        />
      </>,
    );

    expect(markup).toContain("Agent 加载失败，继续显示上次成功加载的 1 项");
    expect(markup).toContain("重试 Agent");
    expect(markup).toContain("正在更新服务");
    expect(markup).toContain("重试知识库");
    expect(markup).toMatchSnapshot();
  });

  it("only replaces categories whose reload completed successfully", () => {
    const current = {
      ...snapshot,
      resourceStates: readyResourceStates,
    };
    const incoming: AgentPlatformSnapshot = {
      ...snapshot,
      agents: [],
      skills: [
        {
          id: 22,
          name: "更新后的 Skill",
          downloaded: true,
        },
      ],
      resourceStates: {
        ...readyResourceStates,
        agents: { status: "error", error: "Agent request failed" },
      },
    };

    const merged = mergeAgentPlatformSnapshot(current, incoming);

    expect(merged.agents).toEqual(snapshot.agents);
    expect(merged.skills).toEqual(incoming.skills);
    expect(merged.resourceStates?.agents).toEqual({
      status: "error",
      error: "Agent request failed",
    });

    const scopedReload = mergeAgentPlatformSnapshot(
      current,
      {
        ...incoming,
        agents: [{ id: 13, name: "更新后的 Agent", downloaded: true }],
        resourceStates: readyResourceStates,
      },
      ["agents"],
    );
    expect(scopedReload.agents).toEqual([
      { id: 13, name: "更新后的 Agent", downloaded: true },
    ]);
    expect(scopedReload.skills).toEqual(snapshot.skills);
  });

  it("snapshots friendly online read-only resource details", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentDetail
          detail={{
            id: 12,
            is_active: true,
            api_enabled: true,
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
          resource={{
            id: 21,
            type: "skills",
            name: "risk-check",
            description: "",
            source: "online",
          }}
          detail={{
            id: 21,
            skill_md: {
              content:
                "---\nname: risk-check\n---\n# 风险校验\n\n校验输入并输出风险提示。",
            },
          }}
        />
        <McpDetail
          resource={{
            id: 31,
            type: "mcp_servers",
            name: "风控服务",
            description: "查询风险信号",
            connected: true,
            source: "online",
          }}
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
    expect(markup).toContain("调用工具");
    expect(markup).toContain("调用参数（JSON）");
    expect(markup).not.toContain("无额外字段");
    expect(markup).toMatchSnapshot();
  });
});
