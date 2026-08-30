import assert from "node:assert/strict";

import test from "node:test";

import {
  BoundedWorkspaceListExecutor,
  WORKSPACE_LIST_HARD_LIMITS,
  WorkspaceListExecutionError,
  createWorkspaceListCommand,
  parseWorkspaceListCommand,
  parseWorkspaceListResult,
  projectWorkspaceListResult,
  type WorkspaceDirectoryBinding,
  type WorkspaceDirectoryCapabilityPort,
  type WorkspaceDirectoryEntry,
  type WorkspaceListCommand,
  type WorkspaceListDeadlineSchedulerPort,
  type WorkspaceListLimits,
} from "./workspace-list-executor.ts";

const encoder = new TextEncoder();

type FakeCapability = WorkspaceDirectoryCapabilityPort & { releases: number };

function fakeCapability(
  entries: readonly WorkspaceDirectoryEntry[],
  configuredBinding = binding(),
): FakeCapability {
  const capability: FakeCapability = {
    binding: configuredBinding,
    releases: 0,
    async listTopLevelPage({ cursor, limit, signal }) {
      if (signal.aborted) {
        throw new WorkspaceListExecutionError("fixture_aborted");
      }
      const offset = cursor === null ? 0 : Number(cursor.slice(2));
      const page = entries.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        entries: page,
        nextCursor: nextOffset < entries.length ? `p:${nextOffset}` : null,
      };
    },
    release() {
      capability.releases += 1;
    },
  };
  return capability;
}

function executorFor(capability: WorkspaceDirectoryCapabilityPort) {
  return new BoundedWorkspaceListExecutor({
    capabilities: {
      async acquire(requestedBinding) {
        assert.deepEqual(requestedBinding, binding());
        return capability;
      },
    },
    cleanupFailures: cleanupReporter(),
  });
}

function cleanupReporter() {
  return { report() {} };
}

function command(
  overrides: Partial<
    Pick<
      WorkspaceListCommand,
      | "executionId"
      | "idempotencyKey"
      | "authority"
      | "binding"
      | "policySnapshotId"
      | "limits"
    >
  > = {},
): WorkspaceListCommand {
  return createWorkspaceListCommand({
    executionId: overrides.executionId ?? "workspace-execution-1",
    idempotencyKey: overrides.idempotencyKey ?? "workspace-idempotency-1",
    authority: overrides.authority ?? authority(),
    binding: overrides.binding ?? binding(),
    policySnapshotId: overrides.policySnapshotId ?? "policy-1",
    limits: overrides.limits ?? limits(),
  });
}

function binding(
  workspaceBindingId = "workspace-1",
  incarnationId = "incarnation-1",
): WorkspaceDirectoryBinding {
  return {
    workspaceBindingId,
    incarnationId,
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
  };
}

function authority() {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
  } as const;
}

function limits(
  overrides: Partial<WorkspaceListLimits> = {},
): WorkspaceListLimits {
  return {
    depth: 0,
    maxEntries: 5,
    maxNameBytes: 255,
    maxOutputBytes: 64 * 1024,
    maxScannedEntries: 10,
    maxScannedNameBytes: 8_000,
    timeoutMs: 30_000,
    ...overrides,
  };
}

function entry(
  name: string,
  kind: WorkspaceDirectoryEntry["kind"],
): WorkspaceDirectoryEntry {
  return { nameBytes: encoder.encode(name), kind };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof WorkspaceListExecutionError && error.code === code;
}

test("enforces scanned entry, scanned name byte and encoded output caps", async () => {
  await assert.rejects(
    executorFor(
      fakeCapability([
        entry("a", "file"),
        entry("b", "file"),
        entry("c", "file"),
      ]),
    ).execute(
      command({
        limits: limits({ maxEntries: 2, maxScannedEntries: 2 }),
      }),
      new AbortController().signal,
    ),
    hasCode("workspace_list_scan_limit_exceeded"),
  );

  await assert.rejects(
    executorFor(
      fakeCapability([entry("abc", "file"), entry("def", "file")]),
    ).execute(
      command({ limits: limits({ maxScannedNameBytes: 5 }) }),
      new AbortController().signal,
    ),
    hasCode("workspace_list_scan_bytes_exceeded"),
  );

  await assert.rejects(
    executorFor(fakeCapability([entry("a", "file")])).execute(
      command({ limits: limits({ maxOutputBytes: 50 }) }),
      new AbortController().signal,
    ),
    hasCode("workspace_list_output_too_large"),
  );
});

test("cancels a hung acquire and a hung iterator without sleeping", async () => {
  const acquireAbort = new AbortController();
  const neverCapability = new Promise<WorkspaceDirectoryCapabilityPort | null>(
    () => {},
  );
  const acquireExecution = new BoundedWorkspaceListExecutor({
    capabilities: { acquire: async () => neverCapability },
    cleanupFailures: cleanupReporter(),
  }).execute(command(), acquireAbort.signal);
  acquireAbort.abort("caller_requested");
  await assert.rejects(acquireExecution, hasCode("workspace_list_canceled"));

  const iterationAbort = new AbortController();
  let nextStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    nextStarted = resolve;
  });
  let releases = 0;
  const capability: WorkspaceDirectoryCapabilityPort = {
    binding: binding(),
    listTopLevelPage() {
      nextStarted();
      return new Promise(() => {});
    },
    release() {
      releases += 1;
    },
  };
  const iterationExecution = executorFor(capability).execute(
    command(),
    iterationAbort.signal,
  );
  await started;
  iterationAbort.abort("caller_requested");
  await assert.rejects(iterationExecution, hasCode("workspace_list_canceled"));
  assert.equal(releases, 1);
});

test("applies a deterministic hard deadline to an uncooperative capability", async () => {
  let expire!: () => void;
  const scheduler: WorkspaceListDeadlineSchedulerPort = {
    schedule(_delayMs, callback) {
      expire = callback;
      return () => {};
    },
  };
  const execution = new BoundedWorkspaceListExecutor({
    capabilities: {
      acquire: async () =>
        new Promise<WorkspaceDirectoryCapabilityPort | null>(() => {}),
    },
    cleanupFailures: cleanupReporter(),
    scheduler,
  }).execute(command(), new AbortController().signal);

  expire();

  await assert.rejects(execution, hasCode("workspace_list_deadline_exceeded"));
});

test("requires an exact acquired binding incarnation and never accepts a raw path", async () => {
  const mismatched = fakeCapability(
    [],
    binding("workspace-1", "incarnation-old"),
  );
  await assert.rejects(
    executorFor(mismatched).execute(command(), new AbortController().signal),
    hasCode("workspace_list_capability_binding_mismatch"),
  );
  assert.equal(mismatched.releases, 1);

  await assert.rejects(
    new BoundedWorkspaceListExecutor({
      capabilities: { acquire: async () => null },
      cleanupFailures: cleanupReporter(),
    }).execute(command(), new AbortController().signal),
    hasCode("workspace_list_capability_unavailable"),
  );
  assert.throws(
    () =>
      createWorkspaceListCommand({
        executionId: "workspace-execution-1",
        idempotencyKey: "workspace-idempotency-1",
        authority: authority(),
        binding: {
          ...binding(),
          workspaceBindingId: "/tmp/workspace",
        },
        policySnapshotId: "policy-1",
        limits: limits(),
      }),
    hasCode("workspace_list_binding_invalid"),
  );
});

test("result projection rejects extra fields, unsafe names and non-byte ordering", () => {
  const result = {
    schemaVersion: "crewon.workspace-list-result.v0" as const,
    executionId: "workspace-execution-1",
    actionDigest: command().actionDigest,
    commandDigest: command().commandDigest,
    entries: [
      { name: "a", kind: "file" as const },
      { name: "z", kind: "directory" as const },
    ],
    truncated: false,
  };
  assert.deepEqual(parseWorkspaceListResult(result, command()), result);
  assert.throws(
    () =>
      parseWorkspaceListResult(
        { ...result, binding: "workspace-1" },
        command(),
      ),
    hasCode("workspace_list_result_invalid"),
  );
  assert.throws(
    () =>
      parseWorkspaceListResult(
        { ...result, entries: [...result.entries].reverse() },
        command(),
      ),
    hasCode("workspace_list_result_invalid"),
  );
  assert.throws(
    () =>
      parseWorkspaceListResult(
        { ...result, entries: [{ name: "../x", kind: "file" }] },
        command(),
      ),
    hasCode("workspace_list_entry_name_invalid"),
  );
  assert.throws(
    () =>
      parseWorkspaceListResult(
        { ...result, entries: [{ name: "\ud800", kind: "file" }] },
        command(),
      ),
    hasCode("workspace_list_entry_name_invalid"),
  );
  assert.throws(
    () =>
      parseWorkspaceListResult(
        { ...result, commandDigest: `sha256:${"0".repeat(64)}` },
        command(),
      ),
    hasCode("workspace_list_result_identity_mismatch"),
  );
});

test("rejects limit expansion beyond every hard cap and non-top-level depth", () => {
  const invalid = [
    { maxEntries: WORKSPACE_LIST_HARD_LIMITS.maxEntries + 1 },
    { maxNameBytes: WORKSPACE_LIST_HARD_LIMITS.maxNameBytes + 1 },
    { maxOutputBytes: WORKSPACE_LIST_HARD_LIMITS.maxOutputBytes + 1 },
    { maxScannedEntries: WORKSPACE_LIST_HARD_LIMITS.maxScannedEntries + 1 },
    { maxScannedNameBytes: WORKSPACE_LIST_HARD_LIMITS.maxScannedNameBytes + 1 },
    { timeoutMs: WORKSPACE_LIST_HARD_LIMITS.maxTimeoutMs + 1 },
  ];
  for (const change of invalid) {
    assert.throws(
      () => command({ limits: { ...limits(), ...change } }),
      hasCode("workspace_list_limits_invalid"),
    );
  }
  assert.throws(
    () =>
      command({
        limits: { ...limits(), depth: 1 } as unknown as WorkspaceListLimits,
      }),
    hasCode("workspace_list_limits_invalid"),
  );
});
