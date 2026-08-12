import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  RunStoreError,
  WorkflowRunApplicationService,
  type CommitWorkflowRunStartInput,
  type WorkflowRunAdmissionStore,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  type WorkflowVersionSource,
} from "@crewon/domain";
import { Pool } from "pg";

import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const route = {
  agentVersionId: "default-agent",
  authorityId: "authority-default-agent",
  workspaceBindingId: null,
  runtimeGeneration: "ts-v0",
  policySnapshotId: "policy-1",
} as const;

if (postgresUrl === undefined) {
  test.skip("PostgreSQL Workflow Run admission requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  test("fresh then replay uses distinct specialized and general fingerprints", async () => {
    const fixture = await postgresFixture();
    try {
      const store = countingStore(fixture.admission);
      const first = await service(store).startWorkflowRun(actor(), command());
      const replay = await service(store).startWorkflowRun(actor(), command());
      assert.equal(first.run.disposition, "committed");
      assert.deepEqual(replay, {
        ...first,
        run: { ...first.run, disposition: "replayed" },
      });
      assert.deepEqual(
        {
          resolverCalls: store.resolverCalls,
          prepareCalls: store.prepareCalls,
        },
        { resolverCalls: 1, prepareCalls: 1 },
      );
      const fingerprints = await fixture.pool.query<{
        specialized: string;
        general: string;
      }>(
        `SELECT admission.fingerprint AS specialized,
                general.fingerprint AS general
         FROM ${fixture.schema}.workflow_run_admission_receipts admission
         JOIN ${fixture.schema}.idempotency_receipts general
           ON general.run_id=admission.run_id`,
      );
      assert.notEqual(
        fingerprints.rows[0]!.specialized,
        fingerprints.rows[0]!.general,
      );
      await assert.rejects(
        service(store).startWorkflowRun(actor(), {
          ...command(),
          input: { topic: "changed" },
        }),
        /idempotency_conflict/u,
      );
      assert.deepEqual(
        {
          resolverCalls: store.resolverCalls,
          prepareCalls: store.prepareCalls,
        },
        { resolverCalls: 1, prepareCalls: 1 },
      );
    } finally {
      await fixture.close();
    }
  });

  test("two pools produce one prepared winner and one deep replay", async () => {
    const fixture = await postgresFixture();
    const second = new PostgresWorkflowRunCompositionStore({
      pool: fixture.pool,
      schema: fixture.schema,
      digester,
    });
    try {
      const left = countingStore(fixture.admission);
      const right = countingStore(second);
      const gate = barrier(2);
      left.beforeResolve = gate;
      right.beforeResolve = gate;
      const results = await Promise.all([
        service(left).startWorkflowRun(actor(), command()),
        service(right).startWorkflowRun(actor(), command()),
      ]);
      assert.equal(
        results.filter((result) => result.run.disposition === "committed")
          .length,
        1,
      );
      assert.equal(
        results.filter((result) => result.run.disposition === "replayed")
          .length,
        1,
      );
      assert.equal(left.prepareCalls + right.prepareCalls, 1);
    } finally {
      await second.close();
      await fixture.close();
    }
  });

  test("release switch after resolution fails closed and rolls back every effect", async () => {
    const fixture = await postgresFixture();
    try {
      const switched = await registerRelease(
        fixture.domain,
        "switched-agent",
        "b",
        ["node-agent", "verifier-agent"],
      );
      const store = countingStore(fixture.admission);
      store.afterResolve = async () => {
        await fixture.domain.activateAgentVersionRelease({
          bundle: switched.bundle,
          activation: switched.activation,
          expectedActiveReleaseId: fixture.releaseId,
        });
      };
      await assert.rejects(
        service(store).startWorkflowRun(actor(), command()),
        /workflow_run_route_mismatch/u,
      );
      assert.equal(store.prepareCalls, 0);
      for (const table of [
        "run_snapshots",
        "run_events",
        "idempotency_receipts",
        "outbox",
        "work_items",
        "workflow_execution_values",
        "workflow_run_admission_receipts",
      ]) {
        const count = await fixture.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${fixture.schema}.${table}`,
        );
        assert.equal(count.rows[0]!.count, "0", table);
      }
    } finally {
      await fixture.close();
    }
  });

  test("ordinary Run writer and Workflow admission do not deadlock", async () => {
    const fixture = await postgresFixture();
    try {
      const store = countingStore(fixture.admission);
      const outcomes = await Promise.allSettled([
        service(store).startWorkflowRun(actor(), command()),
        fixture.domain.commitRun(createRunningCommitFixture()),
      ]);
      assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        2,
      );
    } finally {
      await fixture.close();
    }
  });

  test("reopen replays and durable authority tampering fails closed", async () => {
    const fixture = await postgresFixture();
    try {
      const first = await service(fixture.admission).startWorkflowRun(
        actor(),
        command(),
      );
      const reopened = new PostgresWorkflowRunCompositionStore({
        pool: fixture.pool,
        schema: fixture.schema,
        digester,
      });
      assert.equal(
        (await service(reopened).startWorkflowRun(actor(), command())).run
          .disposition,
        "replayed",
      );
      await fixture.pool.query(
        `UPDATE ${fixture.schema}.outbox
         SET topic='tampered' WHERE run_id=$1`,
        [first.run.state.runId],
      );
      await assert.rejects(
        service(reopened).startWorkflowRun(actor(), command()),
        /workflow_run_admission_receipt_corrupt/u,
      );
      await reopened.close();
    } finally {
      await fixture.close();
    }
  });

  test("accepts the exact 32 KiB canonical Workflow input boundary", async () => {
    const inputSchema = {
      type: "object" as const,
      properties: Object.fromEntries(
        ["a", "b", "c", "d"].map((key) => [
          key,
          { type: "string" as const, maxLength: 8_192, enum: null },
        ]),
      ),
      required: ["a", "b", "c", "d"],
      additionalProperties: false as const,
    };
    const fixture = await postgresFixture(inputSchema);
    try {
      const input = {
        a: "x".repeat(8_192),
        b: "x".repeat(8_192),
        c: "x".repeat(8_192),
        d: "x".repeat(8_163),
      };
      assert.equal(Buffer.byteLength(JSON.stringify(input)), 32_768);
      const result = await service(fixture.admission).startWorkflowRun(
        actor(),
        { ...command(), input },
      );
      assert.equal(result.run.disposition, "committed");
    } finally {
      await fixture.close();
    }
  });

  test("specialized receipt conflict leaves Workflow admission effects absent", async () => {
    const fixture = await postgresFixture();
    try {
      const ordinary = await fixture.domain.commitRun(
        createRunningCommitFixture(),
      );
      const store = countingStore(fixture.admission);
      store.afterResolve = async () => {
        const captured = store.lastInput!;
        await fixture.pool.query(
          `INSERT INTO ${fixture.schema}.workflow_run_admission_receipts
             (tenant_id,scope,idempotency_key,fingerprint,run_id,result_json)
           VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
          [
            captured.tenantId,
            captured.idempotency.scope,
            captured.idempotency.key,
            "conflicting-fingerprint",
            ordinary.state.runId,
          ],
        );
      };
      await assert.rejects(
        service(store).startWorkflowRun(actor(), command()),
        /idempotency_conflict/u,
      );
      assert.equal(store.prepareCalls, 0);
      const workflowRuns = await fixture.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${fixture.schema}.run_snapshots
         WHERE state_json->>'purpose'='workflow'`,
      );
      assert.equal(workflowRuns.rows[0]!.count, "0");
      for (const table of ["workflow_execution_values", "outbox"])
        assert.equal(
          (
            await fixture.pool.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM ${fixture.schema}.${table}
               WHERE run_id<>$1`,
              [ordinary.state.runId],
            )
          ).rows[0]!.count,
          "0",
          table,
        );
    } finally {
      await fixture.close();
    }
  });
}

export async function postgresFixture(
  inputSchema: WorkflowVersionSource["inputSchema"] = objectSchema(),
) {
  const schema = `workflow_admission_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: postgresUrl!, max: 8 });
  const domain = await PostgresDomainStore.open({
    pool,
    schema,
    statementTimeoutMs: 2_000,
  });
  const admission = await PostgresWorkflowRunCompositionStore.open({
    pool,
    schema,
    digester,
    statementTimeoutMs: 2_000,
  });
  await seedThread(domain);
  const release = await registerRelease(domain, route.agentVersionId, "a", [
    "node-agent",
    "verifier-agent",
  ]);
  await domain.activateAgentVersionRelease({
    bundle: release.bundle,
    activation: release.activation,
    expectedActiveReleaseId: null,
  });
  const workflow = compileWorkflowVersion(
    workflowSource(inputSchema),
    digester,
  );
  await domain.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00Z",
  });
  return {
    schema,
    pool,
    domain,
    admission,
    releaseId: release.bundle.releaseId,
    async close() {
      await Promise.allSettled([admission.close(), domain.close()]);
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    },
  };
}

async function registerRelease(
  domain: PostgresDomainStore,
  defaultAgentVersionId: string,
  digestCharacter: string,
  additionalAgentVersionIds: readonly string[] = [],
) {
  const ids = [defaultAgentVersionId, ...additionalAgentVersionIds];
  const assets = ids.map(agentAsset);
  for (const asset of assets) await domain.registerAgentVersion(asset);
  const releaseId = `sha256:${digestCharacter.repeat(64)}`;
  return {
    bundle: {
      schemaVersion: "crewon.agent-version-release-bundle.v0" as const,
      tenantId: "tenant-1",
      releaseId,
      manifestDigest: releaseId,
      defaultAgentVersionId,
      deployments: assets.map((asset, index) => ({
        schemaVersion: "crewon.agent-version-deployment.v0" as const,
        tenantId: asset.tenantId,
        agentVersionId: asset.agentVersionId,
        contentDigest: asset.contentDigest,
        materializationDigest: `sha256:${String(index + 1).repeat(64)}`,
        authorityId: `authority-${asset.agentVersionId}`,
        workspaceBindingId: null,
      })),
    },
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0" as const,
      tenantId: "tenant-1",
      releaseId,
      activationId: `activation-${digestCharacter}`,
      previousReleaseId:
        digestCharacter === "a" ? null : `sha256:${"a".repeat(64)}`,
      operator: actor(),
      activatedAt: "2026-08-12T00:00:00Z",
    },
  };
}

function agentAsset(agentVersionId: string) {
  const version = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-1",
      instructions: "test",
      model: {
        adapterName: "responses-http",
        adapterVersion: "0",
        modelId: "test-model",
        contextWindowTokens: 100_000,
        autoCompactAtTokens: 80_000,
      },
      execution: { streamMaxRetries: 1, maxToolRounds: 4 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  return createAgentVersionAsset({
    tenantId: "tenant-1",
    version,
    createdAt: "2026-08-12T00:00:00Z",
  });
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

function workflowSource(
  inputSchema: WorkflowVersionSource["inputSchema"],
): WorkflowVersionSource {
  const outputSchema = objectSchema();
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    name: "admission",
    description: "admission",
    inputSchema,
    outputSchema,
    entryNodeIds: ["node"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        kind: "agent",
        nodeId: "node",
        title: "node",
        instruction: "node",
        dependsOn: [],
        inputSchema,
        outputSchema,
        agentVersionId: "node-agent",
      },
      {
        kind: "verification",
        nodeId: "verify",
        title: "verify",
        instruction: "verify",
        dependsOn: ["node"],
        inputSchema,
        outputSchema,
        verifierAgentVersionId: "verifier-agent",
      },
    ],
  };
}

function countingStore(delegate: WorkflowRunAdmissionStore) {
  return new (class implements WorkflowRunAdmissionStore {
    resolverCalls = 0;
    prepareCalls = 0;
    beforeResolve: (() => Promise<void>) | null = null;
    afterResolve: (() => Promise<void>) | null = null;
    lastInput: CommitWorkflowRunStartInput | null = null;
    async commitWorkflowRunStart(input: CommitWorkflowRunStartInput) {
      this.lastInput = input;
      return delegate.commitWorkflowRunStart({
        ...input,
        resolveCandidateRoute: async () => {
          this.resolverCalls += 1;
          await this.beforeResolve?.();
          const resolved = await input.resolveCandidateRoute();
          await this.afterResolve?.();
          return resolved;
        },
        prepare: (authority) => {
          this.prepareCalls += 1;
          return input.prepare(authority);
        },
      });
    }
  })();
}

export function service(store: WorkflowRunAdmissionStore) {
  let id = 0;
  return new WorkflowRunApplicationService({
    store,
    authorization: {
      async authorize() {
        return { outcome: "allow" as const };
      },
    },
    clock: { now: () => "2026-08-12T00:00:00Z" },
    ids: { nextId: () => `workflow-admission-${++id}` },
    workflowDigester: digester,
    routeResolver: {
      async resolveRoute() {
        return route;
      },
    },
  });
}

export function actor() {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    principalId: "principal-1",
    actorId: "actor-1",
  };
}

export function command() {
  return {
    kind: "workflowRun.start" as const,
    idempotencyKey: "workflow-key-1",
    workflowVersionId: "workflow-version-1",
    threadId: "thread-1",
    input: { topic: "safe" },
  };
}

function barrier(parties: number) {
  let remaining = parties;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    remaining -= 1;
    if (remaining === 0) release();
    await ready;
  };
}

function hasStoreCode(code: string) {
  return (error: unknown) =>
    error instanceof RunStoreError && error.code === code;
}
