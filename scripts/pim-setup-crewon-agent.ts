#!/usr/bin/env -S node --experimental-strip-types
/**
 * Provision a CrewON demo agent, knowledge base, and showcase on the PIM platform.
 *
 * Usage:
 *   node --experimental-strip-types scripts/pim-setup-crewon-agent.ts
 *
 * Prerequisites:
 *   - PIM reachable at PIM_BASE_URL (default http://123.56.172.85:3000)
 *   - admin credentials in env: PIM_ADMIN_USERNAME / PIM_ADMIN_PASSWORD
 *   - crewon-ui dev server URL in CREWON_DEMO_URL
 */

const PIM_BASE_URL =
  (process.env.PIM_BASE_URL ?? "http://123.56.172.85:3000").replace(/\/+$/, "");
const PIM_ADMIN_USERNAME = process.env.PIM_ADMIN_USERNAME ?? "admin";
const PIM_ADMIN_PASSWORD = process.env.PIM_ADMIN_PASSWORD ?? "cuicantongxing@123";
const CREWON_DEMO_URL =
  process.env.CREWON_DEMO_URL ?? "http://localhost:5173";

// ── resource identities ──────────────────────────────────────────────
const KB_NAME = "CrewON 平台知识库（演示）";
const AGENT_NAME = "CrewON 智能助手";
const AGENT_KEY = "crewon_assistant";
const SHOWCASE_TITLE = "CrewON 智能协作工作台";

const PIM_CUSTOMER_CODE = process.env.PIM_CUSTOMER_CODE ?? "PIM交付";
const PIM_CUSTOMER_USER_ID = Number(process.env.PIM_CUSTOMER_USER_ID ?? "110");
const PIM_CUSTOMER_TENANT_ID = Number(process.env.PIM_CUSTOMER_TENANT_ID ?? "106");
const PIM_CUSTOMER_SPACE_ID = Number(process.env.PIM_CUSTOMER_SPACE_ID ?? "113");

// ── system prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `你是 CrewON 智能助手，服务于企业 Agent 协作工作台的用户。

核心能力：
- 知识检索：回答关于 CrewON 平台功能、Agent 配置、Workflow 编排、Tool 集成的问题时必须先调用 knowledge_retrieval。
- 长期记忆：用户说"请记住""以后优先""我们的偏好"时，必须实际调用 save_memory 工具保存。
- 工作区操作：可以创建/重命名/归档对话线程（Thread），绑定企业 Provider 资源。
- Agent 配置：帮助用户创建和调整 Agent（系统提示词、模型、知识库、Skill、MCP 绑定）。
- Workflow 编排：支持多 Agent 串行/并行协作流。

规则：
1. 先给结论，再给行动建议，最后列出知识依据（文档名 + 条款 + 短摘录）。
2. 知识库没有依据时明确说明"未命中"，不得伪造。
3. 用户要求的记忆必须调用 save_memory 工具，得到成功返回后才能说"已记住"。
4. 区分平台功能事实和你的个人建议，不要把建议写成功能要求。
5. 所有演示数据均为示例，不要暗示为真实生产数据。`;

// ── mock knowledge documents ─────────────────────────────────────────
const MOCK_DOCUMENTS: Array<{ filename: string; content: string }> = [
  {
    filename: "crewon-platform-overview.md",
    content: `# CrewON 智能协作工作台 - 平台概览

## 产品定位
CrewON 是企业级 Agent 协作工作台，统一组织 Agent、Skill、MCP 与企业知识，协同推进任务交付。

## 核心模块

### 1. 对话工作台 (Conversation Workspace)
- 单会话 Thread：自由对话，支持文本、文件上传、图片理解
- 命令工作台 (Command Shell)：项目级工作区，绑定文件系统和终端

### 2. Agent 配置
- 系统提示词编辑
- 模型绑定（SOTA 模型）
- 知识库绑定
- Skill 绑定
- MCP Server 绑定
- 记忆开关

### 3. 知识库
- 文档上传与自动分块
- embedding 模型：text-embedding-v4
- 默认 chunk_size: 500, chunk_overlap: 50
- 支持 Markdown、PDF、Word 等格式

### 4. Skill 管理
- Skill 是预定义的可复用能力模块
- 每个 Skill 包含 SKILL.md 描述文件
- 支持脚本和模板文件
- 可绑定到 Agent

### 5. MCP (Model Context Protocol)
- 标准协议接入外部工具
- 支持 stdio 子进程模式
- 只读 + 可回放工具优先

### 6. Workflow 编排
- 多 Agent 串行协作
- 节点：输入 → Agent → Agent → ... → 输出
- 编辑器和可视化

## 技术架构
- 前端：React + Vite + Electron（桌面端，TypeScript 主进程）
- 后端：Node 24 + Fastify + SQLite/PostgreSQL
- Agent Runtime：自研 Durable Agent Kernel
- 模型：通过 PIM LLM Proxy 接入 SOTA 模型`,
  },
  {
    filename: "agent-configuration-guide.md",
    content: `# Agent 配置指南

## 创建 Agent 的步骤

1. 进入 CrewON 工作台，打开 Agent 配置面板
2. 填写 Agent 名称和角色描述
3. 编辑系统提示词（System Prompt）
4. 选择模型（默认 SOTA 模型）
5. 绑定知识库（可选，最多 10 个）
6. 绑定 Skill（可选）
7. 绑定 MCP Server（可选）
8. 开启记忆（Memory）开关
9. 保存配置

## 系统提示词最佳实践

- 明确 Agent 的角色和职责边界
- 列出必须遵守的规则
- 指定工具调用的优先级
- 定义输出格式要求
- 设置失败处理策略

### 示例模板
\`\`\`
你是 [角色名称]，服务于 [业务场景]。

核心能力：
1. [能力 1]
2. [能力 2]

规则：
1. 凡是查询 [领域] 的信息，必须先调用 knowledge_retrieval
2. 用户要求记住的信息，必须调用 save_memory
3. 先给结论，再给建议，最后列出知识依据

输出格式：
- 结论
- 行动建议
- 知识依据（文档名 + 条款 + 摘录）
\`\`\`

## 模型配置
- model_binding.source: "newapi"
- display_model: "SOTA模型"
- temperature: 0.2（推荐）
- max_tokens: 4096

## 记忆配置
- memory_enabled: true
- max_history: 20 轮对话上下文
- diversity_enabled: true（增加回复多样性）

## 知识库绑定
- 支持绑定多个知识库
- 检索工具：knowledge_retrieval
- 自动注入到 Agent 的可用工具列表`,
  },
  {
    filename: "workflow-orchestration.md",
    content: `# Workflow 编排指南

## 概述
Workflow 允许将多个 Agent 组合为串行协作管道，实现复杂任务的分工与交付。

## 节点类型

### 输入节点 (Start)
- 定义任务输入变量
- 支持段落文本、单行文本等类型
- 可设置必填和最大长度

### Agent 节点
- 绑定平台 Agent
- 接收上游节点的输出作为本节点输入
- 独立执行，拥有自己的工具和知识库

### 输出节点 (End)
- 汇总最终交付结果
- 从最后 Agent 节点的输出中选取

## 编排模式

### 串行模式 (默认)
Agent A → Agent B → Agent C → 交付

每个 Agent 的输出成为下一个 Agent 的输入。

### 并行模式
Agent A ↘
          → Agent C → 交付
Agent B ↗

多个 Agent 同时处理，结果汇总后由最终 Agent 整合。

## 典型场景

1. **合同审核流程**
   文档解析 Agent → 条款审核 Agent → 风险汇总 Agent → 交付

2. **采购决策流程**
   需求分析 Agent → 供应商评估 Agent → 报价比较 Agent → 决策建议 Agent → 交付

3. **智能办公流程**
   意图识别 Agent → 知识检索 Agent → 内容生成 Agent → 格式审核 Agent → 交付`,
  },
  {
    filename: "tool-integration-guide.md",
    content: `# Tool 集成指南

## 内置工具

### knowledge_retrieval
- 检索绑定知识库中的文档
- 输入：自然语言查询
- 输出：相关文档片段及来源

### save_memory
- 保存用户偏好和长期记忆
- 跨会话持久化
- 输入：要记住的内容
- 自动关联到当前用户

## MCP 工具集成

### 什么是 MCP
Model Context Protocol，标准化的 AI 工具接口协议。

### 接入步骤
1. 准备 MCP Server（stdio 子进程或 HTTP）
2. 在 CrewON 中注册 MCP Server
3. 配置 endpoint 和认证
4. 在 Agent 中绑定 MCP Server
5. 选择启用的 Tool

### 安全策略
- 只读工具优先开放
- 可回放工具才允许自动重试
- 写操作需要审批流程
- 沙箱隔离执行环境

## Shell / 文件系统工具
- 命令执行在沙箱环境中
- 文件操作限制在工作区目录
- 网络访问需显式授权
- 输出有大小限制（约 40KB）

## Tool 输出截断
- 模型可见输出上限约 40KB
- 超限时保留头部和尾部
- 完整输出进入 Artifact 存储`,
  },
  {
    filename: "crewon-demo-scenarios.md",
    content: `# CrewON 演示场景

## 场景 1：智能问答助手
用户上传企业制度文档到知识库，创建 Agent 绑定该知识库。
用户询问："公司采购超过 50 万需要什么流程？"
Agent 调用 knowledge_retrieval → 返回制度依据 → 给出结论和建议。

## 场景 2：合同审核
用户粘贴合同文本。
Agent 调用合同审核 Skill → 逐条分析风险 → 输出审核报告。
用户说"请记住我们公司的合同审核标准"，Agent 调用 save_memory 保存。

## 场景 3：多 Agent Workflow
创建一个 Workflow：
- Agent A：需求分析
- Agent B：方案设计
- Agent C：方案审核

用户输入"设计一个供应商评估系统"，三个 Agent 串行协作，最终交付完整方案。

## 场景 4：知识库管理
管理员上传产品文档、技术规范、FAQ。
创建 Agent 绑定知识库并开启记忆。
用户持续对话，Agent 根据记忆个性化回答。

## 场景 5：Terminal 集成
在 Command Shell 模式下，Agent 可以：
- 读取项目文件
- 执行 Shell 命令
- 运行代码
- 管理 Git 版本

适合开发者日常使用。`,
  },
];

// ── helpers ──────────────────────────────────────────────────────────
let _adminToken: string | null = null;

async function adminToken(): Promise<string> {
  if (_adminToken) return _adminToken;
  const form = new URLSearchParams({
    username: PIM_ADMIN_USERNAME,
    password: PIM_ADMIN_PASSWORD,
  });
  const res = await fetch(`${PIM_BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`PIM login failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("PIM login: no access_token");
  _adminToken = body.access_token;
  return _adminToken;
}

async function pimGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${PIM_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${await adminToken()}` },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function pimPost<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${PIM_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await adminToken()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path}: ${res.status} – ${text}`);
  }
  return (await res.json()) as T;
}

async function pimPut<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${PIM_BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await adminToken()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${path}: ${res.status} – ${text}`);
  }
  return (await res.json()) as T;
}

interface PimPage<T> {
  items: T[];
  total: number;
}

interface PimKnowledgeBase {
  id: number;
  name: string;
}

interface PimAgent {
  id: number;
  uid: string;
  name: string;
}

interface PimShowcase {
  id: number;
  title: string;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  console.log("🔑 Logging into PIM...");
  await adminToken();
  console.log("✅ Admin authenticated\n");

  // ── 1. Knowledge Base ─────────────────────────────────────────────
  console.log(`📚 Knowledge Base: "${KB_NAME}"`);
  const kbList = await pimGet<PimPage<PimKnowledgeBase>>(
    `/api/v1/knowledge/?page=1&page_size=100`,
  );
  let kb = kbList.items.find((k) => k.name === KB_NAME);

  if (kb) {
    console.log(`   ✅ Already exists (id=${kb.id})`);
  } else {
    kb = await pimPost<PimKnowledgeBase>("/api/v1/knowledge/", {
      name: KB_NAME,
      description:
        "CrewON 平台功能文档、Agent 配置指南、Workflow 编排和 Tool 集成参考。",
      embedding_model: "text-embedding-v4",
      chunk_size: 500,
      chunk_overlap: 50,
      metadata: { demo: "crewon-platform", data_classification: "synthetic" },
    });
    console.log(`   ✅ Created (id=${kb.id})`);
  }

  // ── 2. Upload documents ──────────────────────────────────────────
  console.log("\n📄 Uploading documents...");
  const existingDocs = await pimGet<PimPage<{ id: number; filename: string }>>(
    `/api/v1/knowledge/${kb.id}/documents?page=1&page_size=100`,
  );
  const existingNames = new Set(existingDocs.items.map((d) => d.filename));

  for (const doc of MOCK_DOCUMENTS) {
    if (existingNames.has(doc.filename)) {
      console.log(`   ⏭  ${doc.filename} (already exists)`);
      continue;
    }
    await pimPost(`/api/v1/knowledge/${kb.id}/documents/upload-text`, {
      knowledge_base_id: kb.id,
      content: doc.content,
      filename: doc.filename,
      parsing_strategy: "markdown_header",
    });
    console.log(`   ✅ ${doc.filename}`);
  }

  // Wait for document processing
  console.log("\n⏳ Waiting for document processing...");
  let pending = true;
  let attempts = 0;
  while (pending && attempts < 30) {
    const docs = await pimGet<
      PimPage<{ id: number; filename: string; status: string }>
    >(`/api/v1/knowledge/${kb.id}/documents?page=1&page_size=100`);
    const failed = docs.items.filter((d) => d.status === "failed");
    if (failed.length > 0) {
      console.error(
        `❌ Document processing failed: ${failed.map((d) => d.filename).join(", ")}`,
      );
      process.exit(1);
    }
    pending = docs.items.some((d) => d.status !== "completed");
    if (pending) {
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }
  }
  if (pending) {
    console.error("❌ Document processing timed out");
    process.exit(1);
  }
  console.log("   ✅ All documents processed");

  // ── 3. Skills ─────────────────────────────────────────────────────
  console.log("\n🔧 Skills...");
  const skillsList = await pimGet<
    PimPage<{ id: number; name: string; user_id: number }>
  >(`/api/v1/skills?page=1&page_size=100`);
  const adminSkills = skillsList.items.filter((s) => s.user_id === 1);
  console.log(`   Found ${adminSkills.length} admin-owned skills`);
  const skillIds = adminSkills.map((s) => s.id);

  // ── 4. Agent ──────────────────────────────────────────────────────
  console.log(`\n🤖 Agent: "${AGENT_NAME}"`);
  const agentList = await pimGet<PimPage<PimAgent>>(
    `/api/v1/agents/?page=1&page_size=100`,
  );
  let agent = agentList.items.find((a) => a.name === AGENT_NAME);
  let agentUid: string;

  const agentBody = {
    name: AGENT_NAME,
    description:
      "CrewON 平台内置智能助手，绑定平台知识库、合同审核等 Skill，并开启跨会话长期记忆。",
    system_prompt: SYSTEM_PROMPT,
    model_id: null,
    knowledge_base_ids: [kb.id],
    tools: [],
    skill_ids: skillIds,
    mcp_servers: [],
    workflow_ids: [],
    api_enabled: 0,
    max_concurrency: 20,
    config: {
      model_binding: { source: "newapi", display_model: "SOTA模型" },
      memory_enabled: true,
      max_history: 20,
      diversity_enabled: true,
      temperature: 0.2,
      max_tokens_enabled: true,
      max_tokens: 4096,
      tags: ["CrewON", "样例 Agent", AGENT_KEY],
    },
  };

  if (agent) {
    const identifier = agent.uid || String(agent.id);
    await pimPut(`/api/v1/agents/${identifier}`, {
      ...agentBody,
      is_active: 1,
    });
    agentUid = agent.uid || String(agent.id);
    console.log(`   ✅ Updated (uid=${agentUid})`);
  } else {
    const created = await pimPost<PimAgent>("/api/v1/agents/", agentBody);
    agentUid = created.uid || String(created.id);
    console.log(`   ✅ Created (uid=${agentUid})`);
  }

  // ── 5. Showcase ───────────────────────────────────────────────────
  console.log(`\n🖥  Showcase: "${SHOWCASE_TITLE}"`);
  const showcaseList = await pimGet<PimPage<PimShowcase>>(
    "/api/v1/showcase?page=1&page_size=100",
  );
  let showcase = showcaseList.items.find((s) => s.title === SHOWCASE_TITLE);

  const showcaseBody = {
    title: SHOWCASE_TITLE,
    description:
      "CrewON 智能协作工作台 — 统一组织 Agent、Skill、MCP 与企业知识，协同推进任务交付。",
    url: CREWON_DEMO_URL,
    category: "智能协作",
    icon: "Bot",
    color: "#1D4ED8",
    config: {
      agent_bindings: { [AGENT_KEY]: agentUid },
      agent_binding_version: 1,
      capabilities: ["knowledge_retrieval", "cross_session_memory", "skill_invoke"],
    },
    visible_user_ids: [PIM_CUSTOMER_USER_ID],
    sort_order: 0,
    is_enabled: true,
  };

  if (showcase) {
    await pimPut(`/api/v1/showcase/${showcase.id}`, showcaseBody);
    console.log(`   ✅ Updated (id=${showcase.id})`);
  } else {
    showcase = await pimPost<PimShowcase>("/api/v1/showcase", showcaseBody);
    console.log(`   ✅ Created (id=${showcase.id})`);
  }

  // ── 6. Report ─────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("✅ CrewON PIM setup complete");
  console.log("=".repeat(60));
  console.log(`   Knowledge Base:  "${KB_NAME}" (id=${kb.id})`);
  console.log(`   Documents:        ${MOCK_DOCUMENTS.length} files`);
  console.log(`   Agent:            "${AGENT_NAME}" (uid=${agentUid})`);
  console.log(`   Skills bound:     ${skillIds.length}`);
  console.log(`   Memory:           enabled`);
  console.log(`   Showcase:         "${SHOWCASE_TITLE}"`);
  console.log(`   Demo URL:         ${CREWON_DEMO_URL}`);
}

main().catch((err) => {
  console.error("❌ Setup failed:", err.message);
  process.exit(1);
});
