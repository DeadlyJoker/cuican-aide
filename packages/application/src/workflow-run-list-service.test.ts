import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowRunListApplicationService } from "./workflow-run-list-service.ts";
import { parseWorkflowRunListQuery } from "@crewon/contracts";
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "actor",
  principalId: "principal",
};
const query = parseWorkflowRunListQuery({ workflowVersionId: "version" });
test("root discovery captures actor/query and checks scope and each root without inventing a global Run grant", async () => {
  const mutable = { ...actor },
    input = { ...query };
  const calls: {
    action: string;
    runId?: string | null;
    threadId?: string | null;
  }[] = [];
  const service = new WorkflowRunListApplicationService({
    authorization: {
      async authorize(request) {
        await Promise.resolve();
        assert.deepEqual(request.actor, actor);
        calls.push({
          action: request.action,
          ...("runId" in request.resource
            ? { runId: request.resource.runId }
            : {}),
          ...("threadId" in request.resource
            ? { threadId: request.resource.threadId }
            : {}),
        });
        return { outcome: "allow" };
      },
    },
    store: {
      async listWorkflowRuns(value) {
        assert.equal(value.tenantId, actor.tenantId);
        assert.equal(value.query.workflowVersionId, "version");
        await value.authorizeRun({ runId: "root", threadId: "thread" });
        await value.authorizeScope();
        return { data: [], nextCursor: null };
      },
    },
  });
  const pending = service.listRuns(mutable, input);
  mutable.tenantId = "foreign";
  input.workflowVersionId = "changed";
  assert.deepEqual(await pending, { data: [], nextCursor: null });
  assert.deepEqual(
    calls.map((c) => c.action),
    [
      "workflowVersion:read",
      "thread:read",
      "thread:read",
      "run:read",
      "workflowVersion:read",
      "thread:read",
    ],
  );
  assert.ok(
    calls
      .filter((c) => c.action === "run:read")
      .every((c) => c.runId === "root" && c.threadId === "thread"),
  );
});
test("denied discovery does not access Store and revoked per-root grants refuse the entire page", async () => {
  let reads = 0;
  let denied = "workflowVersion:read";
  const service = new WorkflowRunListApplicationService({
    authorization: {
      async authorize(request) {
        return request.action === denied
          ? { outcome: "deny", reasonCode: "revoked" }
          : { outcome: "allow" };
      },
    },
    store: {
      async listWorkflowRuns(value) {
        reads++;
        await value.authorizeRun({ runId: "root", threadId: "thread" });
        return { data: [], nextCursor: null };
      },
    },
  });
  await assert.rejects(service.listRuns(actor, query), {
    category: "authorization",
  });
  assert.equal(reads, 0);
  denied = "run:read";
  await assert.rejects(service.listRuns(actor, query), {
    category: "authorization",
  });
  assert.equal(reads, 1);
});
test("root discovery refuses malformed actor/query accessors before policy or database calls", async () => {
  let calls = 0,
    hooks = 0;
  const service = new WorkflowRunListApplicationService({
    authorization: {
      async authorize() {
        calls++;
        return { outcome: "allow" };
      },
    },
    store: {
      async listWorkflowRuns() {
        calls++;
        return { data: [], nextCursor: null };
      },
    },
  });
  await assert.rejects(
    service.listRuns(
      {
        ...actor,
        get tenantId() {
          hooks++;
          return "tenant";
        },
      },
      query,
    ),
  );
  await assert.rejects(
    service.listRuns(actor, {
      ...query,
      get limit() {
        hooks++;
        return 20;
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(hooks, 0);
});
