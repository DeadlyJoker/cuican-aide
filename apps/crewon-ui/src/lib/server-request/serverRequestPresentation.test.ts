import { describe, expect, it } from "vitest";

import {
  approvalHandledBody,
  buildApprovalResponse,
  buildDynamicToolResponse,
  buildExternalSecretResolution,
  buildMcpElicitationResponse,
  buildServerRequestPresentation,
  buildUserInputAnswers,
  decodeCapabilityActionPayload,
  dynamicToolHandledBody,
  encodeCapabilityActionPayload,
  externalSecretHandledBody,
  getDynamicToolDetails,
  getMcpElicitationDetails,
  getParamDisplay,
  getUserInputQuestions,
  grantedPermissionsFromRequest,
  mcpElicitationHandledBody,
  userInputHandledBody,
} from "./serverRequestPresentation";

describe("server request presentation helpers", () => {
  it("formats string, array, and object params for display", () => {
    expect(getParamDisplay({ command: "pnpm test" }, "command")).toBe(
      "pnpm test",
    );
    expect(
      getParamDisplay({ permissions: ["network", "files"] }, "permissions"),
    ).toBe("network files");
    expect(getParamDisplay({ fileChanges: { added: 2 } }, "fileChanges")).toBe(
      '{\n  "added": 2\n}',
    );
    expect(getParamDisplay({ empty: "" }, "empty")).toBeNull();
  });

  it("extracts granted permission objects from approval requests", () => {
    expect(
      grantedPermissionsFromRequest({
        permissions: {
          fileSystem: { read: ["/repo"] },
          network: { allow: true },
          ignored: true,
        },
      }),
    ).toEqual({
      fileSystem: { read: ["/repo"] },
      network: { allow: true },
    });
  });

  it("normalizes user input questions into editable field metadata", () => {
    expect(
      getUserInputQuestions({
        questions: [
          {
            id: "target",
            header: "Target",
            question: "Pick a deploy target",
            options: [{ label: "staging" }, { label: "production" }],
          },
          {
            id: "token",
            question: "API token",
            isSecret: true,
          },
          { question: "missing id" },
        ],
      }),
    ).toEqual([
      {
        id: "target",
        label: "Target - Pick a deploy target",
        placeholder: "staging / production",
        secret: false,
      },
      {
        id: "token",
        label: "API token",
        placeholder: undefined,
        secret: true,
      },
    ]);
  });

  it("formats dynamic tool and MCP elicitation details", () => {
    expect(
      getDynamicToolDetails({
        namespace: "browser",
        tool: "open",
        callId: "call-1",
        arguments: { url: "https://example.com" },
      }),
    ).toEqual({
      title: "browser.open",
      body: [
        "callId: call-1",
        'arguments:\n{\n  "url": "https://example.com"\n}',
      ].join("\n"),
    });

    expect(
      getMcpElicitationDetails({
        serverName: "github",
        mode: "form",
        message: "Authorize access",
        requestedSchema: { type: "object" },
      }),
    ).toEqual({
      title: "github · form",
      body: ["Authorize access", 'schema:\n{\n  "type": "object"\n}'].join(
        "\n",
      ),
      placeholder: "{}",
    });
  });

  it("round-trips capability action payloads", () => {
    const payload = { path: "/repo/README.md", nested: { line: 12 } };

    expect(
      decodeCapabilityActionPayload(encodeCapabilityActionPayload(payload)),
    ).toEqual(payload);
    expect(decodeCapabilityActionPayload("%")).toBeNull();
  });

  it("builds approval request panels and pending state", () => {
    expect(
      buildServerRequestPresentation(
        {
          id: 7,
          method: "execCommandApproval",
          params: { command: "pnpm build", cwd: "/repo" },
        },
        "en",
      ),
    ).toEqual({
      pending: {
        type: "approval",
        id: 7,
        method: "execCommandApproval",
        params: { command: "pnpm build", cwd: "/repo" },
      },
      panel: {
        title: "Command approval",
        subtitle: "7",
        body: "pnpm build\n/repo",
        actions: [
          { id: "approve-request", label: "Approve", tone: "primary" },
          { id: "decline-request", label: "Decline", tone: "danger" },
        ],
      },
    });
  });

  it("builds editable fields for user input requests", () => {
    expect(
      buildServerRequestPresentation(
        {
          id: "input-1",
          method: "item/tool/requestUserInput",
          params: {
            questions: [
              {
                id: "token",
                header: "Token",
                question: "Paste API token",
                isSecret: true,
              },
            ],
          },
        },
        "en",
      ),
    ).toEqual({
      pending: {
        type: "userInput",
        id: "input-1",
        questionIds: ["token"],
      },
      panel: {
        title: "User input request",
        subtitle: "input-1",
        body: "Answer the backend request",
        fields: [
          {
            id: "token",
            label: "Token - Paste API token",
            placeholder: undefined,
            secret: true,
            value: "",
          },
        ],
        actions: [
          { id: "submit-user-input", label: "Submit", tone: "primary" },
          { id: "cancel-user-input", label: "Cancel" },
        ],
      },
    });
  });

  it("builds dynamic tool result panels", () => {
    const presentation = buildServerRequestPresentation(
      {
        id: "tool-1",
        method: "item/tool/call",
        params: {
          namespace: "browser",
          tool: "open",
          arguments: { url: "https://example.com" },
        },
      },
      "en",
    );

    expect(presentation.pending).toEqual({
      type: "dynamicTool",
      id: "tool-1",
      fieldId: "dynamic-tool-result",
    });
    expect(presentation.panel.title).toBe("Dynamic tool call: browser.open");
    expect(presentation.panel.fields).toEqual([
      {
        id: "dynamic-tool-result",
        label: "Text returned to the tool call",
        placeholder: "Enter tool result...",
        value: "",
      },
    ]);
  });

  it("builds conservative panels for unknown server requests", () => {
    expect(
      buildServerRequestPresentation(
        { id: "unknown-1", method: "future/request" },
        "en",
      ),
    ).toEqual({
      pending: null,
      panel: {
        title: "Server request",
        subtitle: "unknown-1",
        body: "future/request\nSent a conservative response so the turn does not hang.",
      },
    });
  });

  it("builds external secret responses and rejections", () => {
    expect(
      buildExternalSecretResolution("submit-auth-refresh", "chatgptAuthTokens", (fieldId) =>
        ({
          accessToken: "token",
          chatgptAccountId: "account",
          chatgptPlanType: "",
        })[fieldId] ?? "",
      ),
    ).toEqual({
      type: "respond",
      payload: {
        accessToken: "token",
        chatgptAccountId: "account",
        chatgptPlanType: null,
      },
    });
    expect(
      buildExternalSecretResolution(
        "submit-attestation",
        "attestation",
        () => "",
      ),
    ).toEqual({
      type: "reject",
      reason: "Missing attestation token",
    });
    expect(externalSecretHandledBody(true, "en")).toBe("Request rejected");
    expect(externalSecretHandledBody(false, "zh")).toBe("已提交响应");
  });

  it("builds MCP elicitation responses", () => {
    expect(buildMcpElicitationResponse("accept-mcp-elicitation", '{"ok":true}')).toEqual({
      action: "accept",
      content: { ok: true },
      _meta: null,
    });
    expect(buildMcpElicitationResponse("decline-mcp-elicitation", "ignored")).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    expect(mcpElicitationHandledBody("accept", "zh")).toBe("已提交 MCP 输入");
    expect(mcpElicitationHandledBody("cancel", "en")).toBe(
      "MCP elicitation closed",
    );
  });

  it("builds dynamic tool responses", () => {
    expect(buildDynamicToolResponse("complete-dynamic-tool", "", "en")).toEqual({
      contentItems: [{ type: "inputText", text: "Tool call completed." }],
      success: true,
    });
    expect(buildDynamicToolResponse("fail-dynamic-tool", "bad input", "en")).toEqual({
      contentItems: [{ type: "inputText", text: "bad input" }],
      success: false,
    });
    expect(dynamicToolHandledBody(true, "en")).toBe("Tool result returned");
    expect(dynamicToolHandledBody(false, "zh")).toBe("已返回工具失败");
  });

  it("builds user input answers from selected fields", () => {
    expect(
      buildUserInputAnswers(
        [
          { id: "target", label: "Target", value: " staging " },
          { id: "ignored", label: "Ignored", value: "x" },
        ],
        ["target", "empty"],
        true,
      ),
    ).toEqual({
      target: { answers: ["staging"] },
    });
    expect(buildUserInputAnswers(undefined, ["target"], false)).toEqual({});
    expect(userInputHandledBody(true, "zh")).toBe("已提交输入");
    expect(userInputHandledBody(false, "en")).toBe("Input request cancelled");
  });

  it("builds approval responses for each approval API shape", () => {
    expect(
      buildApprovalResponse("item/permissions/requestApproval", true, {
        permissions: { network: { allow: true } },
      }),
    ).toEqual({
      permissions: { network: { allow: true } },
      scope: "turn",
      strictAutoReview: undefined,
    });
    expect(buildApprovalResponse("execCommandApproval", false, null)).toEqual({
      decision: "denied",
    });
    expect(buildApprovalResponse("item/fileChange/requestApproval", true, null)).toEqual({
      decision: "accept",
    });
    expect(approvalHandledBody(true, "en")).toBe("Request approved");
    expect(approvalHandledBody(false, "zh")).toBe("已拒绝请求");
  });
});
