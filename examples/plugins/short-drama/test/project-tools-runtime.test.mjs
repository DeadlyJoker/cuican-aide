import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.2";
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
function fixture({
  contextService = null,
  projectMethods = {},
  assetContextService = null,
  assetMethods = null,
} = {}) {
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
    ...projectMethods,
  };
  plugin.setup({
    identity: {
      pluginId: "crewon.short-drama",
      version,
      packageDigest: sha("package"),
    },
    services: {
      getOptional(service) {
        return service === "crewon.project-asset-context"
          ? assetContextService
          : service === "crewon.project-asset-tools"
            ? assetMethods
            : service === "crewon.project-context"
              ? contextService
              : service === "crewon.project-tools"
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
  assert.equal(
    f.runtime.definitions().length,
    Number(version.split(".")[0]) >= 23
      ? 24
      : Number(version.split(".")[0]) >= 21
        ? 23
        : Number(version.split(".")[0]) >= 19
          ? 21
          : Number(version.split(".")[0]) >= 16
            ? 15
            : 14,
  );
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
  if (Number(version.split(".")[0]) >= 21) {
    for (const name of ["media_submit", "media_observe"])
      assert.deepEqual(
        f.runtime.definitions().find((d) => d.name === tool(name)).inputSchema,
        {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      );
    assert.equal(
      f.runtime.executionPolicy("function", tool("media_observe")).effect,
      "readOnly",
    );
    assert.equal(
      f.runtime.executionPolicy("function", tool("media_submit")).recovery,
      "reconcilable",
    );
  }
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

const scopeFor = (stage) => ({
  projectId: "unit-project",
  threadId: "unit-thread",
  runId: "unit-run",
  bindingId: "unit-binding",
  bindingRevision: 1,
  stage,
  sources: {
    brief:
      stage.kind === "discussion"
        ? null
        : { briefRevision: stage.briefRevision, contentDigest: sha("brief") },
    outline:
      stage.kind === "script" && stage.outline
        ? { ...stage.outline, contentDigest: sha("outline") }
        : null,
  },
  allowedOperations: [
    "project_context_read",
    "project_read",
    "outline_read",
    "script_read",
    "content_read",
    "text_history",
    ...(stage.kind === "discussion"
      ? []
      : [
          stage.kind === "brief"
            ? "brief_append"
            : stage.kind === "outline"
              ? "outline_save"
              : "script_save",
        ]),
  ],
  contentDigest: sha("persisted-stage-scope"),
});
test("project_context_read returns bounded actual Run metadata and validates its empty input", async () => {
  const scope = scopeFor({ kind: "outline", briefRevision: 1 });
  const calls = [];
  const f = fixture({
    contextService: {
      async readScope(input) {
        calls.push(input.command);
        return { scope };
      },
    },
  });
  try {
    const command = f.command("project_context_read", {}, 1);
    const result = await f.runtime.execute(
      command,
      new AbortController().signal,
    );
    assert.deepEqual(JSON.parse(JSON.parse(result.result.output).resultJson), {
      scope,
    });
    assert.equal(calls[0], command);
    assert.ok(Buffer.byteLength(result.result.output) <= 8192);
    await assert.rejects(
      f.runtime.execute(
        f.command("project_context_read", { projectId: "spoofed" }, 2),
        new AbortController().signal,
      ),
      /context_input_invalid/u,
    );
    assert.equal(calls.length, 1);
    assert.equal(f.writes(), 0);
  } finally {
    await f.runtime.close();
  }
});
test("discussion stage denies writes, project discovery and media before any business effect", async () => {
  const f = fixture({
    contextService: {
      async readScope() {
        return { scope: scopeFor({ kind: "discussion" }) };
      },
    },
  });
  try {
    for (const [index, operation, input] of [
      [1, "project_create", { title: "other", briefText: "idea" }],
      [2, "project_list", { state: "all", limit: 1 }],
      [
        3,
        "brief_append",
        { projectId: "unit-project", expectedProjectRevision: 1, text: "new" },
      ],
      [4, "submit", { prompt: "人物照片" }],
    ])
      await assert.rejects(
        f.runtime.execute(
          f.command(operation, input, index),
          new AbortController().signal,
        ),
        /stage_operation_denied/u,
      );
    assert.equal(f.writes(), 0);
    assert.deepEqual(
      f.runtime.retainedExecutionResults({ runId: "unit-run", limit: 8 }),
      [],
    );
  } finally {
    await f.runtime.close();
  }
});
test("outline stage preserves the admitted project and brief while legacy null scope keeps old behavior", async () => {
  let saves = 0;
  const f = fixture({
    contextService: {
      async readScope() {
        return { scope: scopeFor({ kind: "outline", briefRevision: 1 }) };
      },
    },
    projectMethods: {
      async saveOutlineCandidate() {
        ++saves;
        return { candidate: "saved" };
      },
    },
  });
  try {
    const input = {
      projectId: "unit-project",
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: {
        title: "来信",
        logline: "过去寄来一封信。",
        synopsis: "寻找信的来源。",
        episodes: [],
      },
    };
    await assert.rejects(
      f.runtime.execute(
        f.command(
          "outline_save",
          { ...input, projectId: "foreign-project" },
          1,
        ),
        new AbortController().signal,
      ),
      /stage_project_mismatch/u,
    );
    await assert.rejects(
      f.runtime.execute(
        f.command("outline_save", { ...input, briefRevision: 2 }, 2),
        new AbortController().signal,
      ),
      /stage_source_mismatch/u,
    );
    await f.runtime.execute(
      f.command("outline_save", input, 3),
      new AbortController().signal,
    );
    assert.equal(saves, 1);
  } finally {
    await f.runtime.close();
  }
  const legacy = fixture({
    contextService: {
      async readScope() {
        return { scope: null };
      },
    },
  });
  try {
    await legacy.runtime.execute(
      legacy.command(
        "project_create",
        { title: "legacy", briefText: "idea" },
        1,
      ),
      new AbortController().signal,
    );
    assert.equal(legacy.writes(), 1);
  } finally {
    await legacy.runtime.close();
  }
});
test("script stage cannot switch episodes or its admitted outline and rejects malformed scope", async () => {
  const stage = {
    kind: "script",
    episodeId: "episode-one",
    briefRevision: 1,
    outline: { artifactId: "outline-one", contentRevision: 1 },
  };
  let scope = scopeFor(stage),
    saves = 0;
  const f = fixture({
    contextService: {
      async readScope() {
        return { scope };
      },
    },
    projectMethods: {
      async saveScriptCandidate() {
        ++saves;
        return { candidate: "saved" };
      },
    },
  });
  try {
    const input = {
      projectId: "unit-project",
      episodeId: "episode-one",
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: stage.outline,
      content: { title: "第一集", scenes: [] },
    };
    await assert.rejects(
      f.runtime.execute(
        f.command("script_save", { ...input, episodeId: "episode-two" }, 1),
        new AbortController().signal,
      ),
      /stage_episode_mismatch/u,
    );
    await assert.rejects(
      f.runtime.execute(
        f.command("script_save", { ...input, outline: null }, 2),
        new AbortController().signal,
      ),
      /stage_source_mismatch/u,
    );
    await f.runtime.execute(
      f.command("script_save", input, 3),
      new AbortController().signal,
    );
    assert.equal(saves, 1);
    scope = { ...scope, runId: "foreign-run" };
    await assert.rejects(
      f.runtime.execute(
        f.command("script_save", input, 4),
        new AbortController().signal,
      ),
      /context_scope_mismatch/u,
    );
    scope = {
      ...scopeFor(stage),
      allowedOperations: [...scopeFor(stage).allowedOperations, "submit"],
    };
    await assert.rejects(
      f.runtime.execute(
        f.command("submit", { prompt: "test" }, 5),
        new AbortController().signal,
      ),
      /project_context_invalid/u,
    );
    assert.equal(saves, 1);
  } finally {
    await f.runtime.close();
  }
});
test("runtime close joins a pending scope read and prevents subsequent business dispatch", async () => {
  let release,
    closed = false;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    contextService: {
      async readScope() {
        await held;
        return { scope: scopeFor({ kind: "discussion" }) };
      },
    },
  });
  const executing = assert.rejects(
    f.runtime.execute(
      f.command("project_read", { projectId: "unit-project" }, 1),
      new AbortController().signal,
    ),
    /runtime_closed/u,
  );
  const closing = f.runtime.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([executing, closing]);
  assert.equal(closed, true);
  assert.equal(f.writes(), 0);
});

const assetScope = {
  version: "crewon.project-asset-runtime-scope.v1",
  runId: "unit-run",
  threadId: "unit-thread",
  projectId: "unit-project",
  bindingId: "asset-binding",
  bindingRevision: 1,
  workspaceId: null,
  stage: {
    kind: "assets",
    assetKind: "character",
    briefRevision: 1,
    script: null,
  },
  sources: {
    brief: { briefRevision: 1, contentDigest: sha("brief") },
    script: null,
  },
  allowedOperations: [
    "asset_context_read",
    "asset_list",
    "asset_read",
    "asset_history",
    "asset_content_read",
    "project_read",
    "outline_read",
    "script_read",
    "content_read",
    "text_history",
    "asset_save",
  ],
  admissionDigest: sha("asset-admission"),
};
const assetCandidate = {
  projectId: "unit-project",
  kind: "character",
  expectedAssetRevision: 0,
  briefRevision: 1,
  content: {
    name: "陈遥",
    setting: "信件修复师",
    visualPrompt: "写实人物，灰色大衣",
  },
};
const assetHead = {
  projectId: "unit-project",
  assetId: "unit-asset",
  kind: "character",
  revision: 1,
  latestContentRevision: 1,
  selectedContentRevision: null,
  latestReferenceRevision: 0,
  selectedReferenceRevision: null,
  locked: false,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
};
const assetRevision = {
  projectId: "unit-project",
  assetId: "unit-asset",
  kind: "character",
  contentRevision: 1,
  brief: { briefRevision: 1, contentDigest: sha("brief") },
  script: null,
  createdAt: assetHead.createdAt,
  contentDigest: sha("content"),
};
test("asset Run reads its own actual scope and denies old writes/media or foreign kind/sources before effects", async () => {
  let writes = 0,
    scopeCalls = 0;
  const f = fixture({
    assetContextService: {
      async readScope() {
        ++scopeCalls;
        return { scope: assetScope };
      },
    },
    assetMethods: {
      async saveCandidate() {
        ++writes;
        return {
          kind: "save-content",
          disposition: "committed",
          asset: assetHead,
          contentRevision: assetRevision,
        };
      },
    },
  });
  try {
    const result = await f.runtime.execute(
      f.command("asset_context_read", {}, 1),
      new AbortController().signal,
    );
    assert.deepEqual(JSON.parse(JSON.parse(result.result.output).resultJson), {
      scope: assetScope,
    });
    for (const [i, op, body, pattern] of [
      [
        2,
        "project_create",
        { title: "new", briefText: "x" },
        /asset_stage_operation_denied/,
      ],
      [3, "submit", { prompt: "x" }, /asset_stage_operation_denied/],
      [
        4,
        "asset_save",
        { ...assetCandidate, kind: "scene" },
        /asset_stage_kind_mismatch/,
      ],
      [
        5,
        "asset_save",
        { ...assetCandidate, briefRevision: 2 },
        /asset_stage_source_mismatch/,
      ],
      [
        6,
        "asset_save",
        { ...assetCandidate, projectId: "other" },
        /asset_stage_project_mismatch/,
      ],
    ])
      await assert.rejects(
        f.runtime.execute(f.command(op, body, i), new AbortController().signal),
        pattern,
      );
    assert.equal(writes, 0);
    assert.equal(f.writes(), 0);
    assert.equal(scopeCalls, 6);
    const command = f.command("asset_save", assetCandidate, 7);
    const raw = command.input;
    const saved = await f.runtime.execute(
      command,
      new AbortController().signal,
    );
    assert.equal(writes, 1);
    assert.equal(command.input, raw);
    assert.equal(JSON.parse(raw).assetId, undefined);
    assert.equal(
      JSON.parse(JSON.parse(saved.result.output).resultJson).asset
        .selectedContentRevision,
      null,
    );
    assert.ok(Buffer.byteLength(saved.result.output) <= 8192);
  } finally {
    await f.runtime.close();
  }
});
test("corrupt asset scope never falls through to ordinary project creation; context absence only keeps legacy commands", async () => {
  const f = fixture({
    assetContextService: {
      async readScope() {
        return { scope: { ...assetScope, admissionDigest: "invented" } };
      },
    },
  });
  try {
    await assert.rejects(
      f.runtime.execute(
        f.command("project_create", { title: "x", briefText: "x" }, 1),
        new AbortController().signal,
      ),
      /protocol_invalid/,
    );
    assert.equal(f.writes(), 0);
  } finally {
    await f.runtime.close();
  }
  const legacy = fixture();
  try {
    await assert.rejects(
      legacy.runtime.execute(
        legacy.command("asset_save", assetCandidate, 1),
        new AbortController().signal,
      ),
      /asset_context_unavailable/,
    );
    assert.equal(legacy.writes(), 0);
  } finally {
    await legacy.runtime.close();
  }
});
test("asset cancellation on a cold owner stays unknown; bounded content rejects a mismatched offset", async () => {
  let writes = 0;
  const f = fixture({
    assetContextService: {
      async readScope() {
        return { scope: assetScope };
      },
    },
    assetMethods: {
      async saveCandidate() {
        ++writes;
      },
      async readContent() {
        return {
          contentDigest: sha("content"),
          format: "canonical-json",
          offset: 1,
          nextOffset: null,
          totalCodePoints: 2,
          text: "字",
        };
      },
    },
  });
  try {
    const canceled = await f.runtime.cancel(
      f.command("asset_save", assetCandidate, 1),
      new AbortController().signal,
    );
    assert.equal(canceled.status, "unknownOutcome");
    assert.equal(writes, 0);
    await assert.rejects(
      f.runtime.execute(
        f.command(
          "asset_content_read",
          {
            projectId: "unit-project",
            assetId: "unit-asset",
            contentRevision: 1,
            offset: 0,
          },
          2,
        ),
        new AbortController().signal,
      ),
      /protocol_invalid/,
    );
  } finally {
    await f.runtime.close();
  }
});
