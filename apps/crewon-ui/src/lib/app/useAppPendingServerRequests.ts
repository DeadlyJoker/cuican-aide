import { useState } from "react";

import type {
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "../shared/pendingServerRequests";

export function useAppPendingServerRequests() {
  const [pendingApprovalRequest, setPendingApprovalRequest] =
    useState<PendingApprovalRequest | null>(null);
  const [pendingUserInputRequest, setPendingUserInputRequest] =
    useState<PendingUserInputRequest | null>(null);
  const [pendingDynamicToolRequest, setPendingDynamicToolRequest] =
    useState<PendingDynamicToolRequest | null>(null);
  const [pendingMcpElicitationRequest, setPendingMcpElicitationRequest] =
    useState<PendingMcpElicitationRequest | null>(null);
  const [pendingExternalSecretRequest, setPendingExternalSecretRequest] =
    useState<PendingExternalSecretRequest | null>(null);

  return {
    pendingApprovalRequest,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
    setPendingApprovalRequest,
    setPendingDynamicToolRequest,
    setPendingExternalSecretRequest,
    setPendingMcpElicitationRequest,
    setPendingUserInputRequest,
  };
}
