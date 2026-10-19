import assert from "node:assert/strict";
import test from "node:test";
import { replayRunLifecycle, type RunState } from "@crewon/domain";
import {
  PermanentWorkerError,
  resolveTeamRunRuntime,
  type TeamRunRuntimeResolverPort,
  type WorkerAgentRuntime,
} from "./runtime-worker.ts";

const baseRuntime = {} as WorkerAgentRuntime;

function run(binding?: RunState["teamTaskBinding"]): RunState {
  return replayRunLifecycle([
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-1",
      sequence: 1,
      occurredAt: "2026-08-08T00:00:01Z",
      type: "run.created",
      data: {
        threadId: "thread-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
        createdByActorId: "actor-1",
        authorityId: "authority-1",
        runtimeGeneration: "runtime-1",
        agentVersionId: "agent-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
        collaborationMode: "default",
        goalBinding: null,
        ...(binding === undefined ? {} : { teamTaskBinding: binding }),
      },
    },
  ]);
}

const binding = {
  schemaVersion: "crewon.team-task-run-binding.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  teamTaskId: "team-1",
  parentTaskId: "team-1",
  admissionEpoch: 1,
  capabilitySnapshotId: "sha256:capability",
};

test("routes a persisted Team binding through the host resolver", async () => {
  let calls = 0;
  const resolver: TeamRunRuntimeResolverPort = {
    resolve: async (input) => {
      calls++;
      assert.deepEqual(input.binding, binding);
      assert.equal(input.run.runId, "run-1");
      return { ...input.base, toolDefinitions: [] };
    },
  };
  const resolved = await resolveTeamRunRuntime({
    run: run(binding),
    base: baseRuntime,
    resolver,
  });
  assert.equal(resolved.toolDefinitions.length, 0);
  assert.equal(calls, 1);
});

test("fails closed when the bound Team runtime is unavailable or out of scope", async () => {
  await assert.rejects(
    resolveTeamRunRuntime({
      run: run(binding),
      base: baseRuntime,
      resolver: { resolve: async () => null },
    }),
    (error: unknown) =>
      error instanceof PermanentWorkerError &&
      error.code === "team_runtime_unavailable",
  );
  const foreign = {
    ...run(binding),
    teamTaskBinding: { ...binding, tenantId: "tenant-foreign" },
  } as RunState;
  await assert.rejects(
    resolveTeamRunRuntime({
      run: foreign,
      base: baseRuntime,
      resolver: { resolve: async () => baseRuntime },
    }),
    (error: unknown) =>
      error instanceof PermanentWorkerError &&
      error.code === "team_runtime_binding_scope_invalid",
  );
});
