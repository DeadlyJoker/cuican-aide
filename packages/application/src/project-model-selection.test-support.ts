import { randomUUID } from "node:crypto";
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
import type { PluginTaskModelSelectionPort } from "./plugin-task-model-selection.ts";
import type { ExtensionStore } from "./extension-store-port.ts";

/** Real SQL Turn/Run transaction; model readiness and selection policy are named offline boundaries. */
export async function projectModelSelectionFixture(
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
  const modelPort: PluginTaskModelSelectionPort = {
    async prepareTarget(input) {
      model.preparations++;
      assert.deepEqual(input.target, modelTarget);
      assert.deepEqual(input.pin, f.authority.pin);
      assertActive();
      return {
        modelId: "gpt-5.6-sol",
        target: modelTarget,
        assertActive,
        async assertCurrent() {
          assertActive();
        },
      };
    },
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
  };
  const services = (
    options: {
      unavailable?: boolean;
      copyGrant?: boolean;
      omitGrant?: boolean;
      invalidOptionPrototype?: boolean;
      symbolOption?: boolean;
    } = {},
  ) => {
    const extensions = new Proxy(f.first.store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (
          key === "commitExtensionTurn" &&
          (options.copyGrant ||
            options.omitGrant ||
            options.invalidOptionPrototype ||
            options.symbolOption)
        )
          return (
            input: Parameters<ExtensionStore["commitExtensionTurn"]>[0],
            commit: Parameters<ExtensionStore["commitExtensionTurn"]>[1],
          ) => {
            if (options.invalidOptionPrototype) {
              return target.commitExtensionTurn(
                input,
                Object.assign(Object.create({}), commit),
              );
            }
            if (options.symbolOption) {
              return target.commitExtensionTurn(input, {
                ...commit,
                [Symbol("caller-extension")]: true,
              });
            }
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
            modelSelection: modelPort,
          }),
    });
    return {
      tasks,
      app: new ProjectConversationApplicationService({
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
      }),
    };
  };
  const create = (options: Parameters<typeof services>[0] = {}) =>
    services(options).app;
  const createTasks = (options: Parameters<typeof services>[0] = {}) =>
    services(options).tasks;
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
  return {
    ...f,
    app,
    create,
    createTasks,
    model,
    modelPort,
    modelTarget,
    input,
  };
}
