import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  CrewONAgentKernel,
  DeterministicFakeModelTransport,
} from "@crewon/agent-kernel";
import {
  RunExecutionService,
  ThreadApplicationService,
  WorkflowRunApplicationService,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

import * as productionRuntime from "./index.ts";

test("keeps experimental Workflow execution out of production runtime exports", () => {
  assert.equal("WorkflowDagExecutor" in productionRuntime, false);
  assert.equal("ExperimentalWorkflowScheduler" in productionRuntime, false);
  assert.equal(
    "ExperimentalWorkflowRunCompositionAdapter" in productionRuntime,
    false,
  );
});

test("production Worker defers an experimental scheduler without changing root authority or enabling model calls", async (t) => {
  const store = new SqliteRunStore(":memory:");
  t.after(() => store.close());
  let sequence = 0;
  const clock = { now: () => new Date().toISOString() };
  const ids = { nextId: () => `id-${++sequence}` };
  const digester = {
    sha256: (text: string) =>
      `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
  const actor = {
    actorId: "actor",
    principalId: "principal",
    tenantId: "tenant",
    spaceId: "space",
  };
  const route = {
    authorityId: "authority",
    agentVersionId: "scheduler",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy",
    workspaceBindingId: null,
  };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const threads = new ThreadApplicationService({
    store,
    clock,
    ids,
    digester,
    authorization,
  });
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "thread",
    title: null,
  });
  const schema = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  };
  const node = {
    title: "node",
    instruction: "node",
    inputSchema: schema,
    outputSchema: schema,
  };
  const workflow = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: "workflow",
      workflowVersionId: "version",
      name: "workflow",
      description: "isolation test",
      inputSchema: schema,
      outputSchema: schema,
      entryNodeIds: ["agent"],
      outputNodeIds: ["verify"],
      nodes: [
        {
          ...node,
          nodeId: "agent",
          dependsOn: [],
          kind: "agent",
          agentVersionId: "agent",
        },
        {
          ...node,
          nodeId: "verify",
          dependsOn: ["agent"],
          kind: "verification",
          verifierAgentVersionId: "verifier",
        },
      ],
    },
    digester,
  );
  await store.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: actor.tenantId,
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: clock.now(),
  });
  const admission = store.experimentalWorkflowRunAdmissionStore(() => route);
  const workflows = new WorkflowRunApplicationService({
    store: admission,
    clock,
    ids,
    authorization,
    workflowDigester: digester,
  });
  const command = {
    kind: "workflowRun.start" as const,
    idempotencyKey: "start",
    threadId: thread.state.threadId,
    workflowVersionId: workflow.workflowVersionId,
    input: {},
  };
  const created = await workflows.startWorkflowRun(actor, command);
  const transport = new DeterministicFakeModelTransport({
    expectedLastUserMessage: "must not call",
    events: [],
  });
  const worker = new RuntimeWorker(
    {
      store,
      execution: new RunExecutionService({ store, clock, ids, digester }),
      kernel: new CrewONAgentKernel({ transport }),
      policy: new PinnedRunExecutionPolicy(route),
    },
    {
      ownerId: "worker",
      nextLeaseId: () => ids.nextId(),
      leaseDurationMs: 10_000,
      scanIntervalMs: null,
    },
  );
  t.after(() => worker.close());
  assert.deepEqual(await worker.wake(), {
    kind: "retried",
    runId: created.run.state.runId,
    code: "workflow_scheduler_unavailable",
  });
  assert.equal(transport.requests.length, 0);
  assert.deepEqual(await store.listPendingWorkItems(10), []);
  assert.deepEqual((await workflows.startWorkflowRun(actor, command)).run, {
    ...created.run,
    disposition: "replayed",
  });
  assert.deepEqual(
    await store.loadRun({
      tenantId: actor.tenantId,
      runId: created.run.state.runId,
    }),
    created.run.state,
  );
  assert.deepEqual(
    await store.listRunEvents(
      { tenantId: actor.tenantId, runId: created.run.state.runId },
      0,
      100,
    ),
    created.run.events,
  );
  await worker.close();
});
