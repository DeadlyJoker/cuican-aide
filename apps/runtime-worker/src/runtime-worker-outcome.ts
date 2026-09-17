export type RuntimeWorkerOutcome =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "completed"; runId: string }>
  | Readonly<{ kind: "canceled"; runId: string }>
  | Readonly<{ kind: "failed"; runId: string; code: string }>
  | Readonly<{ kind: "retried"; runId: string; code: string }>
  | Readonly<{
      kind: "workflowWaiting";
      runId: string;
      children: number;
      humanGates: number;
    }>
  | Readonly<{
      kind: "waitingApproval";
      runId: string;
      approvalId: string;
    }>
  | Readonly<{ kind: "leaseLost"; runId: string }>;
