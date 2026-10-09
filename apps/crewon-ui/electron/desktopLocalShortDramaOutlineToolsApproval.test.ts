import { existsSync, readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  parseDesktopPluginApproval,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { sourceConfirmation } from "./desktopLocalPluginSourceImport.test-support.ts";
import { desktopOutlineToolsImportFixture } from "./desktopLocalShortDramaOutlineToolsApproval.test-support.ts";
const fixtures: ReturnType<typeof desktopOutlineToolsImportFixture>[] = [];
function fixture(
  options: Parameters<typeof desktopOutlineToolsImportFixture>[0] = {},
) {
  const f = desktopOutlineToolsImportFixture(options);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
const publish = {
  publicAssets: ["ui/entry.mjs"],
  trustUiModule: true,
  trustNodeExecution: true,
};

it("actual immutable outline package import declares the new service and cold Main carries it without Foundation/media consent", async () => {
  const f = fixture(),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  if (saved.schemaVersion !== "crewon.desktop-plugin-approval.v3")
    throw new Error("outline declaration missing");
  expect(saved.projectOutlineTools).toEqual({
    version: "crewon.project-outline-tools.v2",
    publications: [
      {
        pluginId: preview.pluginId,
        packageDigest: preview.packageDigest,
        contributionId: "workbench",
      },
    ],
  });
  expect(saved.projectFoundationTools).toBeUndefined();
  expect(saved.projectFoundation).toBeUndefined();
  expect(Object.hasOwn(saved.projects, "mediaExecution")).toBe(false);
  for (const entropy of [
    "actual-outline-cold-bootstrap-000001",
    "actual-outline-cold-bootstrap-000002",
  ]) {
    const bootstrap = await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: entropy,
    });
    expect(bootstrap).not.toBeNull();
    expect(
      JSON.parse(readFileSync(bootstrap!.bootstrapPath, "utf8"))
        .projectOutlineTools,
    ).toEqual(saved.projectOutlineTools);
    await bootstrap!.cleanup();
  }
  expect(existsSync(f.marker)).toBe(false);
});
it("legacy package import never receives an outline declaration", async () => {
  const f = fixture({ legacy: true }),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  expect(f.approval().projectOutlineTools).toBeUndefined();
  expect(f.approval().schemaVersion).toBe("crewon.desktop-plugin-approval.v2");
});
it("missing consent/module or incorrect actual tool preserves prior approval", async () => {
  for (const mode of ["node", "module", "capability", "operation"] as const) {
    const f = fixture({
      wrongCapability: mode === "capability",
      missingOperation: mode === "operation",
    });
    f.writeApproval();
    const before = f.originalBytes();
    const owner = f.create(),
      preview = await owner.previewDirectory(f.source);
    await expect(
      owner.confirmPreview(
        sourceConfirmation(preview, {
          ...publish,
          ...(mode === "node" ? { trustNodeExecution: false } : {}),
          ...(mode === "module"
            ? { publicAssets: [], trustUiModule: false }
            : {}),
        }),
      ),
    ).rejects.toThrow();
    expect(f.originalBytes()).toEqual(before);
    expect(existsSync(f.pendingPath)).toBe(false);
  }
});
it("old Main schemas, wrong versions and foreign publication cannot carry new outline grants", async () => {
  const f = fixture(),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = f.approval();
  for (const value of [
    { ...saved, schemaVersion: "crewon.desktop-plugin-approval.v1" },
    { ...saved, schemaVersion: "crewon.desktop-plugin-approval.v2" },
    {
      ...saved,
      projectOutlineTools: {
        ...saved.projectOutlineTools,
        version: "crewon.project-foundation-tools.v1",
      },
    },
    {
      ...saved,
      projectOutlineTools: {
        ...saved.projectOutlineTools,
        publications: [
          {
            ...saved.projectOutlineTools.publications[0],
            contributionId: "foreign",
          },
        ],
      },
    },
  ])
    expect(() => parseDesktopPluginApproval(value)).toThrow();
});

it.skipIf(!process.env.CREWON_TEST_SHORT_DRAMA_PROJECT_PLUGIN_DIR)(
  "actual short47 package bytes import through original Main and retain independent Foundation and outline declarations",
  async () => {
    const f = fixture(),
      owner = f.create();
    const directory = process.env.CREWON_TEST_SHORT_DRAMA_PROJECT_PLUGIN_DIR!;
    const descriptor = JSON.parse(
      readFileSync(directory + "/crewon.plugin.json", "utf8"),
    );
    const preview = await owner.previewDirectory(directory);
    expect(preview.version).toBe("47.0.0");
    await owner.confirmPreview(
      sourceConfirmation(preview, {
        ...publish,
        publicAssets: descriptor.files
          .filter(
            (file: { path: string }) =>
              file.path !== "node.mjs" &&
              /\.(?:mjs|css|png|svg)$/.test(file.path),
          )
          .map((file: { path: string }) => file.path),
      }),
    );
    const saved = parseDesktopPluginApproval(f.approval());
    if (saved.schemaVersion !== "crewon.desktop-plugin-approval.v3")
      throw new Error("missing declarations");
    expect(saved.projectOutlineTools?.publications[0]?.packageDigest).toBe(
      preview.packageDigest,
    );
    expect(saved.projectFoundationTools?.publications[0]?.packageDigest).toBe(
      preview.packageDigest,
    );
    const bootstrap = await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: "actual-short47-cold-main-bootstrap-000001",
    });
    expect(bootstrap).not.toBeNull();
    expect(
      JSON.parse(readFileSync(bootstrap!.bootstrapPath, "utf8"))
        .projectOutlineTools,
    ).toEqual(saved.projectOutlineTools);
    await bootstrap!.cleanup();
  },
);
