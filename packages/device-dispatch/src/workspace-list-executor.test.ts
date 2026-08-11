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

test("builds a path-free action digest over every binding incarnation and limit", () => {
  const base = command();
  const variants = [
    command({ executionId: "workspace-execution-2" }),
    command({ idempotencyKey: "workspace-idempotency-2" }),
    command({ binding: binding("workspace-2", "incarnation-1") }),
    command({ binding: binding("workspace-1", "incarnation-2") }),
    command({ binding: { ...binding(), deviceBindingId: "device-binding-2" } }),
    command({ binding: { ...binding(), deviceId: "device-2" } }),
    command({
      binding: { ...binding(), runtimeBindingId: "runtime-binding-2" },
    }),
    command({ policySnapshotId: "policy-2" }),
    command({ limits: limits({ maxEntries: 4 }) }),
    command({ limits: limits({ maxNameBytes: 200 }) }),
    command({ limits: limits({ maxOutputBytes: 32_000 }) }),
    command({ limits: limits({ maxScannedEntries: 9 }) }),
    command({ limits: limits({ maxScannedNameBytes: 4_000 }) }),
    command({ limits: limits({ timeoutMs: 10_000 }) }),
  ];

  assert.equal(
    new Set([base, ...variants].map((item) => item.actionDigest)).size,
    variants.length + 1,
  );
  const commandVariants = Object.entries(authority()).map(([key, value]) =>
    command({
      authority: {
        ...authority(),
        [key]: typeof value === "number" ? value + 1 : `${value}-changed`,
      },
    }),
  );
  assert.equal(
    new Set([base, ...commandVariants].map((item) => item.commandDigest)).size,
    commandVariants.length + 1,
  );
  assert.equal(JSON.stringify(base).includes("/Users/"), false);
  assert.equal(JSON.stringify(base).includes("root"), false);
  assert.deepEqual(
    { actionDigest: base.actionDigest, commandDigest: base.commandDigest },
    {
      actionDigest:
        "sha256:cc0bf069b288744307c6155248be77640e1c18ff3c24ec6befd650575421cc67",
      commandDigest:
        "sha256:3dc53ee016858a79e5bc45bdf3180dcb5530c9c4bcf9fe1a43bcb634df08836e",
    },
  );
  assert.throws(
    () =>
      parseWorkspaceListCommand({
        ...base,
        actionDigest: `sha256:${"0".repeat(64)}`,
      }),
    hasCode("workspace_list_action_digest_invalid"),
  );
});

test("releases a capability that fulfills after acquire cancellation exactly once", async () => {
  let resolveCapability!: (
    capability: WorkspaceDirectoryCapabilityPort | null,
  ) => void;
  const pending = new Promise<WorkspaceDirectoryCapabilityPort | null>(
    (resolve) => {
      resolveCapability = resolve;
    },
  );
  const capability = fakeCapability([]);
  const reports: string[] = [];
  const controller = new AbortController();
  const execution = new BoundedWorkspaceListExecutor({
    capabilities: { acquire: async () => pending },
    cleanupFailures: {
      report(input) {
        reports.push(input.phase);
      },
    },
  }).execute(command(), controller.signal);
  controller.abort("caller_requested");
  await assert.rejects(execution, hasCode("workspace_list_canceled"));
  resolveCapability(capability);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(capability.releases, 1);
  assert.deepEqual(reports, []);
});

test("fails closed on normal release failure without replacing a primary error", async () => {
  const reports: string[] = [];
  const capability: WorkspaceDirectoryCapabilityPort = {
    binding: binding(),
    async listTopLevelPage() {
      return { entries: [], nextCursor: null };
    },
    release() {
      throw new Error("release_failed");
    },
  };
  const executor = new BoundedWorkspaceListExecutor({
    capabilities: { acquire: async () => capability },
    cleanupFailures: {
      report(input) {
        reports.push(input.phase);
      },
    },
  });
  await assert.rejects(
    executor.execute(command(), new AbortController().signal),
    hasCode("workspace_list_cleanup_failed"),
  );
  await assert.rejects(
    new BoundedWorkspaceListExecutor({
      capabilities: {
        acquire: async () => ({
          ...capability,
          async listTopLevelPage() {
            return { entries: [entry("link", "symlink")], nextCursor: null };
          },
        }),
      },
      cleanupFailures: {
        report(input) {
          reports.push(input.phase);
        },
      },
    }).execute(command(), new AbortController().signal),
    hasCode("workspace_list_link_entry_unsupported"),
  );
  assert.deepEqual(reports, ["ownedCapability", "ownedCapability"]);
});

test("never requests an entry beyond the frozen scan budget", async () => {
  const requested: Array<{
    limit: number;
    maxNameBytes: number;
    maxTotalNameBytes: number;
  }> = [];
  const capability: WorkspaceDirectoryCapabilityPort = {
    binding: binding(),
    async listTopLevelPage({ limit, maxNameBytes, maxTotalNameBytes }) {
      requested.push({ limit, maxNameBytes, maxTotalNameBytes });
      return {
        entries: [entry("a", "file"), entry("b", "file")],
        nextCursor: "p:2",
      };
    },
    release() {},
  };
  await assert.rejects(
    executorFor(capability).execute(
      command({ limits: limits({ maxEntries: 1, maxScannedEntries: 2 }) }),
      new AbortController().signal,
    ),
    hasCode("workspace_list_scan_limit_exceeded"),
  );
  assert.deepEqual(requested, [
    { limit: 2, maxNameBytes: 255, maxTotalNameBytes: 8_000 },
  ]);
});

test("lists only bounded top-level entries in raw UTF-8 byte order", async () => {
  const capability = fakeCapability([
    entry("中", "file"),
    entry("é", "directory"),
    entry("z", "file"),
    entry("a", "directory"),
  ]);
  const executor = executorFor(capability);

  const result = await executor.execute(
    command({ limits: limits({ maxEntries: 3 }) }),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    schemaVersion: "crewon.workspace-list-result.v0",
    executionId: "workspace-execution-1",
    actionDigest: command({ limits: limits({ maxEntries: 3 }) }).actionDigest,
    commandDigest: command({ limits: limits({ maxEntries: 3 }) }).commandDigest,
    entries: [
      { name: "a", kind: "directory" },
      { name: "z", kind: "file" },
      { name: "é", kind: "directory" },
    ],
    truncated: true,
  });
  assert.equal(capability.releases, 1);
  assert.deepEqual(
    projectWorkspaceListResult(
      result,
      command({ limits: limits({ maxEntries: 3 }) }),
    ),
    {
      entries: result.entries,
      truncated: true,
    },
  );
});

test("rejects invalid UTF-8, byte-overlong names and unsafe name controls", async () => {
  const cases: readonly WorkspaceDirectoryEntry[] = [
    { nameBytes: Uint8Array.of(0xc3, 0x28), kind: "file" },
    entry("中文", "file"),
    entry("escape/link", "file"),
    entry("hidden\u202efile", "file"),
  ];
  for (const candidate of cases) {
    const capability = fakeCapability([candidate]);
    await assert.rejects(
      executorFor(capability).execute(
        command({ limits: limits({ maxNameBytes: 5 }) }),
        new AbortController().signal,
      ),
      hasCode("workspace_list_entry_name_invalid"),
    );
    assert.equal(capability.releases, 1);
  }
});

test("fails closed on symlinks, reparse points and unsupported entry types", async () => {
  for (const kind of ["symlink", "reparsePoint", "other"] as const) {
    await assert.rejects(
      executorFor(fakeCapability([entry("escape", kind)])).execute(
        command(),
        new AbortController().signal,
      ),
      hasCode(
        kind === "other"
          ? "workspace_list_entry_type_unsupported"
          : "workspace_list_link_entry_unsupported",
      ),
    );
  }
});
