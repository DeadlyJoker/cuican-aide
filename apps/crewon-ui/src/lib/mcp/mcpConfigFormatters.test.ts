import { describe, expect, it } from "vitest";

import type { McpServerConfigRecord } from "@crewon-ui-model/v2/McpServerConfigRecord";

import {
  mcpConfigDetailText,
  mcpConfigEnabled,
  mcpConfigEndpoint,
  mcpConfigEnvSummary,
} from "./mcpConfigFormatters";

function record(config: McpServerConfigRecord["config"]): McpServerConfigRecord {
  return {
    name: "github",
    config,
  };
}

describe("mcp config formatters", () => {
  it("uses command before url for endpoint", () => {
    expect(
      mcpConfigEndpoint(
        record({
          command: "npx",
          url: "https://example.test/mcp",
        }),
      ),
    ).toBe("npx");
  });

  it("treats only explicit false as disabled", () => {
    expect(mcpConfigEnabled(record({}))).toBe(true);
    expect(mcpConfigEnabled(record({ enabled: true }))).toBe(true);
    expect(mcpConfigEnabled(record({ enabled: false }))).toBe(false);
  });

  it("summarizes env object keys without values", () => {
    expect(mcpConfigEnvSummary(record({ env: { TOKEN: "secret" } }), "en")).toBe(
      "Environment: 1 keys (values hidden)",
    );
    expect(mcpConfigEnvSummary(record({ env: {} }), "en")).toBeNull();
    expect(mcpConfigEnvSummary(record({ env: [] }), "en")).toBeNull();
  });

  it("includes status, string arg count, env summary, and environment id", () => {
    const text = mcpConfigDetailText(
      record({
        command: "node",
        args: ["server.js", 42, "--stdio"],
        env: { TOKEN: "secret", MODE: "test" },
        environment_id: "env-local",
        enabled: false,
      }),
      "en",
    );

    expect(text).toContain("Status: disabled");
    expect(text).toContain("Endpoint: node");
    expect(text).toContain("Args: 2 items (values hidden)");
    expect(text).toContain("Environment: 2 keys (values hidden)");
    expect(text).toContain("Environment: env-local");
  });
});
