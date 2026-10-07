import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { extensionCanonicalJson, parseExtensionManifest } from "@crewon/domain";
import { captureLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  executionSetupFixture,
  fixtureHash,
} from "./desktopLocalPluginExecutionSetup.test-support.ts";
import {
  captureDesktopLocalShortDramaMediaInputs,
  composeDesktopLocalShortDramaMediaInputApproval,
} from "./desktopLocalShortDramaMediaInputs.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
} from "./desktopPluginBootstrap.ts";
import { assertDesktopLocalShortDramaExecutionContract } from "./desktopLocalShortDramaExecutionContract.ts";

const directory = resolve(
  process.env.CREWON_TEST_MEDIA_SETTINGS_PACKAGE_DIR ??
    "../../output/extensions/installable-plugins/short-drama-media-input-settings-20261006/short-drama/24.0.0",
);
const owned: Awaited<ReturnType<typeof executionSetupFixture>>[] = [];
afterEach(async () => {
  for (const f of owned.splice(0)) await f.cleanup();
});
async function fixture(packageDirectory = directory) {
  const f = await executionSetupFixture({
    packageDirectory,
    version: "24.0.0",
    contract: "assets",
    projectContext: true,
  });
  owned.push(f);
  return f;
}

it("actual installed profile has exact canonical graph digests and preview does not import Node or change approvals", async () => {
  const f = await fixture();
  const before = readFileSync(f.approvalPath);
  const owner = f.create();
  const preview = await owner.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  expect(
    preview.mediaInputPreparation?.workflows.map((w) => w.workflowId),
  ).toEqual(["krea2-reference-four-view", "flux2-three-reference-storyboard"]);
  expect(preview.mediaInputPreparation?.scope).toBe("read-write-inputs");
  expect(Object.isFrozen(preview.mediaInputPreparation?.workflows[0])).toBe(
    true,
  );
  for (const workflow of preview.mediaInputPreparation!.workflows) {
    const graph = JSON.parse(
      readFileSync(
        join(f.source, "workflows", workflow.workflowId + ".api.json"),
        "utf8",
      ),
    );
    expect(workflow.workflowDigest).toBe(
      fixtureHash(extensionCanonicalJson(graph)),
    );
  }
  expect(readFileSync(f.approvalPath)).toEqual(before);
});

it("confirmed original preparation writes metadata/UI/Agent declarations then Main cold bootstrap preserves the same scope", async () => {
  const f = await fixture();
  const setup = f.create();
  const preview = await setup.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
  });
  await f.stop();
  await setup.commitPolicyWhileStopped(claim);
  await f.start();
  // Exact catalog entry is a named runtime port here; no real model or provider is invoked.
  const mapping = await setup.captureProjectMappingWhileRunning(
    claim,
    f.fakePreparedRuntime(),
  );
  await f.stop();
  await setup.commitProjectMappingWhileStopped(mapping);
  await f.start();
  await setup.verifyPreparedWhileRunning(claim, f.fakePreparedRuntime());
  const manifest = assertDesktopPluginBootstrapIssued(f.bootstrap);
  if (manifest.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
    throw new Error("expected_v3");
  const publication = {
    pluginId: f.identity.pluginId,
    packageDigest: f.identity.packageDigest,
    contributionId: "workbench",
  };
  expect(manifest.projects.mediaInputStages?.publications).toEqual([
    publication,
  ]);
  expect(manifest.projects.mediaInputUi?.publications).toEqual([publication]);
  expect(manifest.projects.mediaInputs?.purposes).toEqual(["read", "write"]);
  expect(
    manifest.projects.mediaInputs?.reviews.map(
      (r) => r.workflow.workflowDigest,
    ),
  ).toEqual(
    preview.mediaInputPreparation!.workflows.map((w) => w.workflowDigest),
  );
  expect(
    manifest.projects.mediaInputs?.reviews.every(
      (r) => r.targetIdentity.packageDigest === f.identity.packageDigest,
    ),
  ).toBe(true);
  expect(
    setup.result(claim, { stage: "mappingCommitted", runtimeStatus: "ready" })
      .state,
  ).toBe("prepared");
  expect(
    (
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId })
    )?.state,
  ).toBe("disabled");
  const config = await f.store
    .extensionStore()
    .loadLatestExtensionConfiguration({
      ...f.scope,
      pluginId: f.identity.pluginId,
    });
  expect(config).toEqual(f.configuration);
  const approved = parseDesktopPluginApproval(
    JSON.parse(readFileSync(f.approvalPath, "utf8")),
  );
  const installed = await captureLocalPluginPackage(
    { directory: f.installed.directory },
    true,
  );
  const declaration = captureDesktopLocalShortDramaMediaInputs(
    installed,
    f.configuration,
  );
  expect(
    composeDesktopLocalShortDramaMediaInputApproval({
      approval: approved,
      descriptor: installed.verification.descriptor,
      packageDigest: installed.verification.packageDigest,
      declaration,
    }),
  ).toEqual(approved);
});

it("media tool preparation requires the actual API, adapter, capability and recovery contract", async () => {
  const f = await fixture();
  const snapshot = await captureLocalPluginPackage(
    { directory: f.source },
    true,
  );
  const descriptor = snapshot.verification.descriptor;
  const manifest = parseExtensionManifest(
    JSON.parse(snapshot.files.get("business.json")!.toString()),
  );
  expect(() =>
    assertDesktopLocalShortDramaExecutionContract(descriptor, manifest),
  ).not.toThrow();
  for (const apiVersion of ["1", "2", "3"]) {
    const mediaDescriptor = {
      ...descriptor,
      requires: [
        ...descriptor.requires.filter(
          (r) => r.service !== "crewon.project-media-generations",
        ),
        {
          service: "crewon.project-media-generations",
          apiVersion,
          optional: true,
        },
      ],
    };
    const check = () =>
      assertDesktopLocalShortDramaExecutionContract(mediaDescriptor, manifest);
    if (apiVersion === "3") expect(check).toThrow();
    else expect(check).not.toThrow();
  }
  for (const service of [
    "crewon.project-media-inputs",
    "crewon.project-media-input-tools",
  ]) {
    expect(() =>
      assertDesktopLocalShortDramaExecutionContract(
        {
          ...descriptor,
          requires: descriptor.requires.map((r) =>
            r.service === service ? { ...r, apiVersion: "2" } : r,
          ),
        },
        manifest,
      ),
    ).toThrow();
  }
  for (const patch of [
    { adapterId: "crewon.project-tools" },
    { capability: "project.read" },
    { effect: "readOnly" as const },
    { recovery: "replaySafe" as const },
  ]) {
    expect(() =>
      assertDesktopLocalShortDramaExecutionContract(descriptor, {
        ...manifest,
        tools: manifest.tools.map((t) =>
          t.operationId === "media_input" ? { ...t, ...patch } : t,
        ),
      }),
    ).toThrow();
  }
});

it("frozen Short23 remains preparable without guessing a profile or adding new metadata grants", async () => {
  const f = await fixture(
    resolve(
      "../../output/extensions/installable-plugins/short-drama-media-input-agent-20261006/short-drama/23.0.0",
    ),
  );
  const preview = await f
    .create()
    .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId });
  expect(preview.mediaInputPreparation).toBeUndefined();
});

it("data-only profile parser refuses forged scope, graph digests, outputs and paths without importing code", async () => {
  const f = await fixture();
  const snapshot = await captureLocalPluginPackage(
    { directory: f.source },
    true,
  );
  const base = JSON.parse(
    snapshot.files.get("media-input-profile.json")!.toString(),
  );
  for (const change of [
    { ...base, networkGrants: [] },
    { ...base, workflows: [...base.workflows, base.workflows[0]] },
    { ...base, workflows: [base.workflows[0], base.workflows[0]] },
    ...[
      { file: "../node.mjs" },
      { workflowDigest: fixtureHash("other-graph") },
      {
        output: { kind: "image", nodeId: "17", dimensions: "workflow-native" },
      },
      { workflowId: "unknown" },
    ].map((patch) => ({
      ...base,
      workflows: [{ ...base.workflows[0], ...patch }],
    })),
  ]) {
    const files = new Map(snapshot.files);
    files.set("media-input-profile.json", Buffer.from(JSON.stringify(change)));
    expect(() =>
      captureDesktopLocalShortDramaMediaInputs(
        { ...snapshot, files },
        f.configuration,
      ),
    ).toThrow();
  }
});

it("graph changes after preview fail before policy or mapping writes", async () => {
  const f = await fixture();
  const setup = f.create();
  const preview = await setup.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
  });
  const path = join(
    f.installed.directory,
    "workflows",
    "krea2-reference-four-view.api.json",
  );
  chmodSync(path, 0o600);
  writeFileSync(path, "{}");
  await f.stop();
  await expect(setup.commitPolicyWhileStopped(claim)).rejects.toThrow();
  expect(setup.policyCommitted(claim)).toBe(false);
});
