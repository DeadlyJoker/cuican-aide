import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ApplicationError, RunStoreError } from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import {
  admissionActor,
  admissionRoute,
  admissionApplication,
  admissionCommand,
  sqliteAdmissionFixture,
} from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

const configuration = {
  schemaVersion: "crewon.workflow-deployment.v1" as const,
  issuer: admissionActor,
  route: admissionRoute,
  allowedAgentVersionIds: [admissionRoute.agentVersionId],
  maximumParallelNodes: 2,
  humanGates: [],
};
const deployment = (store: SqliteRunStore) =>
  store.workflowDeployment(
    configuration,
    () => {
      throw Error("construction must not decode an unrequested AgentVersion");
    },
    workflowAdmissionDigest,
  );

test("SQLite deployment identity survives reopen but changes when the database at the same path is replaced", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-wf-identity-"));
  const path = join(directory, "control.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new SqliteRunStore(path);
  const identity = deployment(store).identity;
  await store.close();
  store = new SqliteRunStore(path);
  assert.equal(deployment(store).identity, identity);
  await store.close();
  rmSync(path);
  store = new SqliteRunStore(path);
  try {
    assert.notEqual(deployment(store).identity, identity);
  } finally {
    await store.close();
  }
});

test("SQLite deployment fails closed on a future identity version without overwriting it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-wf-identity-corrupt-"));
  const path = join(directory, "control.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteRunStore(path);
  const db = new DatabaseSync(path);
  try {
    deployment(store);
    db.exec("UPDATE workflow_deployment_identity SET version=99");
    assert.throws(() => deployment(store), {
      code: "workflow_deployment_identity_corrupt",
    });
    assert.equal(
      db.prepare("SELECT version FROM workflow_deployment_identity").get()!
        .version,
      99,
    );
  } finally {
    db.close();
    await store.close();
  }
});

for (const mode of ["deny", "promise"] as const)
  test(`SQLite created-root ${mode} policy rolls back Run, original input, history and receipt`, async (t) => {
    const f = await sqliteAdmissionFixture(t);
    const before = f.counts();
    const store = f.store.experimentalWorkflowRunAdmissionStore(
      () => admissionRoute,
      {
        authorizeCreatedRun: () =>
          mode === "deny"
            ? { outcome: "deny", reasonCode: "withdrawn" }
            : (Promise.resolve({ outcome: "allow" }) as never),
      },
    );
    const service = admissionApplication(store);
    await assert.rejects(
      service.app.startWorkflowRun(admissionActor, admissionCommand),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "workflow_run_admission_failed" &&
        error.cause instanceof RunStoreError &&
        error.cause.code === "workflow_scheduler_policy_denied",
    );
    assert.deepEqual(f.counts(), before);
    assert.equal(
      f.database.prepare("SELECT count(*) AS n FROM model_history_items").get()!
        .n,
      0,
    );
    assert.equal(
      f.database.prepare("SELECT count(*) AS n FROM messages").get()!.n,
      0,
    );
  });
