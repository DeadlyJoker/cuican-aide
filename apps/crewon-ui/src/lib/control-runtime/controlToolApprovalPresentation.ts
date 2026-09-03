export type ControlToolApprovalRequest = Readonly<{
  approvalId: string;
  runId: string;
  threadId: string;
  toolName: string | null;
}>;

export type ControlToolApprovalPrompt = ControlToolApprovalRequest &
  Readonly<{
    busy: boolean;
    error?: string;
  }>;
