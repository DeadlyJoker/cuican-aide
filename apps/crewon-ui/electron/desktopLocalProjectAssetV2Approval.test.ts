import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseExtensionManifest } from "@crewon/domain";
import { executionSetupFixture } from "./desktopLocalPluginExecutionSetup.test-support.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
} from "./desktopPluginBootstrap.ts";
import { assertDesktopLocalShortDramaExecutionContract } from "./desktopLocalShortDramaExecutionContract.ts";
import { composeDesktopLocalProjectAssetV2Approval } from "./desktopLocalProjectAssetV2Approval.ts";
const owners: Awaited<ReturnType<typeof executionSetupFixture>>[] = [];
afterEach(async () => {
  for (const f of owners.splice(0)) await f.cleanup();
});
async function fixture() {
  const actualPackage = process.env.CREWON_SHORT_DRAMA_V2_TEST_PACKAGE;
  const f = await executionSetupFixture({
    packageDirectory:
      actualPackage ??
      resolve(
        "../../output/extensions/installable-plugins/short-drama-media-output-ui-20261007/short-drama/30.0.0",
      ),
    ...(actualPackage ? {} : { assetUiProtocol: "2" as const }),
    contract: "assets",
    projectContext: true,
  });
  owners.push(f);
  return f;
}
async function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  approveMediaGenerations = false,
) {
  const setup = f.create();
  const preview = await setup.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
    ...(approveMediaGenerations ? { approveMediaGenerations: true } : {}),
  });
  await f.stop();
  await setup.commitPolicyWhileStopped(claim);
  await f.start();
  const mapping = await setup.captureProjectMappingWhileRunning(
    claim,
    f.fakePreparedRuntime(),
  );
  await f.stop();
  await setup.commitProjectMappingWhileStopped(mapping);
  await f.start();
  await setup.verifyPreparedWhileRunning(claim, f.fakePreparedRuntime());
  return preview;
}
function projects(f: Awaited<ReturnType<typeof fixture>>) {
  const b = assertDesktopPluginBootstrapIssued(f.bootstrap);
  if (b.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
    throw new Error("v3_required");
  return b.projects;
}
it("Main installs an independent V2 descriptor and issues exact asset/result scopes only after existing workflow setup, then cold-reopens idempotently", async () => {
  const f = await fixture();
  const before = readFileSync(f.approvalPath);
  const preview = await f
    .create()
    .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId });
  expect(preview.mediaInputPreparation?.workflows).toHaveLength(2);
  expect(readFileSync(f.approvalPath)).toEqual(before);
  await prepare(f);
  expect(projects(f).assetUi?.publications).toHaveLength(1);
  expect(projects(f).assetV2).toBeUndefined();
  expect(projects(f).mediaResults).toBeUndefined();
  await prepare(f, true);
  const publication = {
    pluginId: f.identity.pluginId,
    packageDigest: f.identity.packageDigest,
    contributionId: "workbench",
  };
  expect(projects(f).assetV2).toEqual({
    version: "crewon.desktop-project-assets.v2",
    publications: [publication],
  });
  expect(projects(f).mediaResults).toEqual({
    version: "crewon.desktop-project-media-results.v1",
    purposes: ["read", "publish"],
    publications: [publication],
  });
  expect(projects(f).assetRecovery).toBeUndefined();
  const saved = readFileSync(f.approvalPath);
  const approval = parseDesktopPluginApproval(JSON.parse(saved.toString()));
  if (approval.schemaVersion !== "crewon.desktop-plugin-approval.v3")
    throw new Error("v3_required");
  const ownReadOnly = {
    ...approval,
    projects: {
      ...approval.projects,
      mediaResults: {
        version: "crewon.desktop-project-media-results.v1" as const,
        purposes: ["read"] as const,
        publications: [publication],
      },
    },
  };
  expect(
    composeDesktopLocalProjectAssetV2Approval({
      approval: ownReadOnly,
      descriptor: f.installed.descriptor,
      packageDigest: f.identity.packageDigest,
    }),
  ).toEqual(approval);
  expect(() =>
    composeDesktopLocalProjectAssetV2Approval({
      approval: {
        ...ownReadOnly,
        projects: {
          ...ownReadOnly.projects,
          mediaResults: {
            ...ownReadOnly.projects.mediaResults,
            publications: [
              publication,
              { ...publication, packageDigest: "sha256:" + "f".repeat(64) },
            ],
          },
        },
      },
      descriptor: f.installed.descriptor,
      packageDigest: f.identity.packageDigest,
    }),
  ).toThrow("desktop_plugin_asset_v2_setup_invalid");
  await prepare(f);
  expect(readFileSync(f.approvalPath)).toEqual(saved);
  await f.stop();
  await f.start();
  expect(projects(f).assetV2?.publications).toEqual([publication]);
});
it("Main rejects mixed protocols and foreign/unpublished V2 grants instead of granting fallback access", async () => {
  const f = await fixture();
  await prepare(f, true);
  const d = f.installed.descriptor,
    manifest = parseExtensionManifest(
      JSON.parse(readFileSync(join(f.source, "business.json"), "utf8")),
    );
  for (const service of [
    "crewon.project-assets",
    "crewon.project-asset-recovery",
  ]) {
    const changed = {
      ...d,
      requires: d.requires.map((r) =>
        r.service === service ? { ...r, apiVersion: "1" } : r,
      ),
    };
    expect(() =>
      assertDesktopLocalShortDramaExecutionContract(changed, manifest),
    ).toThrow();
  }
  const approval = parseDesktopPluginApproval(
    JSON.parse(readFileSync(f.approvalPath, "utf8")),
  );
  expect(
    composeDesktopLocalProjectAssetV2Approval({
      approval,
      descriptor: d,
      packageDigest: f.identity.packageDigest,
    }),
  ).toEqual(approval);
  const valid = {
    approval,
    descriptor: d,
    packageDigest: f.identity.packageDigest,
  };
  expect(() =>
    composeDesktopLocalProjectAssetV2Approval({
      ...valid,
      packageDigest: `sha256:${"f".repeat(64)}`,
    }),
  ).toThrow();
  for (const service of [
    "crewon.project-assets",
    "crewon.project-asset-recovery",
    "crewon.project-media-results",
    "crewon.project-media-result-actions",
  ]) {
    expect(() =>
      composeDesktopLocalProjectAssetV2Approval({
        ...valid,
        descriptor: {
          ...d,
          requires: d.requires.filter((r) => r.service !== service),
        },
      }),
    ).toThrow();
  }
  expect(() =>
    composeDesktopLocalProjectAssetV2Approval({
      ...valid,
      descriptor: {
        ...d,
        contributions: d.contributions.map((c) => ({
          ...c,
          slot: "sidebar.navigation" as never,
        })),
      },
    }),
  ).toThrow();
});
