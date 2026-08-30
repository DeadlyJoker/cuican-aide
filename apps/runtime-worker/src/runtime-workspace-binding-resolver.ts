import type { SpaceScopedThreadStore } from "@crewon/application";

import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";

export type RuntimeWorkspaceBindingQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  expectedThreadRevision: number;
  principalId: string;
  actorId: string;
}>;

export type RuntimeWorkspaceBindingSnapshot = RuntimeWorkspaceBindingQuery &
  Readonly<{
    workspaceBindingId: string;
    incarnationId: string;
    deviceBindingId: string;
    deviceId: string;
    /** Identifies the exact active/default Agent runtime generation. */
    runtimeBindingId: string;
    policySnapshotId: string;
  }>;

/** Resolves only server-owned Workspace and active Agent runtime authority. */
export interface RuntimeWorkspaceBindingResolverPort {
  resolve(
    query: RuntimeWorkspaceBindingQuery,
    signal: AbortSignal,
  ): Promise<RuntimeWorkspaceBindingSnapshot | null>;
}

export type RuntimeWorkspaceDispatchAuthority = Readonly<{
  tenantId: string;
  spaceId: string;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  deviceId: string;
  runtimeBindingId: string;
  policySnapshotId: string;
}>;

/** Admits an exact frozen binding without consulting mutable Thread routing. */
export interface RuntimeWorkspaceDispatchAuthorityPort {
  admit(
    expected: RuntimeWorkspaceDispatchAuthority,
    signal: AbortSignal,
  ): Promise<RuntimeWorkspaceDispatchAuthority | null>;
}

/**
 * Resolves Workspace authority from one static Worker deployment plus the
 * current scoped Thread snapshot in the same Store used by the Worker.
 */
export class StoreBackedRuntimeWorkspaceAuthority
  implements
    RuntimeWorkspaceBindingResolverPort,
    RuntimeWorkspaceDispatchAuthorityPort
{
  readonly #store: SpaceScopedThreadStore;
  readonly #authority: RuntimeWorkspaceDispatchAuthority;

  constructor(config: {
    store: SpaceScopedThreadStore;
    authority: RuntimeWorkspaceDispatchAuthority;
  }) {
    this.#store = config.store;
    this.#authority = validateRuntimeWorkspaceDispatchAuthority(
      config.authority,
      config.authority,
    );
  }

  async resolve(
    query: RuntimeWorkspaceBindingQuery,
    signal: AbortSignal,
  ): Promise<RuntimeWorkspaceBindingSnapshot | null> {
    requireNotAborted(signal);
    if (
      query.tenantId !== this.#authority.tenantId ||
      query.spaceId !== this.#authority.spaceId
    ) {
      return null;
    }
    const thread = await this.#store.loadThreadInSpace({
      tenantId: query.tenantId,
      spaceId: query.spaceId,
      threadId: query.threadId,
    });
    requireNotAborted(signal);
    if (
      thread === null ||
      thread.tenantId !== query.tenantId ||
      thread.spaceId !== query.spaceId ||
      thread.threadId !== query.threadId ||
      thread.status === "deleted" ||
      thread.deletedAt !== null ||
      thread.revision !== query.expectedThreadRevision
    ) {
      return null;
    }
    return validateRuntimeWorkspaceBindingSnapshot(
      { ...query, ...this.#authority },
      query,
    );
  }

  async admit(
    expected: RuntimeWorkspaceDispatchAuthority,
    signal: AbortSignal,
  ): Promise<RuntimeWorkspaceDispatchAuthority | null> {
    requireNotAborted(signal);
    return sameRuntimeWorkspaceDispatchAuthority(expected, this.#authority)
      ? { ...this.#authority }
      : null;
  }
}

export function validateRuntimeWorkspaceDispatchAuthority(
  input: unknown,
  expected: RuntimeWorkspaceDispatchAuthority,
): RuntimeWorkspaceDispatchAuthority {
  if (!plainObject(input)) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid");
  }
  const keys = [
    "deviceBindingId",
    "deviceId",
    "incarnationId",
    "policySnapshotId",
    "runtimeBindingId",
    "spaceId",
    "tenantId",
    "workspaceBindingId",
  ].sort();
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input)
      .sort()
      .some((key, index) => key !== keys[index])
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid");
  }
  const authority: RuntimeWorkspaceDispatchAuthority = {
    tenantId: opaque(input.tenantId),
    spaceId: opaque(input.spaceId),
    workspaceBindingId: opaque(input.workspaceBindingId),
    incarnationId: opaque(input.incarnationId),
    deviceBindingId: opaque(input.deviceBindingId),
    deviceId: opaque(input.deviceId),
    runtimeBindingId: opaque(input.runtimeBindingId),
    policySnapshotId: opaque(input.policySnapshotId),
  };
  if (!sameRuntimeWorkspaceDispatchAuthority(authority, expected)) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_mismatch");
  }
  return authority;
}

export function sameRuntimeWorkspaceDispatchAuthority(
  left: RuntimeWorkspaceDispatchAuthority,
  right: RuntimeWorkspaceDispatchAuthority,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.spaceId === right.spaceId &&
    left.workspaceBindingId === right.workspaceBindingId &&
    left.incarnationId === right.incarnationId &&
    left.deviceBindingId === right.deviceBindingId &&
    left.deviceId === right.deviceId &&
    left.runtimeBindingId === right.runtimeBindingId &&
    left.policySnapshotId === right.policySnapshotId
  );
}

export function validateRuntimeWorkspaceBindingSnapshot(
  input: unknown,
  expected: RuntimeWorkspaceBindingQuery,
): RuntimeWorkspaceBindingSnapshot {
  if (!plainObject(input)) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid");
  }
  const keys = [
    "actorId",
    "deviceBindingId",
    "deviceId",
    "expectedThreadRevision",
    "incarnationId",
    "policySnapshotId",
    "principalId",
    "runtimeBindingId",
    "spaceId",
    "tenantId",
    "threadId",
    "workspaceBindingId",
  ].sort();
  if (
    Object.keys(input)
      .sort()
      .some((key, index) => key !== keys[index]) ||
    Object.keys(input).length !== keys.length
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid");
  }
  const snapshot: RuntimeWorkspaceBindingSnapshot = {
    tenantId: opaque(input.tenantId),
    spaceId: opaque(input.spaceId),
    threadId: opaque(input.threadId),
    expectedThreadRevision: positive(input.expectedThreadRevision),
    principalId: identity(input.principalId),
    actorId: identity(input.actorId),
    workspaceBindingId: opaque(input.workspaceBindingId),
    incarnationId: opaque(input.incarnationId),
    deviceBindingId: opaque(input.deviceBindingId),
    deviceId: opaque(input.deviceId),
    runtimeBindingId: opaque(input.runtimeBindingId),
    policySnapshotId: opaque(input.policySnapshotId),
  };
  if (!sameQuery(snapshot, expected)) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_scope_mismatch");
  }
  return snapshot;
}

export function sameRuntimeWorkspaceBinding(
  left: RuntimeWorkspaceBindingSnapshot,
  right: RuntimeWorkspaceBindingSnapshot,
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof RuntimeWorkspaceBindingSnapshot] ===
      right[key as keyof RuntimeWorkspaceBindingSnapshot],
  );
}

function sameQuery(
  snapshot: RuntimeWorkspaceBindingSnapshot,
  expected: RuntimeWorkspaceBindingQuery,
): boolean {
  return (
    snapshot.tenantId === expected.tenantId &&
    snapshot.spaceId === expected.spaceId &&
    snapshot.threadId === expected.threadId &&
    snapshot.expectedThreadRevision === expected.expectedThreadRevision &&
    snapshot.principalId === expected.principalId &&
    snapshot.actorId === expected.actorId
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function opaque(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid");
  }
  return value;
}

function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid");
  }
  return value;
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid");
  }
  return Number(value);
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RuntimeWorkspaceError("runtime_workspace_aborted");
  }
}
