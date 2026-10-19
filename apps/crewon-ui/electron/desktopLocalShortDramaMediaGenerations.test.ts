import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseExtensionManifest } from "@crewon/domain";
import { captureLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import { executionSetupFixture } from "./desktopLocalPluginExecutionSetup.test-support.ts";
import { captureDesktopLocalShortDramaMediaInputs } from "./desktopLocalShortDramaMediaInputs.ts";
import { captureDesktopLocalShortDramaMediaGenerations } from "./desktopLocalShortDramaMediaGenerations.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
} from "./desktopPluginBootstrap.ts";

const owned: Awaited<ReturnType<typeof executionSetupFixture>>[] = [];
afterEach(async () => {
  for (const f of owned.splice(0)) await f.cleanup();
});
async function fixture(
  withMedia = true,
  serviceProtocol?: "workflow-panel-v1" | "workflow-api-v1",
) {
  const f = await executionSetupFixture(
    withMedia
      ? {
          packageDirectory: resolve(
            process.env.CREWON_TEST_SHORT_DRAMA_MEDIA_PLUGIN_DIR ??
              "../../examples/plugins/short-drama/dist/50.2.13",
          ),
          contract: "assets",
          ...(serviceProtocol
            ? {
                serviceProtocol,
                ...(serviceProtocol === "workflow-api-v1"
                  ? { preset: "api-c16-scene" as const }
                  : {}),
              }
            : {}),
          projectContext: true,
        }
      : {},
  );
  owned.push(f);
  return f;
}
async function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  approve = false,
) {
  const setup = f.create();
  const preview = await setup.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
    ...(approve ? { approveMediaGenerations: true } : {}),
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
  const manifest = assertDesktopPluginBootstrapIssued(f.bootstrap);
  if (manifest.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
    throw new Error("expected_v3");
  return manifest.projects;
}
function paths(f: Awaited<ReturnType<typeof fixture>>) {
  return JSON.parse(readFileSync(f.policyPath, "utf8")).networkGrants[0].paths;
}

it("only independent consent widens the exact installed grant; cold setup retains prior approval without resubmitting", async () => {
  const f = await fixture();
  const first = await prepare(f);
  expect(first.mediaGenerationPreparation).toMatchObject({
    scope: "generate-from-adopted-references",
    alreadyApproved: false,
    workflows: first.mediaInputPreparation!.workflows,
    additionalNetworkPaths: [{ method: "POST", path: "/upload/image" }],
  });
  expect(projects(f).mediaInputs).toBeDefined();
  expect(projects(f).mediaGenerations).toBeUndefined();
  expect(paths(f)).not.toContainEqual({
    method: "POST",
    path: "/upload/image",
  });
  const originalPaths = paths(f);
  await prepare(f, true);
  expect(projects(f).mediaGenerations).toEqual({
    version: "crewon.desktop-project-media-generations.v1",
    publications: [
      {
        pluginId: f.identity.pluginId,
        packageDigest: f.identity.packageDigest,
        contributionId: "workbench",
      },
    ],
  });
  expect(paths(f)).toEqual([
    ...originalPaths,
    { method: "POST", path: "/upload/image" },
  ]);
  const before = readFileSync(f.approvalPath);
  const repeated = await prepare(f);
  expect(repeated.mediaGenerationPreparation?.alreadyApproved).toBe(true);
  expect(repeated.networkPaths).toEqual(paths(f));
  expect(readFileSync(f.approvalPath)).toEqual(before);
  expect(
    await f.store.extensionStore().loadLatestExtensionConfiguration({
      ...f.scope,
      pluginId: f.identity.pluginId,
    }),
  ).toEqual(f.configuration);
});

it("unoffered generation, false flags and renderer-provided authority cannot claim a preview", async () => {
  for (const withMedia of [false, true]) {
    const f = await fixture(withMedia);
    const setup = f.create();
    const preview = await setup.preview({
      bootstrap: f.bootstrap,
      pluginId: f.identity.pluginId,
    });
    const base = { previewId: preview.previewId, approveExecution: true };
    if (!withMedia) {
      expect(preview.mediaGenerationPreparation).toBeUndefined();
      expect(() =>
        setup.claimPreview({ ...base, approveMediaGenerations: true }),
      ).toThrow();
    }
    for (const patch of [
      { approveMediaGenerations: false },
      { approveMediaGenerations: true, workflows: [] },
      {
        approveMediaGenerations: true,
        networkPaths: [{ method: "POST", path: "/upload/image" }],
      },
    ])
      expect(() => setup.claimPreview({ ...base, ...patch })).toThrow();
    expect(() => setup.claimPreview(base)).not.toThrow();
  }
});

it("generation requires actual media operations and fixed graph inputs; metadata-only declarations stay separate", async () => {
  const f = await fixture();
  const snapshot = await captureLocalPluginPackage(
    { directory: f.source },
    true,
  );
  const manifest = parseExtensionManifest(
    JSON.parse(snapshot.files.get("business.json")!.toString()),
  );
  const base = {
    snapshot,
    manifest,
    mediaInputs: captureDesktopLocalShortDramaMediaInputs(
      snapshot,
      f.configuration,
    ),
    approval: parseDesktopPluginApproval(f.approval),
    uploadApproved: false,
  };
  expect(captureDesktopLocalShortDramaMediaGenerations(base)).not.toBeNull();
  expect(
    captureDesktopLocalShortDramaMediaGenerations({
      ...base,
      mediaInputs: null,
    }),
  ).toBeNull();
  expect(
    captureDesktopLocalShortDramaMediaGenerations({
      ...base,
      manifest: {
        ...manifest,
        tools: manifest.tools.filter(
          (t) => !["media_submit", "media_observe"].includes(t.operationId),
        ),
      },
    }),
  ).toBeNull();
  for (const patch of [
    { adapterId: "crewon.project-media-input-tools" },
    { capability: "project.media-input.write" },
    { effect: "readOnly" as const },
    { recovery: "replaySafe" as const },
  ]) {
    expect(() =>
      captureDesktopLocalShortDramaMediaGenerations({
        ...base,
        manifest: {
          ...manifest,
          tools: manifest.tools.map((t) =>
            t.operationId === "media_submit" ? { ...t, ...patch } : t,
          ),
        },
      }),
    ).toThrow();
  }
  const files = new Map(snapshot.files);
  const file = "workflows/krea2-reference-four-view.api.json";
  const graph = JSON.parse(files.get(file)!.toString());
  delete graph["146"].inputs.image;
  files.set(file, Buffer.from(JSON.stringify(graph)));
  expect(() =>
    captureDesktopLocalShortDramaMediaGenerations({
      ...base,
      snapshot: { ...snapshot, files },
    }),
  ).toThrow();
});

it("package withdrawal after generation consent cannot write the upload policy", async () => {
  const f = await fixture();
  const setup = f.create();
  const preview = await setup.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
    approveMediaGenerations: true,
  });
  const graph = join(
    f.installed.directory,
    "workflows/krea2-reference-four-view.api.json",
  );
  chmodSync(graph, 0o600);
  writeFileSync(graph, "{}");
  await f.stop();
  await expect(setup.commitPolicyWhileStopped(claim)).rejects.toThrow();
  expect(setup.policyCommitted(claim)).toBe(false);
});

it("explicit consent does not repair an unrelated or broader existing network policy", async () => {
  const f = await fixture();
  await prepare(f);
  const policy = JSON.parse(readFileSync(f.policyPath, "utf8"));
  policy.networkGrants[0].paths.push({ method: "POST", path: "/unreviewed" });
  writeFileSync(f.policyPath, JSON.stringify(policy));
  const before = readFileSync(f.policyPath);
  await expect(
    f
      .create()
      .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId }),
  ).rejects.toThrow("policy_conflict");
  expect(readFileSync(f.policyPath)).toEqual(before);
});

it.each(["workflow-panel-v1", "workflow-api-v1"] as const)(
  "%s offers its exact file upload only through separate Main consent and retains it on cold preparation",
  async (protocol) => {
    const f = await fixture(true, protocol);
    const first = await prepare(f);
    expect(first.mediaGenerationPreparation?.additionalNetworkPaths).toEqual([
      { method: "POST", path: "/api/comfy/upload/file" },
    ]);
    expect(paths(f)).not.toContainEqual({
      method: "POST",
      path: "/api/comfy/upload/file",
    });
    expect(projects(f).mediaGenerations).toBeUndefined();
    await prepare(f, true);
    expect(paths(f)).toContainEqual({
      method: "POST",
      path: "/api/comfy/upload/file",
    });
    expect(paths(f)).not.toContainEqual({
      method: "POST",
      path: "/upload/image",
    });
    expect(paths(f)).not.toContainEqual({ method: "POST", path: "/prompt" });
    const repeated = await prepare(f);
    expect(repeated.mediaGenerationPreparation?.alreadyApproved).toBe(true);
    expect(
      paths(f).filter(
        (p: { path?: string }) => p.path === "/api/comfy/upload/file",
      ),
    ).toHaveLength(1);
  },
);
