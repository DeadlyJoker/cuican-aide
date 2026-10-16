import assert from "node:assert/strict";
import test from "node:test";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import type { WorkflowDeploymentConfiguration } from "@crewon/application";

function configuration(
  route: WorkflowDeploymentConfiguration["route"],
): WorkflowDeploymentConfiguration {
  return {
    schemaVersion: "crewon.workflow-deployment.v1",
    issuer: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      actorId: "actor-1",
      principalId: "principal-1",
    },
    route,
    allowedAgentVersionIds: [route.agentVersionId],
    maximumParallelNodes: 2,
    humanGates: [],
  };
}
test("SQLite refuses explicit PostgreSQL Workflow execution and joins every owned startup resource", async (t) => {
  const f = compositionFixture(t, "sqlite");
  await f.activate();
  f.observeStoreClose();
  await assert.rejects(f.create({ workflow: configuration(f.config.route) }), {
    message: "workflow_deployment_requires_postgres",
  });
  assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
});
test("invalid Workflow deployment capture fails before Store open and still disposes owned tools and model transport", async (t) => {
  const f = compositionFixture(t, "sqlite");
  f.observeStoreClose();
  await assert.rejects(
    f.create({
      workflow: { ...configuration(f.config.route), maximumParallelNodes: 5 },
    }),
    { code: "workflow_deployment_configuration_invalid" },
  );
  assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 0 });
});
