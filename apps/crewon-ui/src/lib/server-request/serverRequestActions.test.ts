import { describe, expect, it } from "vitest";

import type {
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "../shared/pendingServerRequests";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createServerRequestActionHandlers,
  serverRequestActionForActionId,
  type ServerRequestActionHandlersParams,
} from "./serverRequestActions";

function baseParams(
  overrides: Partial<ServerRequestActionHandlersParams> = {},
): ServerRequestActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Request",
    body: "Pending",
  };
  let pendingApprovalRequest: PendingApprovalRequest | null = null;
  let pendingDynamicToolRequest: PendingDynamicToolRequest | null = null;
  let pendingExternalSecretRequest: PendingExternalSecretRequest | null = null;
  let pendingMcpElicitationRequest: PendingMcpElicitationRequest | null = null;
  let pendingUserInputRequest: PendingUserInputRequest | null = null;
  return {
    actionId: "approve-request",
    capabilityPanel: panel,
    client: {
      rejectServerRequest() {},
      respondServerRequest() {},
    },
    fieldValue: () => "",
    locale: "en",
    pendingApprovalRequest,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setPendingApprovalRequest: (request) => {
      pendingApprovalRequest = request;
    },
    setPendingDynamicToolRequest: (request) => {
      pendingDynamicToolRequest = request;
    },
    setPendingExternalSecretRequest: (request) => {
      pendingExternalSecretRequest = request;
    },
    setPendingMcpElicitationRequest: (request) => {
      pendingMcpElicitationRequest = request;
    },
    setPendingUserInputRequest: (request) => {
      pendingUserInputRequest = request;
    },
    ...overrides,
  };
}

describe("server request actions", () => {
  it("maps pending server request actions by action id", () => {
    expect(
      serverRequestActionForActionId({
        actionId: "submit-auth-refresh",
        pendingApprovalRequest: null,
        pendingDynamicToolRequest: null,
        pendingExternalSecretRequest: {
          id: "secret-1",
          kind: "chatgptAuthTokens",
        },
        pendingMcpElicitationRequest: null,
        pendingUserInputRequest: null,
      }),
    ).toBe("externalSecret");
    expect(
      serverRequestActionForActionId({
        actionId: "accept-mcp-elicitation",
        pendingApprovalRequest: null,
        pendingDynamicToolRequest: null,
        pendingExternalSecretRequest: null,
        pendingMcpElicitationRequest: { id: "mcp-1", fieldId: "payload" },
        pendingUserInputRequest: null,
      }),
    ).toBe("mcpElicitation");
    expect(
      serverRequestActionForActionId({
        actionId: "complete-dynamic-tool",
        pendingApprovalRequest: null,
        pendingDynamicToolRequest: { id: "tool-1", fieldId: "result" },
        pendingExternalSecretRequest: null,
        pendingMcpElicitationRequest: null,
        pendingUserInputRequest: null,
      }),
    ).toBe("dynamicTool");
    expect(
      serverRequestActionForActionId({
        actionId: "submit-user-input",
        pendingApprovalRequest: null,
        pendingDynamicToolRequest: null,
        pendingExternalSecretRequest: null,
        pendingMcpElicitationRequest: null,
        pendingUserInputRequest: { id: "input-1", questionIds: ["answer"] },
      }),
    ).toBe("userInput");
    expect(
      serverRequestActionForActionId({
        actionId: "decline-request",
        pendingApprovalRequest: {
          id: "approval-1",
          method: "execCommandApproval",
        },
        pendingDynamicToolRequest: null,
        pendingExternalSecretRequest: null,
        pendingMcpElicitationRequest: null,
        pendingUserInputRequest: null,
      }),
    ).toBe("approval");
  });

  it("responds to external auth token requests", () => {
    let panel: CapabilityPanel | null = {
      title: "Request",
      body: "Pending",
    };
    let pendingExternalSecretRequest: PendingExternalSecretRequest | null = {
      id: "secret-1",
      kind: "chatgptAuthTokens",
    };
    const responses: Array<{ requestId: number | string; response: unknown }> = [];
    const handlers = createServerRequestActionHandlers(
      baseParams({
        actionId: "submit-auth-refresh",
        client: {
          rejectServerRequest() {},
          respondServerRequest(requestId, response) {
            responses.push({ requestId, response });
          },
        },
        fieldValue: (fieldId) =>
          ({
            accessToken: "token",
            chatgptAccountId: "account",
            chatgptPlanType: "pro",
          })[fieldId] ?? "",
        pendingExternalSecretRequest,
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setPendingExternalSecretRequest: (request) => {
          pendingExternalSecretRequest = request;
        },
      }),
    );

    handlers.externalSecret();

    expect(responses).toEqual([
      {
        requestId: "secret-1",
        response: {
          accessToken: "token",
          chatgptAccountId: "account",
          chatgptPlanType: "pro",
        },
      },
    ]);
    expect(panel).toMatchObject({ body: "Response submitted" });
    expect(pendingExternalSecretRequest).toBeNull();
  });

  it("rejects external secret requests when requested", () => {
    const rejections: Array<{ reason: string; requestId: number | string }> = [];
    const handlers = createServerRequestActionHandlers(
      baseParams({
        actionId: "reject-external-secret",
        client: {
          rejectServerRequest(requestId, reason) {
            rejections.push({ reason, requestId });
          },
          respondServerRequest() {},
        },
        pendingExternalSecretRequest: {
          id: "secret-1",
          kind: "attestation",
        },
      }),
    );

    handlers.externalSecret();

    expect(rejections).toEqual([
      {
        reason: "Attestation token was not provided",
        requestId: "secret-1",
      },
    ]);
  });

  it("responds to MCP elicitation requests", () => {
    const responses: unknown[] = [];
    let pendingMcpElicitationRequest: PendingMcpElicitationRequest | null = {
      id: "mcp-1",
      fieldId: "payload",
    };
    const handlers = createServerRequestActionHandlers(
      baseParams({
        actionId: "accept-mcp-elicitation",
        client: {
          rejectServerRequest() {},
          respondServerRequest(_requestId, response) {
            responses.push(response);
          },
        },
        fieldValue: () => '{"ok":true}',
        pendingMcpElicitationRequest,
        setPendingMcpElicitationRequest: (request) => {
          pendingMcpElicitationRequest = request;
        },
      }),
    );

    handlers.mcpElicitation();

    expect(responses).toEqual([
      { action: "accept", content: { ok: true }, _meta: null },
    ]);
    expect(pendingMcpElicitationRequest).toBeNull();
  });

  it("responds to dynamic tool requests", () => {
    const responses: unknown[] = [];
    const handlers = createServerRequestActionHandlers(
      baseParams({
        actionId: "fail-dynamic-tool",
        client: {
          rejectServerRequest() {},
          respondServerRequest(_requestId, response) {
            responses.push(response);
          },
        },
        fieldValue: () => "bad input",
        pendingDynamicToolRequest: { id: "tool-1", fieldId: "result" },
      }),
    );

    handlers.dynamicTool();

    expect(responses).toEqual([
      {
        contentItems: [{ type: "inputText", text: "bad input" }],
        success: false,
      },
    ]);
  });

  it("responds to user input requests", () => {
    const responses: unknown[] = [];
    const handlers = createServerRequestActionHandlers(
      baseParams({
        actionId: "submit-user-input",
        capabilityPanel: {
          title: "Input",
          fields: [{ id: "answer", label: "Answer", value: " yes " }],
        },
        client: {
          rejectServerRequest() {},
          respondServerRequest(_requestId, response) {
            responses.push(response);
          },
        },
        pendingUserInputRequest: { id: "input-1", questionIds: ["answer"] },
      }),
    );

    handlers.userInput();

    expect(responses).toEqual([
      { answers: { answer: { answers: ["yes"] } } },
    ]);
  });

  it("responds to approval requests", () => {
    let panel: CapabilityPanel | null = {
      title: "Approval",
      body: "Pending",
    };
    let pendingApprovalRequest: PendingApprovalRequest | null = {
      id: "approval-1",
      method: "execCommandApproval",
    };
    const responses: unknown[] = [];
    const handlers = createServerRequestActionHandlers(
      baseParams({
        actionId: "decline-request",
        client: {
          rejectServerRequest() {},
          respondServerRequest(_requestId, response) {
            responses.push(response);
          },
        },
        pendingApprovalRequest,
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setPendingApprovalRequest: (request) => {
          pendingApprovalRequest = request;
        },
      }),
    );

    handlers.approval();

    expect(responses).toEqual([{ decision: "denied" }]);
    expect(panel).toMatchObject({ body: "Request declined" });
    expect(pendingApprovalRequest).toBeNull();
  });
});
