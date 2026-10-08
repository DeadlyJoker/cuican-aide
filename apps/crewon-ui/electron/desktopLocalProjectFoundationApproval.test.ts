import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseDesktopPluginConfiguration } from "../../control-api/src/desktop-plugin-configuration.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  parseDesktopPluginApproval,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { composeDesktopLocalProjectFoundationApproval } from "./desktopLocalProjectFoundationApproval.ts";
import {
  desktopLocalPluginSourceImportFixture,
  sourceConfirmation,
} from "./desktopLocalPluginSourceImport.test-support.ts";

const fixtures: ReturnType<typeof desktopLocalPluginSourceImportFixture>[] = [];
function fixture(
  services: readonly string[] = [
    "crewon.project-foundation",
    "crewon.project-source-uploads",
  ],
) {
  const f = desktopLocalPluginSourceImportFixture();
  fixtures.push(f);
  f.writeDescriptor({
    ...f.descriptor,
    pluginId: "crewon.short-drama",
    version: "40.0.0",
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: true },
      ...services.map((service) => ({
        service,
        apiVersion: "1",
        optional: true,
      })),
    ],
  });
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

it("original Main import independently approves both explicitly trusted UI services and cold bootstrap reaches the original Control parser", async () => {
  const f = fixture(),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  if (saved.schemaVersion !== "crewon.desktop-plugin-approval.v3")
    throw new Error("missing v3 UI declaration");
  const publication = {
    pluginId: preview.pluginId,
    packageDigest: preview.packageDigest,
    contributionId: "studio",
  };
  expect(saved.projectFoundation).toEqual({
    version: "crewon.project-foundation.v1",
    pluginUi: { publications: [publication] },
    uploads: {
      version: "crewon.project-source-uploads.v1",
      pluginUi: { publications: [publication] },
    },
  });
  expect(saved.projectFoundationTools).toBeUndefined();
  expect(saved.projects.version).toBe("crewon.desktop-project-execution.v1");
  for (const entropy of [
    "actual-ui-foundation-bootstrap-000001",
    "actual-ui-foundation-bootstrap-000002",
  ]) {
    const bootstrap = await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: entropy,
    });
    expect(bootstrap).not.toBeNull();
    const configuration = parseDesktopPluginConfiguration(
      JSON.parse(readFileSync(bootstrap!.bootstrapPath, "utf8")),
    );
    if (configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      throw new Error("missing v3 bootstrap");
    expect(configuration.projectFoundation).toEqual(saved.projectFoundation);
    await bootstrap!.cleanup();
  }
  expect(existsSync(f.marker)).toBe(false);
  expect(existsSync(join(f.dataDirectory, "control.sqlite"))).toBe(false);
  expect(existsSync(join(f.dataDirectory, "plugin-native-policy.json"))).toBe(
    false,
  );
});

it("Foundation and upload UI publications are independently requested; missing UI consent or publication grants neither", async () => {
  for (const services of [
    ["crewon.project-foundation"],
    ["crewon.project-source-uploads"],
  ]) {
    const f = fixture(services),
      owner = f.create(),
      preview = await owner.previewDirectory(f.source);
    await owner.confirmPreview(sourceConfirmation(preview, publish));
    const saved = parseDesktopPluginApproval(f.approval());
    if (saved.schemaVersion !== "crewon.desktop-plugin-approval.v3")
      throw new Error("missing declaration");
    expect(Boolean(saved.projectFoundation?.pluginUi)).toBe(
      services.includes("crewon.project-foundation"),
    );
    expect(Boolean(saved.projectFoundation?.uploads.pluginUi)).toBe(
      services.includes("crewon.project-source-uploads"),
    );
  }
  const f = fixture(),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(
    sourceConfirmation(preview, {
      ...publish,
      publicAssets: [],
      trustUiModule: false,
    }),
  );
  expect(Object.hasOwn(f.approval(), "projectFoundation")).toBe(false);
});

it("the Main UI composition preserves legacy absence and rejects wrong source identity or metadata contribution", async () => {
  const f = fixture(),
    owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  const input = {
    approval: saved,
    descriptor: f.descriptor,
    packageDigest: preview.packageDigest,
    trustUiModule: true,
  };
  expect(composeDesktopLocalProjectFoundationApproval(input)).toEqual(saved);
  expect(() =>
    composeDesktopLocalProjectFoundationApproval({
      ...input,
      descriptor: { ...f.descriptor, version: "39.0.0" },
    }),
  ).toThrow();
  expect(() =>
    composeDesktopLocalProjectFoundationApproval({
      ...input,
      descriptor: {
        ...f.descriptor,
        contributions: [
          {
            id: "foreign",
            kind: "module",
            slot: "main.content",
            title: "Foreign",
          },
        ],
      },
    }),
  ).toThrow();
  const v1 = f.originalApproval,
    v2 = {
      ...saved,
      schemaVersion: "crewon.desktop-plugin-approval.v2",
      projects: {
        version: "crewon.desktop-project-history.v1",
        pluginUi: {
          publications: [
            {
              pluginId: preview.pluginId,
              packageDigest: preview.packageDigest,
              contributionId: "studio",
            },
          ],
        },
      },
    };
  delete (v2 as Record<string, unknown>).projectFoundation;
  expect(parseDesktopPluginApproval(v1)).toEqual(v1);
  expect(parseDesktopPluginApproval(v2)).toEqual(v2);
  for (const value of [
    {
      ...v1,
      projectFoundation:
        saved.schemaVersion === "crewon.desktop-plugin-approval.v3"
          ? saved.projectFoundation
          : undefined,
    },
    { ...v2, projectFoundation: undefined },
    { ...saved, projectFoundation: undefined },
    {
      ...saved,
      projectFoundation: {
        version: "crewon.project-foundation.v2",
        uploads: { version: "crewon.project-source-uploads.v1" },
      },
    },
  ])
    expect(() => parseDesktopPluginApproval(value)).toThrow();
});

const releaseDirectory =
  process.env.CREWON_TEST_SHORT_DRAMA_FOUNDATION_PLUGIN_DIR;
it.skipIf(!releaseDirectory)(
  "actual released Short40 import forwards both UI services and the independent Node declaration through cold Main bootstrap",
  async () => {
    const f = desktopLocalPluginSourceImportFixture();
    fixtures.push(f);
    const owner = f.create(),
      preview = await owner.previewDirectory(releaseDirectory!);
    expect(preview.version).toBe("40.0.0");
    expect(preview.packageDigest).toBe(
      "sha256:64654c5d6ad0d3eb312aef805cc359fcb5a015ea140a19fab72aaab625936c5a",
    );
    await owner.confirmPreview(
      sourceConfirmation(preview, {
        ...publish,
        publicAssets: [preview.uiEntry!.path],
      }),
    );
    const saved = parseDesktopPluginApproval(f.approval());
    if (saved.schemaVersion !== "crewon.desktop-plugin-approval.v3")
      throw new Error("missing v3");
    expect(saved.projectFoundation?.pluginUi?.publications).toHaveLength(1);
    expect(
      saved.projectFoundation?.uploads.pluginUi?.publications,
    ).toHaveLength(1);
    expect(saved.projectFoundationTools?.publications).toHaveLength(1);
    const bootstrap = await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: "actual-released-short40-cold-ui-000001",
    });
    const configuration = parseDesktopPluginConfiguration(
      JSON.parse(readFileSync(bootstrap!.bootstrapPath, "utf8")),
    );
    if (configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      throw new Error("missing bootstrap");
    expect(configuration.projectFoundation).toEqual(saved.projectFoundation);
    expect(configuration.projectFoundationTools).toEqual(
      saved.projectFoundationTools,
    );
    await bootstrap!.cleanup();
    expect(existsSync(join(f.dataDirectory, "plugin-native-policy.json"))).toBe(
      false,
    );
    expect(existsSync(join(f.dataDirectory, "control.sqlite"))).toBe(false);
  },
);
