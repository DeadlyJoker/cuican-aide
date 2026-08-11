import type { ToolExecutionCommand } from "@crewon/tool-broker";

export type McpToolDescriptor = Readonly<{
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

export type McpToolPage = Readonly<{
  tools: readonly McpToolDescriptor[];
  nextCursor?: string;
}>;

export type McpToolCallResult = Readonly<{
  content?: readonly unknown[];
  structuredContent?: Readonly<Record<string, unknown>>;
  isError?: boolean;
  toolResult?: unknown;
}>;

export type McpMutationExecution = Readonly<{
  providerExecutionId: string;
  toolName: string;
  command: ToolExecutionCommand;
}>;

export type McpMutationResolution =
  | Readonly<{
      status: "completed";
      providerReceiptId: string;
      result: McpToolCallResult;
    }>
  | Readonly<{
      status: "canceled" | "unknownOutcome";
      providerReceiptId: string | null;
    }>;

/** Provider mutation protocol over a Worker-durable execution identity. */
export interface McpMutationProviderPort {
  execute(
    execution: McpMutationExecution,
    signal: AbortSignal,
  ): Promise<McpMutationResolution>;
  reconcile(
    execution: McpMutationExecution,
    signal: AbortSignal,
  ): Promise<McpMutationResolution>;
  cancel(
    execution: McpMutationExecution,
    signal: AbortSignal,
  ): Promise<McpMutationResolution>;
}

/** Narrow MCP client surface kept outside the Agent Kernel and domain. */
export interface McpClientPort {
  readonly mutationProvider?: McpMutationProviderPort;
  connect(signal: AbortSignal): Promise<void>;
  listTools(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<McpToolPage>;
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  ): Promise<McpToolCallResult>;
  close(): Promise<void>;
}
