import { ApplicationError } from "./application-error.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type {
  FrozenWorkspaceReadFileDispatch,
  WorkspaceReadFileLocator,
  WorkspaceReadFileMutationResult,
  WorkspaceReadFilePhase,
  WorkspaceReadFileRecord,
  WorkspaceReadFileResolution,
  WorkspaceReadFileStore,
} from "./workspace-read-file-store-port.ts";

export type WorkspaceReadFileExecuteIntent = WorkspaceReadFileLocator &
  Readonly<{
    threadId: string;
    expectedThreadRevision: number;
    principalId: string;
    actorId: string;
    leaseId: string;
    leaseEpoch: number;
    expiresAt: string;
    idempotency: IdempotencyDescriptor;
    relativePathSegments: readonly string[];
  }>;
export type WorkspaceReadFileRecoveryIntent = WorkspaceReadFileLocator &
  Readonly<{ idempotency: IdempotencyDescriptor }>;
export type WorkspaceReadFileExecuteProbeIntent =
  WorkspaceReadFileRecoveryIntent &
    Readonly<{ relativePathSegments: readonly string[] }>;

export interface WorkspaceReadFileExecuteAuthorityResolverPort {
  resolve(
    intent: WorkspaceReadFileExecuteProbeIntent,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileExecuteIntent>;
}

export interface WorkspaceReadFileCommandFactoryPort {
  create(
    intent: WorkspaceReadFileExecuteIntent,
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceReadFileDispatch>;
}

export interface WorkspaceReadFileAuthorityPort {
  execute(
    frozen: FrozenWorkspaceReadFileDispatch,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileResolution>;
  reconcile(
    frozen: FrozenWorkspaceReadFileDispatch,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileResolution>;
  cancel(
    frozen: FrozenWorkspaceReadFileDispatch,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileResolution>;
}

export class WorkspaceReadFileDispatchError extends Error {
  readonly certainty: "notSent" | "possiblySent";
  constructor(certainty: "notSent" | "possiblySent", options?: ErrorOptions) {
    super("workspace_read_file_dispatch_failed", options);
    this.name = "WorkspaceReadFileDispatchError";
    this.certainty = certainty;
  }
}

/** Receipt-first coordinator for the private durable read-file capability. */
export class WorkspaceReadFileApplicationService {
  readonly #store: WorkspaceReadFileStore;
  readonly #commands: WorkspaceReadFileCommandFactoryPort;
  readonly #authority: WorkspaceReadFileAuthorityPort;

  constructor(config: {
    store: WorkspaceReadFileStore;
    commands: WorkspaceReadFileCommandFactoryPort;
    authority: WorkspaceReadFileAuthorityPort;
  }) {
    this.#store = config.store;
    this.#commands = config.commands;
    this.#authority = config.authority;
  }

  async execute(
    intent: WorkspaceReadFileExecuteIntent,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult> {
    const replay = await this.#receipt(intent, "execute");
    if (replay !== null) {
      return replay.operation.status === "prepared"
        ? this.#dispatch(
            replay.operation,
            "execute",
            intent.idempotency,
            signal,
          )
        : replay;
    }
    const frozen = await this.#commands.create(intent, signal);
    const prepared = await this.#store.prepareWorkspaceReadFile({
      ...intent,
      frozen,
    });
    if (prepared.operation.status !== "prepared") return prepared;
    return this.#dispatch(
      prepared.operation,
      "execute",
      intent.idempotency,
      signal,
    );
  }

  async executeWithAuthority(
    intent: WorkspaceReadFileExecuteProbeIntent,
    authority: WorkspaceReadFileExecuteAuthorityResolverPort,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult> {
    const replay = await this.#receipt(intent, "execute");
    if (replay !== null) {
      return replay.operation.status === "prepared"
        ? this.#dispatch(
            replay.operation,
            "execute",
            intent.idempotency,
            signal,
          )
        : replay;
    }
    const resolved = await authority.resolve(intent, signal);
    if (!sameProbe(intent, resolved))
      throw new ApplicationError(
        "internal",
        "workspace_read_file_authority_drift",
      );
    return this.execute(resolved, signal);
  }

  reconcile(intent: WorkspaceReadFileRecoveryIntent, signal: AbortSignal) {
    return this.#recover(intent, "reconcile", signal);
  }

  cancel(intent: WorkspaceReadFileRecoveryIntent, signal: AbortSignal) {
    return this.#recover(intent, "cancel", signal);
  }

  async #recover(
    intent: WorkspaceReadFileRecoveryIntent,
    phase: "reconcile" | "cancel",
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult> {
    const replay = await this.#receipt(intent, phase);
    if (replay !== null) {
      return replay.operation.resolution === null
        ? this.#dispatch(replay.operation, phase, intent.idempotency, signal)
        : replay;
    }
    const prepared = await this.#store.prepareWorkspaceReadFileAction({
      ...intent,
      phase,
    });
    if (prepared.operation.resolution !== null) return prepared;
    return this.#dispatch(
      prepared.operation,
      phase,
      intent.idempotency,
      signal,
    );
  }

  #receipt(
    intent: WorkspaceReadFileRecoveryIntent,
    phase: WorkspaceReadFilePhase,
  ) {
    return this.#store.loadWorkspaceReadFileReceipt({
      tenantId: intent.tenantId,
      spaceId: intent.spaceId,
      phase,
      idempotency: intent.idempotency,
    });
  }

  async #dispatch(
    operation: WorkspaceReadFileRecord,
    phase: WorkspaceReadFilePhase,
    idempotency: IdempotencyDescriptor,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult> {
    const dispatchOperation =
      phase === "execute"
        ? await this.#store.markWorkspaceReadFilePossiblySent({
            ...locator(operation),
            expectedRevision: operation.revision,
          })
        : operation;
    let resolution: WorkspaceReadFileResolution;
    try {
      resolution = await (phase === "execute"
        ? this.#authority.execute(dispatchOperation.frozen, signal)
        : phase === "reconcile"
          ? this.#authority.reconcile(dispatchOperation.frozen, signal)
          : this.#authority.cancel(dispatchOperation.frozen, signal));
    } catch (error) {
      const certainty = dispatchCertainty(error);
      if (phase === "execute" && certainty === "notSent") {
        await this.#store.abandonWorkspaceReadFileSend({
          ...locator(dispatchOperation),
          expectedRevision: dispatchOperation.revision,
        });
      }
      throw new WorkspaceReadFileDispatchError(certainty, { cause: error });
    }
    return this.#store.commitWorkspaceReadFileResolution({
      ...locator(dispatchOperation),
      phase,
      idempotency,
      expectedRevision: dispatchOperation.revision,
      resolution,
    });
  }
}

function locator(operation: WorkspaceReadFileRecord): WorkspaceReadFileLocator {
  return {
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    runId: operation.runId,
    stepId: operation.stepId,
    attemptId: operation.attemptId,
    executionId: operation.executionId,
  };
}

function dispatchCertainty(error: unknown): "notSent" | "possiblySent" {
  if (
    typeof error === "object" &&
    error !== null &&
    "certainty" in error &&
    (error.certainty === "notSent" || error.certainty === "possiblySent")
  )
    return error.certainty;
  return "possiblySent";
}

function sameProbe(
  probe: WorkspaceReadFileExecuteProbeIntent,
  resolved: WorkspaceReadFileExecuteIntent,
): boolean {
  return (
    probe.tenantId === resolved.tenantId &&
    probe.spaceId === resolved.spaceId &&
    probe.runId === resolved.runId &&
    probe.stepId === resolved.stepId &&
    probe.attemptId === resolved.attemptId &&
    probe.executionId === resolved.executionId &&
    JSON.stringify(probe.idempotency) ===
      JSON.stringify(resolved.idempotency) &&
    JSON.stringify(probe.relativePathSegments) ===
      JSON.stringify(resolved.relativePathSegments)
  );
}
