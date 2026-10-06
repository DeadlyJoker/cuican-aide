import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import {
  prepareDesktopPluginBootstrap,
  assertDesktopPluginBootstrapIssued,
} from "./desktopPluginBootstrap.ts";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(purposes = ["read", "write"]) {
  const f = desktopPluginBootstrapFixture();
  roots.push(f.directory);
  const source = {
    ...f.source,
    pluginId: "crewon.short-drama",
    version: "21.0.1",
  };
  const identity = {
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    version: source.version,
    packageDigest: source.packageDigest,
    manifestDigest: source.packageDigest,
    implementationDigest: source.packageDigest,
  };
  const mediaInputs = {
    version: "crewon.desktop-project-media-inputs.v1",
    purposes,
    reviews: [
      {
        targetIdentity: identity,
        workflow: {
          workflowId: "krea2-reference-four-view",
          workflowDigest: source.packageDigest,
          output: {
            kind: "image",
            nodeId: "129",
            dimensions: "workflow-native",
          },
        },
      },
    ],
    referenceIdentities: [
      {
        pluginId: "crewon.short-drama",
        pluginVersion: source.version,
        manifestDigest: source.packageDigest,
        implementationDigest: source.packageDigest,
      },
    ],
  };
  const approval = {
    schemaVersion: "crewon.desktop-plugin-approval.v3",
    sources: [source],
    publications: [{ ...f.publication, pluginId: source.pluginId }],
    projects: {
      version: "crewon.desktop-project-execution.v1",
      textArtifacts: { version: "crewon.project-text.v1" },
      assetArtifacts: { version: "crewon.project-asset.v1" },
      mediaInputs,
    },
  };
  f.writeApproval(approval);
  return { ...f, approval, mediaInputs };
}
// Genuine Main file producer, offline schema identities. No Node/runtime/provider readiness is inferred.
it("original Main issues the exact private media metadata opt-in without execution or renderer credentials", async () => {
  const f = fixture();
  const bootstrap = await prepareDesktopPluginBootstrap(f.input);
  expect(bootstrap).not.toBeNull();
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap!);
  expect(manifest.schemaVersion).toBe("crewon.desktop-plugin-bootstrap.v3");
  if (manifest.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
    throw new Error("v3_required");
  expect(manifest.projects.mediaInputs).toEqual(f.mediaInputs);
  expect(Object.keys(bootstrap!.environment)).toEqual([
    "CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH",
  ]);
  expect(readFileSync(bootstrap!.bootstrapPath, "utf8")).not.toContain(
    f.input.sessionEntropy,
  );
  expect(manifest.projects.pluginGenerations).toBeUndefined();
  expect(manifest.projects.uiRecovery).toBeUndefined();
  await bootstrap!.cleanup();
});
it("Main keeps read-only purposes distinct and rejects qualification or hidden network authority", async () => {
  const f = fixture(["read"]);
  const bootstrap = await prepareDesktopPluginBootstrap(f.input);
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap!);
  if (manifest.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
    throw new Error("v3_required");
  expect(manifest.projects.mediaInputs!.purposes).toEqual(["read"]);
  await bootstrap!.cleanup();
  for (const patch of [{ purposes: ["qualify"] }, { networkGrants: [] }]) {
    const bad = fixture();
    bad.writeApproval({
      ...bad.approval,
      projects: {
        ...bad.approval.projects,
        mediaInputs: { ...bad.mediaInputs, ...patch },
      },
    });
    await expect(prepareDesktopPluginBootstrap(bad.input)).rejects.toThrow();
  }
});
it("original Main approval replacement withdraws the issued media opt-in even with identical bytes", async () => {
  const f = fixture();
  const bootstrap = await prepareDesktopPluginBootstrap(f.input);
  const bytes = readFileSync(f.approvalPath);
  renameSync(f.approvalPath, `${f.approvalPath}.old`);
  writeFileSync(f.approvalPath, bytes, { mode: 0o600 });
  expect(() => assertDesktopPluginBootstrapIssued(bootstrap!)).toThrow();
  await bootstrap!.cleanup();
});

it("Main preserves an independently approved media UI module without inferring it from read/write purposes", async () => {
  const f = fixture();
  const mediaInputUi = {
    publications: [
      {
        pluginId: f.approval.sources[0]!.pluginId,
        packageDigest: f.approval.sources[0]!.packageDigest,
        contributionId: "workbench",
      },
    ],
  };
  f.writeApproval({
    ...f.approval,
    projects: { ...f.approval.projects, mediaInputUi },
  });
  const bootstrap = await prepareDesktopPluginBootstrap(f.input);
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap!);
  if (manifest.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
    throw new Error("v3_required");
  expect(manifest.projects.mediaInputUi).toEqual(mediaInputUi);
  expect(manifest.projects.pluginGenerations).toBeUndefined();
  await bootstrap!.cleanup();
  const missing = fixture();
  missing.writeApproval({
    ...missing.approval,
    projects: {
      ...missing.approval.projects,
      mediaInputs: undefined,
      mediaInputUi,
    },
  });
  await expect(prepareDesktopPluginBootstrap(missing.input)).rejects.toThrow();
});
