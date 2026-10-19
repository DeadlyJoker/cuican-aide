import type { TeamMemberRuntimeProfile } from "@crewon/domain/team-prompts";
import type { TeamTaskWriteFence } from "./team-task-journal.ts";
import type { AutonomousTaskChildAdmission } from "./autonomous-task-admission.ts";
import type { AutonomousTaskChildAdmissionResult } from "./team-task-journal.ts";
export type {
  TeamMemberRuntimeCapability,
  TeamMemberRuntimeProfile,
} from "@crewon/domain/team-prompts";
import type {
  AppendThreadMessageRequest,
  AppendThreadMessageResponse,
  AuthorizeOfficeRunResponse,
  CreateRunRequest,
  ExecutionIntentCapabilityResponse,
  ForkThreadRequest,
  GetOfficeResponse,
  GetRunResponse,
  GetThreadGoalResponse,
  GetThreadResponse,
  ListThreadMessagesResponse,
  MessageView,
  RunMutationResponse,
  RunView,
  SetThreadGoalRequest,
  StartOfficeRunRequest,
  StartTurnRequest,
  StartTurnResponse,
  ThreadHistoryViewMode,
  ThreadGoalMutationResponse,
  ThreadMutationResponse,
  ToolPermissionMode,
} from "@crewon/contracts";

/**
 * Team application operations. Hosts supply current authorization and durable
 * commands; this port grants no capability and depends on neither HTTP nor UI.
 * A saved profile contributes prompt guidance only, never tool permissions.
 */
export interface ControlTeamRuntimeClient {
  withTeamTaskFence?(fence: TeamTaskWriteFence): ControlTeamRuntimeClient;
  /** Optional host-only autonomous admission; never supplied by browser clients. */
  admitAutonomousChild?(
    admission: Omit<AutonomousTaskChildAdmission, "parentCapability">,
  ): Promise<AutonomousTaskChildAdmissionResult>;
  /** Optional host-only event wait; never supplied by browser clients. */
  waitForRunTerminal?: TeamRunTerminalWait;
  appendThreadMessage(
    threadId: string,
    body: AppendThreadMessageRequest,
    idempotencyKey: string,
  ): Promise<AppendThreadMessageResponse>;
  authorizeOfficeRun(
    officeVersionId: string,
    body: StartOfficeRunRequest,
  ): Promise<AuthorizeOfficeRunResponse>;
  createRun(
    body: CreateRunRequest,
    idempotencyKey: string,
  ): Promise<RunMutationResponse>;
  forkThread(
    threadId: string,
    body: ForkThreadRequest,
    idempotencyKey: string,
  ): Promise<ThreadMutationResponse>;
  getExecutionIntentCapability(): Promise<ExecutionIntentCapabilityResponse>;
  getOffice(officeVersionId: string): Promise<GetOfficeResponse>;
  getRun(runId: string): Promise<GetRunResponse>;
  getThread(threadId: string): Promise<GetThreadResponse>;
  getThreadGoal(threadId: string): Promise<GetThreadGoalResponse>;
  listThreadMessages(
    threadId: string,
    query?: {
      cursor?: string | null;
      limit?: number;
      view?: ThreadHistoryViewMode;
    },
  ): Promise<ListThreadMessagesResponse>;
  setThreadGoalWithExecutionIntentV1(
    threadId: string,
    body: SetThreadGoalRequest,
    idempotencyKey: string,
  ): Promise<ThreadGoalMutationResponse>;
  startTurn(
    threadId: string,
    body: StartTurnRequest,
    idempotencyKey: string,
  ): Promise<StartTurnResponse>;
}

/** Host-only terminal wait; HTTP and browser clients do not provide it. */
export type TeamRunTerminalWait = (input: {
  run: RunView;
  deadlineAt: number;
  signal?: AbortSignal;
}) => Promise<RunView>;

export type ControlTeamMember = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
  targetId: string;
  profile?: TeamMemberRuntimeProfile;
}>;

export type ControlTeamPlan = Readonly<{
  officeVersionId: string;
  officeTitle: string;
  manager: ControlTeamMember;
  workers: readonly ControlTeamMember[];
}>;

export type ControlTeamTurnResult = Readonly<{
  message: MessageView;
  run: RunView;
}>;

export type ControlTeamResponseMode = "manager" | "member";

export type ControlTeamManagerResponseKind = "office" | "experts";

export type ControlTeamRunKind =
  | "managerPlanning"
  | "worker"
  | "workerRecovery"
  | "managerFinal"
  | "managerDelegation"
  | "memberFinal";

/**
 * Emitted only after Control accepted a durable Team Run and the response was
 * checked against the expected Thread and Run shape. The Run remains the
 * source of truth; this event only records its structural place in the
 * hosted Team execution.
 */
export type ControlTeamRunAcceptedEvent = Readonly<{
  phaseIndex: number;
  kind: ControlTeamRunKind;
  /** Office member whose AgentVersion was submitted for this Run. */
  memberId: string;
  agentVersionId: string;
  runId: string;
  runThreadId: string;
  recoveredMemberId?: string;
}>;

export type StartControlTeamTurnInput = Readonly<{
  client: ControlTeamRuntimeClient;
  threadId: string;
  expectedRevision: number;
  content: string;
  plan: ControlTeamPlan;
  idempotencyKey: (operation: string) => string;
  executionIntent?: "none" | "goal" | "plan";
  toolPermissionMode?: ToolPermissionMode;
  /** Main user message already committed by durable Team admission. */
  acceptedMessage?: AppendThreadMessageResponse;
  /** History boundary before the admitted message, for fork creation. */
  acceptedThroughHistorySequence?: number;
  onRunStarted?: (run: RunView) => void;
  onTaskAccepted?: (message: MessageView) => void;
  onTeamRunAccepted?: (
    event: ControlTeamRunAcceptedEvent,
  ) => void | Promise<void>;
  onFinalTurnStarted?: (started: ControlTeamTurnResult) => void;
  onExecutionIntentMismatch?: (run: RunView) => void;
  pollIntervalMs?: number;
  runDeadlineMs?: number;
  signal?: AbortSignal;
  /** Only the backend task host supplies immutable stage observations. */
  checkpoint?: TeamTurnCheckpoint;
  /** Only a trusted host may replace polling with a durable event wait. */
  waitForRunTerminal?: TeamRunTerminalWait;
}> &
  (
    | Readonly<{
        responseMode: "manager";
        managerResponseKind: ControlTeamManagerResponseKind;
      }>
    | Readonly<{
        responseMode: "member";
        managerResponseKind?: never;
      }>
  );

export type TeamTurnCheckpoint = <T>(
  label: string,
  read: () => Promise<T>,
) => Promise<T>;

export function readTeamCheckpoint<T>(
  input: { checkpoint?: TeamTurnCheckpoint },
  label: string,
  read: () => Promise<T>,
): Promise<T> {
  return input.checkpoint ? input.checkpoint(label, read) : read();
}
