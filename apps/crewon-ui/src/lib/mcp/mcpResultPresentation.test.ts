import { describe, expect, it } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import {
  mcpResourceBody,
  mcpResourceOpenThreadActions,
  mcpResourcePanelBody,
  mcpResourceReadResultPanel,
  mcpResourceRecordText,
  mcpResourceRecordTitle,
  mcpToolArgumentsError,
  mcpToolArgumentsErrorPanel,
  mcpToolArgumentsPayload,
  mcpToolCallPanelBody,
  mcpToolCallResultPanel,
  mcpToolCallRecordText,
  mcpToolCallRecordTitle,
  mcpToolThreadUnavailablePanel,
  mcpToolOpenThreadActions,
  mcpToolThreadUnavailableError,
} from "./mcpResultPresentation";

function panel(): LibraryPanel {
  return {
    kind: "tools",
    title: "GitHub MCP",
    subtitle: "github",
    body: "Existing details",
    actions: [{ id: "call-mcp-tool", label: "Call" }],
    items: [],
    error: "old error",
  };
}

describe("mcp result presentation", () => {
  it("builds tool call status titles and errors", () => {
    expect(mcpToolThreadUnavailableError("en")).toBe(
      "Unable to create a tool verification thread.",
    );
    expect(mcpToolArgumentsError(new Error("Unexpected token"), "zh")).toBe(
      "参数不是合法 JSON: Unexpected token",
    );
    expect(mcpToolArgumentsError(null, "en")).toBe(
      "Arguments are not valid JSON",
    );
    expect(
      mcpToolCallRecordTitle({
        locale: "zh",
        server: "github",
        tool: "search",
      }),
    ).toBe("记录 MCP 工具调用：github.search");
  });

  it("parses tool call argument payloads from panels", () => {
    expect(
      mcpToolArgumentsPayload({
        ...panel(),
        fields: [
          {
            id: "mcp-tool-arguments",
            label: "Arguments",
            value: ' { "query": "bug" } ',
          },
        ],
      }),
    ).toEqual({ query: "bug" });
    expect(mcpToolArgumentsPayload(panel())).toEqual({});
    expect(
      mcpToolArgumentsPayload({
        ...panel(),
        fields: [
          {
            id: "mcp-tool-arguments",
            label: "Arguments",
            value: "   ",
          },
        ],
      }),
    ).toBeUndefined();
    expect(() =>
      mcpToolArgumentsPayload({
        ...panel(),
        fields: [
          {
            id: "mcp-tool-arguments",
            label: "Arguments",
            value: "{",
          },
        ],
      }),
    ).toThrow();
  });

  it("builds tool call record and panel body text", () => {
    expect(
      mcpToolCallRecordText({
        args: { query: "bug" },
        locale: "en",
        response: { content: ["ok"] },
        server: "github",
        tool: "search",
      }),
    ).toBe(
      [
        "Tool: github.search",
        "Arguments:",
        '{\n  "query": "bug"\n}',
        "Result:",
        '{\n  "content": [\n    "ok"\n  ]\n}',
      ].join("\n"),
    );

    expect(
      mcpToolCallPanelBody({
        currentBody: "Existing details",
        locale: "zh",
        recordWarning: null,
        response: { content: ["ok"] },
        threadId: "thread-1",
      }),
    ).toContain("结果已写入工具验证线程。");
    expect(
      mcpToolCallResultPanel(panel(), {
        locale: "en",
        recordWarning: null,
        response: { content: ["ok"] },
        threadId: "thread-1",
      }),
    ).toMatchObject({
      body: expect.stringContaining("Tool result · thread thread-1"),
      actions: [
        {
          id: "open-thread",
          label: "Open tool verification thread",
          threadId: "thread-1",
        },
        { id: "call-mcp-tool", label: "Call" },
      ],
      error: undefined,
    });
    expect(mcpToolCallResultPanel(null, {
      locale: "en",
      recordWarning: null,
      response: {},
      threadId: "thread-1",
    })).toBeNull();
  });

  it("builds tool call error panels", () => {
    expect(mcpToolThreadUnavailablePanel(panel(), "en")).toEqual({
      ...panel(),
      error: "Unable to create a tool verification thread.",
    });
    expect(
      mcpToolArgumentsErrorPanel(
        panel(),
        new Error("Unexpected token"),
        "en",
      ),
    ).toEqual({
      ...panel(),
      error: "Arguments are not valid JSON: Unexpected token",
    });
    expect(mcpToolArgumentsErrorPanel(null, null, "en")).toBeNull();
  });

  it("deduplicates tool open-thread actions", () => {
    expect(
      mcpToolOpenThreadActions(
        [
          { id: "open-thread", label: "old", threadId: "thread-1" },
          { id: "reload-tools", label: "Reload" },
        ],
        "thread-1",
        "en",
      ),
    ).toEqual([
      {
        id: "open-thread",
        label: "Open tool verification thread",
        threadId: "thread-1",
      },
      { id: "reload-tools", label: "Reload" },
    ]);
  });

  it("formats text and binary resource content", () => {
    expect(
      mcpResourceBody(
        [
          {
            uri: "file://notes.md",
            mimeType: "text/markdown",
            text: "# Notes",
          },
          {
            uri: "file://image.png",
            blob: "YWJjZA==",
          },
        ],
        "en",
      ),
    ).toBe(
      [
        "URI: file://notes.md",
        "MIME: text/markdown",
        "# Notes",
        "",
        "---",
        "",
        "URI: file://image.png",
        "Binary resource, base64 length: 8",
      ].join("\n"),
    );
  });

  it("builds resource record and panel body text", () => {
    expect(mcpResourceRecordTitle({ locale: "en", server: "github" })).toBe(
      "Record MCP resource read: github",
    );
    expect(
      mcpResourceRecordText({
        body: "abcdef",
        locale: "zh",
        uri: "file://notes.md",
      }),
    ).toBe(["资源：file://notes.md", "内容摘要：", "abcdef"].join("\n"));

    expect(
      mcpResourcePanelBody({
        body: "",
        locale: "en",
        recordWarning: "disk full",
        threadId: "thread-2",
      }),
    ).toBe(
      "Resource read succeeded with no contents.\n\nRecord warning: disk full",
    );
  });

  it("deduplicates resource open-thread actions", () => {
    expect(
      mcpResourceOpenThreadActions(
        [{ id: "open-thread", label: "old", threadId: "thread-2" }],
        "thread-2",
        "zh",
      ),
    ).toEqual([
      {
        id: "open-thread",
        label: "打开资源验证线程",
        threadId: "thread-2",
      },
    ]);
  });

  it("updates resource read result panels", () => {
    expect(
      mcpResourceReadResultPanel(panel(), {
        body: "# Notes",
        locale: "en",
        recordWarning: null,
        threadId: "thread-2",
      }),
    ).toEqual({
      ...panel(),
      body: "# Notes\n\nResource read result written to thread: thread-2",
      actions: [
        {
          id: "open-thread",
          label: "Open resource verification thread",
          threadId: "thread-2",
        },
        { id: "call-mcp-tool", label: "Call" },
      ],
      error: undefined,
    });

    expect(
      mcpResourceReadResultPanel(panel(), {
        body: "",
        locale: "zh",
        recordWarning: null,
        threadId: null,
      }),
    ).toEqual({
      ...panel(),
      body: "资源读取成功，但没有内容。",
      error: undefined,
    });
    expect(
      mcpResourceReadResultPanel(null, {
        body: "",
        locale: "en",
        recordWarning: null,
        threadId: null,
      }),
    ).toBeNull();
  });
});
