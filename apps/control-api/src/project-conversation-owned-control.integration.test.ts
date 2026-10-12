import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { pluginProjectWorkspaceIdentityInput } from "@crewon/domain";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ApplicationError,
  PluginUiApplicationService,
  ProjectConversationApplicationService,
} from "@crewon/application";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { LocalPluginUiPackageReader } from "@crewon/plugin-host";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ownedConversationSqlFixture } from "../../../packages/store/src/project-conversation-owned.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import { SqliteRunStore } from "@crewon/store";

// Original SQLite and genuinely verified installed bytes. Identity/policy are named local fixtures;
// this proves Control issuance, not HTTP, Native directory allocation or provider execution.
for (const { native, targetDeclared, executeCase } of [
  { native: false, targetDeclared: true, executeCase: false },
  { native: false, targetDeclared: true, executeCase: true },
  { native: true, targetDeclared: true, executeCase: false },
  { native: true, targetDeclared: false, executeCase: false },
])
  test(`actual Control owner stage preparation ${executeCase} target declaration ${targetDeclared} ${native ? "qualifies Native provisioning before an unavailable observer" : "qualifies installed UI project conversation reads and rejects changed bytes and identity before replay"}`, async (t) => {
    const f = await ownedConversationSqlFixture(t, "sqlite");
    const parent = f.parent;
    assert.ok(parent instanceof SqliteRunStore);
    const { source, pkg, publications } = await conversationPackage(t, {
      version: "9.0.0",
      ...(targetDeclared ? { workspaceTargetProtocol: "1" as const } : {}),
      ...(executeCase ? { projectAction: true as const } : {}),
      pluginId: f.installation.pluginId,
      publisherId: f.installation.publisherId,
    });
    const scope = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      profileId: f.installation.profileId,
    };
    const previous = (await f.installs.loadSelection({
      scope,
      pluginId: pkg.pluginId,
    }))!;
    const installed = await f.installs.recordInstalledPackage(
      installationRecipe("actual-control-package", {
        scope,
        actor: f.actor,
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        version: pkg.version,
        packageDigest: pkg.packageDigest,
        expectedSelectionRevision: previous.revision,
      }),
    );
    const selected = await f.installs.commitSelection(
      selectionRecipe(installed.selection, "actual-control-select", {
        actor: f.actor,
        packageDigest: pkg.packageDigest,
      }),
    );
    const directory = join(
      source.installRoot,
      "packages",
      pkg.packageDigest.slice(7),
    );
    await mkdir(join(source.installRoot, "packages"), { recursive: true });
    await cp(pkg.directory, directory, { recursive: true });
    await f.parent.migratePluginProjectWorkspaceNamespaces();
    if (!native) await (await f.mounted()).write();
    const state = {
      identityAllowed: true,
      policyAllowed: true,
      projectWriteAllowed: true,
      withdrawAfterSources: false,
      taskCalls: 0,
      observed: 0,
    };
    const profiles = { resolve: async () => scope };
    const requests = new InstalledPluginRequestOwner({
      identity: {
        async resolveCurrentActor() {
          if (!state.identityAllowed)
            throw new Error("named_identity_withdrawn");
          return f.actor;
        },
      },
      profiles,
      ...(executeCase
        ? {
            taskPeer: {
              prepare: async () => ({
                catalog: { list: () => [], resolve: () => null },
                host: {
                  taskAdmissionMode: () => "installed" as const,
                  validateConfiguration: async () => {},
                  evaluate: async () => ({
                    outcome: "unavailable" as const,
                    reasonCode: "extension_runtime_unavailable" as const,
                  }),
                },
                pluginQueryHost: {
                  resolveRegistration: async () => null,
                  evaluate: async () => ({
                    outcome: "unavailable" as const,
                    reasonCode: "extension_runtime_unavailable" as const,
                  }),
                },
              }),
            },
          }
        : {}),
    });
    const authorization = {
      async authorize() {
        return state.policyAllowed
          ? {
              outcome: "allow" as const,
              authorityEpoch: "actual-control-owned-epoch",
            }
          : { outcome: "deny" as const, reasonCode: "named_ui_policy_denied" };
      },
    };
    const clock = { now: () => f.namespaceRecipe().createdAt };
    const service = new ProjectConversationApplicationService({
      conversations: f.store,
      threads: f.threads,
      threadStore: f.parent,
      projects: f.parent.creativeProjectStore(),
      texts: f.parent.projectTextStore(),
      tasks: {
        async createProjectConversationTurnFromHost(_actor, _command, task) {
          if (executeCase) {
            assert.ok("prepareSources" in task);
            const sources = await task.prepareSources();
            assert.ok(sources.brief);
            if (state.withdrawAfterSources) state.projectWriteAllowed = false;
            await task.authority.assertCurrent();
            state.taskCalls++;
            throw new Error("named_stage_task_boundary_reached");
          }
          state.taskCalls++;
          throw new Error("metadata_must_not_execute_run");
        },
      },
      authorization: {
        authorize: async ({ action }) =>
          action !== "creativeProject:write" || state.projectWriteAllowed
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named_project_write_withdrawn" },
      },
      clock,
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
    });
    const owner = new ProjectConversationControlOwner({
      service,
      projectOwnership: "plugin-project-v1",
      ...(native
        ? {
            nativeWorkspace: {
              async observe() {
                state.observed++;
                throw new Error("named_native_observer_unavailable");
              },
              registration:
                parent.pluginProjectWorkspaceNativeRegistrationStore(),
            },
          }
        : {}),
      conversations: f.store,
      configuration: { publications },
      installations: f.installs,
      requests,
      installRoot: source.installRoot,
      authorization,
      authorizePackage: async () => "allow",
      assertExternal() {},
      clock,
      digester: f.digester,
    });
    t.after(async () => {
      await owner.close();
      await requests.close();
    });
    const reader = new LocalPluginUiPackageReader({
      profile: scope,
      installRoot: source.installRoot,
      authorizePublication: async () => ["ui.mjs"],
    });
    const ui = new PluginUiApplicationService({
      store: f.installs,
      profiles,
      authorization,
      packages: reader,
      actions: owner.actions,
      committedMetadata: owner.committedMetadata,
      clock,
      ids: { nextId: () => randomUUID().replaceAll("-", "").repeat(2) },
    });
    const lease = await ui.openMount(f.actor, {
      pluginId: pkg.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: selected.selection.revision,
      expectedPackageDigest: pkg.packageDigest,
    });
    const invoke = (action: string, input: object) =>
      requests.run(
        {
          request: {
            method: "POST",
            url: "/named/installed-ui",
            remoteAddress: "127.0.0.1",
            headers: {},
          },
          actor: f.actor,
          preparation: "configuration",
        },
        () =>
          ui.invoke(f.actor, {
            mountRef: lease.mountRef,
            action,
            input: parsePluginUiJsonValue(input),
          }),
      );
    if (!native) {
      assert.equal(
        owner.supportsAction(
          "crewon.project-workspace-target.v1.resolveTarget",
        ),
        false,
      );
      await assert.rejects(
        invoke("crewon.project-workspace-target.v1.resolveTarget", {
          projectId: f.reference.projectId,
        }),
      );
    }
    const input = {
      projectId: f.reference.projectId,
      workspaceId: native
        ? `workspace-project-${createHash("sha256").update(pluginProjectWorkspaceIdentityInput(f.namespaceOwner())).digest("hex")}`
        : "workspace-isolated",
      title: "原会话服务",
      idempotencyKey: "actual-control-conversation",
    };
    const targetAction = "crewon.project-workspace-target.v1.resolveTarget";
    if (native) {
      if (!targetDeclared)
        await assert.rejects(
          invoke(targetAction, { projectId: input.projectId }),
        );
      else {
        const target = await invoke(targetAction, {
          projectId: input.projectId,
        });
        assert.deepEqual(target, {
          projectId: input.projectId,
          workspaceId: input.workspaceId,
        });
        assert.equal(state.observed, 0);
        assert.equal(state.taskCalls, 0);
        await assert.rejects(
          invoke(targetAction, { projectId: "foreign-project" }),
        );
        state.policyAllowed = false;
        await assert.rejects(
          invoke(targetAction, { projectId: input.projectId }),
        );
        state.policyAllowed = true;
      }
      await assert.rejects(
        invoke(actions.createConversation, { ...input, workspaceId: null }),
        (error) =>
          error instanceof ApplicationError &&
          error.code ===
            "project_conversation_native_workspace_explicit_target_required",
      );
      assert.equal(state.observed, 0);
      await assert.rejects(
        invoke(actions.createConversation, input),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.cause instanceof Error &&
          error.cause.message === "named_native_observer_unavailable",
      );
      assert.equal(state.observed, 1);
      state.policyAllowed = false;
      await assert.rejects(invoke(actions.createConversation, input));
      assert.equal(state.observed, 1);
      state.policyAllowed = true;
      state.identityAllowed = false;
      await assert.rejects(invoke(actions.createConversation, input));
      assert.equal(state.observed, 1);
      assert.equal(state.taskCalls, 0);
      assert.deepEqual(
        (
          await f.store.listBindings({
            ...f.owner,
            projectId: f.reference.projectId,
            afterThreadId: null,
            limit: 16,
          })
        ).bindings,
        [],
      );
      assert.equal(
        (
          await f.parent.pluginProjectWorkspaceNamespaces().listNamespaces({
            owner: f.namespaceScope,
            afterProjectId: null,
            limit: 16,
          })
        ).namespaces.length,
        0,
      );
      return;
    }
    const first = (await invoke(actions.createConversation, input)) as {
      binding: { threadId: string; workspaceId: string };
      disposition: string;
    };
    assert.equal(first.disposition, "committed");
    assert.equal(first.binding.workspaceId, input.workspaceId);
    assert.deepEqual(
      (
        (await invoke(actions.getBinding, {
          threadId: first.binding.threadId,
        })) as { binding: unknown }
      ).binding,
      first.binding,
    );
    const replay = (await invoke(
      actions.createConversation,
      input,
    )) as typeof first;
    assert.equal(replay.disposition, "replayed");
    assert.deepEqual(replay.binding, first.binding);
    const page = (await invoke(actions.listConversations, {
      projectId: input.projectId,
      afterThreadId: null,
      limit: 16,
    })) as { bindings: unknown[] };
    assert.deepEqual(page.bindings, [first.binding]);
    const opened = (await invoke(actions.openConversation, {
      projectId: input.projectId,
      threadId: first.binding.threadId,
    })) as { binding: unknown };
    assert.deepEqual(opened.binding, first.binding);
    if (executeCase) {
      const httpRequest = {
        method: "POST",
        url: "/named/project-stage",
        remoteAddress: "127.0.0.1",
        headers: {},
      };
      const stageInput = {
        projectId: input.projectId,
        threadId: first.binding.threadId,
        expectedThreadRevision: 1,
        expectedBindingRevision: 1,
        stage: { kind: "discussion" as const },
        content: "原中央对话的受保护项目准备",
        idempotencyKey: "owned-stage-prepare",
      };
      const reached = (error: unknown) => {
        let item = error;
        for (let i = 0; item instanceof Error && i < 8; i++, item = item.cause)
          if (item.message === "named_stage_task_boundary_reached") return true;
        return false;
      };
      await assert.rejects(
        owner.startStage(httpRequest, f.actor, stageInput),
        reached,
      );
      await assert.rejects(
        owner.startBoundTurn(httpRequest, f.actor, {
          threadId: first.binding.threadId,
          expectedThreadRevision: 1,
          content: stageInput.content,
          idempotencyKey: "owned-bound-prepare",
        }),
        reached,
      );
      assert.equal(state.taskCalls, 2);
      await assert.rejects(invoke(actions.startStage, stageInput), reached);
      assert.equal(state.taskCalls, 3);
      await assert.rejects(
        owner.startStage(httpRequest, f.actor, {
          ...stageInput,
          projectId: randomUUID(),
        }),
      );
      assert.equal(state.taskCalls, 3);
      state.policyAllowed = false;
      await assert.rejects(owner.startStage(httpRequest, f.actor, stageInput));
      assert.equal(state.taskCalls, 3);
      state.policyAllowed = true;
      state.withdrawAfterSources = true;
      await assert.rejects(owner.startStage(httpRequest, f.actor, stageInput));
      assert.equal(state.taskCalls, 3);
      state.withdrawAfterSources = false;
      state.projectWriteAllowed = true;
    }
    state.identityAllowed = false;
    await assert.rejects(
      invoke(actions.createConversation, input),
      (e: unknown) =>
        e instanceof ApplicationError && e.category === "authorization",
    );
    state.identityAllowed = true;
    state.policyAllowed = false;
    await assert.rejects(
      invoke(actions.createConversation, input),
      (e: unknown) =>
        e instanceof ApplicationError && e.category === "authorization",
    );
    state.policyAllowed = true;
    assert.deepEqual(
      ((await invoke(actions.createConversation, input)) as typeof first)
        .binding,
      first.binding,
    );
    const businessPath = join(directory, "business.json");
    const original = await readFile(businessPath, "utf8");
    await writeFile(businessPath, " " + original.slice(1));
    await assert.rejects(
      invoke(actions.createConversation, input),
      (e: unknown) => {
        let current = e;
        for (let depth = 0; current instanceof Error && depth < 8; depth++) {
          if (
            "code" in current &&
            current.code === "plugin_package_file_digest_mismatch"
          )
            return true;
          current = current.cause;
        }
        return false;
      },
    );
    await writeFile(businessPath, original);
    assert.deepEqual(
      ((await invoke(actions.createConversation, input)) as typeof first)
        .binding,
      first.binding,
    );
    await owner.close();
    await assert.rejects(
      invoke(actions.createConversation, input),
      (e: unknown) =>
        e instanceof ApplicationError &&
        e.code === "project_conversation_unavailable",
    );
    assert.equal(state.taskCalls, executeCase ? 3 : 0);
  });
