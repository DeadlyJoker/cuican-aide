export type PendingApprovalRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export type PendingUserInputRequest = {
  id: number | string;
  questionIds: string[];
};

export type PendingDynamicToolRequest = {
  id: number | string;
  fieldId: string;
};

export type PendingMcpElicitationRequest = {
  id: number | string;
  fieldId: string;
};

export type PendingExternalSecretRequest = {
  id: number | string;
  kind: "chatgptAuthTokens" | "attestation";
};
