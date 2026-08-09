export type RunRoute = Readonly<{
  authorityId: string;
  runtimeGeneration: string;
  agentVersionId: string;
  policySnapshotId: string;
  workspaceBindingId: string | null;
}>;

export interface RunRouteResolverPort {
  resolveRoute(input: {
    actor: import("./authorization-port.ts").ActorContext;
    threadId: string;
    agentVersionId: string | null;
  }): Promise<RunRoute>;
}

export type CreateRunCommand = Readonly<{
  kind: "run.create";
  idempotencyKey: string;
  threadId: string;
  route: RunRoute;
}>;

type RunTransitionCommandBase = Readonly<{
  runId: string;
  expectedRevision: number;
  idempotencyKey: string;
}>;

export type RunTransitionCommand = RunTransitionCommandBase &
  (
    | Readonly<{ kind: "run.start" }>
    | Readonly<{
        kind: "run.requireApproval";
        approvalId: string;
        actionDigest: string;
      }>
    | Readonly<{ kind: "run.resume"; reasonCode: string }>
    | Readonly<{ kind: "run.suspend"; reasonCode: string }>
    | Readonly<{ kind: "run.requireReconciliation"; receiptId: string }>
    | Readonly<{ kind: "run.requestCancel" }>
    | Readonly<{ kind: "run.complete"; outputRef: string | null }>
    | Readonly<{ kind: "run.fail"; code: string; retryable: boolean }>
    | Readonly<{ kind: "run.confirmCanceled"; reasonCode: string }>
  );
