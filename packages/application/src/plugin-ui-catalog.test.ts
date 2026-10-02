import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  uiFixture,
  uiRejects,
  uiTestActor,
  uiTestDescriptor,
  uiTestPackage,
  uiTestSelection,
} from "./plugin-ui.test-support.ts";

function mixedCatalogFixture() {
  const f = uiFixture();
  const unsupported = [
    {
      descriptor: parsePluginPackageDescriptor({
        ...uiTestDescriptor,
        pluginId: "example.node",
        entrypoints: { node: "node.mjs", ui: null },
        contributions: [],
      }),
      code: "plugin_ui_mode_unsupported",
    },
    {
      descriptor: parsePluginPackageDescriptor({
        ...uiTestDescriptor,
        pluginId: "example.isolated",
        entrypoints: {
          node: "node.mjs",
          ui: { path: "ui.html", mode: "isolatedWeb" },
        },
        files: [
          ...uiTestDescriptor.files,
          { ...uiTestDescriptor.files[0]!, path: "ui.html" },
        ],
      }),
      code: "plugin_ui_mode_unsupported",
    },
    {
      descriptor: parsePluginPackageDescriptor({
        ...uiTestDescriptor,
        pluginId: "example.settings",
        contributions: [
          {
            id: "preferences",
            kind: "settings",
            slot: "settings.section",
            title: "Preferences",
          },
        ],
      }),
      code: "plugin_ui_contribution_unsupported",
    },
  ];
  const packages = new Map([[uiTestPackage.packageDigest, uiTestPackage]]);
  const selections = new Map([[uiTestSelection.pluginId, uiTestSelection]]);
  const descriptors = new Map([[uiTestDescriptor.pluginId, uiTestDescriptor]]);
  const errors = new Map<string, Error>();
  unsupported.forEach((item, index) => {
    const pkg = parseInstalledPluginPackage({
      ...uiTestPackage,
      pluginId: item.descriptor.pluginId,
      packageDigest: `sha256:${(index + 1).toString().repeat(64)}`,
    });
    const selection = parsePluginSelection({
      ...uiTestSelection,
      pluginId: pkg.pluginId,
      selectedPackageDigest: pkg.packageDigest,
    });
    packages.set(pkg.packageDigest, pkg);
    selections.set(pkg.pluginId, selection);
    descriptors.set(pkg.pluginId, item.descriptor);
    errors.set(pkg.pluginId, new ApplicationError("conflict", item.code));
  });
  f.store.loadSelection = async ({ pluginId }) =>
    selections.get(pluginId) ?? null;
  f.store.loadPackage = async ({ packageDigest }) =>
    packages.get(packageDigest) ?? null;
  f.store.listSelections = async () => ({
    selections: [...selections.values()].sort((a, b) =>
      a.pluginId < b.pluginId ? -1 : 1,
    ),
    next: null,
  });
  f.state.beforeVerify = async () => {
    const pluginId = f.state.contexts.at(-1)!.selection.pluginId;
    const error = errors.get(pluginId);
    if (error) throw error;
    f.state.verifyOverride = {
      descriptor: descriptors.get(pluginId)!,
      publicAssets: ["ui.mjs"],
    };
  };
  return { ...f, selections, descriptors, errors, unsupported };
}

test("catalog retains valid UI alongside enabled Node-only, isolated and settings-only packages", async () => {
  const f = mixedCatalogFixture();
  const result = await f.service.catalog(uiTestActor, {
    afterPluginId: null,
    limit: 4,
  });
  assert.deepEqual(
    result.plugins.map((item) => item.descriptor.pluginId),
    ["example.story"],
  );
  assert.equal(result.next, null);
  assert.deepEqual(
    f.state.contexts.map((item) => item.selection.pluginId),
    ["example.isolated", "example.node", "example.settings", "example.story"],
  );
  assert.equal(
    f.state.calls.some((call) => call === "authorize:mount"),
    false,
  );
  for (const item of f.unsupported) {
    const selection = f.selections.get(item.descriptor.pluginId)!;
    await uiRejects(
      () =>
        f.service.openMount(uiTestActor, {
          pluginId: selection.pluginId,
          contributionId: item.descriptor.contributions[0]?.id ?? "workbench",
          expectedSelectionRevision: selection.revision,
          expectedPackageDigest: selection.selectedPackageDigest!,
        }),
      "conflict",
      item.code,
    );
  }
});

test("catalog skips only the two exact unsupported conflicts and preserves authorization and byte failures", async () => {
  for (const error of [
    new ApplicationError("authorization", "plugin_ui_mode_unsupported"),
    new ApplicationError("authorization", "plugin_ui_publication_denied"),
    new ApplicationError("internal", "plugin_ui_installed_bytes_mismatch"),
    new ApplicationError("conflict", "plugin_ui_asset_lease_mismatch"),
  ]) {
    const f = mixedCatalogFixture();
    f.errors.set("example.isolated", error);
    await uiRejects(
      () => f.service.catalog(uiTestActor, { afterPluginId: null, limit: 4 }),
      error.category,
      error.code,
    );
  }
  const f = mixedCatalogFixture();
  f.errors.set("example.isolated", new Error("plugin_ui_mode_unsupported"));
  await uiRejects(
    () => f.service.catalog(uiTestActor, { afterPluginId: null, limit: 4 }),
    "internal",
    "plugin_ui_unavailable",
  );
});

test("unsupported-package skips still fence current profile, epoch and selection after verify awaits", async () => {
  for (const change of ["profile", "epoch", "selection"] as const) {
    const f = mixedCatalogFixture();
    f.state.beforeVerify = async () => {
      if (change === "profile")
        f.state.scope = { ...f.state.scope, profileId: "other-profile" };
      else if (change === "epoch") f.state.epoch = "epoch-b";
      else {
        const current = f.selections.get("example.isolated")!;
        f.selections.set(
          current.pluginId,
          parsePluginSelection({ ...current, revision: current.revision + 1 }),
        );
      }
      throw new ApplicationError("conflict", "plugin_ui_mode_unsupported");
    };
    await uiRejects(
      () => f.service.catalog(uiTestActor, { afterPluginId: null, limit: 4 }),
      change === "selection" ? "conflict" : "authorization",
      change === "selection"
        ? "plugin_ui_selection_changed"
        : change === "profile"
          ? "plugin_ui_profile_changed"
          : "plugin_ui_authority_changed",
    );
  }
});

test("unsupported metadata cannot conceal a mismatched package identity", async () => {
  const f = mixedCatalogFixture();
  f.errors.delete("example.isolated");
  f.descriptors.set(
    "example.isolated",
    parsePluginPackageDescriptor({
      ...f.descriptors.get("example.isolated")!,
      pluginId: "wrong.plugin",
    }),
  );
  await uiRejects(
    () => f.service.catalog(uiTestActor, { afterPluginId: null, limit: 4 }),
    "internal",
    "plugin_ui_output_invalid",
  );
});
