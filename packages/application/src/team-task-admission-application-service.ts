import { canonicalJson } from "./canonical-json.ts";
import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import { ThreadApplicationService } from "./thread-application-service.ts";
import type { ToolPermissionMode } from "@crewon/contracts";
import {
  captureTeamTaskIntent,
  teamJournalId,
  type TeamTaskAdmissionResult,
  type TeamTaskIntent,
  type TeamTaskJournalStore,
} from "./team-task-journal.ts";
import type {
  ControlTeamManagerResponseKind,
  ControlTeamPlan,
  ControlTeamResponseMode,
} from "./team-turn-types.ts";

export type AdmitTeamTaskCommand = Readonly<{
  kind: "teamTask.admit";
  taskId: string;
  threadId: string;
  expectedRevision: number;
  content: string;
  plan: ControlTeamPlan;
  executionIntent?: "none" | "goal";
  toolPermissionMode?: ToolPermissionMode;
  responseMode: ControlTeamResponseMode;
  managerResponseKind?: ControlTeamManagerResponseKind;
}>;

/**
 * Prepares the main user message once, then lets the Store atomically commit
 * that message and the Team journal. A retry first consults the journal so an
 * old Thread revision cannot turn an idempotent replay into a conflict.
 */
export class TeamTaskAdmissionApplicationService {
  readonly #threads: ThreadApplicationService;
  readonly #journal: TeamTaskJournalStore;

  constructor(input: {
    threads: ThreadApplicationService;
    journal: TeamTaskJournalStore;
  }) {
    this.#threads = input.threads;
    this.#journal = input.journal;
  }

  async admit(
    actor: ActorContext,
    command: AdmitTeamTaskCommand,
  ): Promise<TeamTaskAdmissionResult> {
    validateCommand(command);
    const base = baseIntent(actor, command);
    const prior = await this.#journal.read(base);
    if (prior !== null) {
      assertReplayIntent(prior.intent, base);
      return { disposition: "replayed", task: prior, thread: null };
    }

    const prepared = await this.#threads.prepareAppendMessage(actor, {
      kind: "thread.message.append",
      idempotencyKey: `team-task:${command.taskId}:main-message`,
      threadId: command.threadId,
      expectedRevision: command.expectedRevision,
      role: "user",
      content: command.content,
    });
    if (prepared.messages.length !== 1) {
      throw new ApplicationError(
        "internal",
        "team_task_main_message_preparation_invalid",
      );
    }
    const message = prepared.messages[0]!;
    const intent = captureTeamTaskIntent({
      ...base,
      mainMessageSequence: message.sequence,
    });
    return this.#journal.admit({ intent, thread: prepared });
  }
}

function baseIntent(
  actor: ActorContext,
  command: AdmitTeamTaskCommand,
): TeamTaskIntent {
  return {
    schemaVersion: "crewon.team-task.v1",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    actorId: actor.actorId,
    principalId: actor.principalId,
    taskId: command.taskId,
    turn: {
      threadId: command.threadId,
      expectedRevision: command.expectedRevision,
      content: command.content,
      plan: command.plan,
      ...(command.executionIntent === undefined
        ? {}
        : { executionIntent: command.executionIntent }),
      ...(command.toolPermissionMode === undefined
        ? {}
        : { toolPermissionMode: command.toolPermissionMode }),
      ...(command.responseMode === "manager"
        ? {
            responseMode: "manager" as const,
            managerResponseKind: command.managerResponseKind ?? "office",
          }
        : { responseMode: "member" as const }),
    },
  };
}

function assertReplayIntent(
  actual: TeamTaskIntent,
  expected: TeamTaskIntent,
): void {
  const strip = (value: TeamTaskIntent) => {
    const copy = structuredClone(value) as {
      mainMessageSequence?: number;
    };
    delete copy.mainMessageSequence;
    return canonicalJson(copy);
  };
  if (strip(actual) !== strip(expected)) {
    throw new ApplicationError("conflict", "team_task_intent_conflict");
  }
}

function validateCommand(command: AdmitTeamTaskCommand): void {
  if (command.kind !== "teamTask.admit")
    throw new ApplicationError("validation", "team_task_command_invalid");
  teamJournalId(command.taskId);
  teamJournalId(command.threadId);
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  )
    throw new ApplicationError("validation", "expected_revision_invalid");
  if (
    command.responseMode === "member" &&
    command.managerResponseKind !== undefined
  )
    throw new ApplicationError(
      "validation",
      "team_task_manager_response_kind_invalid",
    );
  if (
    command.responseMode === "manager" &&
    command.managerResponseKind !== undefined &&
    !["office", "experts"].includes(command.managerResponseKind)
  )
    throw new ApplicationError(
      "validation",
      "team_task_manager_response_kind_invalid",
    );
}
