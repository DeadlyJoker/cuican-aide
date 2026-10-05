import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
  ProjectAssetApplicationService,
  ProjectConversationApplicationService,
  ProjectAssetStageApplicationService,
  ThreadApplicationService,
  type CreativeProjectAuthorizationPort,
  type ProjectConversationCommitAuthority,
  type ProjectAssetStageCommitAuthority,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  businessExecutionFixture,
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { deferred } from "./plugin-tool-runtime-adapter.test-support.ts";
const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_ASSET_PLUGIN_DIR;
const content = {
  name: "雨夜摄影师",
  setting: "修复旧底片，追查父亲的来信",
  visualPrompt: "Portrait of a photographer in a darkroom",
};
const authorization: CreativeProjectAuthorizationPort = {
  authorize: async ({ actor: actual, resource }) => {
    assert.deepEqual(actual, actor);
    assert.equal(resource.tenantId, actor.tenantId);
    assert.equal(resource.spaceId, actor.spaceId);
    return { outcome: "allow" };
  },
};
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: immutable installed Short19 real Kernel asset Turn streams, reconnects and cold-resumes a lost candidate Tool receipt`,
    {
      timeout: 120000,
      skip:
        !packageDirectory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      let projectId = "",
        savedAssetId = "",
        allowWrite = true,
        delayQuote = true;
      const entered = deferred(),
        release = deferred();
      const observed: Array<{ callId: string; value: any }> = [];
      const transport = (): ModelTransportPort => ({
        adapterName: "named-offline-asset-model",
        adapterVersion: "1",
        modelId: "named-asset-no-network",
        async *stream(request) {
          const definitions = request.tools.filter((v) =>
            v.name.startsWith("crewon_short_drama__"),
          );
          assert.equal(definitions.length, 21);
          assert.ok(
            definitions.some(
              (v) => v.name === "crewon_short_drama__asset_context_read",
            ),
          );
          const last = request.input.items
              .filter((v) => v.type === "tool_result")
              .at(-1),
            value = last
              ? JSON.parse(JSON.parse(last.output).resultJson)
              : null;
          if (last && !observed.some((v) => v.callId === last.callId))
            observed.push({ callId: last.callId, value });
          let operation: string | null = null,
            input: unknown = null,
            callId = "";
          if (!last) {
            operation = "asset_context_read";
            input = {};
            callId = "asset-scope";
          } else if (last.callId === "asset-scope") {
            assert.equal(value.scope.projectId, projectId);
            assert.equal(value.scope.stage.kind, "assets");
            assert.equal(value.scope.stage.assetKind, "character");
            assert.ok(!value.scope.allowedOperations.includes("text_select"));
            assert.ok(!value.scope.allowedOperations.includes("submit"));
            operation = "asset_save";
            callId = "asset-candidate";
            input = {
              projectId,
              kind: "character",
              expectedAssetRevision: 0,
              briefRevision: 1,
              content,
            };
          } else if (last.callId === "asset-candidate") {
            assert.equal(value.asset.selectedContentRevision, null);
            assert.equal(
              Object.hasOwn(value.contentRevision, "content"),
              false,
            );
            savedAssetId = value.asset.assetId;
            operation = "asset_content_read";
            callId = "asset-content";
            input = {
              projectId,
              assetId: savedAssetId,
              contentRevision: 1,
              offset: 0,
            };
          } else {
            assert.deepEqual(JSON.parse(value.text), content);
            yield { type: "output.delta", delta: "角色档案候选已保存，" };
            yield { type: "output.delta", delta: "请你手动采用。" };
          }
          if (operation)
            yield {
              type: "tool.call",
              kind: "function",
              callId,
              name: `crewon_short_drama__${operation}`,
              input: JSON.stringify(input),
            };
          yield { type: "completed", checkpoint: null };
        },
      });
      const currentAuthorization: CreativeProjectAuthorizationPort = {
        authorize: async (input) => {
          const original = await authorization.authorize(input);
          return input.action === "creativeProject:write" && !allowWrite
            ? {
                outcome: "deny",
                reasonCode: "named_asset_stage_project_withdrawn",
              }
            : original;
        },
      };
      const f = await businessExecutionFixture(t, backend, {
        packageDirectory: packageDirectory!,
        configurationParameters: {
          baseUrl: "https://no-provider-request.example/",
          preset: "krea2-portrait",
        },
        taskAction: { contributionId: "workbench", action: "project.execute" },
        projectAssetStageQuotes: true,
        beforeProjectAssetStageQuote: async () => {
          if (delayQuote) {
            entered.resolve();
            await release.promise;
          }
        },
        taskInput: { prompt: "Create asset candidates" },
        createTransport: transport,
        maxToolRounds: 8,
        taskClock: { now: () => new Date().toISOString() },
        projectTools: { version: "crewon.project-tools.v1", authorization },
        projectAssetTools: {
          version: "crewon.project-asset-tools.v1",
          authorization,
          authorizeService: async (admission, signal) => {
            signal.throwIfAborted();
            assert.equal(admission.pluginId, "crewon.short-drama");
            assert.equal(admission.version, "19.0.0");
          },
        },
      });
      const metadata = f.store.creativeProjectStore(),
        texts = f.store.projectTextStore(),
        assets = f.store.projectAssetStore(),
        conversations = f.store.projectConversationStore(),
        stages = f.store.projectAssetStageStore();
      await metadata.migrate();
      await texts.migrate();
      await assets.migrate();
      await conversations.migrate();
      await stages.migrate();
      const base = {
        authorization: currentAuthorization,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
      };
      const projects = new CreativeProjectApplicationService({
          ...base,
          store: metadata,
        }),
        textApp = new ProjectTextApplicationService({
          ...base,
          store: texts,
          projects: metadata,
        }),
        assetApp = new ProjectAssetApplicationService({
          ...base,
          store: assets,
          projects: metadata,
          texts,
        });
      const created = await projects.createProject(actor, {
        title: "夜航",
        briefText: "摄影师在雨夜收到父亲的来信。",
        idempotencyKey: "asset-project-create",
      });
      projectId = created.project.projectId;
      const selection = await f.installations.loadSelection({
        scope: f.scope,
        pluginId: f.entry.registration.identity.pluginId,
      });
      assert.ok(selection);
      const pkg = await f.installations.loadPackage({
        scope: f.scope,
        packageDigest: selection.selectedPackageDigest!,
      });
      assert.ok(pkg);
      const pin = parsePluginTaskAdmissionPin({
        ...actor,
        ...f.scope,
        ...f.entry.registration.identity,
        selectionRevision: selection.revision,
        contributionId: "workbench",
        action: "project.execute",
        authorityEpoch: "named-asset-stage-issued-epoch",
      });
      const installation = {
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        profileId: pin.profileId,
        pluginId: pin.pluginId,
        publisherId: pin.publisherId,
        version: pin.version,
        packageDigest: pin.packageDigest,
        selectionRevision: pin.selectionRevision,
      };
      const current = async () => {
        assert.deepEqual(
          await f.installations.loadSelection({
            scope: f.scope,
            pluginId: pin.pluginId,
          }),
          selection,
        );
      };
      const conversationAuthority: ProjectConversationCommitAuthority = {
        version: "crewon.project-conversation-commit.v1",
        actor,
        installation,
        pin,
        selection,
        package: pkg,
        assertCurrent: current,
        assertTransactionCurrent: async () => {},
        assertActive: () => {},
      };
      const threads = new ThreadApplicationService({
        ...base,
        store: f.store,
        authorization: {
          authorize: async () => ({ outcome: "allow" as const }),
        },
        workspaceAdmission: { admit: async () => {} },
      });
      const conversationApp = new ProjectConversationApplicationService({
        ...base,
        conversations,
        threads,
        threadStore: f.store,
        projects: metadata,
        texts,
        tasks: f.tasks,
      });
      const bound = await conversationApp.createConversation(
        actor,
        {
          projectId,
          workspaceId: "asset-workspace",
          title: "角色档案创作",
          idempotencyKey: "asset-conversation-create",
        },
        conversationAuthority,
      );
      const app = new ProjectAssetStageApplicationService({
        conversations,
        stages,
        threadStore: f.store,
        projects: metadata,
        texts,
        tasks: f.tasks,
        authorization: currentAuthorization,
        digester,
      });
      const authority: ProjectAssetStageCommitAuthority = {
        ...conversationAuthority,
        version: "crewon.project-asset-stage-commit.v1",
      };
      const request = {
        projectId,
        threadId: bound.binding.threadId,
        expectedThreadRevision: 1,
        expectedBindingRevision: 1,
        stage: {
          kind: "assets" as const,
          assetKind: "character" as const,
          briefRevision: 1,
          script: null,
        },
        content: "根据已保存需求创作一个角色档案候选，不采用。",
        idempotencyKey: "asset-stage-original",
      };
      const failed = assert.rejects(app.startStage(actor, request, authority));
      await entered.promise;
      allowWrite = false;
      release.resolve();
      await failed;
      assert.equal(await f.count("run_snapshots"), 0);
      assert.equal(await f.count("plugin_credit_reservations"), 0);
      assert.equal(
        (await f.store.loadThread({
          tenantId: actor.tenantId,
          threadId: bound.binding.threadId,
        }))!.revision,
        1,
      );
      allowWrite = true;
      delayQuote = false;
      const accepted = await app.startStage(actor, request, authority),
        locator = {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          runId: accepted.runId,
        };
      const admission = await stages.loadAssetStageAdmission(locator);
      assert.ok(admission);
      assert.equal(admission.contentDigest, accepted.stageAdmissionDigest);
      assert.equal(admission.workspaceId, "asset-workspace");
      assert.equal(
        (
          await f.store.listMessages(
            { tenantId: actor.tenantId, threadId: accepted.threadId },
            0,
            100,
          )
        )[0]!.content,
        request.content,
      );
      const first = await f.openWorker({
        afterToolProviderResolved: async (resolution) => {
          if (
            "result" in resolution &&
            resolution.result?.callId === "asset-candidate"
          )
            throw Error("named_asset_loss_after_actual_candidate_commit");
        },
      });
      const interrupted = await first.worker.wake();
      assert.deepEqual(interrupted, {
        kind: "retried",
        runId: accepted.runId,
        code: "named_asset_loss_after_actual_candidate_commit",
      });
      const saved = (
        await assetApp.listAssets(actor, {
          projectId,
          kind: null,
          afterAssetId: null,
          limit: 16,
        })
      ).assets;
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.selectedContentRevision, null);
      await f.closeWorker();
      // Manual brief changes do not alter an already admitted raw request or immutable result on cold recovery.
      await projects.appendBrief(actor, {
        projectId,
        expectedProjectRevision: created.project.revision,
        text: "手动补充：保留雨夜角色。",
        idempotencyKey: "manual-after-asset-commit",
      });
      const replayedStart = await app.startStage(actor, request, authority);
      assert.equal(replayedStart.disposition, "replayed");
      assert.equal(replayedStart.runId, accepted.runId);
      assert.equal(
        replayedStart.stageAdmissionDigest,
        accepted.stageAdmissionDigest,
      );
      const cold = await f.openWorker(),
        resumed = await cold.worker.wake();
      assert.equal(
        resumed.kind,
        "completed",
        JSON.stringify({ resumed, observed }),
      );
      await f.closeWorker();
      assert.equal(
        observed.find((v) => v.callId === "asset-candidate")?.value.disposition,
        "replayed",
      );
      assert.deepEqual(
        (
          await assetApp.listAssets(actor, {
            projectId,
            kind: null,
            afterAssetId: null,
            limit: 16,
          })
        ).assets,
        saved,
      );
      const events = await f.store.listRunEvents(locator, 0, 1000);
      assert.deepEqual(
        events
          .filter((v) => v.type === "model.output.delta")
          .map((v) => v.data.delta),
        ["角色档案候选已保存，", "请你手动采用。"],
      );
      assert.deepEqual(
        await f.store.listRunEvents(locator, events[0]!.sequence, 1000),
        events.slice(1),
      );
      assert.match(
        JSON.stringify(
          (
            await f.store.listMessages(
              { tenantId: actor.tenantId, threadId: accepted.threadId },
              0,
              100,
            )
          ).at(-1)?.content,
        ),
        /角色档案候选已保存/,
      );
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("plugin_task_admissions"), 1);
      assert.equal(f.controls.executes.length, 0);
      const binding = await f.extensions.loadExtensionRunBinding({
        ...actor,
        runId: accepted.runId,
      });
      assert.ok(binding);
      assert.equal(
        (
          await f.operations.listExternalOperations({
            tenantId: actor.tenantId,
            runId: accepted.runId,
            bindingDigest: binding.bindingDigest,
            limit: 16,
          })
        ).operations.length,
        0,
      );
      assert.deepEqual(
        await stages.loadAssetStageAdmission(locator),
        admission,
      );
      assert.equal(
        (
          await textApp.listArtifacts(actor, {
            projectId,
            afterArtifactId: null,
            limit: 16,
          })
        ).artifacts.length,
        0,
      );
    },
  );
