import type {
  ContentDigester,
  RunLocator,
  ThreadSpaceLocator,
  WorkspaceReadFileExecuteAuthorityResolverPort,
  WorkspaceReadFileExecuteIntent,
  WorkspaceReadFileExecuteProbeIntent,
  WorkspaceReadFileMutationResult,
  WorkspaceReadFileRecoveryIntent,
} from "@crewon/application";
import type { RuntimeWorkspaceDispatchAuthority } from "./runtime-workspace-binding-resolver.ts";
import {
  ToolBrokerError,
  validateToolExecutionCommand,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";
import type { RunState, ThreadState } from "@crewon/domain";

import type {
  DurableWorkspaceReadPort,
  DurableWorkspaceReadResolution,
} from "./runtime-workspace-read-tool-runtime.ts";

export interface RuntimeWorkspaceReadAuthorityStorePort {
  loadRun(locator: RunLocator): Promise<RunState | null>;
  loadThreadInSpace(locator: ThreadSpaceLocator): Promise<ThreadState | null>;
}

export interface RuntimeWorkspaceReadApplicationPort {
  executeWithAuthority(
    intent: WorkspaceReadFileExecuteProbeIntent,
    authority: WorkspaceReadFileExecuteAuthorityResolverPort,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult>;
  reconcile(
    intent: WorkspaceReadFileRecoveryIntent,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult>;
  cancel(
    intent: WorkspaceReadFileRecoveryIntent,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileMutationResult>;
}

/** Binds durable Tool identity to the current Run/Thread only after receipt miss. */
export class RuntimeWorkspaceReadApplicationAdapter
  implements DurableWorkspaceReadPort
{
  readonly #application: RuntimeWorkspaceReadApplicationPort;
  readonly #store: RuntimeWorkspaceReadAuthorityStorePort;
  readonly #deployment: RuntimeWorkspaceDispatchAuthority;
  readonly #digester: ContentDigester;

  constructor(config: {
    application: RuntimeWorkspaceReadApplicationPort;
    store: RuntimeWorkspaceReadAuthorityStorePort;
    deployment: RuntimeWorkspaceDispatchAuthority;
    digester: ContentDigester;
  }) {
    this.#application = config.application;
    this.#store = config.store;
    this.#deployment = structuredClone(config.deployment);
    this.#digester = config.digester;
  }

  async execute(
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<DurableWorkspaceReadResolution> {
    const probe = this.#probe("execute", command, relativePathSegments);
    const result = await this.#application.executeWithAuthority(
      probe,
      {
        resolve: (intent, authoritySignal) =>
          this.#resolveExecuteAuthority(command, intent, authoritySignal),
      },
      signal,
    );
    return projectResolution(result);
  }

  async reconcile(
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<DurableWorkspaceReadResolution> {
    const result = await this.#application.reconcile(
      this.#recovery("reconcile", command, relativePathSegments),
      signal,
    );
    return projectResolution(result);
  }

  async cancel(
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<DurableWorkspaceReadResolution> {
    const result = await this.#application.cancel(
      this.#recovery("cancel", command, relativePathSegments),
      signal,
    );
    return projectResolution(result);
  }

  #probe(
    phase: "execute",
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
  ): WorkspaceReadFileExecuteProbeIntent {
    this.#validateCommand(command);
    return {
      ...this.#locator(command),
      idempotency: this.#idempotency(phase, command, relativePathSegments),
      relativePathSegments: [...relativePathSegments],
    };
  }

  #recovery(
    phase: "reconcile" | "cancel",
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
  ): WorkspaceReadFileRecoveryIntent {
    this.#validateCommand(command);
    return {
      ...this.#locator(command),
      idempotency: this.#idempotency(phase, command, relativePathSegments),
    };
  }

  async #resolveExecuteAuthority(
    command: ToolExecutionCommand,
    probe: WorkspaceReadFileExecuteProbeIntent,
    signal: AbortSignal,
  ): Promise<WorkspaceReadFileExecuteIntent> {
    requireNotAborted(signal);
    const run = await this.#store.loadRun({
      tenantId: probe.tenantId,
      runId: probe.runId,
    });
    requireNotAborted(signal);
    if (
      run === null ||
      run.tenantId !== probe.tenantId ||
      run.spaceId !== probe.spaceId ||
      run.runId !== probe.runId ||
      run.workspaceBindingId !== this.#deployment.workspaceBindingId ||
      run.runtimeGeneration !== this.#deployment.runtimeBindingId ||
      run.policySnapshotId !== this.#deployment.policySnapshotId ||
      (run.status !== "running" && run.status !== "reconciling")
    ) {
      throw new ToolBrokerError("workspace_read_run_authority_unavailable");
    }
    const thread = await this.#store.loadThreadInSpace({
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      threadId: run.threadId,
    });
    requireNotAborted(signal);
    if (
      thread === null ||
      thread.tenantId !== run.tenantId ||
      thread.spaceId !== run.spaceId ||
      thread.threadId !== run.threadId ||
      thread.status === "deleted" ||
      thread.deletedAt !== null
    ) {
      throw new ToolBrokerError("workspace_read_thread_authority_unavailable");
    }
    const lease = command.executionLease;
    return {
      ...probe,
      threadId: thread.threadId,
      expectedThreadRevision: thread.revision,
      principalId: run.createdByActorId,
      actorId: run.createdByActorId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      expiresAt: lease.expiresAt,
    };
  }

  #validateCommand(command: ToolExecutionCommand): void {
    validateToolExecutionCommand(command);
    const intent = command.actionIntent;
    if (
      intent.workspaceBindingId !== this.#deployment.workspaceBindingId ||
      intent.resourceBindingId !== this.#deployment.workspaceBindingId ||
      intent.executionTarget.kind !== "control" ||
      intent.executionTarget.bindingId !==
        this.#deployment.workspaceBindingId ||
      intent.policySnapshotId !== this.#deployment.policySnapshotId ||
      intent.capability !== "workspace.read_file.v0"
    ) {
      throw new ToolBrokerError("workspace_read_deployment_mismatch");
    }
  }

  #locator(command: ToolExecutionCommand) {
    return {
      tenantId: this.#deployment.tenantId,
      spaceId: this.#deployment.spaceId,
      runId: command.runId,
      stepId: command.executionLease.stepId,
      attemptId: command.executionLease.attemptId,
      executionId: command.executionId,
    };
  }

  #idempotency(
    phase: "execute" | "reconcile" | "cancel",
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
  ) {
    return {
      scope: `workspace-read-file-${phase}`,
      key: `action-${command.actionDigest.slice("sha256:".length)}`,
      requestFingerprint: this.#digester.sha256(
        canonicalJson({
          schemaVersion: "crewon.workspace-read-file-tool-operation.v0",
          phase,
          command: {
            ...command,
            executionLease: {
              workItemId: command.executionLease.workItemId,
              stepId: command.executionLease.stepId,
              attemptId: command.executionLease.attemptId,
            },
          },
          relativePathSegments,
        }),
      ),
    };
  }
}

function projectResolution(
  result: WorkspaceReadFileMutationResult,
): DurableWorkspaceReadResolution {
  const operation = result.operation;
  const resolution = operation.resolution;
  if (resolution === null) {
    return {
      status: "unknownOutcome",
      executionId: operation.executionId,
      providerReceiptId: operation.frozen.providerReceiptId,
    };
  }
  switch (resolution.status) {
    case "completed": {
      const { outputDigest: _, ...readResult } = resolution.result;
      return {
        status: "completed",
        executionId: operation.executionId,
        providerReceiptId: resolution.providerReceiptId,
        result: readResult,
      };
    }
    case "failed":
      return {
        status: "failed",
        executionId: operation.executionId,
        providerReceiptId: resolution.providerReceiptId,
        code: resolution.code,
        retryable: resolution.retryable,
      };
    case "canceled":
      return {
        status: "canceled",
        executionId: operation.executionId,
        providerReceiptId: resolution.providerReceiptId,
      };
    case "unknownOutcome":
      return {
        status: "unknownOutcome",
        executionId: operation.executionId,
        providerReceiptId: resolution.providerReceiptId,
      };
  }
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new ToolBrokerError("workspace_read_aborted");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
