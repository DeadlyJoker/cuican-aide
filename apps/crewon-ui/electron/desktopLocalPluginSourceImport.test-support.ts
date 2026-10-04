import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PLUGIN_PACKAGE_DESCRIPTOR_PATH,
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  createDesktopLocalPluginSourceImporter,
  type DesktopLocalPluginSourceConfirmation,
  type DesktopLocalPluginSourceImporter,
  type DesktopLocalPluginSourceImporterOptions,
  type DesktopLocalPluginSourcePreview,
} from "./desktopLocalPluginSourceImport.ts";
import { DESKTOP_PLUGIN_APPROVAL_FILE } from "./desktopPluginBootstrap.ts";

/** Ordinary prebuilt developer directory; never a funded/executing deployment. */
export function desktopLocalPluginSourceImportFixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-native-source-import-")),
  );
  chmodSync(root, 0o700);
  const dataDirectory = join(root, "data");
  mkdirSync(dataDirectory, { mode: 0o700 });
  const source = join(root, "developer-package");
  mkdirSync(source, { mode: 0o755 });
  const marker = join(root, "business-imported.log");
  const files = new Map([
    [
      "node/entry.mjs",
      Buffer.from(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'node imported');throw new Error('must never import');`,
      ),
    ],
    [
      "ui/entry.mjs",
      Buffer.from(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ui imported');throw new Error('must never import');`,
      ),
    ],
    [
      "ui/chunk.mjs",
      Buffer.from("export const fixture = 'explicitly selected chunk';"),
    ],
    [
      "assets/cover.svg",
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    ],
    // Package verification checks bytes, not this separate business schema.
    ["business/manifest.json", Buffer.from("not a business JSON document")],
  ]);
  let descriptor: PluginPackageDescriptor = {
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    hostApi: PLUGIN_PACKAGE_HOST_API,
    pluginId: "example.local-import",
    publisherId: "example.declared-publisher",
    version: "1.0.0",
    title: "Local import byte fixture",
    description:
      "Package metadata and explicit publisher trust, no execution or financial authority.",
    entrypoints: {
      node: "node/entry.mjs",
      ui: { path: "ui/entry.mjs", mode: "trustedModule" },
    },
    businessManifestPath: "business/manifest.json",
    requires: [],
    provides: [],
    contributions: [
      {
        id: "studio",
        kind: "module",
        slot: "main.content",
        title: "Import fixture",
      },
    ],
    files: [...files].map(([path, bytes]) => ({
      path,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o755 });
    writeFileSync(join(source, path), bytes, { mode: 0o644 });
  }
  const descriptorPath = join(source, PLUGIN_PACKAGE_DESCRIPTOR_PATH);
  const approvalPath = join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
  const pendingPath = approvalPath + ".import-pending-v1";
  const owners: DesktopLocalPluginSourceImporter[] = [];
  let current = true;
  let commits = 0;
  const writeDescriptor = (value: PluginPackageDescriptor = descriptor) => {
    descriptor = value;
    writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), {
      mode: 0o644,
    });
  };
  writeDescriptor();
  const existingSource = {
    sourceId: "retained-original-source",
    directory: join(root, "original-approved-directory"),
    pluginId: "example.retained-plugin",
    publisherId: "example.retained-publisher",
    version: "1.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
  };
  const existingPublication = {
    pluginId: existingSource.pluginId,
    publisherId: existingSource.publisherId,
    packageDigest: existingSource.packageDigest,
    publicAssets: ["ui/original.mjs"],
  };
  const originalApproval = {
    schemaVersion: "crewon.desktop-plugin-approval.v1",
    sources: [existingSource],
    publications: [existingPublication],
  };
  function writeApproval(value: unknown = originalApproval) {
    writeFileSync(approvalPath, JSON.stringify(value, null, 2), {
      mode: 0o600,
    });
    chmodSync(approvalPath, 0o600);
  }
  function create(
    options: Partial<DesktopLocalPluginSourceImporterOptions> = {},
  ) {
    const owner = createDesktopLocalPluginSourceImporter({
      dataDirectory,
      assertCurrent() {
        if (!current) throw new Error("fixture_document_withdrawn");
      },
      async beforeApprovalCommit() {
        commits += 1;
      },
      ...options,
    });
    owners.push(owner);
    return owner;
  }
  return {
    root,
    dataDirectory,
    source,
    marker,
    files,
    descriptorPath,
    approvalPath,
    pendingPath,
    existingSource,
    existingPublication,
    originalApproval,
    get descriptor() {
      return descriptor;
    },
    get commits() {
      return commits;
    },
    create,
    writeApproval,
    writeDescriptor,
    withdraw() {
      current = false;
    },
    approval() {
      return JSON.parse(readFileSync(approvalPath, "utf8"));
    },
    originalBytes() {
      return readFileSync(approvalPath);
    },
    async cleanup() {
      await Promise.all(owners.map((owner) => owner.close()));
      makeOwnDirectoriesWritable(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function sourceConfirmation(
  preview: DesktopLocalPluginSourcePreview,
  fields: Partial<DesktopLocalPluginSourceConfirmation> = {},
): DesktopLocalPluginSourceConfirmation {
  return {
    previewId: preview.previewId,
    pluginId: preview.pluginId,
    publisherId: preview.publisherId,
    version: preview.version,
    packageDigest: preview.packageDigest,
    publicAssets: [],
    trustNodeExecution: true,
    trustUiModule: false,
    ...fields,
  };
}

export function importProjectSettings(
  schemaVersion:
    | "crewon.desktop-plugin-approval.v2"
    | "crewon.desktop-plugin-approval.v3",
  source: Readonly<{ pluginId: string; packageDigest: string }>,
) {
  // Existing parser metadata only, never a funded business deployment.
  const publication = {
    pluginId: source.pluginId,
    packageDigest: source.packageDigest,
    contributionId: "retained-workbench",
  };
  const target = { ...publication, contributionId: "retained-studio" };
  return schemaVersion === "crewon.desktop-plugin-approval.v3"
    ? {
        version: "crewon.desktop-project-execution.v1",
        pluginUi: { publications: [publication] },
        generationReads: { version: "crewon.project-generation-read.v1" },
        pluginGenerations: {
          publications: [
            {
              source: publication,
              target: { ...target, action: "image.generate" },
            },
          ],
        },
        pluginQueries: {
          publications: [
            {
              source: publication,
              target: { ...target, action: "image.query" },
            },
          ],
        },
        uiRecovery: {
          version: "crewon.plugin-ui-recovery.v1",
          publications: [
            {
              ...publication,
              actions: [
                "crewon.project-generations.v1.generateConcept",
                "crewon.project-generation-queries.v1.queryConceptGeneration",
              ],
            },
          ],
        },
      }
    : {
        version: "crewon.desktop-project-history.v1",
        pluginUi: { publications: [publication] },
        generationReads: { version: "crewon.project-generation-read.v1" },
        generationReadUi: { publications: [publication] },
      };
}

export function sourceImportDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Fixture-only recursive cleanup; never follow a link or chmod a human source. */
function makeOwnDirectoriesWritable(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const child of readdirSync(path))
    makeOwnDirectoriesWritable(join(path, child));
}
