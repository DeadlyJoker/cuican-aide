import type {
  DeviceFilesystemReadDispatchResolution,
  DeviceFilesystemReadRouteIntent,
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadDispatchReference,
} from "@crewon/contracts";

import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type {
  FrozenWorkspaceReadFileDispatch,
  WorkspaceReadFileLocator,
  WorkspaceReadFileMutationResult,
  WorkspaceReadFilePhase,
  WorkspaceReadFileRecord,
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

export interface WorkspaceReadFileCommandFactoryPort {
  create(
    intent: WorkspaceReadFileExecuteIntent,
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceReadFileDispatch>;
}

export interface WorkspaceReadFileGatewayPort {
  execute(
    intent: DeviceFilesystemReadRouteIntent,
    command: DeviceFilesystemReadCommand,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  reconcile(
    intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  cancel(
    intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
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
  readonly #gateway: WorkspaceReadFileGatewayPort;

  constructor(config: {
    store: WorkspaceReadFileStore;
    commands: WorkspaceReadFileCommandFactoryPort;
    gateway: WorkspaceReadFileGatewayPort;
  }) {
    this.#store = config.store;
    this.#commands = config.commands;
    this.#gateway = config.gateway;
  }

  async execute(
    intent: WorkspaceReadFileExecuteIntent,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult> {
    const replay = await this.#receipt(intent, "execute");
    if (replay !== null) {
      return replay.operation.status === "prepared"
        ? this.#dispatch(replay.operation, "execute", intent.idempotency, signal)
        : replay;
    }
    const frozen = await this.#commands.create(intent, signal);
    const prepared = await this.#store.prepareWorkspaceReadFile({ ...intent, frozen });
    if (prepared.operation.status !== "prepared") return prepared;
    return this.#dispatch(prepared.operation, "execute", intent.idempotency, signal);
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
    const prepared = await this.#store.prepareWorkspaceReadFileAction({ ...intent, phase });
    if (prepared.operation.resolution !== null) return prepared;
    return this.#dispatch(prepared.operation, phase, intent.idempotency, signal);
  }

  #receipt(intent: WorkspaceReadFileRecoveryIntent, phase: WorkspaceReadFilePhase) {
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
    const { routeIntent, command, reference } = operation.frozen;
    let resolution: DeviceFilesystemReadDispatchResolution;
    try {
      resolution = await (phase === "execute"
        ? this.#gateway.execute(routeIntent, command, signal)
        : phase === "reconcile"
          ? this.#gateway.reconcile(routeIntent, reference, signal)
          : this.#gateway.cancel(routeIntent, reference, signal));
    } catch (error) {
      const certainty = dispatchCertainty(error);
      if (phase !== "execute" || certainty === "possiblySent") {
        await this.#store.markWorkspaceReadFilePossiblySent({
          ...locator(operation),
          expectedRevision: operation.revision,
        });
      } else {
        await this.#store.abandonWorkspaceReadFileSend({
          ...locator(operation),
          expectedRevision: operation.revision,
        });
      }
      throw new WorkspaceReadFileDispatchError(certainty, { cause: error });
    }
    return this.#store.commitWorkspaceReadFileResolution({
      ...locator(operation),
      phase,
      idempotency,
      expectedRevision: operation.revision,
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
  ) return error.certainty;
  return "possiblySent";
}
