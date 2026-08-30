import {
  WorkspaceListExecutionError,
  type WorkspaceDirectoryCapabilityPort,
  type WorkspaceDirectoryCapabilityResolverPort,
  type WorkspaceListCleanupFailureReporterPort,
  type WorkspaceListCommand,
  type WorkspaceListDeadlineSchedulerPort,
  type WorkspaceListResult,
} from "./workspace-list-types.ts";
import {
  OUTPUT_SCHEMA_VERSION,
  compareBytes,
  parseWorkspaceListCommand,
  requireOutputBound,
  requireSameBinding,
} from "./workspace-list-protocol.ts";
import {
  abortedError,
  acquireWithAbort,
  collectEntries,
  releaseCapability,
  reportCleanupFailure,
  systemDeadlineScheduler,
} from "./workspace-list-runtime.ts";

export class BoundedWorkspaceListExecutor {
  readonly #capabilities: WorkspaceDirectoryCapabilityResolverPort;
  readonly #scheduler: WorkspaceListDeadlineSchedulerPort;
  readonly #cleanupFailures: WorkspaceListCleanupFailureReporterPort;

  constructor(config: {
    capabilities: WorkspaceDirectoryCapabilityResolverPort;
    cleanupFailures: WorkspaceListCleanupFailureReporterPort;
    scheduler?: WorkspaceListDeadlineSchedulerPort;
  }) {
    this.#capabilities = config.capabilities;
    this.#cleanupFailures = config.cleanupFailures;
    this.#scheduler = config.scheduler ?? systemDeadlineScheduler;
  }

  async execute(
    input: WorkspaceListCommand,
    callerSignal: AbortSignal,
  ): Promise<WorkspaceListResult> {
    const command = parseWorkspaceListCommand(input);
    if (callerSignal.aborted) {
      throw abortedError(callerSignal.reason);
    }
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal.reason);
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    const cancelDeadline = this.#scheduler.schedule(
      command.limits.timeoutMs,
      () => controller.abort("workspace_list_deadline_exceeded"),
    );
    let capability: WorkspaceDirectoryCapabilityPort | null = null;
    let primaryFailed = false;
    try {
      capability = await acquireWithAbort(
        this.#capabilities.acquire(command.binding, controller.signal),
        controller.signal,
        this.#cleanupFailures,
      );
      if (capability === null) {
        throw new WorkspaceListExecutionError(
          "workspace_list_capability_unavailable",
        );
      }
      requireSameBinding(capability.binding, command.binding);
      const entries = await collectEntries(
        capability,
        command.limits,
        controller.signal,
      );
      entries.sort((left, right) =>
        compareBytes(left.nameBytes, right.nameBytes),
      );
      const truncated = entries.length > command.limits.maxEntries;
      const projected = entries
        .slice(0, command.limits.maxEntries)
        .map(({ name, kind }) => ({ name, kind }));
      const result: WorkspaceListResult = {
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        executionId: command.executionId,
        actionDigest: command.actionDigest,
        commandDigest: command.commandDigest,
        entries: projected,
        truncated,
      };
      requireOutputBound(result, command.limits.maxOutputBytes);
      return result;
    } catch (error) {
      primaryFailed = true;
      if (controller.signal.aborted) {
        throw abortedError(controller.signal.reason);
      }
      if (error instanceof WorkspaceListExecutionError) {
        throw error;
      }
      throw new WorkspaceListExecutionError("workspace_list_failed", {
        cause: error,
      });
    } finally {
      let cleanupError: unknown = null;
      try {
        cancelDeadline();
      } catch (error) {
        cleanupError = error;
        reportCleanupFailure(this.#cleanupFailures, "deadlineCleanup", error);
      }
      try {
        callerSignal.removeEventListener("abort", onCallerAbort);
      } catch (error) {
        cleanupError ??= error;
        reportCleanupFailure(this.#cleanupFailures, "deadlineCleanup", error);
      }
      const releaseError = await releaseCapability(capability);
      if (releaseError !== null) {
        cleanupError ??= releaseError;
        reportCleanupFailure(
          this.#cleanupFailures,
          "ownedCapability",
          releaseError,
        );
      }
      if (!primaryFailed && cleanupError !== null) {
        throw new WorkspaceListExecutionError("workspace_list_cleanup_failed", {
          cause: cleanupError,
        });
      }
    }
  }
}

export * from "./workspace-list-types.ts";
export {
  createWorkspaceListCommand,
  parseWorkspaceListCommand,
  parseWorkspaceListResult,
  projectWorkspaceListResult,
} from "./workspace-list-protocol.ts";
