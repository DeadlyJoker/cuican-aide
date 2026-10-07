import test from "node:test";
import assert from "node:assert/strict";
import type { PluginProjectContextService } from "@crewon/contracts/project-context";
import type { ProjectStageRunAdmission } from "@crewon/domain";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { readProjectStageRuntimeScope } from "./plugins/project-stage-runtime-scope.ts";
import { assertProjectTextStageDispatch } from "./plugins/project-stage-dispatch-scope.ts";
import { deferred, tick } from "./plugin-tool-runtime-adapter.test-support.ts";

async function scopedFixture(
  t: Parameters<typeof projectToolsOwnerFixture>[0],
) {
  let stage: ProjectStageRunAdmission | undefined,
    conversations: Awaited<ReturnType<typeof conversationFixture>> | undefined;
  const f = await projectToolsOwnerFixture(t, {
    prepareAdmission: async (base) => {
      conversations = await conversationFixture(t, "sqlite", base);
      const c = conversations,
        p = await c.prepare();
      await c.store.commitBinding(p, { authority: c.authority });
      const brief = await c.metadata.loadBrief({
        owner: {
          tenantId: c.actor.tenantId,
          spaceId: c.actor.spaceId,
          principalId: c.actor.principalId,
        },
        projectId: c.reference.projectId,
        briefRevision: 1,
      });
      assert.ok(brief);
      const content = "Write an outline candidate only";
      const started = await c.tasks.createProjectConversationTurnFromHost(
        c.actor,
        {
          pluginId: c.pin.pluginId,
          threadId: p.binding.threadId,
          expectedThreadRevision: 1,
          idempotencyKey: "genuine-outline-stage",
          intent: { kind: "generate", input: { prompt: content } },
        },
        {
          binding: p.binding,
          stage: { kind: "outline", briefRevision: 1 },
          sources: {
            brief: { briefRevision: 1, contentDigest: brief.contentDigest },
            outline: null,
          },
          content,
          authority: c.authority,
          conversations: c.store,
        },
      );
      stage = started.stageAdmission;
      return started.result;
    },
    stageAdmission: () => stage,
  });
  assert.ok(stage);
  assert.ok(conversations);
  const contextService = (owner: ReturnType<typeof f.owner>) =>
    owner.contextHostService().value as PluginProjectContextService;
  return { ...f, stage, conversations, contextService };
}

test("text stages allow only the declared empty read-only asset scope probe, never asset access", async (t) => {
  const f = await scopedFixture(t);
  const base = f.tools.find((tool) => tool.operationId === "project_read")!;
  const probe = {
    ...base,
    operationId: "asset_context_read",
    adapterId: "crewon.project-asset-context",
  };
  const operation = await f.prepareReadOperation("asset_context_read", {});
  const check = (command = operation.command, definition = probe) =>
    assertProjectTextStageDispatch(
      f.stage,
      [...f.tools, definition],
      f.admission.pluginId,
      command,
    );
  assert.doesNotThrow(() => check());
  for (const input of ["null", "[]", '{"projectId":"foreign"}'])
    assert.throws(
      () => check({ ...operation.command, input }),
      /authority_denied/,
    );
  assert.throws(
    () => check(operation.command, { ...probe, adapterId: "unrelated" }),
    /authority_denied/,
  );
  assert.throws(
    () =>
      check({
        ...operation.command,
        actionIntent: { ...operation.command.actionIntent, effect: "mutation" },
      }),
    /authority_denied/,
  );
  assert.throws(
    () => check(operation.command, { ...probe, effect: "mutation" }),
    /authority_denied/,
  );
});

test("actual immutable stage plus independent original-admission marker is required; genuine legacy is null", async (t) => {
  const f = await scopedFixture(t),
    signal = new AbortController().signal;
  const read = {
    conversations: f.conversations.store,
    admission: f.admission,
    binding: f.binding,
    signal,
  };
  assert.deepEqual(await readProjectStageRuntimeScope(read), f.stage);
  await assert.rejects(
    readProjectStageRuntimeScope({
      ...read,
      conversations: {
        readRequiredStageDigest: () =>
          f.conversations.store.readRequiredStageDigest({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            runId: f.admission.runId,
          }),
        loadStageAdmission: async () => null,
      },
    }),
    /project_stage_missing/,
  );
  await assert.rejects(
    readProjectStageRuntimeScope({
      ...read,
      conversations: {
        readRequiredStageDigest: async () => null,
        loadStageAdmission: async () => f.stage,
      },
    }),
    /project_stage_mismatch/,
  );
  const legacy = await projectToolsOwnerFixture(t);
  assert.equal(
    await readProjectStageRuntimeScope({
      conversations: legacy.parent.projectConversationStore(),
      admission: legacy.admission,
      binding: legacy.binding,
      signal,
    }),
    null,
  );
});

test("genuine scoped command reads bounded context; setup, copied command and revoked lease cannot borrow it", async (t) => {
  const f = await scopedFixture(t),
    owner = f.owner(),
    service = f.contextService(owner),
    operation = await f.prepareRead("readProject", {
      projectId: f.stage.projectId,
    });
  await assert.rejects(
    service.readScope({ command: operation.command }),
    /authority_denied/,
  );
  await assert.rejects(
    f.invoke(owner, operation, (command) => service.readScope({ command }), {
      copied: true,
    }),
    /authority_denied/,
  );
  const first = await f.invoke(owner, operation, (command) =>
    service.readScope({ command }),
  );
  assert.equal(first.scope?.projectId, f.stage.projectId);
  assert.equal(first.scope?.runId, f.admission.runId);
  assert.equal(first.scope?.stage.kind, "outline");
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 8192);
  const expired = f.owner({
    now: () => new Date(Date.parse(operation.claim.lease.expiresAt) + 1),
  });
  await assert.rejects(
    f.invoke(expired, operation, (command) =>
      f.contextService(expired).readScope({ command }),
    ),
    /authority_denied/,
  );
  await owner.close();
  const cold = f.owner();
  assert.deepEqual(
    await f.invoke(
      cold,
      operation,
      (command) => f.contextService(cold).readScope({ command }),
      { method: "reconcile" },
    ),
    first,
  );
});

test("stage authority denies media, cross-project writes and manual selection before runtime delegate", async (t) => {
  const f = await scopedFixture(t),
    base = f.tools[0]!;
  const owner = f.owner({
    tools: [
      ...f.tools,
      {
        ...base,
        operationId: "image_generate",
        effect: "readOnly",
        recovery: "replaySafe",
        capability: "project.read",
      },
    ],
  });
  let delegates = 0;
  const media = await f.prepareReadOperation("image_generate", {});
  await assert.rejects(
    f.invoke(owner, media, async () => {
      delegates++;
    }),
    /project_stage_admission_invalid|authority_denied/,
  );
  const foreign = await f.prepareRead("readProject", {
    projectId: "foreign-project",
  });
  await assert.rejects(
    f.invoke(owner, foreign, async () => {
      delegates++;
    }),
    /project_stage_admission_invalid|authority_denied/,
  );
  const select = await f.prepareOperation("text_select", {
    projectId: f.stage.projectId,
    artifactId: "absent",
    expectedArtifactRevision: 1,
    contentRevision: 1,
  });
  await assert.rejects(
    f.invoke(owner, select, async () => {
      delegates++;
    }),
    /project_stage_admission_invalid|authority_denied/,
  );
  assert.equal(delegates, 0);
});

test("context read intrinsic is permitted only under real dispatch, and close joins its already-started reads", async (t) => {
  const f = await scopedFixture(t),
    base = f.tools.find((v) => v.operationId === "project_read")!;
  const owner = f.owner({
      tools: [...f.tools, { ...base, operationId: "project_context_read" }],
    }),
    operation = await f.prepareReadOperation("project_context_read", {}),
    entered = deferred(),
    physical = deferred(),
    runtime = deferred();
  f.controls.beforeCurrent = async () => {
    entered.resolve();
    await physical.promise;
  };
  const pending = f.invoke(owner, operation, async (command) => {
    const read = assert.rejects(
      f.contextService(owner).readScope({ command }),
      /authority_denied/,
    );
    await runtime.promise;
    await read;
  });
  await entered.promise;
  let joined = false;
  const closing = owner.close().then(() => {
    joined = true;
  });
  await tick();
  assert.equal(joined, false);
  physical.resolve();
  await tick();
  assert.equal(joined, false);
  runtime.resolve();
  await pending;
  await closing;
  assert.equal(joined, true);
  assert.equal(owner.canRetire(), true);
});
