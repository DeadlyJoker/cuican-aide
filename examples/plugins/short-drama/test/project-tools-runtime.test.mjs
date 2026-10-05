import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "14.0.0";
const plugin = (
  await import(
    process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR
      ? pathToFileURL(
          join(process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR, "node.mjs"),
        ).href
      : `../dist/${version}/node.mjs`
  )
).default;
const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
const sha = (value) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
const tool = (op) => "crewon_short_drama__" + op;
/** Explicit unit business/I/O ports; authorization and durable commits are verified by the real Worker integration. */
function fixture() {
  let factory;
  let writes = 0;
  const projects = {
    async listProjects() {
      return { projects: [], next: null };
    },
    async createProject() {
      writes++;
      return { project: { projectId: "unit-project" } };
    },
  };
  plugin.setup({
    identity: {
      pluginId: "crewon.short-drama",
      version,
      packageDigest: sha("package"),
    },
    services: {
      getOptional(service) {
        return service === "crewon.project-tools"
          ? projects
          : service === "crewon.execution"
            ? {
                register(value) {
                  factory = value;
                  return { dispose() {} };
                },
              }
            : undefined;
      },
      provide() {
        return { dispose() {} };
      },
    },
    onDispose() {},
  });
  assert.equal(factory.requiredServices, undefined);
  const ctx = {
    identity: {
      pluginId: "crewon.short-drama",
      version,
      packageDigest: sha("package"),
    },
    scope: {
      tenantId: "unit-tenant",
      spaceId: "unit-space",
      profileId: "unit-profile",
    },
    run: {
      runId: "unit-run",
      threadId: "unit-thread",
      bindingDigest: sha("binding"),
      inputDigest: sha("input"),
      source: null,
    },
    configuration: {
      revision: 1,
      contentDigest: sha("config"),
      parameters: {
        baseUrl: "https://unit-no-network.example/",
        preset: "krea2-portrait",
      },
      credentialBindings: [],
    },
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "unit-agent",
      agentVersionContentDigest: sha("agent"),
      materializationDigest: sha("material"),
      authorityId: "unit-authority",
      runtimeGeneration: "unit-generation",
      policySnapshotId: "unit-policy",
      workspaceBindingId: null,
    },
  };
  const ops = new Map();
  const services = {
    approvalRequirement: "none",
    externalOperations: {
      async reserve({ command, operationId, request }) {
        const operation = {
          schemaVersion: "crewon.external-operation.v0",
          tenantId: ctx.scope.tenantId,
          runId: ctx.run.runId,
          bindingDigest: ctx.run.bindingDigest,
          operationId,
          executionId: command.executionId,
          idempotencyKey: command.idempotencyKey,
          actionDigest: command.actionDigest,
          requestDigest: sha(canonical(request)),
          correlationId: operationId,
          providerOperationId: null,
          status: "submitting",
          resultJson: null,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        ops.set(operationId, operation);
        return {
          disposition: "created",
          operation,
          dispatchRef: "unit-dispatch",
        };
      },
      async load({ operationId }) {
        return ops.get(operationId) ?? null;
      },
      async advance({ operationId, expectedRevision, ...fields }) {
        const current = ops.get(operationId);
        assert.equal(current.revision, expectedRevision);
        const operation = {
          ...current,
          ...fields,
          revision: current.revision + 1,
        };
        ops.set(operationId, operation);
        return { disposition: "updated", operation };
      },
    },
    jsonHttp: {
      async request() {
        return {
          prompt_id: "11111111-1111-1111-1111-111111111111",
          node_errors: {},
        };
      },
    },
  };
  const runtime = factory.create(ctx, services);
  function command(operation, input, index) {
    const name = tool(operation),
      body = JSON.stringify(input),
      policy = runtime.executionPolicy("function", name);
    const actionIntent = {
      schemaVersion: "crewon.action-intent.v0",
      runId: ctx.run.runId,
      segmentId: "unit-segment",
      callId: "unit-call-" + index,
      tool: { kind: "function", name, inputDigest: sha(body) },
      policySnapshotId: ctx.target.policySnapshotId,
      workspaceBindingId: null,
      ...policy,
    };
    return {
      schemaVersion: "crewon.tool-invocation.v0",
      executionId: "unit-execution-" + index,
      idempotencyKey: "unit-key-" + index,
      runId: ctx.run.runId,
      segmentId: actionIntent.segmentId,
      callId: actionIntent.callId,
      kind: "function",
      name,
      input: body,
      actionDigest: sha(canonical(actionIntent)),
      actionIntent,
      executionLease: {
        workItemId: "unit-work",
        stepId: "unit-step",
        attemptId: "unit-attempt",
        leaseId: "unit-lease",
        leaseEpoch: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      approvalProof: null,
    };
  }
  return { runtime, command, writes: () => writes };
}
test("Short13 catalog includes stage and original media tools with model schemas and effects", () => {
  const f = fixture();
  assert.equal(f.runtime.definitions().length, 14);
  const list = f.runtime
    .definitions()
    .find((t) => t.name === tool("project_list"));
  assert.deepEqual(list.inputSchema.required, ["limit", "state"]);
  assert.equal(list.inputSchema.properties.state.enum.includes("all"), true);
  const save = f.runtime
    .definitions()
    .find((t) => t.name === tool("script_save"));
  assert.equal(save.inputSchema.required.includes("outline"), false);
  assert.equal("enum" in save.inputSchema.properties.projectId, false);
  assert.equal(
    f.runtime.executionPolicy("function", tool("project_create")).capability,
    "project.write",
  );
  assert.equal(
    f.runtime.executionPolicy("function", tool("submit")).capability,
    "extension.image.generate",
  );
});
test("cold mutation cancellation stays unknown and does not call a second write", async () => {
  const f = fixture();
  const resolution = await f.runtime.cancel(
    f.command("project_create", { title: "unit", briefText: "idea" }, 1),
    new AbortController().signal,
  );
  assert.equal(resolution.status, "unknownOutcome");
  assert.equal(f.writes(), 0);
  await f.runtime.close();
});
test("limit-one maintenance scans rotate both project and media retained results", async () => {
  const f = fixture();
  await f.runtime.execute(
    f.command("project_list", { state: "all", limit: 1 }, 1),
    new AbortController().signal,
  );
  await f.runtime.execute(
    f.command("submit", { prompt: "写实人物照片" }, 2),
    new AbortController().signal,
  );
  const first = f.runtime.scanRetainedExecutionResults({ limit: 1 });
  const second = f.runtime.scanRetainedExecutionResults({ limit: 1 });
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].executionId, second[0].executionId);
  assert.deepEqual(
    new Set([first[0].executionId, second[0].executionId]),
    new Set(["unit-execution-1", "unit-execution-2"]),
  );
  await f.runtime.close();
});
