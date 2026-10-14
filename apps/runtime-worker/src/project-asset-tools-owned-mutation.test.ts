import { markAssetToolsOwnedProject } from "./project-asset-owned.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { assetToolsFixture } from "./project-asset-tools-service-owner.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: protected Asset write cannot publish after the actual queue lease expires`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetToolsFixture(t, backend),
        owner = f.owner(),
        tools = f.services(owner).tools;
      const request = {
        projectId: f.admitted!.assetStageAdmission.projectId,
        assetId: null,
        kind: "character" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: {
          name: "过期租约",
          setting: "不会成为产物",
          visualPrompt: "No output",
        },
      };
      const op = await f.prepareTool("asset_save", request);
      await markAssetToolsOwnedProject(f, "matching");
      await f.sql(
        backend === "sqlite"
          ? "UPDATE work_items SET lease_expires_at_ms=0"
          : `UPDATE ${f.prefix}work_items SET lease_expires_at='1970-01-01T00:00:00Z'`,
      );
      await assert.rejects(
        f.invoke(owner, op, (command) =>
          tools.saveCandidate({ command, request }),
        ),
      );
      for (const table of [
        "project_assets",
        "project_asset_revisions",
        "project_asset_mutation_receipts",
      ])
        assert.equal(
          Number(
            (await f.sql(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]!
              .n,
          ),
          0,
        );
    },
  );
  test(
    `${backend}: original leased asset read Tools use their own read grant on the protected archive`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetToolsFixture(t, backend),
        owner = f.owner(),
        tools = f.services(owner).tools;
      const projectId = f.admitted!.assetStageAdmission.projectId;
      const candidate = {
        projectId,
        assetId: null,
        kind: "character" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: {
          name: "独立只读",
          setting: "真实Stage归档",
          visualPrompt: "Cinematic portrait",
        },
      };
      const write = await f.prepareTool("asset_save", candidate);
      await markAssetToolsOwnedProject(f, "matching");
      const saved = await f.invoke(owner, write, (command) =>
        tools.saveCandidate({ command, request: candidate }),
      );
      const assetId = saved.asset.assetId;
      const list = {
        projectId,
        kind: "character" as const,
        afterAssetId: null,
        limit: 4,
      };
      const op = await f.prepareTool("asset_list", list);
      const page = await f.invoke(owner, op, (command) =>
        tools.listAssets({ command, request: list }),
      );
      assert.equal(page.assets.length, 1);
      await assert.rejects(
        f.invoke(
          owner,
          op,
          (command) => tools.listAssets({ command, request: list }),
          { copied: true },
        ),
      );
      const get = { projectId, assetId },
        read = await f.prepareTool("asset_read", get);
      const view = await f.invoke(owner, read, (command) =>
        tools.getAsset({ command, request: get }),
      );
      assert.equal(view.view?.asset.assetId, assetId);
      const history = { projectId, assetId, afterContentRevision: 0, limit: 4 },
        hist = await f.prepareTool("asset_history", history);
      const versions = await f.invoke(owner, hist, (command) =>
        tools.listRevisions({ command, request: history }),
      );
      assert.equal(versions.revisions.length, 1);
      const content = { projectId, assetId, contentRevision: 1, offset: 0 },
        body = await f.prepareTool("asset_content_read", content);
      const chunk = await f.invoke(owner, body, (command) =>
        tools.readContent({ command, request: content }),
      );
      assert.match(chunk.text, /独立只读/);
      assert.equal(chunk.nextOffset, null);
      f.state.policy = false;
      await assert.rejects(
        f.invoke(owner, body, (command) =>
          tools.readContent({ command, request: content }),
        ),
      );
      assert.equal(
        Number(
          (
            await f.sql(`SELECT COUNT(*) AS n FROM ${f.prefix}project_assets`)
          )[0]!.n,
        ),
        1,
      );
    },
  );
  for (const variant of [
    "matching",
    "foreign",
    "missing",
    "workspace",
  ] as const) {
    test(
      `${backend}: actual Asset Tool writes and cold-replays only the matching protected namespace (${variant})`,
      assetTestOptions(backend),
      async (t) => {
        const f = await assetToolsFixture(t, backend),
          owner = f.owner(),
          service = f.services(owner);
        const projectId = f.admitted!.assetStageAdmission.projectId;
        const request = {
          projectId,
          assetId: null,
          kind: "character" as const,
          expectedAssetRevision: 0,
          briefRevision: 1,
          script: null,
          content: {
            name: "雨夜摄影师",
            setting: "保留真实工具谱系",
            visualPrompt: "Portrait in rain",
          },
        };
        const op = await f.prepareTool("asset_save", request);
        await markAssetToolsOwnedProject(f, variant);
        await assert.rejects(
          f.assets.listAssets(f.actor, {
            projectId,
            kind: null,
            afterAssetId: null,
            limit: 16,
          }),
        );
        const save = () =>
          f.invoke(owner, op, (command) =>
            service.tools.saveCandidate({ command, request }),
          );
        if (variant !== "matching") {
          await assert.rejects(save());
          assert.equal(
            Number(
              (
                await f.sql(
                  `SELECT COUNT(*) AS n FROM ${f.prefix}project_assets`,
                )
              )[0]!.n,
            ),
            0,
          );
          return;
        }
        const saved = await save();
        assert.equal(saved.disposition, "committed");
        assert.equal(saved.asset.selectedContentRevision, null);
        assert.equal(saved.contentRevision.brief.briefRevision, 1);
        await owner.close();
        const cold = f.owner();
        const replay = await f.invoke(cold, op, (command) =>
          f.services(cold).tools.saveCandidate({ command, request }),
        );
        assert.equal(replay.disposition, "replayed");
        assert.deepEqual(replay.asset, saved.asset);
        assert.deepEqual(replay.contentRevision, saved.contentRevision);
        assert.equal(
          Number(
            (
              await f.sql(`SELECT COUNT(*) AS n FROM ${f.prefix}project_assets`)
            )[0]!.n,
          ),
          1,
        );
        f.controls.live = false;
        await assert.rejects(
          f.invoke(cold, op, (command) =>
            f.services(cold).tools.saveCandidate({ command, request }),
          ),
        );
        assert.equal(
          Number(
            (
              await f.sql(`SELECT COUNT(*) AS n FROM ${f.prefix}project_assets`)
            )[0]!.n,
          ),
          1,
        );
      },
    );
  }
}
