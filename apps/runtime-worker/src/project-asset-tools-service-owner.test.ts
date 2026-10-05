import assert from "node:assert/strict";
import test from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { assetToolsFixture } from "./project-asset-tools-service-owner.test-support.ts";
import { readProjectAssetStageRuntimeScope } from "./plugins/project-asset-stage-runtime-scope.ts";
import { deferred, tick } from "./plugin-tool-runtime-adapter.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} actual asset Stage/Worker command saves one frozen candidate and cold receipt replay preserves its identity`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetToolsFixture(t, backend),
        owner = f.owner(),
        service = f.services(owner),
        projectId = f.admitted!.assetStageAdmission.projectId;
      const request = {
        projectId,
        assetId: null,
        kind: "character" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: {
          name: "雨夜摄影师",
          setting: "收到原信的摄影师",
          visualPrompt: "Portrait in rain",
        },
      };
      const raw = { ...request } as Record<string, unknown>;
      delete raw.assetId;
      delete raw.script;
      const op = await f.prepareTool("asset_save", raw),
        saved = await f.invoke(owner, op, (command) =>
          service.tools.saveCandidate({ command, request }),
        );
      assert.equal(saved.disposition, "committed");
      assert.equal(saved.asset.selectedContentRevision, null);
      assert.equal(saved.contentRevision.brief.briefRevision, 1);
      assert.equal(Object.hasOwn(saved.contentRevision, "content"), false);
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ resultJson: JSON.stringify(saved) }),
        ) <= 8192,
      );
      const latest = await f.projects.getProject(f.actor, { projectId });
      await f.projects.appendBrief(f.actor, {
        projectId,
        expectedProjectRevision: latest.revision,
        text: "New manual brief after admitted result",
        idempotencyKey: "manual-brief-after-result",
      });
      await owner.close();
      const cold = f.owner(),
        replay = await f.invoke(cold, op, (command) =>
          f.services(cold).tools.saveCandidate({ command, request }),
        );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.asset, saved.asset);
      assert.deepEqual(replay.contentRevision, saved.contentRevision);
      const page = await f.assets.listAssets(f.actor, {
        projectId,
        kind: null,
        afterAssetId: null,
        limit: 16,
      });
      assert.equal(page.assets.length, 1);
      assert.equal((await f.counts()).extension_external_operations, 0);
    },
  );
  test(
    `${backend} real old read dispatch obtains immutable asset scope; service possession/copy/cross-project/old-write/media cannot borrow it`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetToolsFixture(t, backend),
        owner = f.owner(),
        s = f.services(owner),
        projectId = f.admitted!.assetStageAdmission.projectId,
        op = await f.prepareTool("project_read", { projectId });
      await assert.rejects(
        s.context.readScope({ command: op.command }),
        /authority_denied/,
      );
      const scope = await f.invoke(owner, op, (command) =>
        s.context.readScope({ command }),
      );
      assert.equal(scope.scope?.projectId, projectId);
      assert.equal(scope.scope?.stage.assetKind, "character");
      await assert.rejects(
        f.invoke(owner, op, (command) => s.context.readScope({ command }), {
          copied: true,
        }),
        /authority_denied/,
      );
      for (const [operation, input] of [
        ["project_read", { projectId: "foreign-project" }],
        [
          "brief_append",
          { projectId, expectedProjectRevision: 1, text: "forbidden" },
        ],
        ["submit", {}],
      ] as const) {
        const forbidden = await f.prepareTool(operation, input);
        let executed = false;
        await assert.rejects(
          f.invoke(owner, forbidden, async () => {
            executed = true;
            return undefined;
          }),
        );
        assert.equal(executed, false);
      }
      const list = await f.prepareTool("asset_list", {
        projectId,
        kind: "character",
        limit: 4,
      });
      await assert.rejects(
        f.invoke(owner, list, (command) =>
          s.tools.listAssets({
            command,
            request: { projectId, kind: "scene", afterAssetId: null, limit: 4 },
          }),
        ),
      );
      const wrong = f.owner({
        context: {
          ...f.context,
          run: { ...f.context.run, runId: "different-run" },
        },
        admission: { ...f.admission, runId: "different-run" },
        assetStageAdmission: null,
      });
      await assert.rejects(
        f.invoke(wrong, op, (command) =>
          f.services(wrong).context.readScope({ command }),
        ),
        /authority_denied/,
      );
      assert.equal(
        (
          await f.assets.listAssets(f.actor, {
            projectId,
            kind: null,
            afterAssetId: null,
            limit: 16,
          })
        ).assets.length,
        0,
      );
    },
  );
  test(
    `${backend} immutable asset body Unicode chunks stay bounded and owner close joins in-flight scope reads`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetToolsFixture(t, backend),
        owner = f.owner(),
        s = f.services(owner),
        projectId = f.admitted!.assetStageAdmission.projectId;
      const request = {
          projectId,
          assetId: null,
          kind: "character" as const,
          expectedAssetRevision: 0,
          briefRevision: 1,
          script: null,
          content: {
            name: "分页人物",
            setting: '\t🚀界"\\\n'.repeat(350),
            visualPrompt: "One character",
          },
        },
        op = await f.prepareTool("asset_save", request),
        saved = await f.invoke(owner, op, (command) =>
          s.tools.saveCandidate({ command, request }),
        );
      let offset = 0,
        restored = "";
      do {
        const request = {
            projectId,
            assetId: saved.asset.assetId,
            contentRevision: 1,
            offset,
          },
          read = await f.prepareTool("asset_content_read", request),
          page = await f.invoke(owner, read, (command) =>
            s.tools.readContent({ command, request }),
          );
        assert.equal(page.contentDigest, saved.contentRevision.contentDigest);
        assert.ok(Array.from(page.text).length <= 1024);
        assert.ok(
          Buffer.byteLength(
            JSON.stringify({ resultJson: JSON.stringify(page) }),
          ) <= 8192,
        );
        restored += page.text;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      } while (true);
      assert.equal(restored, extensionCanonicalJson(request.content));
      const read = await f.prepareTool("project_read", { projectId }),
        entered = deferred(),
        physical = deferred(),
        runtime = deferred();
      f.controls.beforeCurrent = async () => {
        entered.resolve();
        await physical.promise;
      };
      const active = f.invoke(owner, read, async (command) => {
        const waiting = assert.rejects(s.context.readScope({ command }));
        await runtime.promise;
        await waiting;
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
      await active;
      await closing;
      assert.equal(owner.canRetire(), true);
    },
  );
  test(
    `${backend} real marker absence is legacy only; required stage record/schema loss never downgrades to null`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetToolsFixture(t, backend),
        scope = await readProjectAssetStageRuntimeScope({
          stages: f.stages,
          admission: f.admission,
          binding: f.binding,
          signal: new AbortController().signal,
        });
      assert.equal(
        scope?.contentDigest,
        f.admitted?.assetStageAdmission.contentDigest,
      );
      await f.sql(`DROP TABLE ${f.prefix}project_asset_stage_run_admissions`);
      await assert.rejects(
        readProjectAssetStageRuntimeScope({
          stages: f.stages,
          admission: f.admission,
          binding: f.binding,
          signal: new AbortController().signal,
        }),
      );
    },
  );
}
test("real legacy admitted dispatch reads null asset scope without acquiring any asset write grant", async (t) => {
  const f = await assetToolsFixture(t, "sqlite", { legacy: true }),
    owner = f.owner(),
    s = f.services(owner),
    op = await f.prepareTool("project_read", {
      projectId: f.reference.projectId,
    });
  const scope = await f.invoke(owner, op, (command) =>
    s.context.readScope({ command }),
  );
  assert.deepEqual(scope, { scope: null });
  const request = {
      projectId: f.reference.projectId,
      assetId: null,
      kind: "character" as const,
      expectedAssetRevision: 0,
      briefRevision: 1,
      script: null,
      content: {
        name: "No grant",
        setting: "Refused",
        visualPrompt: "Refused",
      },
    },
    save = await f.prepareTool("asset_save", request);
  await assert.rejects(
    f.invoke(owner, save, (command) =>
      s.tools.saveCandidate({ command, request }),
    ),
    /authority_denied/,
  );
});
