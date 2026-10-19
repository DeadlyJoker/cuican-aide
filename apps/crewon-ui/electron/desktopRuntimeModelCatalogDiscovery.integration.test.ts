import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  DesktopRuntimeModelCatalogDiscovery,
  DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS,
} from "./desktopRuntimeModelCatalogDiscovery.ts";
import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";
import {
  desktopLocalPluginSourceImportFixture,
  sourceConfirmation,
} from "./desktopLocalPluginSourceImport.test-support.ts";

it("reuses one successful probe across a real source approval CAS and stop/start while preserving child and package verification", async () => {
  let now = 0;
  const probe = vi.fn(async () => ({
    status: "ok",
    models: ["fixture-model"],
  }));
  const discovery = new DesktopRuntimeModelCatalogDiscovery({
    discover: probe,
    context: () => ({
      entry: "/unused/model-catalog",
      source: false,
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      credentialSource: { kind: "keychain", environmentVariable: null },
    }),
    now: () => now,
  });
  const runtime = desktopPluginManagementFixture({
    provider: "configured",
    approval: "present",
    providerModelCatalog: (provider) => discovery.discover(provider),
  });
  const source = desktopLocalPluginSourceImportFixture();
  source.writeDescriptor({ ...source.descriptor, businessManifestPath: null });
  const importer = source.create({
    dataDirectory: runtime.dataDirectory,
    beforeApprovalCommit: async () => {
      expect(() => runtime.owner.session()).toThrow(
        "control_runtime_unavailable",
      );
    },
  });
  try {
    await runtime.owner.start();
    const previousControl = runtime.owner.currentControlOwner();
    const previousGeneration = runtime.owner.sessionGeneration;
    const preview = await importer.previewDirectory(source.source);
    const command = importer.claimPreview(sourceConfirmation(preview));
    const result = await runtime.owner.mutateWhileStopped({
      onStopInvalidation: (stop) => stop(),
      mutation: async () => {
        expect(
          previousControl.exitCode !== null ||
            previousControl.signalCode !== null,
        ).toBe(true);
        return importer.confirmPreview(command);
      },
    });
    expect(result.runtimeStatus).toBe("ready");
    expect(result.value.packageDigest).toBe(preview.packageDigest);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(runtime.owner.sessionGeneration).toBeGreaterThan(previousGeneration);
    expect(runtime.owner.currentControlOwner().pid).not.toBe(
      previousControl.pid,
    );
    expect(runtime.records().map((record) => record.kind)).toEqual([
      "release",
      "worker",
      "control",
      "release",
      "worker",
      "control",
    ]);
    const approval = JSON.parse(
      readFileSync(
        join(runtime.dataDirectory, "plugin-approvals.json"),
        "utf8",
      ),
    );
    expect(
      approval.sources.some(
        (entry: { packageDigest: string }) =>
          entry.packageDigest === preview.packageDigest,
      ),
    ).toBe(true);
    expect(existsSync(source.marker)).toBe(false);
    now = DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS;
    await runtime.owner.restart();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(
      runtime.records().filter((record) => record.kind === "control"),
    ).toHaveLength(3);
    expect(existsSync(source.marker)).toBe(false);
  } finally {
    await source.cleanup();
    await runtime.owner.stop();
    // These are test-owned verified copies, writable only after their children close.
    makeOwnDirectoriesWritable(runtime.directory);
    await runtime.close();
  }
}, 15_000);

function makeOwnDirectoriesWritable(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path))
    makeOwnDirectoriesWritable(join(path, name));
}
