import type { AgentPlatformSnapshot } from "./agentPlatformClient";
import { agentPlatformAuthorizedFetch } from "./agentPlatformClient";
import type { RuntimeDynamicTool } from "../thread/threadRuntimeSettings";

export type PimResourceSelection = {
  execution: "local" | "remote";
  id: number;
  name: string;
  type: "skills" | "mcp_servers" | "knowledge_bases";
};

const PIM_NAMESPACE = "pim";
const MAX_DYNAMIC_TOOLS = 24;
const MAX_TOOL_CONTEXT_CHARS = 40_000;
const DEFAULT_SCHEMA = { type: "object", properties: {} };

function schemaForTool(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_SCHEMA;
  }
  return value;
}

function boundedDescription(value: string): string {
  return value.trim().slice(0, 1_000);
}

function addWithinBudget(
  tools: RuntimeDynamicTool[],
  tool: RuntimeDynamicTool,
  usedChars: { value: number },
): void {
  if (tools.length >= MAX_DYNAMIC_TOOLS) return;
  const size =
    tool.name.length +
    tool.description.length +
    JSON.stringify(tool.inputSchema).length;
  if (usedChars.value + size > MAX_TOOL_CONTEXT_CHARS) return;
  usedChars.value += size;
  tools.push(tool);
}

export function buildPimDynamicTools(
  resources: readonly PimResourceSelection[],
  snapshot: AgentPlatformSnapshot,
): RuntimeDynamicTool[] {
  const tools: RuntimeDynamicTool[] = [];
  const usedChars = { value: 0 };

  for (const resource of resources) {
    if (resource.execution !== "remote") continue;
    if (resource.type === "mcp_servers") {
      for (const tool of snapshot.mcpTools.filter(
        (candidate) => candidate.server_id === resource.id,
      )) {
        addWithinBudget(
          tools,
          {
            namespace: PIM_NAMESPACE,
            name: `mcp_tool_${tool.id}`,
            description: boundedDescription(
              `通过 PIM MCP ${resource.name} 调用 ${tool.alias || tool.name}。${tool.description || tool.intro || ""}`,
            ),
            inputSchema: schemaForTool(tool.input_schema),
            deferLoading: false,
          },
          usedChars,
        );
      }
      continue;
    }
    if (resource.type === "knowledge_bases") {
      addWithinBudget(
        tools,
        {
          namespace: PIM_NAMESPACE,
          name: `knowledge_search_${resource.id}`,
          description: boundedDescription(
            `在 PIM 知识库“${resource.name}”中检索信息。仅在回答需要引用该知识库时调用。`,
          ),
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "检索问题" },
              top_k: { type: "integer", minimum: 1, maximum: 20 },
              search_mode: {
                type: "string",
                enum: ["keyword", "vector", "hybrid"],
              },
              score_threshold: { type: "number", minimum: 0 },
              rerank: { type: "boolean" },
            },
            required: ["query"],
            additionalProperties: false,
          },
          deferLoading: false,
        },
        usedChars,
      );
    }
  }
  return tools;
}

type DynamicToolCall = {
  arguments?: unknown;
  namespace?: unknown;
  tool?: unknown;
};

function jsonArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `PIM request failed (${response.status})`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function isPimDynamicToolCall(params: unknown): params is DynamicToolCall {
  return (
    Boolean(params) &&
    typeof params === "object" &&
    (params as DynamicToolCall).namespace === PIM_NAMESPACE &&
    typeof (params as DynamicToolCall).tool === "string"
  );
}

export async function executePimDynamicTool(
  params: DynamicToolCall,
): Promise<{ contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }> {
  const tool = String(params.tool);
  const args = jsonArguments(params.arguments);
  let response: Response;

  if (tool.startsWith("mcp_tool_")) {
    const toolId = Number(tool.slice("mcp_tool_".length));
    if (!Number.isInteger(toolId)) throw new Error("Invalid PIM MCP tool id");
    response = await agentPlatformAuthorizedFetch(
      `/api/v1/mcp/tools/${toolId}/call`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      },
    );
  } else if (tool.startsWith("knowledge_search_")) {
    const knowledgeBaseId = Number(tool.slice("knowledge_search_".length));
    if (!Number.isInteger(knowledgeBaseId)) {
      throw new Error("Invalid PIM knowledge base id");
    }
    response = await agentPlatformAuthorizedFetch("/api/v1/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: String(args.query ?? ""),
        knowledge_base_id: knowledgeBaseId,
        kb_ids: [knowledgeBaseId],
        top_k: Number(args.top_k ?? 5),
        score_threshold: Number(args.score_threshold ?? 0),
        search_mode: String(args.search_mode ?? "keyword"),
        rerank: Boolean(args.rerank ?? false),
        return_debug: true,
      }),
    });
  } else {
    throw new Error(`Unsupported PIM dynamic tool: ${tool}`);
  }

  const result = await responseJson(response);
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  };
}
