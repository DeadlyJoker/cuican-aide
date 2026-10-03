import {
  chmodSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";

const fsObservation = vi.hoisted(() => ({
  paths: [] as string[],
  beforeRead: null as ((path: string) => void) | null,
  beforeWrite: null as (() => void) | null,
  readBufferBytes: [] as number[],
  wrongUid: false,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const descriptors = new Map<number, string>();
  return {
    ...fs,
    lstatSync: ((
      path: Parameters<typeof fs.lstatSync>[0],
      options?: Parameters<typeof fs.lstatSync>[1],
    ) => {
      fsObservation.paths.push(String(path));
      const result = fs.lstatSync(path, options);
      if (
        result !== undefined &&
        fsObservation.wrongUid &&
        String(path).endsWith("plugin-approvals.json")
      )
        return Object.assign(result, {
          uid:
            typeof result.uid === "number" ? result.uid + 1 : result.uid + 1n,
        });
      return result;
    }) as typeof fs.lstatSync,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      fsObservation.paths.push(String(args[0]));
      const fd = fs.openSync(...args);
      descriptors.set(fd, String(args[0]));
      return fd;
    },
    readSync: ((...args: Parameters<typeof fs.readSync>) => {
      fsObservation.readBufferBytes.push(args[1].byteLength);
      fsObservation.beforeRead?.(descriptors.get(args[0])!);
      return fs.readSync(...args);
    }) as typeof fs.readSync,
    writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number") fsObservation.beforeWrite?.();
      return fs.writeFileSync(...args);
    }) as typeof fs.writeFileSync,
  };
});
const directories: string[] = [];
function fixture() {
  const f = desktopPluginBootstrapFixture();
  directories.push(f.directory);
  fsObservation.paths = [];
  fsObservation.readBufferBytes = [];
  return f;
}
afterEach(() => {
  fsObservation.beforeRead = null;
  fsObservation.beforeWrite = null;
  fsObservation.wrongUid = false;
  fsObservation.paths = [];
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("actual Native host-owned plugin bootstrap inputs", () => {
  it("missing fixed opt-in reads only that path and never creates a profile, scans packages or initializes plugins", async () => {
    const f = fixture();
    expect(await prepareDesktopPluginBootstrap(f.input)).toBeNull();
    expect(fsObservation.paths).toEqual([f.approvalPath]);
    expect(readdirSync(f.dataDirectory)).toEqual([]);
  });

  it("writes the exact private frozen DTO, binds a real persistent UUID profile and exposes only the environment path", async () => {
    const f = fixture();
    f.writeApproval();
    const result = await prepareDesktopPluginBootstrap(f.input);
    expect(result).not.toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.environment)).toBe(true);
    expect(Object.isFrozen(result!.scope)).toBe(true);
    const dto = f.read(result!.bootstrapPath);
    expect(dto).toEqual({
      schemaVersion: DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA,
      actor: f.input.actor,
      scope: result!.scope,
      authorityEpoch: result!.authorityEpoch,
      installRoot: join(f.dataDirectory, "plugins"),
      sources: [f.source],
      publications: [f.publication],
    });
    expect(result!.environment).toEqual({
      CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: result!.bootstrapPath,
    });
    expect(dto.scope.profileId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(readFileSync(result!.bootstrapPath, "utf8")).not.toContain(
      f.input.sessionEntropy,
    );
    expect(readdirSync(join(f.dataDirectory, "plugins"))).toEqual([]);
    expect(lstatSync(result!.bootstrapPath).mode & 0o777).toBe(0o600);
    expect(
      lstatSync(join(f.dataDirectory, "plugin-profile.json")).mode & 0o777,
    ).toBe(0o600);
    expect(lstatSync(join(f.dataDirectory, "plugins")).mode & 0o777).toBe(
      0o700,
    );
    const next = await prepareDesktopPluginBootstrap({
      ...f.input,
      sessionEntropy: `${f.input.sessionEntropy}:8`,
    });
    expect(next!.scope).toEqual(result!.scope);
    expect(next!.authorityEpoch).not.toBe(result!.authorityEpoch);
    await result!.cleanup();
    await result!.cleanup();
    await next!.cleanup();
    expect(readdirSync(f.dataDirectory).sort()).toEqual([
      "plugin-approvals.json",
      "plugin-profile.json",
      "plugins",
    ]);
  });

  it("derives its epoch from exact approval content and actual session entropy, with no request UUID or secret persisted", async () => {
    const f = fixture();
    f.writeApproval();
    const first = await prepareDesktopPluginBootstrap(f.input);
    const hash = (bytes: string | Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    expect(first!.authorityEpoch).toBe(
      hash(
        JSON.stringify({
          schemaVersion: "crewon.desktop-plugin-epoch.v1",
          approvalDigest: hash(readFileSync(f.approvalPath)),
          sessionEntropy: f.input.sessionEntropy,
        }),
      ),
    );
    const second = await prepareDesktopPluginBootstrap(f.input);
    expect(second!.bootstrapPath).toBe(first!.bootstrapPath);
    expect(second!.authorityEpoch).toBe(first!.authorityEpoch);
    await first!.cleanup();
    f.writeApproval({
      ...f.approval,
      publications: [{ ...f.publication, publicAssets: ["ui/entry.mjs"] }],
    });
    const changed = await prepareDesktopPluginBootstrap(f.input);
    expect(changed!.scope).toEqual(first!.scope);
    expect(changed!.authorityEpoch).not.toBe(first!.authorityEpoch);
    await changed!.cleanup();
  });

  it("never overwrites bootstrap content when approvals drift without a new Native lifecycle", async () => {
    const f = fixture();
    f.writeApproval();
    const first = await prepareDesktopPluginBootstrap(f.input);
    const before = readFileSync(first!.bootstrapPath);
    f.writeApproval({ ...f.approval, publications: [] });
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow(
      "changed_invalid",
    );
    expect(readFileSync(first!.bootstrapPath)).toEqual(before);
    await first!.cleanup();
  });

  it.each([
    "symlink",
    "hardlink",
    "mode",
    "uid",
    "directory",
    "oversize",
    "utf8",
  ])("refuses unsafe actual approval storage: %s", async (kind) => {
    const f = fixture();
    f.writeApproval();
    if (kind === "symlink") {
      renameSync(f.approvalPath, join(f.directory, "outside.json"));
      symlinkSync(join(f.directory, "outside.json"), f.approvalPath);
    }
    if (kind === "hardlink")
      linkSync(f.approvalPath, join(f.directory, "approval-alias.json"));
    if (kind === "mode") chmodSync(f.approvalPath, 0o644);
    if (kind === "uid") fsObservation.wrongUid = true; // UID mismatch only is an explicit metadata fault fixture.
    if (kind === "directory") chmodSync(f.dataDirectory, 0o755);
    if (kind === "oversize")
      writeFileSync(f.approvalPath, "x".repeat(128 * 1024 + 1));
    if (kind === "utf8") writeFileSync(f.approvalPath, Buffer.from([0xff]));
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
    expect(readdirSync(f.dataDirectory)).not.toContain("plugin-profile.json");
  });

  it("rejects symlink ancestors even when the leaf approval itself is a regular private file", async () => {
    const f = fixture();
    f.writeApproval();
    const alias = join(f.directory, "alias");
    symlinkSync(f.dataDirectory, alias);
    await expect(
      prepareDesktopPluginBootstrap({ ...f.input, dataDirectory: alias }),
    ).rejects.toThrow("directory_invalid");
    expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
  });

  it.each([
    "unknown",
    "schema",
    "duplicate-source",
    "duplicate-digest",
    "duplicate-publication",
    "asset",
    "source-path",
    "empty-public-assets",
    "publisher-conflict",
    "orphan-publication",
    "many-sources",
  ])("rejects exact bounded approval DTO violation: %s", async (kind) => {
    const f = fixture();
    let value: unknown = f.approval;
    if (kind === "unknown") value = { ...f.approval, actorId: "renderer" };
    if (kind === "schema") value = { ...f.approval, schemaVersion: "future" };
    if (kind === "duplicate-source")
      value = { ...f.approval, sources: [f.source, f.source] };
    if (kind === "duplicate-digest")
      value = {
        ...f.approval,
        sources: [
          f.source,
          {
            ...f.source,
            sourceId: "other",
            directory: `${f.source.directory}-other`,
            version: "2.0.0",
          },
        ],
      };
    if (kind === "duplicate-publication")
      value = { ...f.approval, publications: [f.publication, f.publication] };
    if (kind === "asset")
      value = {
        ...f.approval,
        publications: [{ ...f.publication, publicAssets: ["../secret"] }],
      };
    if (kind === "source-path")
      value = {
        ...f.approval,
        sources: [{ ...f.source, directory: "relative" }],
      };
    if (kind === "empty-public-assets")
      value = {
        ...f.approval,
        publications: [{ ...f.publication, publicAssets: [] }],
      };
    if (kind === "publisher-conflict")
      value = {
        ...f.approval,
        sources: [
          f.source,
          {
            ...f.source,
            sourceId: "second",
            directory: `${f.source.directory}-second`,
            publisherId: "different.publisher",
            version: "2.0.0",
            packageDigest: `sha256:${"b".repeat(64)}`,
          },
        ],
      };
    if (kind === "many-sources")
      value = { ...f.approval, sources: Array(33).fill(f.source) };
    if (kind === "orphan-publication") value = { ...f.approval, sources: [] };
    f.writeApproval(value);
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
    expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
  });

  it("captures authority input before any asynchronous caller mutation and rejects accessors/unknown identity without invoking them", async () => {
    const f = fixture();
    f.writeApproval();
    const input = { ...f.input, actor: { ...f.input.actor } };
    const pending = prepareDesktopPluginBootstrap(input);
    input.actor.actorId = "forged";
    input.sessionEntropy = "changed";
    const result = await pending;
    expect(f.read(result!.bootstrapPath).actor).toEqual(f.input.actor);
    const getter = vi.fn(() => f.input.sessionEntropy);
    await expect(
      prepareDesktopPluginBootstrap(
        Object.defineProperty({ ...f.input }, "sessionEntropy", {
          get: getter,
          enumerable: true,
        }),
      ),
    ).rejects.toThrow("shape_invalid");
    expect(getter).not.toHaveBeenCalled();
    await expect(
      prepareDesktopPluginBootstrap({
        ...f.input,
        actor: { ...f.input.actor, principalId: "PIM-user" },
      }),
    ).rejects.toThrow("actor_invalid");
    await expect(
      prepareDesktopPluginBootstrap({
        ...f.input,
        dataDirectory: `${f.dataDirectory}/../data`,
      }),
    ).rejects.toThrow("path_invalid");
    await result!.cleanup();
  });

  it("refuses a persistent profile bound to another actor without overwriting it", async () => {
    const f = fixture();
    f.writeApproval();
    const first = await prepareDesktopPluginBootstrap(f.input);
    await first!.cleanup();
    const path = join(f.dataDirectory, "plugin-profile.json");
    const altered = {
      ...f.read(path),
      actor: { ...f.input.actor, principalId: "wrong-owner" },
    };
    writeFileSync(path, JSON.stringify(altered));
    const before = readFileSync(path);
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow(
      "profile_invalid",
    );
    expect(readFileSync(path)).toEqual(before);
  });

  it("observes real approval mutation during descriptor reading and never publishes a bootstrap from a drifting source", async () => {
    const f = fixture();
    f.writeApproval();
    let mutated = false;
    fsObservation.beforeRead = (path) => {
      if (mutated || path !== f.approvalPath) return;
      mutated = true;
      f.writeApproval({ ...f.approval, publications: [] });
    };
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow(
      "changed_invalid",
    );
    expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
  });

  it("checks approval content again after final file preparation and leaves a changed snapshot unusable", async () => {
    const f = fixture();
    f.writeApproval();
    let changed = false;
    let writes = 0;
    fsObservation.beforeWrite = () => {
      if (++writes !== 2) return;
      changed = true;
      f.writeApproval({ ...f.approval, publications: [] });
    };
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow(
      "changed_invalid",
    );
    expect(changed).toBe(true);
    expect(
      readdirSync(f.dataDirectory).some((name) =>
        name.startsWith("plugin-bootstrap-"),
      ),
    ).toBe(false);
  });

  it("bounds actual descriptor read allocation when a valid small approval grows while open", async () => {
    const f = fixture();
    f.writeApproval();
    let grown = false;
    fsObservation.beforeRead = (path) => {
      if (grown || path !== f.approvalPath) return;
      grown = true;
      writeFileSync(f.approvalPath, Buffer.alloc(1024 * 1024, 32));
    };
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow(
      "changed_invalid",
    );
    expect(grown).toBe(true);
    expect(fsObservation.readBufferBytes).toEqual([128 * 1024 + 1]);
    expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
  });

  it("cleanup never unlinks a replacement inode or a symlink and retains a failed owner's file", async () => {
    const f = fixture();
    f.writeApproval();
    const result = await prepareDesktopPluginBootstrap(f.input);
    renameSync(
      result!.bootstrapPath,
      join(f.directory, "saved-bootstrap.json"),
    );
    writeFileSync(result!.bootstrapPath, "replacement", { mode: 0o600 });
    await expect(result!.cleanup()).rejects.toThrow("changed_invalid");
    expect(readFileSync(result!.bootstrapPath, "utf8")).toBe("replacement");
    rmSync(result!.bootstrapPath);
    symlinkSync(
      join(f.directory, "saved-bootstrap.json"),
      result!.bootstrapPath,
    );
    await expect(result!.cleanup()).rejects.toThrow("file_invalid");
    expect(lstatSync(result!.bootstrapPath).isSymbolicLink()).toBe(true);
  });
});
