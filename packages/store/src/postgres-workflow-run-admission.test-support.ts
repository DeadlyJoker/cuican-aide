import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { CommitWorkflowRunStartInput } from "@crewon/application";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import type { PostgresWorkflowRouteResolver } from "./postgres-workflow-run-admission.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  admissionApplication,
  admissionActor,
  admissionCommand,
  admissionRoute,
  admissionVersion,
} from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

export async function postgresWorkflowAdmissionFixture(
  t: TestContext,
  options: { asset?: ReturnType<typeof admissionVersion> } = {},
) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const schema = `workflow_admit_${randomUUID().replaceAll("-", "_")}`;
  const sql = `"${schema}"`;
  const admin = new Pool({ connectionString });
  const stores: PostgresDomainStore[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    try {
      await admin.query(`DROP SCHEMA ${sql} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const open = async () => {
    const store = await PostgresDomainStore.open({ connectionString, schema });
    stores.push(store);
    return store;
  };
  const store = await open();
  await seedThread(store);
  const versions = store.workflowVersionStore(workflowAdmissionDigest);
  await versions.migrate();
  const asset = options.asset ?? admissionVersion();
  await versions.registerWorkflowVersion(asset);
  let routeCalls = 0,
    prepareCalls = 0;
  let route: PostgresWorkflowRouteResolver = () => admissionRoute;
  let modify = (value: ReturnType<CommitWorkflowRunStartInput["prepare"]>) =>
    value;
  let lastInput: CommitWorkflowRunStartInput | null = null;
  const adapter = store.experimentalWorkflowRunAdmissionStore((input) => {
    routeCalls++;
    return route(input);
  });
  await adapter.migrate();
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
  const tables = [
    "run_snapshots",
    "run_events",
    "run_thread_bindings",
    "work_items",
    "outbox",
    "idempotency_receipts",
    "workflow_run_inputs",
    "workflow_run_admissions",
  ] as const;
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          Number(
            (await admin.query(`SELECT count(*) AS n FROM ${sql}.${table}`))
              .rows[0].n,
          ),
        ]),
      ),
    );
  assert.ok(Object.values(await counts()).every((n) => n === 0));
  return {
    store,
    adapter,
    admin,
    schema,
    sql,
    asset,
    open,
    counts,
    start: (command = admissionCommand, actor = admissionActor) =>
      service.app.startWorkflowRun(actor, command),
    callbacks: () => ({ routeCalls, prepareCalls, ids: service.ids() }),
    lastInput: () => {
      assert.ok(lastInput);
      return lastInput;
    },
    route: (value: PostgresWorkflowRouteResolver) => {
      route = value;
    },
    modify: (value: typeof modify) => {
      modify = value;
    },
  };
}
