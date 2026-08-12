import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compileAgentVersion,
  createAgentVersionAsset,
  type AgentVersionSource,
} from "@crewon/agent-version";
import {
  RunStoreError,
  type CommitWorkflowRunStartInput,
  type RunRoute,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  type WorkflowVersionSource,
} from "@crewon/domain";

import { SqliteRunStore } from "./sqlite-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { SqliteWorkflowVersionStore } from "./workflow-version-store.ts";

const digester = { sha256 };
const rootValue = {};
const rootDigest = sha256("{}");

test("SQLite Workflow admission invokes fresh authorities once and replay bypasses them", async (context) => {
  const path = await temporaryPath(context, "calls");
  const store = new SqliteRunStore(path, { workflowDigester: digester });
  await seedAuthority(store, path);
  let resolverCalls = 0;
  let prepareCalls = 0;
  const input = admissionInput({
    resolveCandidateRoute: async () => {
      resolverCalls += 1;
      return route("default-v1");
    },
    onPrepare: () => { prepareCalls += 1; },
  });
  const fresh = await store.commitWorkflowRunStart(input);
  assert.equal(fresh.run.disposition, "committed");
  assert.deepEqual({ resolverCalls, prepareCalls }, { resolverCalls: 1, prepareCalls: 1 });

  const replay = await store.commitWorkflowRunStart({
    ...input,
    resolveCandidateRoute: async () => {
      resolverCalls += 1;
      throw new Error("resolver unavailable");
    },
    prepare: () => {
      prepareCalls += 1;
      throw new Error("prepare must not run");
    },
  });
  assert.equal(replay.run.disposition, "replayed");
  assert.deepEqual({ resolverCalls, prepareCalls }, { resolverCalls: 1, prepareCalls: 1 });
  await assert.rejects(
    store.commitWorkflowRunStart({
      ...input,
      idempotency: { ...input.idempotency, requestFingerprint: "changed" },
    }),
    hasCode("idempotency_conflict"),
  );
  await store.close();
});

test("SQLite Workflow admission rejects a release switch after route resolution without writes", async (context) => {
  const path = await temporaryPath(context, "release-switch");
  const store = new SqliteRunStore(path, { workflowDigester: digester });
  await seedAuthority(store, path);
  let prepareCalls = 0;
  await assert.rejects(
    store.commitWorkflowRunStart(admissionInput({
      resolveCandidateRoute: async () => {
        await activateRelease(store, "default-v2", "b", `sha256:${"b".repeat(64)}`,
          `sha256:${"a".repeat(64)}`);
        return route("default-v1");
      },
      onPrepare: () => { prepareCalls += 1; },
    })),
    (error) => error instanceof RunStoreError &&
      ["workflow_run_route_mismatch", "workflow_agent_deployment_mismatch"].includes(error.code),
  );
  assert.equal(prepareCalls, 0);
  const database = new DatabaseSync(path);
  for (const table of ["run_snapshots", "run_events", "outbox", "work_items",
    "workflow_execution_values", "workflow_run_admission_receipts"]) {
    assert.equal(database.prepare(`SELECT count(*) count FROM ${table}`).get()!.count, 0, table);
  }
  await store.close();
  database.close();
});

test("SQLite Workflow admission replay fails closed on receipt and durable authority tamper", async (context) => {
  for (const mutation of [
    "UPDATE workflow_run_admission_receipts SET result_json='{}'",
    "UPDATE run_snapshots SET state_json='{}'",
    "UPDATE workflow_execution_values SET value_json='[]'",
    "UPDATE work_items SET work_item_json='{}'",
    "UPDATE outbox SET topic='tampered'",
  ]) {
    const path = await temporaryPath(context, sha256(mutation).slice(-8));
    const store = new SqliteRunStore(path, { workflowDigester: digester });
    await seedAuthority(store, path);
    const input = admissionInput();
    await store.commitWorkflowRunStart(input);
    const database = new DatabaseSync(path);
    database.exec(mutation);
    database.close();
    await assert.rejects(
      store.commitWorkflowRunStart({
        ...input,
        resolveCandidateRoute: async () => { throw new Error("must not run"); },
      }),
      (error) => error instanceof RunStoreError,
      mutation,
    );
    await store.close();
  }
});

test("SQLite Workflow admission concurrent loser rechecks the receipt after resolving", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-admission-race-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authority.sqlite");
  const first = new SqliteRunStore(path, { workflowDigester: digester });
  await seedAuthority(first, path);
  const second = new SqliteRunStore(path, { workflowDigester: digester });
  let releaseResolver!: () => void;
  const paused = new Promise<void>((resolve) => { releaseResolver = resolve; });
  let loserPrepareCalls = 0;
  const loser = first.commitWorkflowRunStart(admissionInput({
    resolveCandidateRoute: async () => { await paused; return route("default-v1"); },
    onPrepare: () => { loserPrepareCalls += 1; },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const winner = await second.commitWorkflowRunStart(admissionInput());
  releaseResolver();
  const replay = await loser;
  assert.equal(winner.run.disposition, "committed");
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(loserPrepareCalls, 0);
  await first.close();
  await second.close();
});

async function seedAuthority(store: SqliteRunStore, path: string): Promise<void> {
  await seedThread(store);
  const database = new DatabaseSync(path);
  const versions = new SqliteWorkflowVersionStore(database, digester);
  const workflow = compileWorkflowVersion(workflowSource(), digester);
  await versions.registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0", tenantId: "tenant-1",
    workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  await activateRelease(store, "node-v1", "a", `sha256:${"a".repeat(64)}`, null,
    "default-v1", ["verifier-v1"]);
  database.close();
}

async function temporaryPath(context: { after(callback: () => unknown): void }, label: string) {
  const directory = await mkdtemp(join(tmpdir(), `workflow-admission-${label}-`));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "authority.sqlite");
}

async function activateRelease(
  store: SqliteRunStore, agentVersionId: string, digestCharacter: string,
  releaseId: string, previousReleaseId: string | null, defaultId = agentVersionId,
  extraIds: readonly string[] = [],
): Promise<void> {
  const ids = [...new Set([agentVersionId, defaultId, ...extraIds])];
  const deployments = [];
  for (const id of ids) {
    const version = compileAgentVersion(agentSource(id), digester);
    await store.registerAgentVersion(createAgentVersionAsset({
      tenantId: "tenant-1", version, createdAt: "2026-08-12T00:00:00.000Z",
    }));
    deployments.push({ schemaVersion: "crewon.agent-version-deployment.v0" as const,
      tenantId: "tenant-1", agentVersionId: id, contentDigest: version.contentDigest,
      materializationDigest: `sha256:${digestCharacter.repeat(64)}`,
      authorityId: `authority-${id}`, workspaceBindingId: null });
  }
  const bundle = { schemaVersion: "crewon.agent-version-release-bundle.v0" as const,
    tenantId: "tenant-1", releaseId, manifestDigest: `sha256:${digestCharacter.repeat(64)}`,
    defaultAgentVersionId: defaultId, deployments };
  await store.activateAgentVersionRelease({ bundle, expectedActiveReleaseId: previousReleaseId,
    activation: { schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: "tenant-1", releaseId, activationId: `activate-${releaseId}`,
      previousReleaseId, operator: { principalId: "principal", actorId: "actor",
        spaceId: "space-1" }, activatedAt: "2026-08-12T00:00:00.000Z" } });
}

function admissionInput(options: { resolveCandidateRoute?: () => Promise<RunRoute>;
  onPrepare?: () => void } = {}): CommitWorkflowRunStartInput {
  return { tenantId: "tenant-1", spaceId: "space-1", threadId: "thread-1",
    workflowVersionId: "workflow-v1", workflowInput: rootValue,
    idempotency: { scope: "workflow-start", key: "start-1", requestFingerprint: "fp-1" },
    resolveCandidateRoute: options.resolveCandidateRoute ?? (async () => route("default-v1")),
    prepare: (authority) => {
      options.onPrepare?.();
      const runId = "workflow-run-1";
      const occurredAt = "2026-08-12T00:00:01.000Z";
      const event = { schemaVersion: "crewon.run-event.v0" as const, identity: { runId },
        eventId: "workflow-created-1", sequence: 1, occurredAt, type: "run.created" as const,
        data: { threadId: "thread-1", tenantId: "tenant-1", spaceId: "space-1",
          createdByActorId: "actor", ...authority.route, collaborationMode: "default" as const,
          origin: null, goalBinding: null, purpose: "workflow" as const,
          workflowVersionBinding: { workflowId: authority.workflowVersion.workflowId,
            workflowVersionId: authority.workflowVersion.workflowVersionId,
            contentDigest: authority.workflowVersion.contentDigest } } };
      return { workflowInputValue: { schemaVersion: "crewon.workflow-execution-value.v0",
        valueId: "root-value-1", value: rootValue, valueDigest: rootDigest },
        commit: { tenantId: "tenant-1", expectedRevision: 0,
          idempotency: { scope: "run-create", key: "run-1", requestFingerprint: "run-fp-1" },
          events: [event], outbox: [{ messageId: "outbox-1", tenantId: "tenant-1", runId,
            topic: "run.updated", payload: { eventId: event.eventId, eventType: event.type,
              throughSequence: 1 }, createdAt: occurredAt }],
          workItems: [{ workItemId: "work-1", tenantId: "tenant-1", runId,
            kind: "run.execute", createdAt: occurredAt,
            payload: { schemaVersion: "crewon.workflow-scheduler-work-item.v1",
              trigger: "workflowScheduler", schedulerOperationId: "scheduler-1",
              binding: event.data.workflowVersionBinding,
              workflowInput: { valueId: "root-value-1", valueDigest: rootDigest } } }] } };
    } };
}

function workflowSource(): WorkflowVersionSource {
  const schema = { type: "object" as const, properties: {}, required: [], additionalProperties: false as const };
  return { schemaVersion: "crewon.workflow-version-source.v0", workflowId: "workflow-1",
    workflowVersionId: "workflow-v1", name: "workflow", description: "workflow",
    inputSchema: schema, outputSchema: schema, entryNodeIds: ["node"], outputNodeIds: ["verify"],
    nodes: [{ nodeId: "node", title: "node", instruction: "run", dependsOn: [],
      inputSchema: schema, outputSchema: schema, kind: "agent", agentVersionId: "node-v1" },
    { nodeId: "verify", title: "verify", instruction: "verify", dependsOn: ["node"],
      inputSchema: schema, outputSchema: schema, kind: "verification",
      verifierAgentVersionId: "verifier-v1" }] };
}

function agentSource(agentVersionId: string): AgentVersionSource {
  return { schemaVersion: "crewon.agent-version-source.v0", agentVersionId,
    runtimeGeneration: "ts-v0", policySnapshotId: "policy-1", instructions: null,
    model: { adapterName: "test", adapterVersion: "1", modelId: "model",
      contextWindowTokens: 4096, autoCompactAtTokens: null },
    execution: { streamMaxRetries: 1, maxToolRounds: 1 },
    resources: { workspaceRequired: false, governedContextDigest: null }, tools: [] };
}

function route(agentVersionId: string): RunRoute {
  return { agentVersionId, authorityId: `authority-${agentVersionId}`,
    runtimeGeneration: "ts-v0", policySnapshotId: "policy-1", workspaceBindingId: null };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
