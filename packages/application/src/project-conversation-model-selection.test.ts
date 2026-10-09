import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { conversationFixture } from "../../store/src/project-conversation-store.test-support.ts";
import {
  releaseBundle,
  releaseActivation,
} from "../../store/src/agent-version-release-store-conformance.test-support.ts";
import {
  target as originalTarget,
  timestamp,
} from "../../store/src/extension-store.test-support.ts";
import type { ExtensionStore } from "./extension-store-port.ts";

/** Real SQL Turn/Run transaction; model readiness and selection policy are named offline boundaries. */
async function fixture(
  t: Parameters<typeof conversationFixture>[0],
  backend: "sqlite" | "postgres",
) {
  const f = await conversationFixture(t, backend);
  const modelTarget = {
    ...originalTarget,
    agentVersionId: "selected-model-agent",
    authorityId: "authority-selected-model-agent",
    materializationDigest: `sha256:${"2".repeat(64)}`,
  };
  await f.parent.registerAgentVersion({
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: f.actor.tenantId,
    agentVersionId: modelTarget.agentVersionId,
    contentDigest: modelTarget.agentVersionContentDigest,
    createdAt: timestamp,
    definitionJson: JSON.stringify({
      schemaVersion: "crewon.agent-version.v0",
      agentVersionId: modelTarget.agentVersionId,
      runtimeGeneration: modelTarget.runtimeGeneration,
      policySnapshotId: modelTarget.policySnapshotId,
    }),
  });
  const bundle = releaseBundle("d", [
    originalTarget.agentVersionId,
    modelTarget.agentVersionId,
  ]);
  await f.parent.activateAgentVersionRelease({
    bundle,
    activation: releaseActivation(
      bundle,
      "model-release",
      `sha256:${"c".repeat(64)}`,
    ),
    expectedActiveReleaseId: `sha256:${"c".repeat(64)}`,
  });
  const model = { live: true, preparations: 0 };
  const assertActive = () => {
    if (!model.live) throw new Error("named_model_owner_withdrawn");
  };
  const create = (
    options: {
      unavailable?: boolean;
      copyGrant?: boolean;
      omitGrant?: boolean;
    } = {},
  ) => {
    const extensions = new Proxy(f.first.store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (
          key === "commitExtensionTurn" &&
          (options.copyGrant || options.omitGrant)
        )
          return (
            input: Parameters<ExtensionStore["commitExtensionTurn"]>[0],
            commit: Parameters<ExtensionStore["commitExtensionTurn"]>[1],
          ) => {
            const { pluginModelSelection, ...rest } = commit!;
            return target.commitExtensionTurn(
              input,
              options.omitGrant
                ? rest
                : {
                    ...rest,
                    pluginModelSelection: { ...pluginModelSelection! },
                  },
            );
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const tasks = new ExtensionTaskApplicationService({
      ...f.dependencies,
      store: f.parent,
      extensions,
      operations: f.operations,
      ids: { nextId: () => randomUUID() },
      host: {
        ...f.dependencies.host,
        taskAdmissionMode: () => "installed",
        async evaluate(input) {
          return {
            outcome: "ready",
            target:
              input.agentVersionId === modelTarget.agentVersionId
                ? modelTarget
                : originalTarget,
          };
        },
      },
      unmeteredTasks: {
        async prepareGeneration() {
          return f.originalTaskFixture.authority;
        },
      },
      ...(options.unavailable
        ? {}
        : {
            modelSelection: {
              async prepareModel(input) {
                model.preparations++;
                assert.equal(input.modelId, "gpt-5.6-sol");
                assert.deepEqual(input.pin, f.authority.pin);
                return {
                  modelId: input.modelId,
                  target: modelTarget,
                  assertActive,
                  async assertCurrent() {
                    assertActive();
                  },
                };
              },
            },
          }),
    });
    return new ProjectConversationApplicationService({
      conversations: f.store,
      threads: f.threads,
      threadStore: f.parent,
      projects: f.metadata,
      texts: f.parent.projectTextStore(),
      tasks,
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
      clock: f.dependencies.clock,
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
    });
  };
  await f.parent.projectTextStore().migrate();
  const app = create();
  const created = await app.createConversation(
    f.actor,
    {
      projectId: f.reference.projectId,
      workspaceId: "original-project-workspace",
      title: "模型选择",
      idempotencyKey: "model-conversation",
    },
    f.authority,
  );
  const input = {
    projectId: f.reference.projectId,
    threadId: created.binding.threadId,
    expectedThreadRevision: 1,
    expectedBindingRevision: 1,
    content: "整理人物动机",
    stage: { kind: "discussion" as const },
    idempotencyKey: "selected-model-turn",
    modelId: "gpt-5.6-sol",
  };
  return { ...f, app, create, model, modelTarget, input };
}
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: selected project model creates one original Run and cold replay never resolves or replaces its model`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const result = await f.app.startProjectTurn(
        f.actor,
        f.input,
        f.authority,
      );
      assert.deepEqual(result.result.binding.target, f.modelTarget);
      assert.equal(result.result.turn.messages[0]!.content, f.input.content);
      assert.equal(
        result.result.turn.threadState.workspaceId,
        "original-project-workspace",
      );
      assert.equal(
        result.result.turn.runState.agentVersionId,
        f.modelTarget.agentVersionId,
      );
      assert.equal(f.model.preparations, 1);
      const activation = await f.first.store.loadExtensionActivation(
        result.result.binding,
      );
      assert.deepEqual(activation!.target, originalTarget);
      f.model.live = false;
      const replay = await f
        .create({ unavailable: true })
        .startProjectTurn(f.actor, f.input, f.authority);
      assert.equal(replay.result.run.disposition, "replayed");
      assert.deepEqual(replay.result.binding, result.result.binding);
      assert.equal(f.model.preparations, 1);
      await assert.rejects(
        f
          .create({ unavailable: true })
          .startProjectTurn(
            f.actor,
            { ...f.input, modelId: "gpt-5.6-luna" },
            f.authority,
          ),
      );
      assert.equal(
        (await f.parent.loadThreadInSpace({
          ...f.actor,
          threadId: f.input.threadId,
        }))!.revision,
        2,
      );
    },
  );
  for (const failure of ["copyGrant", "omitGrant", "withdraw"] as const)
    test(
      `${backend}: ${failure} cannot admit an alternate project model or leave a partial Turn`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        if (failure === "withdraw")
          f.state.beforeTransaction = () => {
            f.model.live = false;
          };
        const app =
          failure === "withdraw" ? f.app : f.create({ [failure]: true });
        await assert.rejects(
          app.startProjectTurn(f.actor, f.input, f.authority),
        );
        assert.equal(
          (await f.parent.loadThreadInSpace({
            ...f.actor,
            threadId: f.input.threadId,
          }))!.revision,
          1,
        );
        const { modelId: _model, ...legacy } = f.input;
        const result = await f
          .create({ unavailable: true })
          .startProjectTurn(f.actor, legacy, f.authority);
        assert.deepEqual(result.result.binding.target, originalTarget);
      },
    );
}
