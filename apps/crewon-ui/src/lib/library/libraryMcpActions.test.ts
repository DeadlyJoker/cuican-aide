import type { ResourceContent } from "@crewon-protocol/ResourceContent";
import { describe, expect, it } from "vitest";

import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import { handleLibraryMcpAction } from "./libraryMcpActions";

type CapturedMcpState = {
  calls: Array<{ args: unknown; server: string; threadId: string; tool: string }>;
  events: Array<{ body: string; threadId: string; title: string }>;
  oauthLogins: string[];
  panel: LibraryPanel | null;
  resources: Array<{ server: string; threadId: string | undefined; uri: string }>;
  threads: Array<{ server: string; tool: string }>;
};

function panel(fields: LibraryPanel["fields"] = []): LibraryPanel {
  return {
    kind: "tools",
    title: "MCP",
    subtitle: "github",
    body: "Existing",
    items: [],
    fields,
    actions: [{ id: "call-mcp-tool", label: "Call" }],
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    eventError?: unknown;
    fields?: LibraryPanel["fields"];
    resourceContents?: ResourceContent[];
    threadId?: string | null;
  } = {},
): Promise<{ handled: boolean; state: CapturedMcpState }> {
  const state: CapturedMcpState = {
    calls: [],
    events: [],
    oauthLogins: [],
    panel: panel(options.fields),
    resources: [],
    threads: [],
  };

  const handled = await handleLibraryMcpAction({
    action,
    callMcpTool: async (threadId, server, tool, args) => {
      state.calls.push({ args, server, threadId, tool });
      return { ok: true };
    },
    ensureBackendToolThread: async (server, tool) => {
      state.threads.push({ server, tool });
      return Object.hasOwn(options, "threadId")
        ? (options.threadId ?? null)
        : "thread-tool";
    },
    libraryPanel: state.panel,
    locale: "en",
    readMcpResource: async (server, uri, threadId) => {
      state.resources.push({ server, threadId, uri });
      return { contents: options.resourceContents ?? [] };
    },
    recordBackendToolEvent: async (threadId, title, body) => {
      if (options.eventError) {
        throw options.eventError;
      }
      state.events.push({ body, threadId, title });
    },
    resourceContextThreadId: "selected-thread",
    setLibraryPanel: (updater) => {
      state.panel = updater(state.panel);
    },
    startMcpOauthLogin: async (server) => {
      state.oauthLogins.push(server);
      return { authorizationUrl: "https://auth.example" };
    },
  });

  return { handled, state };
}

describe("library MCP actions", () => {
  it("starts MCP OAuth login and updates the panel", async () => {
    const { handled, state } = await handleAction({
      id: "login-mcp-oauth",
      label: "Login",
      mcpServerName: "github",
    });

    expect(handled).toBe(true);
    expect(state.oauthLogins).toEqual(["github"]);
    expect(state.panel?.body).toBe(
      "Open this URL to finish MCP authorization\nhttps://auth.example",
    );
  });

  it("calls MCP tools and records the result", async () => {
    const { handled, state } = await handleAction(
      {
        id: "call-mcp-tool",
        label: "Call",
        mcpServerName: "github",
        mcpToolName: "search",
      },
      {
        fields: [
          {
            id: "mcp-tool-arguments",
            label: "Args",
            value: '{ "query": "bugs" }',
          },
        ],
      },
    );

    expect(handled).toBe(true);
    expect(state.calls).toEqual([
      {
        args: { query: "bugs" },
        server: "github",
        threadId: "thread-tool",
        tool: "search",
      },
    ]);
    expect(state.events[0]).toMatchObject({
      threadId: "thread-tool",
      title: "Record MCP tool call: github.search",
    });
    expect(state.panel?.body).toContain("Tool result · thread thread-tool");
  });

  it("shows argument errors before calling MCP tools", async () => {
    const { handled, state } = await handleAction(
      {
        id: "call-mcp-tool",
        label: "Call",
        mcpServerName: "github",
        mcpToolName: "search",
      },
      {
        fields: [
          { id: "mcp-tool-arguments", label: "Args", value: "{" },
        ],
      },
    );

    expect(handled).toBe(true);
    expect(state.calls).toEqual([]);
    expect(state.panel?.error).toContain("Arguments are not valid JSON");
  });

  it("reads MCP resources and preserves record warnings", async () => {
    const { handled, state } = await handleAction(
      {
        id: "read-mcp-resource",
        label: "Read",
        mcpResourceServer: "github",
        mcpResourceUri: "repo://issues",
      },
      {
        eventError: new Error("record denied"),
        resourceContents: [
          {
            uri: "repo://issues",
            mimeType: "text/plain",
            text: "issue list",
          },
        ],
      },
    );

    expect(handled).toBe(true);
    expect(state.resources).toEqual([
      {
        server: "github",
        threadId: "selected-thread",
        uri: "repo://issues",
      },
    ]);
    expect(state.panel?.body).toContain("issue list");
    expect(state.panel?.body).toContain("Record warning: record denied");
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
  });
});
