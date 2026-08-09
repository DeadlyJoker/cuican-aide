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

/** Narrow MCP client surface kept outside the Agent Kernel and domain. */
export interface McpClientPort {
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
