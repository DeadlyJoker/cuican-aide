import {
  WORKSPACE_READ_FILE_LIMITS,
  canonicalJson,
  type ContentDigester,
  type FrozenWorkspaceReadFileDispatch,
  type WorkspaceReadFileCommandFactoryPort,
  type WorkspaceReadFileExecuteIntent,
} from "@crewon/application";

import {
  validateRuntimeWorkspaceBindingSnapshot,
  type RuntimeWorkspaceBindingQuery,
  type RuntimeWorkspaceBindingResolverPort,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";

const EMPTY_DIGEST = `sha256:${"0".repeat(64)}`;
const WORKSPACE_READ_FILE_CAPABILITY = "workspace.read_file.v0" as const;

export type RuntimeWorkspaceReadFileAuthority = RuntimeWorkspaceBindingQuery &
  Readonly<{
    runId: string;
    stepId: string;
    attemptId: string;
    executionId: string;
    leaseId: string;
    leaseEpoch: number;
    expiresAt: string;
  }>;

export type RuntimeWorkspaceReadFileIntent = Readonly<{
  authority: RuntimeWorkspaceReadFileAuthority;
  relativePathSegments: readonly string[];
}>;

export type CanonicalRuntimeWorkspaceReadFileIntent = Readonly<{
  schemaVersion: "crewon.runtime-workspace-read-file-action.v0";
  tenantId: string;
  spaceId: string;
  threadId: string;
  expectedThreadRevision: number;
  principalId: string;
  actorId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  executionId: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
  binding: Readonly<{
    workspaceBindingId: string;
    incarnationId: string;
    runtimeBindingId: string;
  }>;
  policySnapshotId: string;
  capability: typeof WORKSPACE_READ_FILE_CAPABILITY;
  relativePathSegments: readonly string[];
  limits: Readonly<{
    timeoutMs: number;
    maxOutputBytes: number;
    maxArtifactBytes: number;
  }>;
}>;

/** Canonicalizes every authority field that must survive outside the generic command. */
export function canonicalRuntimeWorkspaceReadFileIntent(
  input: CanonicalRuntimeWorkspaceReadFileIntent,
): string {
  return canonicalJson(input);
}

/** Produces one provider-neutral, server-routed local Workspace read command. */
export interface RuntimeWorkspaceReadFileCommandPort {
  produce(
    intent: RuntimeWorkspaceReadFileIntent,
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceReadFileDispatch>;
}

/** Revalidates Thread/deployment authority and freezes the local read. */
export class RuntimeWorkspaceReadFileCommandService
  implements
    RuntimeWorkspaceReadFileCommandPort,
    WorkspaceReadFileCommandFactoryPort
{
  readonly #bindings: RuntimeWorkspaceBindingResolverPort;
  readonly #digester: ContentDigester;

  constructor(config: {
    bindings: RuntimeWorkspaceBindingResolverPort;
    digester: ContentDigester;
  }) {
    this.#bindings = config.bindings;
    this.#digester = config.digester;
  }

  async produce(
    intent: RuntimeWorkspaceReadFileIntent,
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceReadFileDispatch> {
    return this.#produceFrozen(intent, signal);
  }

  create(
    intent: WorkspaceReadFileExecuteIntent,
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceReadFileDispatch> {
    return this.#produceFrozen(
      {
        authority: {
          tenantId: intent.tenantId,
          spaceId: intent.spaceId,
          threadId: intent.threadId,
          expectedThreadRevision: intent.expectedThreadRevision,
          principalId: intent.principalId,
          actorId: intent.actorId,
          runId: intent.runId,
          stepId: intent.stepId,
          attemptId: intent.attemptId,
          executionId: intent.executionId,
          leaseId: intent.leaseId,
          leaseEpoch: intent.leaseEpoch,
          expiresAt: intent.expiresAt,
        },
        relativePathSegments: intent.relativePathSegments,
      },
      signal,
    );
  }

  async #produceFrozen(
    intent: RuntimeWorkspaceReadFileIntent,
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceReadFileDispatch> {
    const authority = validateAuthority(intent.authority);
    const relativePathSegments = validatePathSegments(
      intent.relativePathSegments,
    );
    requireNotAborted(signal);
    const query = bindingQuery(authority);
    const resolved = await abortable(
      this.#bindings.resolve(query, signal),
      signal,
    );
    if (resolved === null) {
      throw new RuntimeWorkspaceError("runtime_workspace_binding_unavailable", {
        retryable: true,
      });
    }
    const binding = validateRuntimeWorkspaceBindingSnapshot(resolved, query);
    const limits = {
      ...WORKSPACE_READ_FILE_LIMITS,
    };
    const actionDigest = this.#digester.sha256(
      canonicalRuntimeWorkspaceReadFileIntent({
        schemaVersion: "crewon.runtime-workspace-read-file-action.v0",
        tenantId: authority.tenantId,
        spaceId: authority.spaceId,
        threadId: authority.threadId,
        expectedThreadRevision: authority.expectedThreadRevision,
        principalId: authority.principalId,
        actorId: authority.actorId,
        runId: authority.runId,
        stepId: authority.stepId,
        attemptId: authority.attemptId,
        executionId: authority.executionId,
        leaseId: authority.leaseId,
        leaseEpoch: authority.leaseEpoch,
        expiresAt: authority.expiresAt,
        binding: {
          workspaceBindingId: binding.workspaceBindingId,
          incarnationId: binding.incarnationId,
          runtimeBindingId: binding.runtimeBindingId,
        },
        policySnapshotId: binding.policySnapshotId,
        capability: WORKSPACE_READ_FILE_CAPABILITY,
        relativePathSegments,
        limits,
      }),
    );
    const command: FrozenWorkspaceReadFileDispatch = {
      schemaVersion: "crewon.workspace-read-file-command.v0",
      executionId: authority.executionId,
      runId: authority.runId,
      stepId: authority.stepId,
      attemptId: authority.attemptId,
      leaseId: authority.leaseId,
      leaseEpoch: authority.leaseEpoch,
      expiresAt: authority.expiresAt,
      workspaceBindingId: binding.workspaceBindingId,
      incarnationId: binding.incarnationId,
      runtimeBindingId: binding.runtimeBindingId,
      policySnapshotId: binding.policySnapshotId,
      actionDigest,
      commandDigest: EMPTY_DIGEST,
      relativePathSegments,
      limits,
      providerReceiptId: null,
    };
    requireNotAborted(signal);
    const commandDigest = this.#digester.sha256(
      canonicalJson({
        schemaVersion: "crewon.workspace-read-file-command-digest.v0",
        command,
      }),
    );
    return { ...command, commandDigest };
  }
}

function bindingQuery(
  authority: RuntimeWorkspaceReadFileAuthority,
): RuntimeWorkspaceBindingQuery {
  return {
    tenantId: authority.tenantId,
    spaceId: authority.spaceId,
    threadId: authority.threadId,
    expectedThreadRevision: authority.expectedThreadRevision,
    principalId: authority.principalId,
    actorId: authority.actorId,
  };
}

function validateAuthority(
  input: RuntimeWorkspaceReadFileAuthority,
): RuntimeWorkspaceReadFileAuthority {
  const expectedKeys = [
    "actorId",
    "attemptId",
    "executionId",
    "expectedThreadRevision",
    "expiresAt",
    "leaseEpoch",
    "leaseId",
    "principalId",
    "runId",
    "spaceId",
    "stepId",
    "tenantId",
    "threadId",
  ].sort();
  if (
    typeof input !== "object" ||
    input === null ||
    Object.keys(input).sort().join(",") !== expectedKeys.join(",")
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_read_authority_invalid");
  }
  const query = bindingQuery(input);
  validateRuntimeWorkspaceBindingSnapshot(
    {
      ...query,
      workspaceBindingId: "validation",
      incarnationId: "validation",
      runtimeBindingId: "validation",
      policySnapshotId: "validation",
    },
    query,
  );
  for (const value of [
    input.runId,
    input.stepId,
    input.attemptId,
    input.executionId,
    input.leaseId,
  ]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
      throw new RuntimeWorkspaceError(
        "runtime_workspace_read_authority_invalid",
      );
    }
  }
  if (
    !Number.isSafeInteger(input.leaseEpoch) ||
    input.leaseEpoch < 1 ||
    !canonicalTimestamp(input.expiresAt)
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_read_authority_invalid");
  }
  return structuredClone(input);
}

function validatePathSegments(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) {
    throw new RuntimeWorkspaceError("runtime_workspace_read_path_invalid");
  }
  for (const segment of input) {
    if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      Buffer.byteLength(segment) > 255 ||
      segment === "." ||
      segment === ".." ||
      /[\\/:\0]/u.test(segment)
    ) {
      throw new RuntimeWorkspaceError("runtime_workspace_read_path_invalid");
    }
  }
  return [...input];
}

function canonicalTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): RuntimeWorkspaceError {
  return signal.reason instanceof RuntimeWorkspaceError
    ? signal.reason
    : new RuntimeWorkspaceError("runtime_workspace_aborted");
}
