import type {
  ControlApiClient,
  ControlApiRequestOptions,
} from "@crewon/control-client";
import {
  parseRunView,
  parseStartWorkflowRunRequest,
  parseWorkflowExecutionCapability,
  parseWorkflowRecoveryContextResponse,
  parseWorkflowRecoveryContextId,
  parseWorkflowReviewCapability,
  parseWorkflowRunSnapshotResponse,
  parseReviewWorkflowHumanGateRequest,
  parseWorkflowHumanGateReviewMutationResponse,
  type RunView,
  type RunMutationResponse,
  type StartWorkflowRunRequest,
  type WorkflowRunSnapshotResponse,
  type WorkflowHumanGateReviewMutationResponse,
} from "@crewon/contracts";
import {
  ControlWorkflowIntentJournal,
  WorkflowIntentJournalError,
  type WorkflowIntent,
  type WorkflowIntentCommand,
} from "./controlWorkflowIntentJournal.ts";

export type ControlWorkflowCommandsClient = Pick<
  ControlApiClient,
  | "getWorkflowExecutionCapability"
  | "getWorkflowRecoveryContext"
  | "getWorkflowReviewCapability"
  | "getWorkflowReviewContextCapability"
  | "startWorkflowRun"
  | "cancelRun"
  | "reviewWorkflowHumanGate"
>;
export type WorkflowCommandRequestOptions = ControlApiRequestOptions & {
  /** Context of the definition and user action currently displayed by the UI. */
  expectedRecoveryContext?: string;
};
type Acknowledgement = Readonly<{
  intent: WorkflowIntent;
  // A validated response is still useful when storage removal fails. Keep the
  // original intent available for exact replay rather than report a new failure.
  journal: "acknowledged" | "retained";
}>;
export type WorkflowCommandResult = Acknowledgement &
  (
    | Readonly<{ kind: "start" | "cancel"; response: RunMutationResponse }>
    | Readonly<{
        kind: "review";
        response: WorkflowHumanGateReviewMutationResponse;
      }>
  );

export class WorkflowCommandUnconfirmedError extends Error {
  readonly intentId: string;
  constructor(intentId: string, cause: unknown) {
    super("workflow_command_unconfirmed", { cause });
    this.name = "WorkflowCommandUnconfirmedError";
    this.intentId = intentId;
  }
}

/** Only owns user commands and their exact recovery data. No execution loop,
 * Thread fork, model call, directory-based guessing, or automatic write replay.
 */
export class ControlWorkflowCommands {
  readonly #client: ControlWorkflowCommandsClient;
  readonly #journal: ControlWorkflowIntentJournal;
  constructor(input: {
    client: ControlWorkflowCommandsClient;
    journal?: ControlWorkflowIntentJournal;
  }) {
    this.#client = input.client;
    this.#journal = input.journal ?? new ControlWorkflowIntentJournal();
  }

  async readAvailability(options: WorkflowCommandRequestOptions = {}) {
    options.signal?.throwIfAborted();
    const [executionValue, contextValue] = await Promise.all([
      this.#client.getWorkflowExecutionCapability(options),
      this.#client.getWorkflowRecoveryContext(options),
    ]);
    options.signal?.throwIfAborted();
    const execution = parseWorkflowExecutionCapability(executionValue);
    const { contextId } = parseWorkflowRecoveryContextResponse(contextValue);
    return {
      execution,
      contextId,
      pending: contextId === null ? [] : this.#journal.list(contextId),
    };
  }

  async start(
    body: StartWorkflowRunRequest,
    options: WorkflowCommandRequestOptions = {},
  ): Promise<WorkflowCommandResult> {
    const captured = parseStartWorkflowRunRequest(body);
    return this.#create(
      {
        workflowVersionId: captured.workflowVersionId,
        threadId: captured.threadId,
        command: { kind: "start", body: captured },
      },
      options,
    );
  }

  async cancel(
    snapshot: WorkflowRunSnapshotResponse,
    options: WorkflowCommandRequestOptions = {},
  ): Promise<WorkflowCommandResult> {
    const captured = parseWorkflowRunSnapshotResponse(
      snapshot,
      snapshot.run.runId,
    );
    requireActive(captured.run);
    if (captured.run.cancelRequested)
      throw new Error("workflow_cancel_already_requested");
    return this.#create(
      {
        workflowVersionId:
          captured.run.workflowVersionBinding!.workflowVersionId,
        threadId: captured.run.threadId,
        command: {
          kind: "cancel",
          runId: captured.run.runId,
          body: { expectedRevision: captured.run.revision },
        },
      },
      options,
    );
  }

  async review(
    input: {
      snapshot: WorkflowRunSnapshotResponse;
      nodeId: string;
      decision: "approved" | "rejected";
      comment: string | null;
      commentContext: "auditOnly" | "descendants-v1";
    },
    options: WorkflowCommandRequestOptions = {},
  ): Promise<WorkflowCommandResult> {
    const snapshot = parseWorkflowRunSnapshotResponse(
      input.snapshot,
      input.snapshot.run.runId,
    );
    requireActive(snapshot.run);
    if (snapshot.run.cancelRequested || snapshot.execution?.cancelRequested)
      throw new Error("workflow_cancel_already_requested");
    const node = snapshot.nodes.find((node) => node.nodeId === input.nodeId);
    if (
      node?.kind !== "humanGate" ||
      node.status !== "waitingHuman" ||
      node.gate === null
    )
      throw new Error("workflow_gate_not_waiting");
    if (!["auditOnly", "descendants-v1"].includes(input.commentContext))
      throw new Error("workflow_comment_context_invalid");
    const body = parseReviewWorkflowHumanGateRequest({
      inputDigest: node.gate.inputDigest,
      decision: input.decision,
      // Preserve empty/whitespace strings and null as distinct original values.
      comment: input.comment,
      ...(input.commentContext === "descendants-v1"
        ? { commentContext: input.commentContext }
        : {}),
    });
    return this.#create(
      {
        workflowVersionId:
          snapshot.run.workflowVersionBinding!.workflowVersionId,
        threadId: snapshot.run.threadId,
        command: {
          kind: "review",
          locator: {
            runId: snapshot.run.runId,
            nodeId: node.nodeId,
            gateRequestId: node.gate.gateRequestId,
          },
          body,
        },
      },
      options,
    );
  }

  /** Explicit user action only; the stored body, key, Gate and mode never change. */
  async recover(
    intentId: string,
    options: WorkflowCommandRequestOptions = {},
  ): Promise<WorkflowCommandResult> {
    options = { ...options };
    const intent = this.#journal.get(intentId);
    const ready = await this.#ready(intent.command, options);
    if (ready.contextId !== intent.contextId)
      throw new Error("workflow_recovery_context_changed");
    return this.#dispatch(intent, options);
  }

  async #create(
    input: {
      workflowVersionId: string;
      threadId: string;
      command: WorkflowIntentCommand;
    },
    options: WorkflowCommandRequestOptions,
  ): Promise<WorkflowCommandResult> {
    options = { ...options };
    const ready = await this.#ready(input.command, options);
    // A second click must not replace a still-unknown intent with a new key.
    if (
      this.#journal
        .list(ready.contextId)
        .some((intent) => conflicts(intent, input))
    )
      throw new Error("workflow_command_pending_recovery");
    options.signal?.throwIfAborted();
    // A failed/denied storage write must happen before the first HTTP mutation.
    const intent = this.#journal.create({
      ...input,
      contextId: ready.contextId,
    });
    return this.#dispatch(intent, options);
  }

  async #ready(
    command: WorkflowIntentCommand,
    options: WorkflowCommandRequestOptions,
  ) {
    const expected =
      options.expectedRecoveryContext === undefined
        ? undefined
        : parseWorkflowRecoveryContextId(options.expectedRecoveryContext);
    const state = await this.readAvailability(options);
    if (expected !== undefined && expected !== state.contextId)
      throw Error("workflow_recovery_context_changed");
    if (
      state.contextId === null ||
      !state.execution.snapshots ||
      (command.kind === "start" && !state.execution.admission) ||
      (command.kind === "review" && !state.execution.humanGates)
    )
      throw new Error("workflow_durable_execution_unavailable");
    if (command.kind === "review") {
      const capability = parseWorkflowReviewCapability(
        await this.#client.getWorkflowReviewCapability(options),
      );
      if (!capability.available)
        throw new Error("workflow_reviews_unavailable");
      if (command.body.commentContext === "descendants-v1") {
        const context = parseWorkflowReviewCapability(
          await this.#client.getWorkflowReviewContextCapability(options),
        );
        if (!context.available)
          throw new Error("workflow_review_context_unavailable");
      }
    }
    options.signal?.throwIfAborted();
    return { ...state, contextId: state.contextId };
  }

  async #dispatch(
    intent: WorkflowIntent,
    options: WorkflowCommandRequestOptions,
  ): Promise<WorkflowCommandResult> {
    try {
      options.signal?.throwIfAborted();
      const { expectedRecoveryContext: _expected, ...transportOptions } =
        options;
      const guarded = {
        ...transportOptions,
        workflowRecoveryContext: intent.contextId,
      };
      const command = intent.command;
      let result:
        | Omit<
            Extract<WorkflowCommandResult, { kind: "start" | "cancel" }>,
            keyof Acknowledgement
          >
        | Omit<
            Extract<WorkflowCommandResult, { kind: "review" }>,
            keyof Acknowledgement
          >;
      switch (command.kind) {
        case "start": {
          const response = await this.#client.startWorkflowRun(
            structuredClone(command.body),
            intent.id,
            guarded,
          );
          result = { kind: "start", response: runResponse(response, intent) };
          break;
        }
        case "cancel": {
          const response = await this.#client.cancelRun(
            command.runId,
            structuredClone(command.body),
            intent.id,
            guarded,
          );
          const parsed = runResponse(response, intent);
          if (
            parsed.run.runId !== command.runId ||
            parsed.run.revision < command.body.expectedRevision ||
            (!parsed.run.cancelRequested && !terminal(parsed.run))
          )
            throw new Error("workflow_cancel_response_invalid");
          result = { kind: "cancel", response: parsed };
          break;
        }
        case "review": {
          const response = parseWorkflowHumanGateReviewMutationResponse(
            await this.#client.reviewWorkflowHumanGate(
              structuredClone(command.locator),
              structuredClone(command.body),
              guarded,
            ),
            command.locator,
            command.body,
          );
          if (
            response.review.decision.authority.binding.workflowVersionId !==
            intent.workflowVersionId
          )
            throw new Error("workflow_review_response_binding_invalid");
          result = { kind: "review", response };
          break;
        }
      }
      options.signal?.throwIfAborted();
      let journal: Acknowledgement["journal"] = "acknowledged";
      try {
        this.#journal.acknowledge(intent);
      } catch (error) {
        if (!(error instanceof WorkflowIntentJournalError)) throw error;
        journal = "retained";
      }
      return { ...result, intent, journal };
    } catch (error) {
      throw new WorkflowCommandUnconfirmedError(intent.id, error);
    }
  }
}

function runResponse(
  value: RunMutationResponse,
  intent: WorkflowIntent,
): RunMutationResponse {
  if (
    !value ||
    Object.keys(value).sort().join() !== "disposition,run" ||
    !["committed", "replayed"].includes(value.disposition)
  )
    throw new Error("workflow_run_response_invalid");
  const run = parseRunView(value.run, intent.threadId);
  if (
    run.purpose !== "workflow" ||
    run.workflowVersionBinding?.workflowVersionId !== intent.workflowVersionId
  )
    throw new Error("workflow_run_response_binding_invalid");
  return { run, disposition: value.disposition };
}
function terminal(run: RunView): boolean {
  return ["completed", "failed", "canceled"].includes(run.status);
}
function requireActive(run: RunView): void {
  if (terminal(run)) throw new Error("workflow_run_already_terminal");
}
function conflicts(
  intent: WorkflowIntent,
  next: { threadId: string; command: WorkflowIntentCommand },
): boolean {
  const left = intent.command,
    right = next.command;
  // Block replacement of the same command, not unrelated future actions. An
  // unknown review must not prevent stopping its known root; a stale cancel
  // must not prevent a new explicit stop at an observed newer revision.
  if (right.kind === "start")
    return left.kind === "start" && intent.threadId === next.threadId;
  if (right.kind === "cancel")
    return (
      left.kind === "cancel" &&
      left.runId === right.runId &&
      left.body.expectedRevision >= right.body.expectedRevision
    );
  if (left.kind !== "review") return false;
  return (
    left.locator.runId === right.locator.runId &&
    left.locator.nodeId === right.locator.nodeId &&
    left.locator.gateRequestId === right.locator.gateRequestId
  );
}
