import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type {
  McpClientPort,
  McpToolCallResult,
  McpToolPage,
} from "./mcp-client-port.ts";

export type StdioMcpClientConfig = Readonly<{
  command: string;
  args?: readonly string[];
  cwd?: string | null;
  env?: Readonly<Record<string, string>>;
  clientName?: string;
  clientVersion?: string;
  connectTimeoutMs?: number;
}>;

export class StdioMcpClient implements McpClientPort {
  readonly #client: Client;
  readonly #transport: StdioClientTransport;
  readonly #connectTimeoutMs: number;
  #connected = false;
  #closed = false;

  constructor(config: StdioMcpClientConfig) {
    validateConfig(config);
    this.#connectTimeoutMs = config.connectTimeoutMs ?? 10_000;
    this.#client = new Client({
      name: config.clientName ?? "crewon-mcp-runtime",
      version: config.clientVersion ?? "0.0.0",
    });
    this.#transport = new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      env: { ...(config.env ?? {}) },
      ...(config.cwd === undefined || config.cwd === null
        ? {}
        : { cwd: config.cwd }),
      stderr: "pipe",
    });
    this.#transport.stderr?.on("data", () => {
      // Server stderr is untrusted and intentionally not copied into logs or model context.
    });
  }

  async connect(signal: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new Error("mcp_client_closed");
    }
    if (this.#connected) {
      return;
    }
    await this.#client.connect(this.#transport, {
      signal,
      timeout: this.#connectTimeoutMs,
    });
    this.#connected = true;
  }

  async listTools(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<McpToolPage> {
    this.#requireConnected();
    const page = await this.#client.listTools(
      cursor === undefined ? {} : { cursor },
      { signal },
    );
    return {
      tools: page.tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
      })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  ): Promise<McpToolCallResult> {
    this.#requireConnected();
    return (await this.#client.callTool(
      { name, arguments: { ...input } },
      undefined,
      {
        signal: options.signal,
        timeout: options.timeoutMs,
        maxTotalTimeout: options.timeoutMs,
      },
    )) as McpToolCallResult;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connected = false;
    await this.#client.close();
  }

  #requireConnected(): void {
    if (!this.#connected || this.#closed) {
      throw new Error("mcp_client_not_connected");
    }
  }
}

function validateConfig(config: StdioMcpClientConfig): void {
  if (!path.isAbsolute(config.command) || config.command.includes("\u0000")) {
    throw new Error("mcp_command_invalid");
  }
  if (
    config.cwd !== undefined &&
    config.cwd !== null &&
    !path.isAbsolute(config.cwd)
  ) {
    throw new Error("mcp_cwd_invalid");
  }
  if (
    !Number.isSafeInteger(config.connectTimeoutMs ?? 10_000) ||
    (config.connectTimeoutMs ?? 10_000) < 1 ||
    (config.connectTimeoutMs ?? 10_000) > 60_000
  ) {
    throw new Error("mcp_connect_timeout_invalid");
  }
  for (const arg of config.args ?? []) {
    if (
      typeof arg !== "string" ||
      arg.includes("\u0000") ||
      Buffer.byteLength(arg) > 8 * 1024
    ) {
      throw new Error("mcp_argument_invalid");
    }
  }
  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof value !== "string" ||
      value.includes("\u0000") ||
      Buffer.byteLength(value) > 64 * 1024
    ) {
      throw new Error("mcp_environment_invalid");
    }
  }
}
