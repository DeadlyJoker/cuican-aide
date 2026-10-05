import { afterEach, expect, it } from "vitest";
import {
  parseDesktopPluginApproval,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  desktopLocalPluginSourceImportFixture,
  sourceConfirmation,
} from "./desktopLocalPluginSourceImport.test-support.ts";
const fixtures: ReturnType<typeof desktopLocalPluginSourceImportFixture>[] = [];
const declarations = [
  "crewon.creative-projects",
  "crewon.project-texts",
  "crewon.project-conversations",
  "crewon.project-assets",
  "crewon.project-asset-recovery",
  "crewon.project-asset-tools",
  "crewon.project-asset-context",
  "crewon.project-asset-stages",
];
function fixture(services = declarations) {
  const f = desktopLocalPluginSourceImportFixture();
  fixtures.push(f);
  f.writeDescriptor({
    ...f.descriptor,
    entrypoints: { node: "node/entry.mjs", ui: f.descriptor.entrypoints.ui },
    businessManifestPath: "business/manifest.json",
    requires: services.map((service) => ({
      service,
      apiVersion: "1",
      optional: true,
    })),
  });
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
it("actual source approval and cold Main bootstrap publish independent same-source asset metadata/stage without tasks or funds", async () => {
  const f = fixture(),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(
    sourceConfirmation(preview, {
      publicAssets: ["ui/entry.mjs"],
      trustUiModule: true,
    }),
  );
  const saved = parseDesktopPluginApproval(f.approval());
  if (saved.schemaVersion === "crewon.desktop-plugin-approval.v1")
    throw new Error("metadata absent");
  const pin = {
    pluginId: preview.pluginId,
    packageDigest: preview.packageDigest,
    contributionId: "studio",
  };
  expect(saved.projects.assetArtifacts).toEqual({
    version: "crewon.project-asset.v1",
  });
  expect(saved.projects.assetUi).toEqual({ publications: [pin] });
  expect(saved.projects.assetRecovery).toEqual({ publications: [pin] });
  expect(saved.projects.assetStages).toEqual({
    version: "crewon.project-asset-stages.v1",
    publications: [pin],
  });
  expect(Object.hasOwn(saved.projects, "pluginGenerations")).toBe(false);
  expect(Object.hasOwn(saved.projects, "networkGrants")).toBe(false);
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.dataDirectory,
    actor: DESKTOP_RUNTIME_OWNER,
    sessionEntropy: "independent-assets-cold-bootstrap-00000001",
  });
  expect(bootstrap).not.toBeNull();
  await bootstrap?.cleanup();
});
it("old 18 declarations remain absent while metadata UI alone never gains asset stage execution", async () => {
  const f = fixture(declarations.slice(0, 3)),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(
    sourceConfirmation(preview, {
      publicAssets: ["ui/entry.mjs"],
      trustUiModule: true,
    }),
  );
  const old = parseDesktopPluginApproval(f.approval());
  if (old.schemaVersion === "crewon.desktop-plugin-approval.v1")
    throw new Error("metadata absent");
  for (const k of ["assetArtifacts", "assetUi", "assetRecovery", "assetStages"])
    expect(Object.hasOwn(old.projects, k)).toBe(false);
  const ui = fixture([
      "crewon.creative-projects",
      "crewon.project-texts",
      "crewon.project-assets",
    ]),
    uiOwner = ui.create(),
    p = await uiOwner.previewDirectory(ui.source);
  await uiOwner.confirmPreview(
    sourceConfirmation(p, {
      publicAssets: ["ui/entry.mjs"],
      trustUiModule: true,
    }),
  );
  const saved = parseDesktopPluginApproval(ui.approval());
  if (saved.schemaVersion === "crewon.desktop-plugin-approval.v1")
    throw new Error("metadata absent");
  expect(saved.projects.assetUi?.publications).toHaveLength(1);
  expect(Object.hasOwn(saved.projects, "assetStages")).toBe(false);
  expect(Object.hasOwn(saved.projects, "assetRecovery")).toBe(false);
});
it.each([
  "crewon.creative-projects",
  "crewon.project-texts",
  "crewon.project-assets",
  "crewon.project-conversations",
  "crewon.project-asset-context",
  "crewon.project-asset-tools",
])(
  "stage missing %s refuses exact approval without partial publication",
  async (missing) => {
    const f = fixture(declarations.filter((v) => v !== missing));
    f.writeApproval(f.originalApproval);
    const owner = f.create(),
      preview = await owner.previewDirectory(f.source);
    const before = f.approval();
    await expect(
      owner.confirmPreview(
        sourceConfirmation(preview, {
          publicAssets: ["ui/entry.mjs"],
          trustUiModule: true,
        }),
      ),
    ).rejects.toThrow();
    expect(f.approval()).toEqual(before);
  },
);
