import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpClientRequestScope } from "./mcp-client-request-scope.ts";

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
  readonly #requests = new McpClientRequestScope();
  #connected = false;
  #closed = false;

  constructor(config: StdioMcpClientConfig) {
    validateConfig(config);
    this.#connectTimeoutMs = config.connectTimeoutMs ?? 10_000;
    this.#client = new Client({
      name: config.clientName ?? "crewon-mcp-runtime",
      version: config.clientVersion ?? "0.0.0",
    });
    this.#client.onclose = () => {
      this.#connected = false;
      this.#requests.disconnected(
        new McpError(ErrorCode.ConnectionClosed, "Connection closed"),
      );
    };
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
    await this.#requests.run(signal, (ownedSignal) =>
      this.#client.connect(this.#transport, {
        signal: ownedSignal,
        timeout: this.#connectTimeoutMs,
      }),
    );
    if (this.#closed) throw new Error("mcp_client_closed");
    this.#connected = true;
  }

  async listTools(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<McpToolPage> {
    this.#requireConnected();
    const page = await this.#requests.run(signal, (ownedSignal) =>
      this.#client.listTools(cursor === undefined ? {} : { cursor }, {
        signal: ownedSignal,
      }),
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
    return (await this.#requests.run(options.signal, (ownedSignal) =>
      this.#client.callTool({ name, arguments: { ...input } }, undefined, {
        signal: ownedSignal,
        timeout: options.timeoutMs,
        maxTotalTimeout: options.timeoutMs,
      }),
    )) as McpToolCallResult;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connected = false;
    this.#requests.close(
      new McpError(ErrorCode.ConnectionClosed, "Connection closed"),
    );
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
