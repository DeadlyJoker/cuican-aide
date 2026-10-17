import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ApplicationError } from "@crewon/application";
import { WORKFLOW_RECOVERY_CONTEXT_HEADER } from "@crewon/contracts";
import {
  WorkflowRecoveryContext,
  assertWorkflowRecoveryContext,
} from "./workflow-recovery-context.ts";
import { registerWorkflowControlRoutes } from "./workflow-control-routes.ts";
import { registerWorkflowStartRoute } from "./workflow-start-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import { prepareWorkflowControl } from "./workflow-deployment-composition.ts";
import { registerRunCancellationRoutes } from "./run-cancellation-routes.ts";
import type { WorkflowDeploymentConfiguration } from "@crewon/application";
function fixture() {
  const actor = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "actor-1",
    principalId: "principal-1",
  };
  const configuration = {
    schemaVersion: "crewon.workflow-deployment.v1" as const,
    issuer: actor,
    route: {
      authorityId: "authority-1",
      agentVersionId: "agent-1",
      runtimeGeneration: "runtime-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null as string | null,
    },
    allowedAgentVersionIds: ["agent-1"],
    maximumParallelNodes: 2,
    humanGates: [],
  };
  return { actor, configuration };
}
test("Control composition captures one policy for both execution and recovery before asynchronous migration", async () => {
  const f = fixture(),
    actor = { ...f.actor };
  let seen: WorkflowDeploymentConfiguration | undefined;
  const store = {
    workflowDeployment(configuration: WorkflowDeploymentConfiguration) {
      seen = configuration;
      return {
        migrate: async () => {
          f.configuration.route.policySnapshotId = "changed-during-migrate";
          f.configuration.issuer.actorId = "changed-during-migrate";
        },
      };
    },
  } as unknown as Parameters<typeof prepareWorkflowControl>[0]["store"];
  const expected = new WorkflowRecoveryContext({
    configuration: f.configuration,
    namespace: "one",
  }).read(actor);
  const result = await prepareWorkflowControl({
    store,
    configuration: f.configuration,
    actor,
    defaultAgentVersionId: "agent-1",
    namespace: "one",
  });
  assert.ok(seen);
  assert.ok(Object.isFrozen(seen));
  assert.equal(seen.route.policySnapshotId, "policy-1");
  assert.equal(seen.issuer.actorId, "actor-1");
  assert.equal(result!.recovery.read(actor), expected);
});
test("recovery context is deterministic after restart and separates every actual Actor field and deployment policy", () => {
  const f = fixture(),
    original = new WorkflowRecoveryContext({ ...f, namespace: "one" });
  const context = original.read(f.actor);
  assert.equal(
    new WorkflowRecoveryContext({ ...f, namespace: "one" }).read(f.actor),
    context,
  );
  for (const key of ["tenantId", "spaceId", "actorId", "principalId"] as const)
    assert.notEqual(original.read({ ...f.actor, [key]: "other" }), context);
  assert.notEqual(
    new WorkflowRecoveryContext({ ...f, namespace: "two" }).read(f.actor),
    context,
  );
  for (const key of [
    "authorityId",
    "agentVersionId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ] as const) {
    const configuration = {
      ...f.configuration,
      route: { ...f.configuration.route, [key]: "other" },
      allowedAgentVersionIds: ["agent-1", "other"],
    };
    assert.notEqual(
      new WorkflowRecoveryContext({ configuration, namespace: "one" }).read(
        f.actor,
      ),
      context,
    );
  }
  f.configuration.route.policySnapshotId = "changed";
  f.actor.actorId = "changed";
  assert.equal(
    original.read({ ...f.actor, actorId: "actor-1" }),
    context,
    "configuration and issuer were captured before caller mutation",
  );
});
test("optional guard never authorizes a mutation and refuses malformed, changed or uncomposed contexts", () => {
  const f = fixture(),
    context = new WorkflowRecoveryContext({ ...f, namespace: "one" }),
    expected = context.read(f.actor);
  assert.doesNotThrow(() =>
    assertWorkflowRecoveryContext({
      context: undefined,
      actor: f.actor,
      expected: undefined,
    }),
  );
  assert.doesNotThrow(() =>
    assertWorkflowRecoveryContext({ context, actor: f.actor, expected }),
  );
  assert.throws(
    () =>
      assertWorkflowRecoveryContext({
        context: undefined,
        actor: f.actor,
        expected,
      }),
    { code: "workflow_recovery_context_unavailable" },
  );
  assert.throws(
    () =>
      assertWorkflowRecoveryContext({
        context,
        actor: { ...f.actor, principalId: "other" },
        expected,
      }),
    { code: "workflow_recovery_context_changed" },
  );
  assert.throws(
    () =>
      assertWorkflowRecoveryContext({
        context,
        actor: f.actor,
        expected: [expected],
      }),
    { code: "workflow_recovery_context_invalid" },
  );
  let accessed = 0;
  assert.throws(
    () =>
      context.read({
        ...f.actor,
        get principalId() {
          accessed++;
          return "principal-1";
        },
      }),
    { code: "workflow_recovery_actor_invalid" },
  );
  assert.equal(accessed, 0);
});
test("Workflow HTTP guards resolve the actual request Actor and reject before admission or gate replay; old omission stays compatible", async (t) => {
  const f = fixture(),
    context = new WorkflowRecoveryContext({ ...f, namespace: "one" });
  const original = context.read(f.actor);
  let actor = { ...f.actor },
    writes = 0;
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    void reply.code(result.statusCode).send(result.body);
  });
  const mutate = async () => {
    writes++;
    throw new ApplicationError(
      "validation",
      "fixture_reached_business_service",
    );
  };
  const dependencies = {
    outboxWakeup: { wake: async () => {} },
    identity: { resolveActor: async () => actor },
    workflowRecoveryContext: context,
    workflowRuns: { startWorkflowRun: mutate },
    application: { transitionRun: mutate },
    workflowHumanGates: { getGate: mutate, decideGate: mutate },
    workflowHumanGateReviews: { getReview: mutate, reviewGate: mutate },
  };
  registerWorkflowControlRoutes(app, dependencies);
  registerWorkflowStartRoute(app, dependencies);
  registerRunCancellationRoutes(app, dependencies);
  const capability = await app.inject({
    method: "GET",
    url: "/api/v1/capabilities/workflow-recovery-context-v1",
  });
  assert.equal(capability.statusCode, 200);
  assert.equal(capability.headers["cache-control"], "no-store");
  assert.deepEqual(capability.json(), { version: "v1", contextId: original });
  assert.equal(writes, 0);
  const requests = [
    { url: "/api/v1/runs/run-1:cancel", payload: { expectedRevision: 1 } },
    {
      url: "/api/v1/workflow-runs",
      payload: {
        workflowVersionId: "version-1",
        threadId: "thread-1",
        input: { prompt: "safe" },
      },
    },
    ...["decisions", "review-v1"].map((suffix) => ({
      url: `/api/v1/workflow-runs/run-1/nodes/node-1/gates/gate-1/${suffix}`,
      payload: {
        inputDigest: `sha256:${"a".repeat(64)}`,
        decision: "approved",
        ...(suffix === "review-v1" ? { comment: null } : {}),
      },
    })),
  ];
  actor = { ...actor, principalId: "other" };
  for (const request of requests) {
    const response = await app.inject({
      method: "POST",
      ...request,
      headers: {
        [WORKFLOW_RECOVERY_CONTEXT_HEADER]: original,
        "idempotency-key": "same-key",
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(
      response.json().error.code,
      "workflow_recovery_context_changed",
    );
    assert.equal(writes, 0);
    const malformed = await app.inject({
      method: "POST",
      ...request,
      headers: {
        [WORKFLOW_RECOVERY_CONTEXT_HEADER]: [original, original],
        "idempotency-key": "same-key",
      },
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assert.equal(writes, 0);
  }
  actor = { ...f.actor };
  const aliases = requests.map((request) => ({
    ...request,
    url:
      request.url === "/api/v1/workflow-runs"
        ? "/api/v1/workflow-runs:admit-v1"
        : request.url.endsWith("/review-v1")
          ? request.url.replace(/review-v1$/u, "review-guarded-v1")
          : request.url + "-guarded-v1",
  }));
  for (const request of aliases) {
    const response = await app.inject({
      method: "POST",
      ...request,
      headers: { "idempotency-key": "same-key" },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(
      response.json().error.code,
      "workflow_recovery_context_invalid",
    );
    assert.equal(writes, 0);
  }
  for (const request of requests)
    for (const pinned of [false, true]) {
      const response = await app.inject({
        method: "POST",
        ...request,
        headers: {
          ...(pinned ? { [WORKFLOW_RECOVERY_CONTEXT_HEADER]: original } : {}),
          "idempotency-key": "same-key",
        },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(
        response.json().error.code,
        "fixture_reached_business_service",
      );
    }
  assert.equal(writes, 8);
});
