import type {
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "../shared/pendingServerRequests";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  approvalHandledPanel,
  dynamicToolHandledPanel,
  externalSecretHandledPanel,
  mcpElicitationHandledPanel,
  userInputHandledPanel,
} from "./serverRequestActionPresentation";
import {
  buildApprovalResponse,
  buildDynamicToolResponse,
  buildExternalSecretResolution,
  buildMcpElicitationResponse,
  buildUserInputAnswers,
} from "./serverRequestPresentation";

export type ServerRequestAction =
  | "approval"
  | "dynamicTool"
  | "externalSecret"
  | "mcpElicitation"
  | "userInput";

type ServerRequestClient = {
  rejectServerRequest(requestId: number | string, reason: string): void;
  respondServerRequest(requestId: number | string, response: unknown): void;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type ServerRequestActionHandlersParams = {
  actionId: string;
  capabilityPanel: CapabilityPanel | null;
  client: ServerRequestClient | null | undefined;
  fieldValue: (fieldId: string) => string;
  locale: Locale;
  pendingApprovalRequest: PendingApprovalRequest | null;
  pendingDynamicToolRequest: PendingDynamicToolRequest | null;
  pendingExternalSecretRequest: PendingExternalSecretRequest | null;
  pendingMcpElicitationRequest: PendingMcpElicitationRequest | null;
  pendingUserInputRequest: PendingUserInputRequest | null;
  setCapabilityPanel: SetCapabilityPanel;
  setPendingApprovalRequest: (request: PendingApprovalRequest | null) => void;
  setPendingDynamicToolRequest: (
    request: PendingDynamicToolRequest | null,
  ) => void;
  setPendingExternalSecretRequest: (
    request: PendingExternalSecretRequest | null,
  ) => void;
  setPendingMcpElicitationRequest: (
    request: PendingMcpElicitationRequest | null,
  ) => void;
  setPendingUserInputRequest: (request: PendingUserInputRequest | null) => void;
};

export function serverRequestActionForActionId(
  params: Pick<
    ServerRequestActionHandlersParams,
    | "actionId"
    | "pendingApprovalRequest"
    | "pendingDynamicToolRequest"
    | "pendingExternalSecretRequest"
    | "pendingMcpElicitationRequest"
    | "pendingUserInputRequest"
  >,
): ServerRequestAction | null {
  const {
    actionId,
    pendingApprovalRequest,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
  } = params;

  if (
    pendingExternalSecretRequest &&
    (actionId === "submit-auth-refresh" ||
      actionId === "submit-attestation" ||
      actionId === "reject-external-secret")
  ) {
    return "externalSecret";
  }

  if (
    pendingMcpElicitationRequest &&
    (actionId === "accept-mcp-elicitation" ||
      actionId === "decline-mcp-elicitation" ||
      actionId === "cancel-mcp-elicitation")
  ) {
    return "mcpElicitation";
  }

  if (
    pendingDynamicToolRequest &&
    (actionId === "complete-dynamic-tool" || actionId === "fail-dynamic-tool")
  ) {
    return "dynamicTool";
  }

  if (
    pendingUserInputRequest &&
    (actionId === "submit-user-input" || actionId === "cancel-user-input")
  ) {
    return "userInput";
  }

  return pendingApprovalRequest ? "approval" : null;
}

export function createServerRequestActionHandlers(
  params: ServerRequestActionHandlersParams,
): Record<ServerRequestAction, () => void> {
  return {
    approval: () => handleApproval(params),
    dynamicTool: () => handleDynamicTool(params),
    externalSecret: () => handleExternalSecret(params),
    mcpElicitation: () => handleMcpElicitation(params),
    userInput: () => handleUserInput(params),
  };
}

function handleExternalSecret(params: ServerRequestActionHandlersParams) {
  const {
    actionId,
    client,
    fieldValue,
    locale,
    pendingExternalSecretRequest,
    setCapabilityPanel,
    setPendingExternalSecretRequest,
  } = params;

  if (!pendingExternalSecretRequest) {
    return;
  }

  const resolution = buildExternalSecretResolution(
    actionId,
    pendingExternalSecretRequest.kind,
    fieldValue,
  );

  if (resolution.type === "reject") {
    client?.rejectServerRequest(
      pendingExternalSecretRequest.id,
      resolution.reason,
    );
  } else {
    client?.respondServerRequest(
      pendingExternalSecretRequest.id,
      resolution.payload,
    );
  }

  setCapabilityPanel((currentPanel) =>
    externalSecretHandledPanel(
      currentPanel,
      actionId === "reject-external-secret",
      locale,
    ),
  );
  setPendingExternalSecretRequest(null);
}

function handleMcpElicitation(params: ServerRequestActionHandlersParams) {
  const {
    actionId,
    client,
    fieldValue,
    locale,
    pendingMcpElicitationRequest,
    setCapabilityPanel,
    setPendingMcpElicitationRequest,
  } = params;

  if (!pendingMcpElicitationRequest) {
    return;
  }

  const value = fieldValue(pendingMcpElicitationRequest.fieldId);
  const response = buildMcpElicitationResponse(actionId, value);
  client?.respondServerRequest(pendingMcpElicitationRequest.id, response);
  setCapabilityPanel((currentPanel) =>
    mcpElicitationHandledPanel(currentPanel, response.action, locale),
  );
  setPendingMcpElicitationRequest(null);
}

function handleDynamicTool(params: ServerRequestActionHandlersParams) {
  const {
    actionId,
    client,
    fieldValue,
    locale,
    pendingDynamicToolRequest,
    setCapabilityPanel,
    setPendingDynamicToolRequest,
  } = params;

  if (!pendingDynamicToolRequest) {
    return;
  }

  const value = fieldValue(pendingDynamicToolRequest.fieldId);
  const response = buildDynamicToolResponse(actionId, value, locale);

  client?.respondServerRequest(pendingDynamicToolRequest.id, response);
  setCapabilityPanel((currentPanel) =>
    dynamicToolHandledPanel(currentPanel, response.success, locale),
  );
  setPendingDynamicToolRequest(null);
}

function handleUserInput(params: ServerRequestActionHandlersParams) {
  const {
    actionId,
    capabilityPanel,
    client,
    locale,
    pendingUserInputRequest,
    setCapabilityPanel,
    setPendingUserInputRequest,
  } = params;

  if (!pendingUserInputRequest) {
    return;
  }

  const shouldSubmit = actionId === "submit-user-input";
  const answers = buildUserInputAnswers(
    capabilityPanel?.fields,
    pendingUserInputRequest.questionIds,
    shouldSubmit,
  );

  client?.respondServerRequest(pendingUserInputRequest.id, { answers });
  setCapabilityPanel((currentPanel) =>
    userInputHandledPanel(currentPanel, shouldSubmit, locale),
  );
  setPendingUserInputRequest(null);
}

function handleApproval(params: ServerRequestActionHandlersParams) {
  const {
    actionId,
    client,
    locale,
    pendingApprovalRequest,
    setCapabilityPanel,
    setPendingApprovalRequest,
  } = params;

  if (!pendingApprovalRequest) {
    return;
  }

  const isApprove = actionId === "approve-request";
  const approvalResult = buildApprovalResponse(
    pendingApprovalRequest.method,
    isApprove,
    pendingApprovalRequest.params,
  );

  client?.respondServerRequest(pendingApprovalRequest.id, approvalResult);
  setCapabilityPanel((currentPanel) =>
    approvalHandledPanel(currentPanel, isApprove, locale),
  );
  setPendingApprovalRequest(null);
}
