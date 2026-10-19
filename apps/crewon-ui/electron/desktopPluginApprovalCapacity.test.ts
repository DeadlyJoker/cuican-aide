import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
} from "./desktopNativePluginAuthority.ts";
import { captureNativePluginAuthority as captureControl } from "../../control-api/src/desktop-native-plugin-authority-files.ts";
import { captureNativePluginAuthority as captureWorker } from "../../runtime-worker/src/plugins/installed-plugin-native-authority-files.ts";
import {
  desktopLocalPluginSourceImportFixture,
  sourceConfirmation,
} from "./desktopLocalPluginSourceImport.test-support.ts";

it("imports another approved version and cold-starts a bounded catalogue over 128 KiB without deleting old sources", async () => {
  const f = desktopLocalPluginSourceImportFixture();
  f.writeDescriptor({ ...f.descriptor, businessManifestPath: null });
  const sources = Array.from({ length: 25 }, (_, i) => ({
    ...f.existingSource,
    sourceId: `retained-${i}`,
    version: `1.0.${i}`,
    directory: `${f.existingSource.directory}/${i}`,
    packageDigest: `sha256:${i.toString(16).padStart(64, "0")}`,
  }));
  const approval = {
    ...f.originalApproval,
    sources,
    publications: sources.map((source) => ({
      pluginId: source.pluginId,
      publisherId: source.publisherId,
      packageDigest: source.packageDigest,
      publicAssets: Array.from(
        { length: 64 },
        (_, i) => `resources/${"retained".repeat(9)}/${i}.md`,
      ),
    })),
  };
  let bootstrap: Awaited<ReturnType<typeof prepareDesktopPluginBootstrap>> =
    null;
  let authority: ReturnType<typeof createDesktopNativePluginAuthority> | null =
    null;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(approval));
    expect(bytes).toBeGreaterThan(128 * 1024);
    expect(bytes).toBeLessThan(256 * 1024);
    f.writeApproval(approval);
    const importer = f.create();
    const preview = await importer.previewDirectory(f.source);
    const result = await importer.confirmPreview(sourceConfirmation(preview));
    expect(result.version).toBe(f.descriptor.version);
    expect(f.approval().sources.slice(0, 25)).toEqual(sources);
    expect(f.approval().sources).toHaveLength(26);
    expect(f.approval().publications).toEqual(approval.publications);
    expect(existsSync(f.marker)).toBe(false);
    bootstrap = await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: "capacity-check-original-session-".repeat(3),
    });
    expect(bootstrap).not.toBeNull();
    const manifest = JSON.parse(readFileSync(bootstrap!.bootstrapPath, "utf8"));
    expect(manifest.sources).toHaveLength(26);
    expect(manifest.publications).toEqual(approval.publications);
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(
      256 * 1024,
    );
    bootstrap!.assertCurrent?.();
    const { pluginId, publisherId, version, packageDigest } = sources[0]!;
    writeFileSync(
      join(f.dataDirectory, "plugin-native-policy.json"),
      JSON.stringify({
        schemaVersion: "crewon.desktop-native-plugin-policy.v1",
        packages: [
          {
            pluginId,
            publisherId,
            version,
            packageDigest,
            approvalRequirement: "none",
          },
        ],
        networkGrants: [],
      }),
      { mode: 0o600 },
    );
    const policy = captureDesktopNativePluginPolicy(
      f.dataDirectory,
      bootstrap!,
    );
    expect(policy).not.toBeNull();
    // File ownership pin only; this test never opens an execution database.
    writeFileSync(join(f.dataDirectory, "control.sqlite"), "", { mode: 0o600 });
    authority = createDesktopNativePluginAuthority({
      dataDirectory: f.dataDirectory,
      bootstrap: bootstrap!,
      policy: policy!,
    });
    const control = captureControl(authority.path),
      worker = captureWorker(authority.path);
    control.assertCurrent();
    worker.assertCurrent();
    expect(control.authority.bootstrapDigest).toBe(
      worker.authority.bootstrapDigest,
    );
    authority.withdraw();
    expect(() => control.assertCurrent()).toThrow();
    expect(() => worker.assertCurrent()).toThrow();
  } finally {
    authority?.close();
    await bootstrap?.cleanup();
    await f.cleanup();
  }
});
