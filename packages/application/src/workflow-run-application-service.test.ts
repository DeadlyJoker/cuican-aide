import assert from "node:assert/strict";
import test from "node:test";

import {
  compileWorkflowVersion,
  reduceRunLifecycleEvent,
  serializeCompiledWorkflowVersion,
  type RunState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import type {
  CommitWorkflowRunStartInput,
  WorkflowRunAdmissionStore,
} from "./workflow-run-admission-store-port.ts";
import {
  MAX_WORKFLOW_INPUT_BYTES,
  MAX_WORKFLOW_INPUT_DEPTH,
  WorkflowRunApplicationService,
} from "./workflow-run-application-service.ts";

test("atomically freezes WorkflowVersion provenance and enqueues bounded input without a Goal", async () => {
  const store = new RecordingStore();
  const result = await service(store).startWorkflowRun(actor(), command());
  assert.equal(result.run.disposition, "committed");
  const commit = store.lastCommit!;
  const event = commit.events[0]!;
  assert.equal(event.type, "run.created");
  if (event.type !== "run.created") assert.fail();
  assert.deepEqual(event.data.workflowVersionBinding, {
    workflowId: "workflow-1",
    workflowVersionId: "version-1",
    contentDigest: store.authority.workflowVersion.contentDigest,
  });
  assert.equal(event.data.purpose, "workflow");
  assert.equal(event.data.collaborationMode, "default");
  assert.equal(event.data.goalBinding, null);
  assert.deepEqual(commit.workItems[0]?.payload, {
    throughSequence: 1,
    workflowInput: { topic: "safe" },
  });
});

test("uses caller input in the receipt fingerprint and maps conflict before prepare", async () => {
  const store = new RecordingStore();
  await service(store).startWorkflowRun(actor(), command());
  store.error = new RunStoreError("idempotency_conflict");
  await assert.rejects(
    service(store).startWorkflowRun(actor(), {
      ...command(),
      input: { topic: "changed" },
    }),
    hasError("conflict", "idempotency_conflict"),
  );
  assert.notEqual(
    store.inputs[0]?.idempotency.requestFingerprint,
    store.inputs[1]?.idempotency.requestFingerprint,
  );
});

test("rejects oversized, overly deep and non-finite input before authorization or Store", async () => {
  const store = new RecordingStore();
  const authorization = new RecordingAuthorization();
  const app = service(store, authorization);
  for (const input of [
    "x".repeat(MAX_WORKFLOW_INPUT_BYTES + 1),
    deepInput(MAX_WORKFLOW_INPUT_DEPTH + 1),
    Number.NaN,
  ]) {
    await assert.rejects(
      app.startWorkflowRun(actor(), { ...command(), input } as never),
      hasError("validation", "workflow_input_invalid"),
    );
  }
  assert.equal(authorization.calls, 0);
  assert.equal(store.inputs.length, 0);
});

test("rejects required, type and additional-property schema mismatches before writes", async () => {
  for (const input of [{}, { topic: 1 }, { topic: "safe", extra: true }]) {
    const store = new RecordingStore();
    await assert.rejects(
      service(store).startWorkflowRun(actor(), {
        ...command(),
        input,
      } as never),
      hasError("validation", "workflow_input_schema_mismatch"),
    );
    assert.equal(store.lastCommit, null);
    assert.equal(store.writeCount, 0);
  }
});

test("rejects corrupt and digest-drift WorkflowVersions with zero writes", async () => {
  for (const mutate of [
    (store: RecordingStore) => {
      store.authority.workflowVersion.definitionJson = "{}";
    },
    (store: RecordingStore) => {
      store.authority.workflowVersion.contentDigest = `sha256:${"b".repeat(64)}`;
    },
  ]) {
    const store = new RecordingStore();
    mutate(store);
    await assert.rejects(
      service(store).startWorkflowRun(actor(), command()),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "internal",
    );
    assert.equal(store.lastCommit, null);
    assert.equal(store.writeCount, 0);
  }
});

class RecordingStore implements WorkflowRunAdmissionStore {
  readonly inputs: CommitWorkflowRunStartInput[] = [];
  lastCommit: ReturnType<CommitWorkflowRunStartInput["prepare"]> | null = null;
  error: Error | null = null;
  writeCount = 0;
  readonly authority = workflowAuthority();
  async commitWorkflowRunStart(input: CommitWorkflowRunStartInput) {
    this.inputs.push(input);
    if (this.error) throw this.error;
    const commit = input.prepare(this.authority);
    this.lastCommit = commit;
    this.writeCount += 1;
    let state: RunState | null = null;
    for (const event of commit.events)
      state = reduceRunLifecycleEvent(state, event);
    if (!state) throw new Error("missing state");
    return {
      authority: this.authority,
      run: {
        disposition: "committed" as const,
        state,
        events: commit.events,
        outbox: commit.outbox,
        workItems: commit.workItems,
      },
    };
  }
}

class RecordingAuthorization implements AuthorizationPort {
  calls = 0;
  async authorize() {
    this.calls += 1;
    return { outcome: "allow" as const };
  }
}

function service(
  store: RecordingStore,
  authorization: AuthorizationPort = new RecordingAuthorization(),
) {
  const ids = ["run-1", "event-1", "outbox-1", "work-1"];
  return new WorkflowRunApplicationService({
    store,
    authorization,
    clock: { now: () => "2026-08-12T00:00:00Z" },
    ids: { nextId: () => ids.shift()! },
    workflowDigester: { sha256 },
  });
}

function workflowAuthority() {
  const workflow = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: "workflow-1",
      workflowVersionId: "version-1",
      name: "Workflow",
      description: "Workflow admission fixture",
      inputSchema: objectSchema(),
      outputSchema: objectSchema(),
      entryNodeIds: ["node-1"],
      outputNodeIds: ["verify-1"],
      nodes: [
        {
          kind: "agent",
          nodeId: "node-1",
          title: "Node",
          instruction: "Execute",
          dependsOn: [],
          inputSchema: objectSchema(),
          outputSchema: objectSchema(),
          agentVersionId: "node-agent-version",
        },
        {
          kind: "verification",
          nodeId: "verify-1",
          title: "Verify",
          instruction: "Verify",
          dependsOn: ["node-1"],
          inputSchema: objectSchema(),
          outputSchema: objectSchema(),
          verifierAgentVersionId: "verifier-version",
        },
      ],
    },
    { sha256 },
  );
  return {
    workflowVersion: {
      schemaVersion: "crewon.workflow-version-asset.v0" as const,
      tenantId: "tenant-1",
      workflowId: workflow.workflowId,
      workflowVersionId: workflow.workflowVersionId,
      contentDigest: workflow.contentDigest,
      definitionJson: serializeCompiledWorkflowVersion(workflow),
      createdAt: "2026-08-12T00:00:00Z",
    },
    route: {
      authorityId: "server-authority",
      runtimeGeneration: "ts-v0",
      agentVersionId: "root-version",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  };
}

function objectSchema() {
  return {
    type: "object" as const,
    properties: {
      topic: { type: "string" as const, maxLength: 32, enum: null },
    },
    required: ["topic"],
    additionalProperties: false as const,
  };
}

function sha256(value: string): string {
  return `sha256:${Buffer.from(value).toString("hex").slice(0, 64).padEnd(64, "0")}`;
}
function actor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}
function command() {
  return {
    kind: "workflowRun.start",
    idempotencyKey: "key-1",
    workflowVersionId: "version-1",
    threadId: "thread-1",
    input: { topic: "safe" },
  } as const;
}
function deepInput(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}
function hasError(category: string, code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
