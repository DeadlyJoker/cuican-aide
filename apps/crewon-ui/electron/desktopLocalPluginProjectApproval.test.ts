import { existsSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { composeDesktopLocalPluginProjectApproval } from "./desktopLocalPluginProjectApproval.ts";
import {
  desktopLocalPluginSourceImportFixture,
  importProjectSettings,
  sourceConfirmation,
} from "./desktopLocalPluginSourceImport.test-support.ts";
import {
  parseDesktopPluginApproval,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

const fixtures: ReturnType<typeof desktopLocalPluginSourceImportFixture>[] = [];
function fixture() {
  const f = desktopLocalPluginSourceImportFixture();
  fixtures.push(f);
  f.writeDescriptor({
    ...f.descriptor,
    entrypoints: { node: null, ui: f.descriptor.entrypoints.ui },
    businessManifestPath: null,
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
      {
        service: "crewon.plugin-ui-recovery",
        apiVersion: "1",
        optional: false,
      },
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
const publish = { publicAssets: ["ui/entry.mjs"], trustUiModule: true };

it("explicit optional planning declaration publishes only same-source metadata and survives original cold Main bootstrap", async () => {
  const f = fixture();
  f.writeDescriptor({
    ...f.descriptor,
    entrypoints: { node: "node/entry.mjs", ui: f.descriptor.entrypoints.ui },
    businessManifestPath: "business/manifest.json",
    requires: [
      "crewon.creative-projects",
      "crewon.project-texts",
      "crewon.project-conversations",
      "crewon.project-text-plans",
      "crewon.project-planning-drafts",
    ].map((service) => ({ service, apiVersion: "1", optional: true })),
  });
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  if (saved.schemaVersion === "crewon.desktop-plugin-approval.v1")
    throw new Error("planning metadata missing");
  const source = {
    pluginId: preview.pluginId,
    packageDigest: preview.packageDigest,
    contributionId: "studio",
  };
  expect(saved.projects.planningDrafts).toEqual({ publications: [source] });
  for (const key of [
    "pluginUi",
    "textUi",
    "conversations",
    "textPlans",
  ] as const)
    expect(saved.projects[key]?.publications).toEqual([source]);
  expect(Object.hasOwn(saved.projects, "pluginGenerations")).toBe(false);
  expect(Object.hasOwn(saved.projects, "historicalQueries")).toBe(false);
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.dataDirectory,
    actor: DESKTOP_RUNTIME_OWNER,
    sessionEntropy: "actual-planning-metadata-bootstrap-000001",
  });
  expect(bootstrap).not.toBeNull();
  await bootstrap?.cleanup();
});
it("planning metadata cannot be appended without the actual same-source prerequisite declarations", async () => {
  const f = fixture();
  f.writeApproval(f.originalApproval);
  f.writeDescriptor({
    ...f.descriptor,
    entrypoints: { node: "node/entry.mjs", ui: f.descriptor.entrypoints.ui },
    businessManifestPath: "business/manifest.json",
    requires: [
      "crewon.creative-projects",
      "crewon.project-texts",
      "crewon.project-conversations",
      "crewon.project-planning-drafts",
    ].map((service) => ({ service, apiVersion: "1", optional: true })),
  });
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await expect(
    owner.confirmPreview(sourceConfirmation(preview, publish)),
  ).rejects.toThrow();
  expect(f.approval()).toEqual(f.originalApproval);
});

it("explicit dual-entry plan declaration adds only exact plan metadata membership and survives a real cold bootstrap", async () => {
  const f = fixture();
  f.writeDescriptor({
    ...f.descriptor,
    entrypoints: { node: "node/entry.mjs", ui: f.descriptor.entrypoints.ui },
    businessManifestPath: "business/manifest.json",
    requires: [
      "crewon.creative-projects",
      "crewon.project-texts",
      "crewon.project-conversations",
      "crewon.project-text-plans",
    ].map((service) => ({ service, apiVersion: "1", optional: true })),
  });
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  if (saved.schemaVersion === "crewon.desktop-plugin-approval.v1")
    throw new Error("plan metadata missing");
  const pin = {
    pluginId: preview.pluginId,
    packageDigest: preview.packageDigest,
    contributionId: "studio",
  };
  expect(saved.projects.textPlans).toEqual({ publications: [pin] });
  expect(Object.hasOwn(saved.projects, "planningDrafts")).toBe(false);
  expect(saved.projects.pluginUi).toEqual({ publications: [pin] });
  expect("pluginGenerations" in saved.projects).toBe(false);
  expect(Object.hasOwn(saved.projects, "delegation")).toBe(false);
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.dataDirectory,
    actor: DESKTOP_RUNTIME_OWNER,
    sessionEntropy: "real-plan-metadata-bootstrap-session-00001",
  });
  expect(bootstrap).not.toBeNull();
  await bootstrap?.cleanup();
  expect(existsSync(f.marker)).toBe(false);
});

it("plan metadata cannot be imported with a missing declared text or conversation prerequisite", async () => {
  const f = fixture();
  f.writeApproval(f.originalApproval);
  f.writeDescriptor({
    ...f.descriptor,
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
      {
        service: "crewon.project-text-plans",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await expect(
    owner.confirmPreview(sourceConfirmation(preview, publish)),
  ).rejects.toThrow();
  expect(f.approval()).toEqual(f.originalApproval);
});

it("first explicit UI import creates exact local metadata approval and a cold original bootstrap without history, targets or funds", async () => {
  const f = fixture();
  const owner = f.create();
  const preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  expect(saved.schemaVersion).toBe("crewon.desktop-plugin-approval.v2");
  if (saved.schemaVersion === "crewon.desktop-plugin-approval.v1")
    throw new Error("metadata approval missing");
  const pin = {
    pluginId: preview.pluginId,
    packageDigest: preview.packageDigest,
    contributionId: "studio",
  };
  expect(saved.projects).toEqual({
    version: "crewon.desktop-project-history.v1",
    pluginUi: { publications: [pin] },
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [{ ...pin, actions: [] }],
    },
  });
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.dataDirectory,
    actor: DESKTOP_RUNTIME_OWNER,
    sessionEntropy: "real-local-metadata-cold-bootstrap-session-0001",
  });
  expect(bootstrap).not.toBeNull();
  await bootstrap?.cleanup();
  expect(existsSync(f.marker)).toBe(false);
});

it("source-only confirmation and optional requirements keep the original v1 behavior", async () => {
  const first = fixture();
  const firstOwner = first.create();
  const sourceOnly = await firstOwner.previewDirectory(first.source);
  await firstOwner.confirmPreview(sourceConfirmation(sourceOnly));
  expect(first.approval().schemaVersion).toBe(
    "crewon.desktop-plugin-approval.v1",
  );
  expect(first.approval().projects).toBeUndefined();
  const second = fixture();
  second.writeDescriptor({
    ...second.descriptor,
    requires: second.descriptor.requires.map((item) => ({
      ...item,
      optional: true,
    })),
  });
  const secondOwner = second.create();
  const optional = await secondOwner.previewDirectory(second.source);
  await secondOwner.confirmPreview(sourceConfirmation(optional, publish));
  expect(second.approval().schemaVersion).toBe(
    "crewon.desktop-plugin-approval.v1",
  );
  expect(second.approval().projects).toBeUndefined();
});

it("an explicitly trusted dual-entry UI receives declared optional metadata without approving generation", async () => {
  const f = fixture();
  f.writeDescriptor({
    ...f.descriptor,
    entrypoints: { node: "node/entry.mjs", ui: f.descriptor.entrypoints.ui },
    businessManifestPath: "business/manifest.json",
    requires: f.descriptor.requires.map((item) => ({
      ...item,
      optional: true,
    })),
  });
  const owner = f.create();
  const preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  expect(saved.schemaVersion).toBe("crewon.desktop-plugin-approval.v2");
  if (saved.schemaVersion === "crewon.desktop-plugin-approval.v1")
    throw new Error("metadata approval missing");
  const pin = {
    pluginId: preview.pluginId,
    packageDigest: preview.packageDigest,
    contributionId: "studio",
  };
  expect(saved.projects).toEqual({
    version: "crewon.desktop-project-history.v1",
    pluginUi: { publications: [pin] },
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [{ ...pin, actions: [] }],
    },
  });
  expect(existsSync(f.marker)).toBe(false);
});

it.each([
  "crewon.desktop-plugin-approval.v2",
  "crewon.desktop-plugin-approval.v3",
] as const)(
  "import appends metadata while preserving every existing %s declaration",
  async (schemaVersion) => {
    const f = fixture();
    const projects = importProjectSettings(schemaVersion, f.existingSource);
    f.writeApproval({ ...f.originalApproval, schemaVersion, projects });
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    await owner.confirmPreview(sourceConfirmation(preview, publish));
    const saved = f.approval();
    expect(saved.schemaVersion).toBe(schemaVersion);
    expect(saved.sources[0]).toEqual(f.existingSource);
    expect(saved.publications[0]).toEqual(f.existingPublication);
    for (const [key, value] of Object.entries(projects)) {
      if (key === "pluginUi" || key === "uiRecovery") {
        if (
          value === null ||
          typeof value !== "object" ||
          !("publications" in value)
        )
          throw new Error("missing prior publication");
        expect(
          saved.projects[key].publications.slice(0, value.publications.length),
        ).toEqual(value.publications);
      } else expect(saved.projects[key]).toEqual(value);
    }
    expect(saved.projects.pluginUi.publications.at(-1).packageDigest).toBe(
      preview.packageDigest,
    );
    expect(saved.projects.uiRecovery.publications.at(-1).actions).toEqual([]);
  },
);

it("metadata derivation rejects a foreign exact package and altered bytes before the original approval commit", async () => {
  const f = fixture();
  const owner = f.create();
  const preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const approved = parseDesktopPluginApproval(f.approval());
  expect(() =>
    composeDesktopLocalPluginProjectApproval({
      approval: approved,
      descriptor: f.descriptor,
      packageDigest: `sha256:${"f".repeat(64)}`,
    }),
  ).toThrow();
  const fresh = fixture();
  const freshOwner = fresh.create();
  const pending = await freshOwner.previewDirectory(fresh.source);
  writeFileSync(
    fresh.descriptorPath,
    JSON.stringify({ ...fresh.descriptor, requires: [] }),
  );
  await expect(
    freshOwner.confirmPreview(sourceConfirmation(pending, publish)),
  ).rejects.toThrow();
  expect(existsSync(fresh.approvalPath)).toBe(false);
  expect(fresh.commits).toBe(0);
});

it("explicit dual-entry text UI import opts into only its own text store/publication and preserves existing execution pins", async () => {
  const f = fixture();
  const previous = parseDesktopPluginApproval({
    ...f.originalApproval,
    schemaVersion: "crewon.desktop-plugin-approval.v3",
    projects: importProjectSettings(
      "crewon.desktop-plugin-approval.v3",
      f.existingSource,
    ),
  });
  f.writeApproval(previous);
  f.writeDescriptor({
    ...f.descriptor,
    entrypoints: { node: "node/entry.mjs", ui: f.descriptor.entrypoints.ui },
    businessManifestPath: "business/manifest.json",
    requires: [
      { service: "crewon.project-texts", apiVersion: "1", optional: true },
      {
        service: "crewon.project-text-recovery",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  const owner = f.create();
  const preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  if (
    saved.schemaVersion !== "crewon.desktop-plugin-approval.v3" ||
    previous.schemaVersion !== "crewon.desktop-plugin-approval.v3"
  )
    throw new Error("execution fixture required");
  const { textArtifacts, textUi, textRecovery, ...original } = saved.projects;
  expect(original).toEqual(previous.projects);
  expect(textArtifacts).toEqual({ version: "crewon.project-text.v1" });
  expect(textRecovery).toEqual(textUi);
  expect(textUi).toEqual({
    publications: [
      {
        pluginId: preview.pluginId,
        packageDigest: preview.packageDigest,
        contributionId: "studio",
      },
    ],
  });
  expect(existsSync(f.marker)).toBe(false);
});
