import type { AppServerRequest } from "../app-server/appServer";
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
  clearPendingRequestById,
  resolveServerRequestPanel,
} from "./serverRequestState";
import { buildServerRequestPresentation } from "./serverRequestPresentation";

export type IncomingServerRequestHandlerParams = {
  locale: Locale;
  request: AppServerRequest;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: (panel: CapabilityPanel) => void;
  setInspectorOpen: (open: boolean) => void;
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
  setPendingUserInputRequest: (
    request: PendingUserInputRequest | null,
  ) => void;
};

export type ResolvedServerRequestHandlerParams = {
  locale: Locale;
  requestId: number | string;
  setCapabilityPanel: (
    updater: (panel: CapabilityPanel | null) => CapabilityPanel | null,
  ) => void;
  setPendingApprovalRequest: (
    updater: (
      request: PendingApprovalRequest | null,
    ) => PendingApprovalRequest | null,
  ) => void;
  setPendingDynamicToolRequest: (
    updater: (
      request: PendingDynamicToolRequest | null,
    ) => PendingDynamicToolRequest | null,
  ) => void;
  setPendingExternalSecretRequest: (
    updater: (
      request: PendingExternalSecretRequest | null,
    ) => PendingExternalSecretRequest | null,
  ) => void;
  setPendingMcpElicitationRequest: (
    updater: (
      request: PendingMcpElicitationRequest | null,
    ) => PendingMcpElicitationRequest | null,
  ) => void;
  setPendingUserInputRequest: (
    updater: (
      request: PendingUserInputRequest | null,
    ) => PendingUserInputRequest | null,
  ) => void;
};

export function handleIncomingServerRequest({
  locale,
  request,
  setCapabilityDockOpen,
  setCapabilityPanel,
  setInspectorOpen,
  setPendingApprovalRequest,
  setPendingDynamicToolRequest,
  setPendingExternalSecretRequest,
  setPendingMcpElicitationRequest,
  setPendingUserInputRequest,
}: IncomingServerRequestHandlerParams): void {
  const presentation = buildServerRequestPresentation(request, locale);

  setCapabilityDockOpen(true);
  setInspectorOpen(false);
  setPendingApprovalRequest(
    presentation.pending?.type === "approval"
      ? {
          id: presentation.pending.id,
          method: presentation.pending.method,
          params: presentation.pending.params,
        }
      : null,
  );
  setPendingUserInputRequest(
    presentation.pending?.type === "userInput"
      ? {
          id: presentation.pending.id,
          questionIds: presentation.pending.questionIds,
        }
      : null,
  );
  setPendingDynamicToolRequest(
    presentation.pending?.type === "dynamicTool"
      ? { id: presentation.pending.id, fieldId: presentation.pending.fieldId }
      : null,
  );
  setPendingMcpElicitationRequest(
    presentation.pending?.type === "mcpElicitation"
      ? { id: presentation.pending.id, fieldId: presentation.pending.fieldId }
      : null,
  );
  setPendingExternalSecretRequest(
    presentation.pending?.type === "externalSecret"
      ? { id: presentation.pending.id, kind: presentation.pending.kind }
      : null,
  );
  setCapabilityPanel(presentation.panel);
}

export function handleResolvedServerRequest({
  locale,
  requestId,
  setCapabilityPanel,
  setPendingApprovalRequest,
  setPendingDynamicToolRequest,
  setPendingExternalSecretRequest,
  setPendingMcpElicitationRequest,
  setPendingUserInputRequest,
}: ResolvedServerRequestHandlerParams): void {
  setCapabilityPanel((currentPanel) =>
    resolveServerRequestPanel(currentPanel, requestId, locale),
  );
  setPendingApprovalRequest((currentRequest) =>
    clearPendingRequestById(currentRequest, requestId),
  );
  setPendingUserInputRequest((currentRequest) =>
    clearPendingRequestById(currentRequest, requestId),
  );
  setPendingDynamicToolRequest((currentRequest) =>
    clearPendingRequestById(currentRequest, requestId),
  );
  setPendingMcpElicitationRequest((currentRequest) =>
    clearPendingRequestById(currentRequest, requestId),
  );
  setPendingExternalSecretRequest((currentRequest) =>
    clearPendingRequestById(currentRequest, requestId),
  );
}
