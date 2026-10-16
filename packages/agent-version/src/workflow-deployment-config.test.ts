import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadWorkflowDeploymentEnvironment,
  WORKFLOW_DEPLOYMENT_CONFIG_ENV,
} from "./workflow-deployment-config.ts";

function fixture(t: import("node:test").TestContext) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-workflow-config-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "deployment.json");
  const actor = {
    tenantId: "tenant",
    spaceId: "space",
    actorId: "actor",
    principalId: "principal",
  };
  const configuration = {
    schemaVersion: "crewon.workflow-deployment.v1",
    issuer: actor,
    route: {
      authorityId: "authority",
      agentVersionId: "agent",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      workspaceBindingId: null,
    },
    allowedAgentVersionIds: ["agent"],
    maximumParallelNodes: 2,
    humanGates: [{ approvalPolicyId: "review", approver: actor }],
  };
  writeFileSync(path, JSON.stringify(configuration), { mode: 0o600 });
  const environment = {
    CREWON_CONTROL_DATABASE_URL: "postgres://named-fixture",
    [WORKFLOW_DEPLOYMENT_CONFIG_ENV]: path,
  };
  return { root, path, configuration, environment };
}
test("Workflow deployment is absent by default and rejects unsupported modes before reading a path", () => {
  assert.equal(loadWorkflowDeploymentEnvironment({}, "production"), undefined);
  for (const mode of ["standalone", "production"] as const)
    assert.throws(
      () =>
        loadWorkflowDeploymentEnvironment(
          { [WORKFLOW_DEPLOYMENT_CONFIG_ENV]: "/must-not-read" },
          mode,
        ),
      /workflow_deployment_requires_standalone_postgres/,
    );
  assert.throws(
    () =>
      loadWorkflowDeploymentEnvironment(
        {
          CREWON_CONTROL_DATABASE_URL: "postgres://named-fixture",
          [WORKFLOW_DEPLOYMENT_CONFIG_ENV]: "/must-not-read",
        },
        "production",
      ),
    /workflow_deployment_requires_standalone_postgres/,
  );
});
test("a private deployment is captured once and cannot change through the file or returned grant", (t) => {
  const f = fixture(t);
  const value = loadWorkflowDeploymentEnvironment(f.environment, "standalone")!;
  assert.deepEqual(value, f.configuration);
  assert.ok(Object.isFrozen(value.humanGates[0]!.approver));
  assert.throws(() => {
    (value.allowedAgentVersionIds as string[]).push("ungranted");
  });
  writeFileSync(f.path, "{}");
  assert.deepEqual(value, f.configuration);
  assert.throws(
    () => loadWorkflowDeploymentEnvironment(f.environment, "standalone"),
    /workflow_deployment_configuration_invalid/,
  );
});
test("deployment rejects public files, links, malformed UTF8, excess bytes and ambiguous paths without leaking their content", (t) => {
  const f = fixture(t);
  chmodSync(f.path, 0o644);
  assert.throws(
    () => loadWorkflowDeploymentEnvironment(f.environment, "standalone"),
    /workflow_deployment_configuration_invalid/,
  );
  chmodSync(f.path, 0o600);
  const link = join(f.root, "link.json");
  symlinkSync(f.path, link);
  assert.throws(
    () =>
      loadWorkflowDeploymentEnvironment(
        { ...f.environment, [WORKFLOW_DEPLOYMENT_CONFIG_ENV]: link },
        "standalone",
      ),
    /workflow_deployment_configuration_invalid/,
  );
  const hard = join(f.root, "hard.json");
  linkSync(f.path, hard);
  assert.throws(
    () => loadWorkflowDeploymentEnvironment(f.environment, "standalone"),
    /workflow_deployment_configuration_invalid/,
  );
  rmSync(hard);
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.alloc(256 * 1024 + 1, 0x20),
    Buffer.from('{"secret":"must-not-log"}'),
  ]) {
    writeFileSync(f.path, bytes);
    assert.throws(
      () => loadWorkflowDeploymentEnvironment(f.environment, "standalone"),
      { message: "workflow_deployment_configuration_invalid" },
    );
  }
  for (const path of [
    "relative.json",
    ` ${f.path}`,
    `${f.root}/../deployment.json`,
  ])
    assert.throws(
      () =>
        loadWorkflowDeploymentEnvironment(
          { ...f.environment, [WORKFLOW_DEPLOYMENT_CONFIG_ENV]: path },
          "standalone",
        ),
      /workflow_deployment_configuration_invalid/,
    );
});
