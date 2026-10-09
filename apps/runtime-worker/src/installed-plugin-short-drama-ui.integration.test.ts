import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type {
  HTMLButtonElement as HappyButton,
  HTMLTextAreaElement as HappyTextarea,
  HTMLInputElement as HappyInput,
  HTMLDivElement as HappyDiv,
} from "happy-dom";
import {
  settleShortDrama,
  shortDramaProps,
  shortDramaUiFixture,
} from "./installed-plugin-short-drama-ui.integration.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 60_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };

  test(
    `${backend}: frozen UI-v1 compatibility: actual installed UI-only short-drama package loads its PNG and preserves concept/history/settings interactions without executing tasks`,
    options,
    async (t) => {
      const f = await shortDramaUiFixture(t, backend);
      const lease = await f.mount();
      assert.equal(lease.packageDigest, f.installed.packageDigest);
      assert.deepEqual(lease.descriptor, f.descriptor);
      assert.equal(f.imports.length, 1);
      assert.equal(
        f.imports[0],
        pathToFileURL(
          join(f.installed.directory, f.descriptor.entrypoints.ui!.path),
        ).href,
      );
      assert.ok(f.readAssets.includes(f.descriptor.entrypoints.ui!.path));
      const png = f.descriptor.files.filter((file) =>
        file.path.endsWith(".png"),
      );
      assert.equal(png.length, 1);
      assert.ok(lease.publicAssets.includes(png[0]!.path));
      const asset = await f.readAsset(lease, png[0]!.path);
      assert.equal(asset.contentType, "image/png");
      assert.equal(asset.bytes.length, png[0]!.byteLength);
      assert.equal(
        createHash("sha256").update(asset.bytes).digest("hex"),
        png[0]!.sha256,
      );
      assert.deepEqual(
        [...asset.bytes.slice(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      assert.equal(
        f.root.querySelector("img")!.src,
        pathToFileURL(join(f.installed.directory, png[0]!.path)).href,
      );
      assert.equal(f.root.querySelectorAll(".project-card").length, 3);
      assert.match(f.root.textContent, /不实际扣费/u);
      assert.match(f.root.textContent, /离开模块后重开会重置演示数据/u);
      assert.equal(f.root.querySelector("aside"), null);
      assert.equal(f.root.querySelector(".sidebar-account"), null);
      await assert.rejects(
        f.readAsset(lease, "SDK-LICENSE"),
        /plugin_ui_asset_unavailable/u,
      );
      await f.click(f.root.querySelector<HappyButton>(".project-card"));
      assert.equal(
        f.root.querySelector(".page-heading h1")!.textContent,
        "窗边的来信",
      );
      await f.click(f.button("生成新版本"));
      assert.match(
        f.root.querySelector(".breadcrumbs")!.textContent,
        /概念图 v3/u,
      );
      await f.click(f.button("开始生成"));
      assert.match(
        f.root.querySelector(".status-stack")!.textContent,
        /排队中/u,
      );
      await f.click(f.button("查询原任务"));
      await f.click(f.button("设为选用"));
      assert.equal(f.button("已设为选用").disabled, true);
      await f.click(f.button("查看生成记录"));
      assert.equal(f.root.querySelector("dialog")!.open, true);
      assert.match(
        f.root.querySelector("dialog")!.textContent,
        /概念图修订 v3/u,
      );
      await f.click(
        f.root.querySelector<HappyButton>('[aria-label="关闭弹窗"]'),
      );
      await f.click(f.button("生成服务设置"));
      assert.match(
        f.root.querySelector("dialog")!.textContent,
        /本预览不会调用/u,
      );
      await f.click(
        f.root.querySelector<HappyButton>('[aria-label="关闭弹窗"]'),
      );
      await f.click(f.button("返回项目"));
      assert.equal(f.root.querySelectorAll(".revision-item").length, 3);
      await f.click(f.button("v2"));
      assert.match(f.root.querySelector("dialog")!.textContent, /需求 v1/u);
      assert.match(f.root.querySelector("dialog")!.textContent, /需求 v2/u);
      await f.click(
        f.root.querySelector<HappyButton>('[aria-label="关闭弹窗"]'),
      );
      await f.click(f.button("AI 短剧"));
      assert.equal(f.root.querySelectorAll(".project-card").length, 3);
      assert.equal(f.diagnostics.length, 0);
      await f.assertNoExecutionWrites();
    },
  );

  test(
    `${backend}: frozen UI-v1 compatibility: installed short-drama project creation/filtering retains brief revisions and archived editing boundaries only in its mounted DOM`,
    options,
    async (t) => {
      const f = await shortDramaUiFixture(t, backend);
      await f.mount();
      await f.click(f.button("新建项目"));
      await f.input(f.root.querySelector("dialog input"), "真实安装页面故事");
      await f.input(
        f.root.querySelector("dialog textarea"),
        "一封保留原始输入的信。",
      );
      await f.click(f.button("创建项目"));
      assert.equal(
        f.root.querySelector(".page-heading h1")!.textContent,
        "真实安装页面故事",
      );
      await f.input(
        f.root.querySelector<HappyTextarea>("#creative-brief"),
        "温暖的故事，需求第二版。",
      );
      await f.click(f.button("保存为新版本"));
      await f.click(f.button("v2"));
      assert.match(
        f.root.querySelector("dialog")!.textContent,
        /一封保留原始输入的信/u,
      );
      assert.match(f.root.querySelector("dialog")!.textContent, /温暖的故事/u);
      await f.click(
        f.root.querySelector<HappyButton>('[aria-label="关闭弹窗"]'),
      );
      await f.click(f.button("创建概念图"));
      await f.click(f.button("开始生成"));
      await f.click(f.button("返回项目"));
      await f.click(f.button("归档项目"));
      await f.click(f.button("已归档"));
      assert.equal(f.root.querySelectorAll(".project-card").length, 1);
      await f.input(
        f.root.querySelector<HappyInput>('[aria-label="搜索项目名称"]'),
        "真实安装",
      );
      await f.click(f.root.querySelector<HappyButton>(".project-card"));
      assert.equal(
        f.root.querySelector<HappyTextarea>("#creative-brief")!.disabled,
        true,
      );
      assert.equal(f.button("生成新版本").disabled, true);
      await f.click(f.root.querySelector<HappyButton>(".concept-art"));
      await f.click(f.button("查询原任务"));
      assert.equal(f.button("设为选用").disabled, true);
      await f.click(f.button("返回项目"));
      await f.click(f.button("恢复项目"));
      await f.click(f.root.querySelector<HappyButton>(".filter-tabs button"));
      await f.input(
        f.root.querySelector<HappyInput>('[aria-label="搜索项目名称"]'),
        "真实安装",
      );
      assert.equal(f.root.querySelectorAll(".project-card").length, 1);
      await f.assertNoExecutionWrites();
    },
  );

  test(
    `${backend}: frozen UI-v1 compatibility: actual trusted loader theme update preserves edits and account/root, and stop closes dialogs/timers before reset remount`,
    options,
    async (t) => {
      const f = await shortDramaUiFixture(t, backend);
      const lease = await f.mount();
      await f.click(f.root.querySelector<HappyButton>(".project-card"));
      await f.input(
        f.root.querySelector<HappyTextarea>("#creative-brief"),
        "未保存的页面输入",
      );
      const textarea = f.root.querySelector<HappyTextarea>("#creative-brief")!;
      const owner = f.root.querySelector<HappyDiv>(
        "[data-short-drama-plugin]",
      )!;
      await f.update(shortDramaProps({ "--surface": "#181818" }, "dark"));
      assert.equal(f.root.querySelector("#creative-brief"), textarea);
      assert.equal(textarea.value, "未保存的页面输入");
      assert.equal(owner.dataset.theme, "dark");
      assert.equal(owner.style.getPropertyValue("--surface"), "#181818");
      assert.equal(owner.style.getPropertyValue("--text"), "");
      await f.click(f.button("生成新版本"));
      assert.equal(f.noticeTimers.size, 1);
      await f.click(f.button("生成服务设置"));
      const dialog = f.root.querySelector("dialog")!;
      assert.equal(dialog.open, true);
      await f.stop();
      assert.equal(dialog.open, false);
      assert.ok(f.closedDialogs.includes(dialog));
      assert.equal(f.noticeTimers.size, 0);
      assert.equal(f.root.children.length, 0);
      await assert.rejects(
        f.service.validateMount(
          {
            tenantId: "tenant-插件",
            spaceId: "space-插件",
            principalId: "principal-本人",
            actorId: "actor-本人",
          },
          { mountRef: lease.mountRef },
        ),
        /plugin_ui_mount_unavailable/u,
      );
      await f.stop();
      await f.mount();
      assert.equal(f.root.querySelectorAll(".project-card").length, 3);
      await f.click(f.root.querySelector<HappyButton>(".project-card"));
      assert.equal(f.root.querySelectorAll(".revision-item").length, 2);
      assert.notEqual(
        f.root.querySelector<HappyTextarea>("#creative-brief")!.value,
        "未保存的页面输入",
      );
      await f.click(f.button("AI 短剧"));
      await f.click(f.button("新建项目"));
      const nextDialog = f.root.querySelector("dialog")!;
      const cancel = new f.window.Event("cancel", { cancelable: true });
      nextDialog.dispatchEvent(cancel);
      await settleShortDrama();
      assert.equal(cancel.defaultPrevented, true);
      assert.equal(nextDialog.open, false);
      await f.click(f.button("新建项目"));
      await f.click(nextDialog);
      assert.equal(nextDialog.open, false);
      await f.assertNoExecutionWrites();
    },
  );

  test(
    `${backend}: frozen UI-v1 compatibility: installed short-drama upgrade and disable invalidate actual active leases and refuse new mounts without hiding host identity`,
    options,
    async (t) => {
      const f = await shortDramaUiFixture(t, backend);
      const originalLease = await f.mount();
      await f.assertNoExecutionWrites();
      const next = await f.upgrade();
      const afterUpgrade = await f.snapshot();
      await assert.rejects(
        f.update(shortDramaProps()),
        /plugin_ui_selection_changed/u,
      );
      await assert.rejects(
        f.service.validateMount(
          {
            tenantId: "tenant-插件",
            spaceId: "space-插件",
            principalId: "principal-本人",
            actorId: "actor-本人",
          },
          { mountRef: originalLease.mountRef },
        ),
        /plugin_ui_mount_unavailable/u,
      );
      await settleShortDrama();
      assert.equal(
        f.root.children.length,
        0,
        "loader revokes and disposes stale active UI",
      );
      await assert.rejects(
        f.service.openMount(
          {
            tenantId: "tenant-插件",
            spaceId: "space-插件",
            principalId: "principal-本人",
            actorId: "actor-本人",
          },
          {
            pluginId: f.descriptor.pluginId,
            contributionId: "workbench",
            expectedSelectionRevision: originalLease.selectionRevision,
            expectedPackageDigest: originalLease.packageDigest,
          },
        ),
        /plugin_ui_selection_changed/u,
      );
      assert.deepEqual(await f.snapshot(), afterUpgrade);
      await f.assertNoExecutionWrites(afterUpgrade);
      const nextLease = await f.mount();
      assert.equal(nextLease.packageDigest, next.packageDigest);
      assert.equal(nextLease.descriptor.version, "2.0.0");
      assert.equal(
        f.imports.at(-1),
        pathToFileURL(
          join(next.directory, next.descriptor.entrypoints.ui!.path),
        ).href,
      );
      assert.equal(f.root.querySelectorAll(".project-card").length, 3);
      await f.disable();
      const afterDisable = await f.snapshot();
      await assert.rejects(
        f.update(shortDramaProps()),
        /plugin_ui_selection_changed/u,
      );
      await assert.rejects(f.mount(), /plugin_ui_selection_changed/u);
      await settleShortDrama();
      assert.deepEqual(await f.snapshot(), afterDisable);
      await f.assertNoExecutionWrites(afterDisable);
      assert.equal(f.root.children.length, 0);
      assert.equal(f.account.textContent, "原用户栏与设置");
      assert.equal(f.account.isConnected, true);
      assert.equal(
        f.window.document.documentElement.getAttribute("style"),
        f.hostRootStyle,
      );
      assert.equal(f.noticeTimers.size, 0);
      assert.equal(
        f.imports.length,
        2,
        "disabled selection never imports another UI bundle",
      );
    },
  );
}
