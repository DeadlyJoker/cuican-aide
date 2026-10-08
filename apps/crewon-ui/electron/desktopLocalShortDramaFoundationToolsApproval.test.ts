import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadInstalledPluginBusinessRegistration } from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  parseDesktopPluginApproval,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { composeDesktopLocalShortDramaFoundationToolsApproval } from "./desktopLocalShortDramaFoundationToolsApproval.ts";
import { sourceConfirmation } from "./desktopLocalPluginSourceImport.test-support.ts";
import { desktopFoundationToolsImportFixture } from "./desktopLocalShortDramaFoundationToolsApproval.test-support.ts";
const fixtures: ReturnType<typeof desktopFoundationToolsImportFixture>[] = [];
function fixture(
  options: Parameters<typeof desktopFoundationToolsImportFixture>[0] = {},
) {
  const f = desktopFoundationToolsImportFixture(options);
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
it("explicit Node consent verifies actual v2 business bytes and survives cold Main bootstrap without Comfy or UI Foundation grant", async () => {
  const f = fixture();
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  if (saved.schemaVersion !== "crewon.desktop-plugin-approval.v3")
    throw new Error("expected independent v3 declaration");
  const publication = {
    pluginId: preview.pluginId,
    packageDigest: preview.packageDigest,
    contributionId: "workbench",
  };
  expect(saved.projectFoundationTools).toEqual({
    version: "crewon.project-foundation-tools.v1",
    publications: [publication],
  });
  expect(Object.hasOwn(saved, "projectFoundation")).toBe(false);
  for (const key of [
    "resultSelections",
    "pluginGenerations",
    "pluginQueries",
    "mediaInputs",
    "mediaExecution",
  ])
    expect(Object.hasOwn(saved.projects, key)).toBe(false);
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.dataDirectory,
    actor: DESKTOP_RUNTIME_OWNER,
    sessionEntropy: "actual-foundation-node-cold-bootstrap-000001",
  });
  expect(bootstrap).not.toBeNull();
  if (bootstrap === null) throw new Error("missing bootstrap");
  const raw = JSON.parse(readFileSync(bootstrap.bootstrapPath, "utf8"));
  expect(raw.projectFoundationTools).toEqual(saved.projectFoundationTools);
  expect(raw.projects).toEqual(saved.projects);
  await bootstrap.cleanup();
  const reopened = await prepareDesktopPluginBootstrap({
    dataDirectory: f.dataDirectory,
    actor: DESKTOP_RUNTIME_OWNER,
    sessionEntropy: "actual-foundation-node-cold-bootstrap-000002",
  });
  expect(
    JSON.parse(readFileSync(reopened!.bootstrapPath, "utf8"))
      .projectFoundationTools,
  ).toEqual(saved.projectFoundationTools);
  await reopened!.cleanup();
  expect(existsSync(f.marker)).toBe(false);
  expect(
    existsSync(join(f.dataDirectory, "plugins", "installations.json")),
  ).toBe(false);
});
it("old package39 retains original approval and does not parse its intentionally non-JSON business file", async () => {
  const f = fixture({ legacy: true });
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = f.approval();
  expect(saved.schemaVersion).toBe("crewon.desktop-plugin-approval.v2");
  expect(Object.hasOwn(saved, "projectFoundationTools")).toBe(false);
  expect(existsSync(f.marker)).toBe(false);
});
it("missing Node consent, missing published module, and incorrect business declarations preserve prior approval", async () => {
  for (const mode of [
    "node-consent",
    "module-consent",
    "wrong-capability",
    "missing-operation",
  ] as const) {
    const f = fixture({
      wrongCapability: mode === "wrong-capability",
      missingOperation: mode === "missing-operation",
    });
    f.writeApproval();
    const before = f.originalBytes();
    const owner = f.create(),
      preview = await owner.previewDirectory(f.source);
    const confirmation = sourceConfirmation(preview, {
      ...publish,
      ...(mode === "node-consent" ? { trustNodeExecution: false } : {}),
      ...(mode === "module-consent"
        ? { publicAssets: [], trustUiModule: false }
        : {}),
    });
    await expect(owner.confirmPreview(confirmation)).rejects.toThrow();
    expect(f.originalBytes()).toEqual(before);
    expect(existsSync(f.pendingPath)).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
  }
});
it("a copied registration cannot manufacture a declaration and verified composition is idempotent", async () => {
  const f = fixture();
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = parseDesktopPluginApproval(f.approval());
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: join(f.dataDirectory, "plugin-import-sources"),
    expectedPluginId: preview.pluginId,
    expectedPublisherId: preview.publisherId,
    expectedVersion: preview.version,
    expectedPackageDigest: preview.packageDigest,
    signal: new AbortController().signal,
    authorizeRead: async () => "allow",
  });
  const input = {
    approval: saved,
    descriptor: f.descriptor,
    registration,
    trustNodeExecution: true,
  };
  expect(composeDesktopLocalShortDramaFoundationToolsApproval(input)).toEqual(
    saved,
  );
  expect(() =>
    composeDesktopLocalShortDramaFoundationToolsApproval({
      ...input,
      registration: { ...registration },
    }),
  ).toThrow("installed_plugin_business_registration_unverified");
  expect(() =>
    composeDesktopLocalShortDramaFoundationToolsApproval({
      ...input,
      trustNodeExecution: false,
    }),
  ).toThrow();
});
it("late original approval CAS change prevents the newly derived declaration from committing", async () => {
  const f = fixture();
  f.writeApproval();
  const changed = { ...f.originalApproval, publications: [] };
  const owner = f.create({
      async beforeApprovalCommit() {
        f.writeApproval(changed);
      },
    }),
    preview = await owner.previewDirectory(f.source);
  await expect(
    owner.confirmPreview(sourceConfirmation(preview, publish)),
  ).rejects.toThrow();
  expect(f.approval()).toEqual(changed);
  expect(existsSync(f.pendingPath)).toBe(false);
  expect(existsSync(f.marker)).toBe(false);
});

it("Main approval parser preserves absent legacy fields and rejects Node declarations outside exact v3 metadata", async () => {
  const f = fixture();
  const owner = f.create(),
    preview = await owner.previewDirectory(f.source);
  await owner.confirmPreview(sourceConfirmation(preview, publish));
  const saved = f.approval();
  const tools = saved.projectFoundationTools;
  const v1 = { ...f.originalApproval };
  const v2 = {
    ...saved,
    schemaVersion: "crewon.desktop-plugin-approval.v2",
    projects: {
      ...saved.projects,
      version: "crewon.desktop-project-history.v1",
    },
  };
  delete v2.projectFoundationTools;
  expect(parseDesktopPluginApproval(v1)).toEqual(v1);
  expect(parseDesktopPluginApproval(v2)).toEqual(v2);
  for (const input of [
    { ...v1, projectFoundationTools: tools },
    { ...v2, projectFoundationTools: tools },
    { ...saved, projectFoundationTools: undefined },
    {
      ...saved,
      projectFoundationTools: {
        ...tools,
        publications: [{ ...tools.publications[0], contributionId: "unknown" }],
      },
    },
    { ...saved, projects: { version: saved.projects.version } },
  ])
    expect(() => parseDesktopPluginApproval(input)).toThrow();
});
