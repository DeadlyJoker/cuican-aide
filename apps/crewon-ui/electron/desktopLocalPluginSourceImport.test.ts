import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  parseDesktopPluginApproval,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { recoverDesktopLocalPluginSourceImport } from "./desktopLocalPluginSourceImport.ts";
import {
  desktopLocalPluginSourceImportFixture,
  importProjectSettings,
  sourceConfirmation,
  sourceImportDeferred,
} from "./desktopLocalPluginSourceImport.test-support.ts";

const filesystemFault = vi.hoisted(() => ({
  unlinkOnce: null as string | null,
  lstats: [] as string[],
  opens: [] as string[],
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      filesystemFault.lstats.push(String(args[0]));
      return fs.lstatSync(...args);
    }) as typeof fs.lstatSync,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      filesystemFault.opens.push(String(args[0]));
      return fs.openSync(...args);
    },
    unlinkSync: (path: Parameters<typeof fs.unlinkSync>[0]) => {
      if (String(path) === filesystemFault.unlinkOnce) {
        filesystemFault.unlinkOnce = null;
        throw Object.assign(new Error("fixture_pending_cleanup_unavailable"), {
          code: "EACCES",
        });
      }
      fs.unlinkSync(path);
    },
  };
});

const fixtures: ReturnType<typeof desktopLocalPluginSourceImportFixture>[] = [];
function fixture() {
  const f = desktopLocalPluginSourceImportFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  filesystemFault.unlinkOnce = null;
  filesystemFault.lstats = [];
  filesystemFault.opens = [];
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

describe("Native Main local prebuilt source import", () => {
  it("verifies real bytes without imports, allocations, paths or implicitly public Node/business assets", async () => {
    const f = fixture();
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    const original = await verifyLocalPluginPackage({ directory: f.source });
    expect(preview).toMatchObject({
      pluginId: original.descriptor.pluginId,
      publisherId: original.descriptor.publisherId,
      version: original.descriptor.version,
      packageDigest: original.packageDigest,
      totalBytes: original.totalBytes,
      fileCount: original.fileCount,
      nodeEntry: "node/entry.mjs",
      uiEntry: { path: "ui/entry.mjs", mode: "trustedModule" },
    });
    expect(preview.previewId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(preview.expiresAt).toBeGreaterThan(Date.now());
    expect(preview.publicAssetCandidates).toEqual([
      "assets/cover.svg",
      "ui/chunk.mjs",
      "ui/entry.mjs",
    ]);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.publicAssetCandidates)).toBe(true);
    expect(Object.isFrozen(preview.uiEntry)).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(f.source);
    expect(Object.hasOwn(preview, "directory")).toBe(false);
    expect(Object.hasOwn(preview, "descriptor")).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
    expect(readdirSync(f.dataDirectory)).toEqual([]);
    expect(lstatSync(f.source).mode & 0o777).toBe(0o755);
  });

  it("consumes a confirmed ticket into a separate verified immutable copy and a private source-only v1 approval", async () => {
    const f = fixture();
    const beforeBytes = readFileSync(f.descriptorPath);
    const beforeModes = [...f.files.keys()].map(
      (path) => lstatSync(join(f.source, path)).mode,
    );
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    const result = await owner.confirmPreview(sourceConfirmation(preview));
    expect(result).toEqual({
      sourceId: expect.stringMatching(/^local-import-/u),
      pluginId: preview.pluginId,
      publisherId: preview.publisherId,
      version: preview.version,
      packageDigest: preview.packageDigest,
      restartRequired: true,
    });
    expect(f.commits).toBe(1);
    const approval = parseDesktopPluginApproval(f.approval());
    expect(approval.schemaVersion).toBe("crewon.desktop-plugin-approval.v1");
    expect(approval.publications).toEqual([]);
    expect(approval.sources).toHaveLength(1);
    const source = approval.sources[0]!;
    expect(source.directory).toBe(
      join(
        f.dataDirectory,
        "plugin-import-sources",
        "packages",
        preview.packageDigest.slice(7),
      ),
    );
    expect(source.directory).not.toBe(f.source);
    expect(
      source.directory.startsWith(join(f.dataDirectory, "plugins") + "/"),
    ).toBe(false);
    const copied = await verifyLocalPluginPackage({
      directory: source.directory,
    });
    expect(copied.packageDigest).toBe(preview.packageDigest);
    expect(readFileSync(join(source.directory, "crewon.plugin.json"))).toEqual(
      beforeBytes,
    );
    expect(lstatSync(source.directory).mode & 0o777).toBe(0o555);
    expect(lstatSync(f.approvalPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(f.approvalPath).nlink).toBe(1);
    expect(existsSync(f.pendingPath)).toBe(false);
    expect(readFileSync(f.descriptorPath)).toEqual(beforeBytes);
    expect(lstatSync(f.source).mode & 0o777).toBe(0o755);
    expect(
      [...f.files.keys()].map((path) => lstatSync(join(f.source, path)).mode),
    ).toEqual(beforeModes);
    expect(readdirSync(f.dataDirectory).sort()).toEqual([
      "plugin-approvals.json",
      "plugin-import-sources",
    ]);
    expect(existsSync(f.marker)).toBe(false);
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("preview_unavailable");
    // The ordinary developer source can change after import without changing the approved copy.
    writeFileSync(join(f.source, "ui/chunk.mjs"), "changed developer bytes");
    expect(
      (await verifyLocalPluginPackage({ directory: source.directory }))
        .packageDigest,
    ).toBe(preview.packageDigest);
  });

  it("publishes only the explicit UI entry plus selected declared assets and no business/task grants", async () => {
    const f = fixture();
    f.writeApproval();
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    await owner.confirmPreview(
      sourceConfirmation(preview, {
        publicAssets: ["ui/entry.mjs", "ui/chunk.mjs"],
        trustUiModule: true,
      }),
    );
    const approval = f.approval();
    expect(approval.sources[0]).toEqual(f.existingSource);
    expect(approval.publications).toEqual([
      f.existingPublication,
      {
        pluginId: preview.pluginId,
        publisherId: preview.publisherId,
        packageDigest: preview.packageDigest,
        publicAssets: ["ui/entry.mjs", "ui/chunk.mjs"],
      },
    ]);
    expect(Object.keys(approval).sort()).toEqual([
      "publications",
      "schemaVersion",
      "sources",
    ]);
    expect(existsSync(f.marker)).toBe(false);
    expect(readdirSync(f.dataDirectory)).not.toContain("plugins");
  });

  it("returns the committed receipt if absent-file publication succeeds but pending cleanup fails", async () => {
    const f = fixture();
    const owner = f.create({
      async beforeApprovalCommit() {
        filesystemFault.unlinkOnce = f.pendingPath;
      },
    });
    const preview = await owner.previewDirectory(f.source);
    const result = await owner.confirmPreview(sourceConfirmation(preview));
    expect(result).toMatchObject({
      packageDigest: preview.packageDigest,
      restartRequired: true,
    });
    expect(f.approval().sources[0].sourceId).toBe(result.sourceId);
    expect(readFileSync(f.approvalPath)).toEqual(readFileSync(f.pendingPath));
    expect(lstatSync(f.approvalPath).nlink).toBe(2);
    // A failed post-commit cleanup is never misreported as no approval. The
    // original runtime still refuses this linked file, rather than bypassing it.
    await expect(
      prepareDesktopPluginBootstrap({
        dataDirectory: f.dataDirectory,
        actor: DESKTOP_RUNTIME_OWNER,
        sessionEntropy: "source-import-postcommit-cleanup-session-0001",
      }),
    ).rejects.toThrow();
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("preview_unavailable");
  });

  it("cold recovery removes only the proven committed second link and original bootstrap reads the exact approved source", async () => {
    const f = fixture();
    const owner = f.create({
      async beforeApprovalCommit() {
        filesystemFault.unlinkOnce = f.pendingPath;
      },
    });
    const preview = await owner.previewDirectory(f.source);
    const result = await owner.confirmPreview(sourceConfirmation(preview));
    await owner.close();
    const bytes = readFileSync(f.approvalPath);
    const identity = lstatSync(f.approvalPath);
    expect(identity.nlink).toBe(2);
    expect(
      recoverDesktopLocalPluginSourceImport({
        dataDirectory: f.dataDirectory,
        ownsSingleInstance: true,
      }),
    ).toEqual({ recovered: true, retained: false });
    expect(existsSync(f.pendingPath)).toBe(false);
    expect(readFileSync(f.approvalPath)).toEqual(bytes);
    expect(lstatSync(f.approvalPath)).toMatchObject({
      dev: identity.dev,
      ino: identity.ino,
      nlink: 1,
    });
    const bootstrap = (await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: "source-import-cold-link-recovery-session-0001",
    }))!;
    try {
      expect(
        JSON.parse(readFileSync(bootstrap.bootstrapPath, "utf8")).sources[0]
          .sourceId,
      ).toBe(result.sourceId);
      expect(
        (
          await verifyLocalPluginPackage({
            directory: f.approval().sources[0].directory,
          })
        ).packageDigest,
      ).toBe(result.packageDigest);
    } finally {
      await bootstrap.cleanup();
    }
  });

  it("absent pending recovery reads only its fixed lstat and requires the actual Main instance lock", () => {
    const f = fixture();
    f.writeApproval();
    filesystemFault.lstats = [];
    filesystemFault.opens = [];
    expect(
      recoverDesktopLocalPluginSourceImport({
        dataDirectory: f.dataDirectory,
        ownsSingleInstance: true,
      }),
    ).toEqual({ recovered: false, retained: false });
    expect(filesystemFault.lstats).toEqual([f.pendingPath]);
    expect(filesystemFault.opens).toEqual([]);
    expect(() =>
      recoverDesktopLocalPluginSourceImport({
        dataDirectory: f.dataDirectory,
        ownsSingleInstance: false,
      }),
    ).toThrow("instance_lock_required");
  });

  it.each([
    "uncommitted",
    "different_inode",
    "mode",
    "third_link",
    "symlink",
    "json",
    "parent_mode",
  ] as const)(
    "cold recovery retains unsafe %s staging without approving or deleting files",
    (kind) => {
      const f = fixture();
      if (kind === "uncommitted")
        writeFileSync(f.pendingPath, JSON.stringify(f.originalApproval), {
          mode: 0o600,
        });
      else {
        f.writeApproval();
        if (kind === "different_inode")
          writeFileSync(f.pendingPath, readFileSync(f.approvalPath), {
            mode: 0o600,
          });
        else if (kind === "symlink") symlinkSync(f.approvalPath, f.pendingPath);
        else {
          linkSync(f.approvalPath, f.pendingPath);
          if (kind === "mode") chmodSync(f.approvalPath, 0o640);
          else if (kind === "third_link")
            linkSync(f.approvalPath, join(f.root, "human-third-link.json"));
          else if (kind === "json")
            writeFileSync(f.approvalPath, '{"schemaVersion":"not-approved"}');
          else if (kind === "parent_mode") chmodSync(f.dataDirectory, 0o750);
        }
      }
      const pending = readFileSync(f.pendingPath);
      const original = existsSync(f.approvalPath)
        ? readFileSync(f.approvalPath)
        : null;
      expect(
        recoverDesktopLocalPluginSourceImport({
          dataDirectory: f.dataDirectory,
          ownsSingleInstance: true,
        }),
      ).toEqual({ recovered: false, retained: true });
      expect(readFileSync(f.pendingPath)).toEqual(pending);
      if (original === null) expect(existsSync(f.approvalPath)).toBe(false);
      else expect(readFileSync(f.approvalPath)).toEqual(original);
    },
  );

  it.each([
    { trustNodeExecution: false },
    { publicAssets: ["ui/entry.mjs"], trustUiModule: false },
    { publicAssets: ["ui/chunk.mjs"], trustUiModule: true },
    { publicAssets: ["ui/entry.mjs", "node/entry.mjs"], trustUiModule: true },
    {
      publicAssets: ["ui/entry.mjs", "business/manifest.json"],
      trustUiModule: true,
    },
    { publicAssets: ["ui/entry.mjs", "undeclared.mjs"], trustUiModule: true },
    { publicAssets: ["ui/entry.mjs", "ui/entry.mjs"], trustUiModule: true },
    { pluginId: "another.plugin" },
    { publisherId: "another.publisher" },
    { version: "2.0.0" },
    { packageDigest: `sha256:${"0".repeat(64)}` },
    { previewId: "a".repeat(43) },
  ])(
    "rejects incomplete or changed exact consent %j without writing and consumes that ticket",
    async (change) => {
      const f = fixture();
      f.writeApproval();
      const bytes = f.originalBytes();
      const owner = f.create();
      const preview = await owner.previewDirectory(f.source);
      await expect(
        owner.confirmPreview(sourceConfirmation(preview, change)),
      ).rejects.toThrow();
      expect(f.originalBytes()).toEqual(bytes);
      expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
      expect(f.commits).toBe(0);
      await expect(
        owner.confirmPreview(sourceConfirmation(preview)),
      ).rejects.toThrow("preview_unavailable");
    },
  );

  it("rejects getters and sparse/oversized selections without executing caller accessors", async () => {
    const f = fixture();
    const owner = f.create();
    for (const alteration of ["getter", "sparse", "large", "extra"] as const) {
      const preview = await owner.previewDirectory(f.source);
      const input = sourceConfirmation(preview);
      let calls = 0;
      if (alteration === "getter")
        Object.defineProperty(input, "publicAssets", {
          enumerable: true,
          get() {
            calls += 1;
            return [];
          },
        });
      else if (alteration === "sparse")
        Object.defineProperty(input, "publicAssets", {
          enumerable: true,
          value: new Array(2),
        });
      else if (alteration === "large")
        Object.defineProperty(input, "publicAssets", {
          enumerable: true,
          value: Array.from({ length: 257 }, (_, i) => `asset${i}.mjs`),
        });
      else
        Object.defineProperty(input, "directory", {
          enumerable: true,
          value: f.source,
        });
      await expect(owner.confirmPreview(input)).rejects.toThrow();
      expect(calls).toBe(0);
    }
    expect(readdirSync(f.dataDirectory)).toEqual([]);
  });

  it("rechecks actual selected bytes rather than authorizing the preview digest", async () => {
    const f = fixture();
    f.writeApproval();
    const bytes = f.originalBytes();
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    f.writeDescriptor({ ...f.descriptor, version: "1.0.1" });
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("identity_changed");
    expect(f.originalBytes()).toEqual(bytes);
    expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
    expect(existsSync(f.marker)).toBe(false);
  });

  it("checks source bytes again after the physical-stop callback and leaves an unapproved private copy on drift", async () => {
    const f = fixture();
    f.writeApproval();
    const bytes = f.originalBytes();
    const owner = f.create({
      async beforeApprovalCommit() {
        f.writeDescriptor({
          ...f.descriptor,
          description: "Actual developer bytes changed during stopping",
        });
      },
    });
    const preview = await owner.previewDirectory(f.source);
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("identity_changed");
    expect(f.originalBytes()).toEqual(bytes);
    const unapprovedCopy = join(
      f.dataDirectory,
      "plugin-import-sources",
      "packages",
      preview.packageDigest.slice(7),
    );
    expect(
      (await verifyLocalPluginPackage({ directory: unapprovedCopy }))
        .packageDigest,
    ).toBe(preview.packageDigest);
    expect(f.approval().sources).toEqual([f.existingSource]);
    expect(existsSync(f.pendingPath)).toBe(false);
    expect(lstatSync(f.source).mode & 0o777).toBe(0o755);
  });

  it("preserves old approvals on stop failure and verified retry reuses only the exact orphaned copy", async () => {
    const f = fixture();
    f.writeApproval();
    const bytes = f.originalBytes();
    let attempts = 0;
    const owner = f.create({
      async beforeApprovalCommit() {
        attempts += 1;
        if (attempts === 1) throw new Error("fixture_original_stop_failed");
      },
    });
    const first = await owner.previewDirectory(f.source);
    await expect(
      owner.confirmPreview(sourceConfirmation(first)),
    ).rejects.toThrow("fixture_original_stop_failed");
    expect(f.originalBytes()).toEqual(bytes);
    expect(existsSync(f.pendingPath)).toBe(false);
    const copy = join(
      f.dataDirectory,
      "plugin-import-sources",
      "packages",
      first.packageDigest.slice(7),
    );
    const before = lstatSync(copy);
    const second = await owner.previewDirectory(f.source);
    expect(second.packageDigest).toBe(first.packageDigest);
    const result = await owner.confirmPreview(sourceConfirmation(second));
    expect(result.packageDigest).toBe(first.packageDigest);
    expect(lstatSync(copy)).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(
      readdirSync(join(f.dataDirectory, "plugin-import-sources", "packages")),
    ).toEqual([first.packageDigest.slice(7)]);
    expect(f.approval().sources).toHaveLength(2);
    expect(f.approval().sources[0]).toEqual(f.existingSource);
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each([
    "crewon.desktop-plugin-approval.v2",
    "crewon.desktop-plugin-approval.v3",
  ] as const)(
    "retains complete original %s project declarations and only appends source/publication",
    async (schemaVersion) => {
      const f = fixture();
      const projects = importProjectSettings(schemaVersion, f.existingSource);
      const approval = { ...f.originalApproval, schemaVersion, projects };
      f.writeApproval(approval);
      const owner = f.create();
      const preview = await owner.previewDirectory(f.source);
      await owner.confirmPreview(
        sourceConfirmation(preview, {
          publicAssets: ["ui/entry.mjs"],
          trustUiModule: true,
        }),
      );
      expect(f.approval().schemaVersion).toBe(schemaVersion);
      expect(f.approval().projects).toEqual(projects);
      expect(f.approval().sources[0]).toEqual(f.existingSource);
      expect(f.approval().publications[0]).toEqual(f.existingPublication);
      expect(parseDesktopPluginApproval(f.approval())).toMatchObject({
        schemaVersion,
        projects,
      });
    },
  );

  it("uses the original bootstrap with an imported source while old approval ownership is invalidated", async () => {
    const f = fixture();
    f.writeApproval();
    const bootstrapInput = {
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: "source-import-original-session-entropy-0001",
    };
    const old = (await prepareDesktopPluginBootstrap(bootstrapInput))!;
    const owner = f.create({
      async beforeApprovalCommit() {
        await old.cleanup();
      },
    });
    const preview = await owner.previewDirectory(f.source);
    await owner.confirmPreview(sourceConfirmation(preview));
    expect(() => old.assertCurrent!()).toThrow();
    const next = (await prepareDesktopPluginBootstrap({
      ...bootstrapInput,
      sessionEntropy: `${bootstrapInput.sessionEntropy}:new`,
    }))!;
    try {
      expect(next.scope).toEqual(old.scope);
      expect(next.authorityEpoch).not.toBe(old.authorityEpoch);
      const manifest = JSON.parse(readFileSync(next.bootstrapPath, "utf8"));
      expect(manifest.sources).toEqual(f.approval().sources);
      expect(manifest.publications).toEqual(f.approval().publications);
    } finally {
      await next.cleanup();
    }
  });

  it.each(["write", "replace", "mode"] as const)(
    "refuses approval CAS %s changes without overwriting the current file",
    async (change) => {
      const f = fixture();
      f.writeApproval();
      let retained!: Buffer;
      const owner = f.create({
        async beforeApprovalCommit() {
          if (change === "mode") chmodSync(f.approvalPath, 0o640);
          else if (change === "replace") {
            renameSync(f.approvalPath, `${f.approvalPath}.old`);
            f.writeApproval();
          } else
            f.writeApproval({
              ...f.originalApproval,
              sources: [],
              publications: [],
            });
          retained = readFileSync(f.approvalPath);
        },
      });
      const preview = await owner.previewDirectory(f.source);
      await expect(
        owner.confirmPreview(sourceConfirmation(preview)),
      ).rejects.toThrow();
      expect(readFileSync(f.approvalPath)).toEqual(retained);
      expect(existsSync(f.pendingPath)).toBe(false);
      expect(existsSync(f.source)).toBe(true);
    },
  );

  it("refuses an approval appearing after an absent preview and never overwrites it", async () => {
    const f = fixture();
    const owner = f.create({
      async beforeApprovalCommit() {
        f.writeApproval();
      },
    });
    const preview = await owner.previewDirectory(f.source);
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("approval_changed");
    expect(f.approval()).toEqual(f.originalApproval);
    expect(existsSync(f.pendingPath)).toBe(false);
  });

  it.each(["symlink", "hardlink", "mode", "malformed", "size"] as const)(
    "rejects unsafe existing approval %s before preview allocations",
    async (change) => {
      const f = fixture();
      if (change === "symlink") {
        const target = join(f.root, "human-approval.json");
        writeFileSync(target, JSON.stringify(f.originalApproval), {
          mode: 0o600,
        });
        symlinkSync(target, f.approvalPath);
      } else {
        f.writeApproval();
        if (change === "hardlink")
          linkSync(f.approvalPath, join(f.root, "human-linked-approval.json"));
        else if (change === "mode") chmodSync(f.approvalPath, 0o644);
        else if (change === "malformed")
          f.writeApproval({
            ...f.originalApproval,
            actor: DESKTOP_RUNTIME_OWNER,
          });
        else writeFileSync(f.approvalPath, Buffer.alloc(128 * 1024 + 1, 0x20));
      }
      const before = readFileSync(f.approvalPath);
      await expect(f.create().previewDirectory(f.source)).rejects.toThrow();
      expect(readFileSync(f.approvalPath)).toEqual(before);
      expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
    },
  );

  it("rejects source links, extra files and tampered declared bytes without running package code", async () => {
    for (const change of ["link", "undeclared", "tampered"] as const) {
      const f = fixture();
      if (change === "link")
        symlinkSync(f.marker, join(f.source, "unexpected-link"));
      else if (change === "undeclared")
        writeFileSync(join(f.source, "unlisted.txt"), "undeclared");
      else writeFileSync(join(f.source, "ui/chunk.mjs"), "tampered");
      await expect(f.create().previewDirectory(f.source)).rejects.toThrow();
      expect(readdirSync(f.dataDirectory)).toEqual([]);
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  it("rejects duplicate approved package/version and the 32-source limit before copying or stopping", async () => {
    for (const kind of ["duplicate", "limit", "publisher"] as const) {
      const f = fixture();
      const verified = await verifyLocalPluginPackage({ directory: f.source });
      const actual = {
        ...f.existingSource,
        pluginId: verified.descriptor.pluginId,
        publisherId: verified.descriptor.publisherId,
        version: verified.descriptor.version,
        packageDigest: verified.packageDigest,
      };
      const sources =
        kind === "limit"
          ? Array.from({ length: 32 }, (_, index) => ({
              ...f.existingSource,
              sourceId: `retained-source-${index}`,
              directory: join(f.root, `retained-${index}`),
              pluginId: `example.retained-${index}`,
              packageDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
            }))
          : kind === "publisher"
            ? [
                {
                  ...actual,
                  version: "0.9.0",
                  packageDigest: `sha256:${"b".repeat(64)}`,
                  publisherId: "other.publisher",
                },
              ]
            : [actual];
      f.writeApproval({
        schemaVersion: "crewon.desktop-plugin-approval.v1",
        sources,
        publications: [],
      });
      const bytes = f.originalBytes();
      const owner = f.create();
      const preview = await owner.previewDirectory(f.source);
      await expect(
        owner.confirmPreview(sourceConfirmation(preview)),
      ).rejects.toThrow();
      expect(f.originalBytes()).toEqual(bytes);
      expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
      expect(f.commits).toBe(0);
    }
  });

  it("keeps an occupied fixed pending slot untouched and leaves the original approval usable", async () => {
    const f = fixture();
    f.writeApproval();
    const bytes = f.originalBytes();
    writeFileSync(f.pendingPath, "previous interrupted owned write", {
      mode: 0o600,
    });
    const pending = readFileSync(f.pendingPath);
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow();
    expect(f.originalBytes()).toEqual(bytes);
    expect(readFileSync(f.pendingPath)).toEqual(pending);
    expect(f.commits).toBe(0);
  });

  it("enforces UTC and monotonic expiry without allowing clock rollback to extend a ticket", async () => {
    const f = fixture();
    const owner = f.create({ previewLifetimeMs: 100 });
    const utc = Date.now();
    const monotonic = performance.now();
    const date = vi.spyOn(Date, "now").mockReturnValue(utc);
    const clock = vi.spyOn(performance, "now").mockReturnValue(monotonic);
    const preview = await owner.previewDirectory(f.source);
    date.mockReturnValue(utc - 60_000);
    clock.mockReturnValue(monotonic + 101);
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("preview_expired");
    expect(readdirSync(f.dataDirectory)).toEqual([]);
    date.mockReturnValue(utc);
    clock.mockReturnValue(monotonic);
    const second = await owner.previewDirectory(f.source);
    date.mockReturnValue(second.expiresAt + 1);
    await expect(
      owner.confirmPreview(sourceConfirmation(second)),
    ).rejects.toThrow("preview_expired");
  });

  it("cancels/replaces preview tickets and permanently withdraws on document lifetime loss", async () => {
    const f = fixture();
    const owner = f.create();
    const old = await owner.previewDirectory(f.source);
    const current = await owner.previewDirectory(f.source);
    expect(current.previewId).not.toBe(old.previewId);
    owner.cancelPreview({ previewId: old.previewId });
    owner.cancelPreview({ previewId: current.previewId });
    await expect(
      owner.confirmPreview(sourceConfirmation(current)),
    ).rejects.toThrow("preview_unavailable");
    const third = await owner.previewDirectory(f.source);
    f.withdraw();
    await expect(
      owner.confirmPreview(sourceConfirmation(third)),
    ).rejects.toThrow("fixture_document_withdrawn");
    await expect(owner.previewDirectory(f.source)).rejects.toThrow("closed");
    expect(readdirSync(f.dataDirectory)).toEqual([]);
  });

  it("claims a detached frozen exact command before runtime stop and preview unmount cancellation cannot retract it", async () => {
    const f = fixture();
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    const assets = ["ui/entry.mjs"];
    const input = sourceConfirmation(preview, {
      publicAssets: assets,
      trustUiModule: true,
    });
    const command = owner.claimPreview(input);
    expect(command).not.toBe(input);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.publicAssets)).toBe(true);
    assets.push("node/entry.mjs");
    expect(command.publicAssets).toEqual(["ui/entry.mjs"]);
    // The old hook unmounts when original management stop clears its client.
    owner.cancelPreview({ previewId: preview.previewId });
    const result = await owner.confirmPreview(command);
    expect(result.packageDigest).toBe(preview.packageDigest);
    expect(f.approval().publications[0].publicAssets).toEqual(["ui/entry.mjs"]);
    await expect(owner.confirmPreview(command)).rejects.toThrow(
      "preview_unavailable",
    );
  });

  it("direct confirmation auto-claims synchronously before a preview cancellation microtask", async () => {
    const f = fixture();
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    const result = owner.confirmPreview(sourceConfirmation(preview));
    owner.cancelPreview({ previewId: preview.previewId });
    expect((await result).packageDigest).toBe(preview.packageDigest);
    expect(f.approval().sources).toHaveLength(1);
  });

  it("a claim holds the ticket once and does not open a second physical confirmation slot", async () => {
    const f = fixture();
    const entered = sourceImportDeferred(),
      release = sourceImportDeferred();
    const owner = f.create({
      async beforeApprovalCommit() {
        entered.resolve();
        await release.promise;
      },
    });
    const preview = await owner.previewDirectory(f.source);
    const command = owner.claimPreview(sourceConfirmation(preview));
    expect(() => owner.claimPreview(command)).toThrow("claim_busy");
    await expect(owner.previewDirectory(f.source)).rejects.toThrow(
      "claim_busy",
    );
    const confirmation = owner.confirmPreview(command);
    await entered.promise;
    await expect(owner.confirmPreview(command)).rejects.toThrow("busy");
    owner.cancelPreview({ previewId: preview.previewId });
    release.resolve();
    expect((await confirmation).packageDigest).toBe(preview.packageDigest);
    expect(f.approval().sources).toHaveLength(1);
  });

  it.each([
    { publicAssets: ["ui/entry.mjs", "ui/chunk.mjs"], trustUiModule: true },
    { trustUiModule: true },
    { trustNodeExecution: false },
    { publisherId: "another.publisher" },
  ])(
    "consumes a claimed ticket on command mismatch %j without granting extra consent",
    async (change) => {
      const f = fixture();
      const owner = f.create();
      const preview = await owner.previewDirectory(f.source);
      const command = owner.claimPreview(sourceConfirmation(preview));
      await expect(
        owner.confirmPreview({ ...command, ...change }),
      ).rejects.toThrow("claim_mismatch");
      await expect(owner.confirmPreview(command)).rejects.toThrow(
        "preview_unavailable",
      );
      expect(readdirSync(f.dataDirectory)).toEqual([]);
      expect(existsSync(f.marker)).toBe(false);
    },
  );

  it("a claimed command cannot survive document withdrawal or actual close before execution", async () => {
    for (const mode of ["document", "close"] as const) {
      const f = fixture();
      const owner = f.create();
      const preview = await owner.previewDirectory(f.source);
      const command = owner.claimPreview(sourceConfirmation(preview));
      if (mode === "document") f.withdraw();
      else await owner.close();
      await expect(owner.confirmPreview(command)).rejects.toThrow(
        mode === "document" ? "fixture_document_withdrawn" : "closed",
      );
      await expect(owner.previewDirectory(f.source)).rejects.toThrow("closed");
      expect(readdirSync(f.dataDirectory)).toEqual([]);
    }
  });

  it("keeps the original preview expiry after synchronous claim while queued runtime stop waits", async () => {
    const f = fixture();
    const owner = f.create({ previewLifetimeMs: 100 });
    const utc = Date.now(),
      monotonic = performance.now();
    const date = vi.spyOn(Date, "now").mockReturnValue(utc);
    const clock = vi.spyOn(performance, "now").mockReturnValue(monotonic);
    const preview = await owner.previewDirectory(f.source);
    const command = owner.claimPreview(sourceConfirmation(preview));
    date.mockReturnValue(preview.expiresAt + 1);
    clock.mockReturnValue(monotonic + 101);
    await expect(owner.confirmPreview(command)).rejects.toThrow(
      "preview_expired",
    );
    await expect(owner.confirmPreview(command)).rejects.toThrow(
      "preview_unavailable",
    );
    expect(readdirSync(f.dataDirectory)).toEqual([]);
  });

  it("retains one physical slot until a held stop callback completes and close joins it before returning", async () => {
    const f = fixture();
    f.writeApproval();
    const bytes = f.originalBytes();
    const entered = sourceImportDeferred(),
      release = sourceImportDeferred();
    const owner = f.create({
      async beforeApprovalCommit() {
        entered.resolve();
        await release.promise;
      },
    });
    const preview = await owner.previewDirectory(f.source);
    let operationEnded = false;
    const command = owner.claimPreview(sourceConfirmation(preview));
    const confirmation = owner.confirmPreview(command);
    const result = confirmation.then(
      () => null,
      (error: unknown) => {
        operationEnded = true;
        return error;
      },
    );
    await entered.promise;
    await expect(owner.previewDirectory(f.source)).rejects.toThrow("busy");
    let physicallyClosed = false;
    const closed = owner.close().then(() => {
      physicallyClosed = true;
    });
    await Promise.resolve();
    expect(physicallyClosed).toBe(false);
    expect(operationEnded).toBe(false);
    release.resolve();
    expect(await result).toBeInstanceOf(Error);
    await closed;
    expect(physicallyClosed).toBe(true);
    expect(f.originalBytes()).toEqual(bytes);
    expect(existsSync(f.pendingPath)).toBe(false);
    await expect(owner.previewDirectory(f.source)).rejects.toThrow("closed");
  });

  it("checks pinned parent permissions at commit and never repairs a changed human directory", async () => {
    const f = fixture();
    f.writeApproval();
    const bytes = f.originalBytes();
    const owner = f.create({
      async beforeApprovalCommit() {
        chmodSync(f.root, 0o750);
      },
    });
    const preview = await owner.previewDirectory(f.source);
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("parent_changed");
    expect(f.originalBytes()).toEqual(bytes);
    expect(lstatSync(f.root).mode & 0o777).toBe(0o750);
    expect(lstatSync(f.source).mode & 0o777).toBe(0o755);
  });

  it("rejects a symlink source quarantine root without following or changing the outside directory", async () => {
    const f = fixture();
    const outside = join(f.root, "outside-human-root");
    mkdirSync(outside, { mode: 0o755 });
    symlinkSync(outside, join(f.dataDirectory, "plugin-import-sources"));
    const owner = f.create();
    const preview = await owner.previewDirectory(f.source);
    await expect(
      owner.confirmPreview(sourceConfirmation(preview)),
    ).rejects.toThrow("directory");
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(outside).mode & 0o777).toBe(0o755);
    expect(existsSync(f.approvalPath)).toBe(false);
  });
});
