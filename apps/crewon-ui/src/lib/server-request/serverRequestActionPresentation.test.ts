import { describe, expect, it } from "vitest";

import {
  approvalHandledPanel,
  approvalHandledPatch,
  dynamicToolHandledPanel,
  dynamicToolHandledPatch,
  externalSecretHandledPanel,
  externalSecretHandledPatch,
  mcpElicitationHandledPanel,
  mcpElicitationHandledPatch,
  userInputHandledPanel,
  userInputHandledPatch,
} from "./serverRequestActionPresentation";

describe("server request action presentation helpers", () => {
  it("builds external secret handled patches", () => {
    expect(externalSecretHandledPatch(true, "en")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "Request rejected",
    });
    expect(externalSecretHandledPatch(false, "zh")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "已提交响应",
    });
    expect(
      externalSecretHandledPanel(
        {
          title: "Request",
          body: "Waiting",
          actions: [{ id: "reject-external-secret", label: "Reject" }],
          fields: [{ id: "token", label: "Token", value: "secret" }],
        },
        true,
        "en",
      ),
    ).toEqual({
      title: "Request",
      body: "Request rejected",
      actions: undefined,
      fields: undefined,
    });
    expect(externalSecretHandledPanel(null, false, "en")).toBeNull();
  });

  it("builds MCP elicitation handled patches", () => {
    expect(mcpElicitationHandledPatch("accept", "zh")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "已提交 MCP 输入",
    });
    expect(mcpElicitationHandledPatch("cancel", "en")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "MCP elicitation closed",
    });
    expect(
      mcpElicitationHandledPanel(
        {
          title: "Request",
          body: "Waiting",
          actions: [{ id: "accept-mcp-elicitation", label: "Accept" }],
          fields: [{ id: "answer", label: "Answer", value: "yes" }],
        },
        "accept",
        "zh",
      ),
    ).toEqual({
      title: "Request",
      body: "已提交 MCP 输入",
      actions: undefined,
      fields: undefined,
    });
  });

  it("builds dynamic tool handled patches", () => {
    expect(dynamicToolHandledPatch(true, "en")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "Tool result returned",
    });
    expect(dynamicToolHandledPatch(false, "zh")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "已返回工具失败",
    });
    expect(
      dynamicToolHandledPanel(
        {
          title: "Tool",
          body: "Waiting",
          actions: [{ id: "complete-dynamic-tool", label: "Complete" }],
          fields: [{ id: "result", label: "Result", value: "ok" }],
        },
        true,
        "en",
      ),
    ).toEqual({
      title: "Tool",
      body: "Tool result returned",
      actions: undefined,
      fields: undefined,
    });
  });

  it("builds user input handled patches", () => {
    expect(userInputHandledPatch(true, "zh")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "已提交输入",
    });
    expect(userInputHandledPatch(false, "en")).toEqual({
      actions: undefined,
      fields: undefined,
      body: "Input request cancelled",
    });
    expect(
      userInputHandledPanel(
        {
          title: "Input",
          body: "Waiting",
          actions: [{ id: "submit-user-input", label: "Submit" }],
          fields: [{ id: "answer", label: "Answer", value: "yes" }],
        },
        false,
        "en",
      ),
    ).toEqual({
      title: "Input",
      body: "Input request cancelled",
      actions: undefined,
      fields: undefined,
    });
  });

  it("builds approval handled patches without clearing fields", () => {
    expect(approvalHandledPatch(true, "en")).toEqual({
      actions: undefined,
      body: "Request approved",
    });
    expect(approvalHandledPatch(false, "zh")).toEqual({
      actions: undefined,
      body: "已拒绝请求",
    });
    expect(
      approvalHandledPanel(
        {
          title: "Approval",
          body: "Waiting",
          actions: [{ id: "approve-request", label: "Approve" }],
          fields: [{ id: "reason", label: "Reason", value: "ok" }],
        },
        true,
        "en",
      ),
    ).toEqual({
      title: "Approval",
      body: "Request approved",
      actions: undefined,
      fields: [{ id: "reason", label: "Reason", value: "ok" }],
    });
  });
});
