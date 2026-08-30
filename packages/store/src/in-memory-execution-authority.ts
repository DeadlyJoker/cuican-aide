import {
  ExecutionLifecycleError,
  finishRunAttempt,
  startRunAttempt,
  type RunAttemptState,
  type RunStepState,
  validateProviderTurnState,
} from "@crewon/domain";
import {
  RunStoreError,
  type BeginRunAttemptInput,
  type BeginRunAttemptResult,
  type RunAttemptLocator,
  type RunAttemptTerminalMutation,
  type RunAttemptTransitionResult,
  type RunStepLocator,
} from "@crewon/application";

export class InMemoryExecutionAuthority {
  readonly #steps = new Map<string, RunStepState>();
  readonly #attempts = new Map<string, RunAttemptState>();

  loadStep(locator: RunStepLocator): RunStepState | null {
    const step = this.#steps.get(locator.stepId) ?? null;
    return step?.tenantId === locator.tenantId && step.runId === locator.runId
      ? clone(step)
      : null;
  }

  loadAttempt(locator: RunAttemptLocator): RunAttemptState | null {
    const attempt = this.#attempts.get(locator.attemptId) ?? null;
    return attempt?.tenantId === locator.tenantId &&
      attempt.runId === locator.runId &&
      attempt.stepId === locator.stepId
      ? clone(attempt)
      : null;
  }

  listAttempts(
    locator: RunStepLocator,
    afterAttemptNumber: number,
    limit: number,
  ): readonly RunAttemptState[] {
    return [...this.#attempts.values()]
      .filter(
        (attempt) =>
          attempt.tenantId === locator.tenantId &&
          attempt.runId === locator.runId &&
          attempt.stepId === locator.stepId &&
          attempt.attemptNumber > afterAttemptNumber,
      )
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .slice(0, limit)
      .map(clone);
  }

  loadRunProviderTurnState(
    locator: Readonly<{
      tenantId: string;
      runId: string;
    }>,
  ): string | null {
    const values = new Set(
      [...this.#attempts.values()]
        .filter(
          (attempt) =>
            attempt.tenantId === locator.tenantId &&
            attempt.runId === locator.runId &&
            attempt.providerTurnState !== null,
        )
        .map((attempt) => attempt.providerTurnState!),
    );
    if (values.size > 1) {
      throw new RunStoreError("stored_run_attempt_invalid");
    }
    return values.values().next().value ?? null;
  }

  begin(input: BeginRunAttemptInput): BeginRunAttemptResult {
    if (this.#attempts.has(input.attemptId)) {
      throw new RunStoreError("attempt_id_conflict");
    }
    const currentStep = this.#steps.get(input.stepId) ?? null;
    const currentAttempt =
      currentStep?.currentAttemptId === null || currentStep === null
        ? null
        : (this.#attempts.get(currentStep.currentAttemptId) ?? null);
    if (currentStep !== null && currentAttempt === null) {
      throw new RunStoreError("stored_run_attempt_invalid");
    }
    let started: BeginRunAttemptResult;
    try {
      started = startRunAttempt(currentStep, currentAttempt, {
        tenantId: input.tenantId,
        runId: input.runId,
        stepId: input.stepId,
        kind: input.kind,
        attemptId: input.attemptId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        startedAt: input.startedAt,
      });
    } catch (error) {
      throw normalizeExecutionLifecycleError(error);
    }
    if (started.abandonedAttempt !== null) {
      this.#attempts.set(
        started.abandonedAttempt.attemptId,
        clone(started.abandonedAttempt),
      );
    }
    this.#steps.set(started.step.stepId, clone(started.step));
    this.#attempts.set(started.attempt.attemptId, clone(started.attempt));
    return clone(started);
  }

  finish(
    tenantId: string,
    runId: string,
    workItemId: string,
    leaseEpoch: number,
    mutation: RunAttemptTerminalMutation,
  ): RunAttemptTransitionResult {
    const step = this.#steps.get(mutation.stepId) ?? null;
    const attempt = this.#attempts.get(mutation.attemptId) ?? null;
    if (
      step?.tenantId !== tenantId ||
      step.runId !== runId ||
      attempt?.tenantId !== tenantId ||
      attempt.runId !== runId ||
      attempt.stepId !== step.stepId
    ) {
      throw new RunStoreError("run_attempt_not_found");
    }
    if (
      attempt.leaseEpoch !== leaseEpoch ||
      attempt.workItemId !== workItemId
    ) {
      throw new RunStoreError("stale_attempt_epoch");
    }
    try {
      return finishRunAttempt(
        step,
        {
          ...attempt,
          providerTurnState:
            mutation.providerTurnState ?? attempt.providerTurnState,
        },
        terminalInput(mutation),
      );
    } catch (error) {
      throw normalizeExecutionLifecycleError(error);
    }
  }

  finishWithCheckpoint(
    tenantId: string,
    runId: string,
    workItemId: string,
    leaseEpoch: number,
    mutation: RunAttemptTerminalMutation,
    checkpoint: RunAttemptState["providerCheckpoint"],
  ): RunAttemptTransitionResult {
    const step = this.#steps.get(mutation.stepId) ?? null;
    const attempt = this.#attempts.get(mutation.attemptId) ?? null;
    if (
      step?.tenantId !== tenantId ||
      step.runId !== runId ||
      attempt?.tenantId !== tenantId ||
      attempt.runId !== runId ||
      attempt.stepId !== step.stepId
    ) {
      throw new RunStoreError("run_attempt_not_found");
    }
    if (
      attempt.leaseEpoch !== leaseEpoch ||
      attempt.workItemId !== workItemId ||
      (attempt.providerCheckpoint !== null &&
        (attempt.checkpointDigest !== mutation.checkpointDigest ||
          JSON.stringify(attempt.providerCheckpoint) !==
            JSON.stringify(checkpoint)))
    ) {
      throw new RunStoreError("attempt_provider_checkpoint_conflict");
    }
    try {
      return finishRunAttempt(
        step,
        {
          ...attempt,
          providerTurnState:
            mutation.providerTurnState ?? attempt.providerTurnState,
          providerCheckpoint: clone(checkpoint),
          checkpointDigest: mutation.checkpointDigest,
          updatedAt: mutation.finishedAt,
        },
        terminalInput(mutation),
      );
    } catch (error) {
      throw normalizeExecutionLifecycleError(error);
    }
  }

  apply(result: RunAttemptTransitionResult): void {
    this.#steps.set(result.step.stepId, clone(result.step));
    this.#attempts.set(result.attempt.attemptId, clone(result.attempt));
  }

  checkpoint(
    locator: RunAttemptLocator,
    workItemId: string,
    leaseEpoch: number,
    checkpoint: RunAttemptState["providerCheckpoint"],
    checkpointDigest: string,
    checkpointedAt: string,
  ): RunAttemptState {
    const attempt = this.#attempts.get(locator.attemptId);
    if (
      attempt?.tenantId !== locator.tenantId ||
      attempt.runId !== locator.runId ||
      attempt.stepId !== locator.stepId ||
      attempt.status !== "running"
    ) {
      throw new RunStoreError("run_attempt_not_running");
    }
    if (
      attempt.workItemId !== workItemId ||
      attempt.leaseEpoch !== leaseEpoch
    ) {
      throw new RunStoreError("stale_attempt_epoch");
    }
    if (attempt.providerCheckpoint !== null) {
      throw new RunStoreError("attempt_provider_checkpoint_conflict");
    }
    const next = {
      ...attempt,
      providerCheckpoint: clone(checkpoint),
      checkpointDigest,
      updatedAt: checkpointedAt,
    };
    this.#attempts.set(next.attemptId, clone(next));
    return clone(next);
  }

  recordProviderTurnState(
    locator: RunAttemptLocator,
    workItemId: string,
    leaseEpoch: number,
    providerTurnState: string,
    observedAt: string,
  ): RunAttemptState {
    try {
      validateProviderTurnState(providerTurnState);
    } catch (error) {
      throw new RunStoreError("attempt_provider_turn_state_invalid", {
        cause: error,
      });
    }
    const attempt = this.#attempts.get(locator.attemptId);
    if (
      attempt?.tenantId !== locator.tenantId ||
      attempt.runId !== locator.runId ||
      attempt.stepId !== locator.stepId ||
      attempt.status !== "running"
    ) {
      throw new RunStoreError("run_attempt_not_running");
    }
    if (
      attempt.workItemId !== workItemId ||
      attempt.leaseEpoch !== leaseEpoch
    ) {
      throw new RunStoreError("stale_attempt_epoch");
    }
    if (
      attempt.providerTurnState !== null &&
      attempt.providerTurnState !== providerTurnState
    ) {
      throw new RunStoreError("attempt_provider_turn_state_conflict");
    }
    if (attempt.providerTurnState === providerTurnState) return clone(attempt);
    const next = { ...attempt, providerTurnState, updatedAt: observedAt };
    this.#attempts.set(next.attemptId, clone(next));
    return clone(next);
  }
}

function terminalInput(
  input: RunAttemptTerminalMutation,
): Parameters<typeof finishRunAttempt>[2] {
  return input.status === "failed"
    ? {
        status: input.status,
        finishedAt: input.finishedAt,
        checkpointDigest: input.checkpointDigest,
        failure: input.failure,
      }
    : {
        status: input.status,
        finishedAt: input.finishedAt,
        checkpointDigest: input.checkpointDigest,
      };
}

function normalizeExecutionLifecycleError(error: unknown): Error {
  return error instanceof ExecutionLifecycleError
    ? new RunStoreError(error.code, { cause: error })
    : error instanceof Error
      ? error
      : new RunStoreError("execution_lifecycle_error", { cause: error });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
