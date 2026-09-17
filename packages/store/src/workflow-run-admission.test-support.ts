import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  WorkflowRunApplicationService,
  type WorkflowRunAdmissionStore,
  type StartWorkflowRunCommand,
  type CommitWorkflowRunStartInput,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  type WorkflowObjectSchema,
} from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import type { SqliteWorkflowRouteResolver } from "./sqlite-workflow-run-admission.ts";
import type { LeaseClock } from "./lease-clock.ts";

export const admissionActor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
export const admissionCommand: StartWorkflowRunCommand = {
  kind: "workflowRun.start",
  idempotencyKey: "start-1",
  threadId: "thread-1",
  workflowVersionId: "version-1",
  input: { topic: "safe" },
};
export const admissionRoute = {
  authorityId: "authority-1",
  runtimeGeneration: "ts-v0",
  agentVersionId: "scheduler-version",
  policySnapshotId: "policy-1",
  workspaceBindingId: "workspace-1",
};
const defaultSchema: WorkflowObjectSchema = {
  type: "object",
  properties: { topic: { type: "string", maxLength: 128, enum: null } },
  required: ["topic"],
  additionalProperties: false,
};
export function admissionVersion(inputSchema = defaultSchema) {
  const workflow = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: "workflow-1",
      workflowVersionId: "version-1",
      name: "Workflow",
      description: "Atomic admission",
      inputSchema,
      outputSchema: inputSchema,
      entryNodeIds: ["agent"],
      outputNodeIds: ["verify"],
      nodes: [
        {
          kind: "agent",
          nodeId: "agent",
          title: "Agent",
          instruction: "Execute",
          dependsOn: [],
          inputSchema,
          outputSchema: inputSchema,
          agentVersionId: "agent-1",
        },
        {
          kind: "verification",
          nodeId: "verify",
          title: "Verify",
          instruction: "Verify",
          dependsOn: ["agent"],
          inputSchema,
          outputSchema: inputSchema,
          verifierAgentVersionId: "verifier-1",
        },
      ],
    },
    workflowAdmissionDigest,
  );
  return {
    schemaVersion: "crewon.workflow-version-asset.v0" as const,
    tenantId: "tenant-1",
    workflowId: "workflow-1",
    workflowVersionId: "version-1",
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-09-14T00:00:00.000Z",
  };
}

export function admissionApplication(
  store: WorkflowRunAdmissionStore,
  prefix = "fixture",
) {
  let ids = 0;
  const app = new WorkflowRunApplicationService({
    store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-09-14T00:00:00.000Z" },
    ids: { nextId: (kind) => `${prefix}-${kind}-${++ids}` },
    workflowDigester: workflowAdmissionDigest,
  });
  return { app, ids: () => ids };
}

export async function sqliteAdmissionFixture(
  context: TestContext,
  inputSchema = defaultSchema,
  options: { clock?: LeaseClock; asset?: ReturnType<typeof admissionVersion> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-workflow-admission-"));
  const path = join(root, "store.sqlite");
  const stores: SqliteRunStore[] = [];
  const open = () => {
    const store = new SqliteRunStore(path, { clock: options.clock });
    stores.push(store);
    return store;
  };
  const store = open();
  const database = new DatabaseSync(path);
  context.after(async () => {
    database.close();
    for (const owned of stores) await owned.close();
    rmSync(root, { recursive: true, force: true });
  });
  await seedThread(store);
  const asset = options.asset ?? admissionVersion(inputSchema);
  await store
    .workflowVersionStore(workflowAdmissionDigest)
    .registerWorkflowVersion(asset);
  let routeCalls = 0,
    prepareCalls = 0;
  let lastInput: CommitWorkflowRunStartInput | null = null;
  let route: SqliteWorkflowRouteResolver = () => admissionRoute;
  let modify = (value: ReturnType<CommitWorkflowRunStartInput["prepare"]>) =>
    value;
  const adapter = store.experimentalWorkflowRunAdmissionStore((input) => {
    routeCalls++;
    return route(input);
  });
  const service = admissionApplication({
    commitWorkflowRunStart(input) {
      lastInput = input;
      return adapter.commitWorkflowRunStart({
        ...input,
        prepare(authority) {
          prepareCalls++;
          return modify(input.prepare(authority));
        },
      });
    },
  });
  const counts = () =>
    Object.fromEntries(
      [
        "run_snapshots",
        "run_events",
        "run_thread_bindings",
        "work_items",
        "outbox",
        "idempotency_receipts",
        "workflow_run_inputs",
        "workflow_run_admissions",
      ].map((table) => [
        table,
        (
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count,
      ]),
    );
  assert.ok(Object.values(counts()).every((count) => count === 0));
  return {
    root,
    path,
    store,
    database,
    adapter,
    asset,
    open,
    counts,
    service,
    start: (
      command: StartWorkflowRunCommand = admissionCommand,
      actor = admissionActor,
    ) => service.app.startWorkflowRun(actor, command),
    callbacks: () => ({ routeCalls, prepareCalls, ids: service.ids() }),
    lastInput: () => {
      assert.ok(lastInput);
      return lastInput;
    },
    route: (value: SqliteWorkflowRouteResolver) => {
      route = value;
    },
    modify: (value: typeof modify) => {
      modify = value;
    },
  };
}
