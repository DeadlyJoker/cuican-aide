import { describe, expect, it } from "vitest";

import type { AppServerRequest } from "../app-server/appServer";
import type {
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "../shared/pendingServerRequests";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  handleIncomingServerRequest,
  handleResolvedServerRequest,
} from "./serverRequestHandler";

type CapturedServerRequestState = {
  capabilityDockOpen: boolean;
  capabilityPanel: CapabilityPanel | null;
  inspectorOpen: boolean;
  pendingApprovalRequest: PendingApprovalRequest | null;
  pendingDynamicToolRequest: PendingDynamicToolRequest | null;
  pendingExternalSecretRequest: PendingExternalSecretRequest | null;
  pendingMcpElicitationRequest: PendingMcpElicitationRequest | null;
  pendingUserInputRequest: PendingUserInputRequest | null;
};

function handleRequest(
  request: AppServerRequest,
): CapturedServerRequestState {
  const state: CapturedServerRequestState = {
    capabilityDockOpen: false,
    capabilityPanel: null,
    inspectorOpen: true,
    pendingApprovalRequest: {
      id: "stale-approval",
      method: "execCommandApproval",
    },
    pendingDynamicToolRequest: {
      id: "stale-tool",
      fieldId: "dynamic-tool-result",
    },
    pendingExternalSecretRequest: {
      id: "stale-secret",
      kind: "attestation",
    },
    pendingMcpElicitationRequest: {
      id: "stale-mcp",
      fieldId: "mcp-elicitation-content",
    },
    pendingUserInputRequest: {
      id: "stale-input",
      questionIds: ["answer"],
    },
  };

  handleIncomingServerRequest({
    locale: "en",
    request,
    setCapabilityDockOpen: (open) => {
      state.capabilityDockOpen = open;
    },
    setCapabilityPanel: (panel) => {
      state.capabilityPanel = panel;
    },
    setInspectorOpen: (open) => {
      state.inspectorOpen = open;
    },
    setPendingApprovalRequest: (pendingRequest) => {
      state.pendingApprovalRequest = pendingRequest;
    },
    setPendingDynamicToolRequest: (pendingRequest) => {
      state.pendingDynamicToolRequest = pendingRequest;
    },
    setPendingExternalSecretRequest: (pendingRequest) => {
      state.pendingExternalSecretRequest = pendingRequest;
    },
    setPendingMcpElicitationRequest: (pendingRequest) => {
      state.pendingMcpElicitationRequest = pendingRequest;
    },
    setPendingUserInputRequest: (pendingRequest) => {
      state.pendingUserInputRequest = pendingRequest;
    },
  });

  return state;
}

function resolveRequest(requestId: number | string): CapturedServerRequestState {
  const state: CapturedServerRequestState = {
    capabilityDockOpen: true,
    capabilityPanel: {
      title: "Command approval",
      subtitle: "7",
      body: "pnpm build",
      actions: [{ id: "approve-request", label: "Approve" }],
      fields: [{ id: "comment", label: "Comment", value: "" }],
    },
    inspectorOpen: false,
    pendingApprovalRequest: {
      id: 7,
      method: "execCommandApproval",
    },
    pendingDynamicToolRequest: {
      id: "other-request",
      fieldId: "dynamic-tool-result",
    },
    pendingExternalSecretRequest: null,
    pendingMcpElicitationRequest: null,
    pendingUserInputRequest: null,
  };

  handleResolvedServerRequest({
    locale: "en",
    requestId,
    setCapabilityPanel: (updater) => {
      state.capabilityPanel = updater(state.capabilityPanel);
    },
    setPendingApprovalRequest: (updater) => {
      state.pendingApprovalRequest = updater(state.pendingApprovalRequest);
    },
    setPendingDynamicToolRequest: (updater) => {
      state.pendingDynamicToolRequest = updater(state.pendingDynamicToolRequest);
    },
    setPendingExternalSecretRequest: (updater) => {
      state.pendingExternalSecretRequest = updater(
        state.pendingExternalSecretRequest,
      );
    },
    setPendingMcpElicitationRequest: (updater) => {
      state.pendingMcpElicitationRequest = updater(
        state.pendingMcpElicitationRequest,
      );
    },
    setPendingUserInputRequest: (updater) => {
      state.pendingUserInputRequest = updater(state.pendingUserInputRequest);
    },
  });

  return state;
}

describe("server request handler", () => {
  it("opens the capability panel and stores approval request state", () => {
    const state = handleRequest({
      id: 7,
      method: "execCommandApproval",
      params: { command: "pnpm build", cwd: "/repo" },
    });

    expect(state).toMatchObject({
      capabilityDockOpen: true,
      capabilityPanel: {
        title: "Command approval",
        subtitle: "7",
      },
      inspectorOpen: false,
      pendingApprovalRequest: {
        id: 7,
        method: "execCommandApproval",
        params: { command: "pnpm build", cwd: "/repo" },
      },
      pendingDynamicToolRequest: null,
      pendingExternalSecretRequest: null,
      pendingMcpElicitationRequest: null,
      pendingUserInputRequest: null,
    });
  });

  it("clears stale request state when storing user input request state", () => {
    const state = handleRequest({
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
    });

    expect(state).toMatchObject({
      capabilityDockOpen: true,
      capabilityPanel: {
        title: "User input request",
        fields: [
          {
            id: "token",
            label: "Token - Paste API token",
            secret: true,
            value: "",
          },
        ],
      },
      inspectorOpen: false,
      pendingApprovalRequest: null,
      pendingDynamicToolRequest: null,
      pendingExternalSecretRequest: null,
      pendingMcpElicitationRequest: null,
      pendingUserInputRequest: {
        id: "input-1",
        questionIds: ["token"],
      },
    });
  });

  it("stores dynamic tool, MCP elicitation, and external secret pending states", () => {
    expect(
      handleRequest({
        id: "tool-1",
        method: "item/tool/call",
        params: { namespace: "browser", tool: "open" },
      }).pendingDynamicToolRequest,
    ).toEqual({ id: "tool-1", fieldId: "dynamic-tool-result" });
    expect(
      handleRequest({
        id: "mcp-1",
        method: "mcpServer/elicitation/request",
        params: { serverName: "github", mode: "form" },
      }).pendingMcpElicitationRequest,
    ).toEqual({ id: "mcp-1", fieldId: "mcp-elicitation-content" });
    expect(
      handleRequest({
        id: "secret-1",
        method: "account/chatgptAuthTokens/refresh",
      }).pendingExternalSecretRequest,
    ).toEqual({ id: "secret-1", kind: "chatgptAuthTokens" });
  });

  it("marks matching request panels resolved and clears matching pending state", () => {
    const state = resolveRequest("7");

    expect(state.capabilityPanel).toEqual({
      title: "Command approval",
      subtitle: "7",
      body: "Request resolved",
      actions: undefined,
      fields: undefined,
    });
    expect(state.pendingApprovalRequest).toBeNull();
    expect(state.pendingDynamicToolRequest).toEqual({
      id: "other-request",
      fieldId: "dynamic-tool-result",
    });
  });
});
