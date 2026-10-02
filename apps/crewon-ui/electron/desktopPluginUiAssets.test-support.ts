import type { PluginUiLease } from "@crewon/contracts/plugins";
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
/** Explicit wire fixture; the separate native integration uses a real installer/reader/SQLite/HTTP lease. */
export function uiLease(serial = 1): PluginUiLease {
  return {
    schemaVersion: "crewon.plugin-ui-lease.v1",
    mountRef: `mount_${String(serial).padStart(32, "0")}`,
    expiresAt: "2099-10-02T00:00:00.000Z",
    selectionRevision: serial,
    packageDigest: `sha256:${String(serial % 10).repeat(64)}`,
    descriptor: {
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: "example.workbench",
      version: `1.0.${serial}`,
      title: "Fixture workbench",
      description: "Native finite asset owner wire fixture",
      publisherId: "example.publisher",
      entrypoints: {
        node: null,
        ui: { path: "ui/index.js", mode: "trustedModule" },
      },
      businessManifestPath: null,
      requires: [],
      provides: [],
      contributions: [
        {
          id: "workbench",
          title: "Workbench",
          kind: "module",
          slot: "main.content",
        },
      ],
      files: [
        { path: "ui/index.js", byteLength: 100, sha256: "a".repeat(64) },
        { path: "ui/chunk.js", byteLength: 100, sha256: "b".repeat(64) },
      ],
    },
    contributionId: "workbench",
    publicAssets: ["ui/index.js", "ui/chunk.js"],
  };
}
