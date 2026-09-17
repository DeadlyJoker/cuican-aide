import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import * as io from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalWorkspaceAuthority,
  LocalWorkspaceSandbox,
} from "./localWorkspace.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: vi.fn(real.open),
    opendir: vi.fn(real.opendir),
    lstat: vi.fn(real.lstat),
  };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string, workspace: string, other: string;
let authority: LocalWorkspaceAuthority, sandbox: LocalWorkspaceSandbox;

beforeEach(() => {
  vi.mocked(io.open).mockReset().mockImplementation(actual.open);
  vi.mocked(io.opendir).mockReset().mockImplementation(actual.opendir);
  vi.mocked(io.lstat).mockReset().mockImplementation(actual.lstat);
  root = mkdtempSync(join(tmpdir(), "crewon-bounded-desktop-read-"));
  workspace = join(root, "workspace");
  other = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(other);
  authority = new LocalWorkspaceAuthority(join(root, "profile"), workspace);
  sandbox = new LocalWorkspaceSandbox(authority);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("native workspace read budgets", () => {
  it("reads only 3,000 bytes of a 512 MiB file for the native preview", async () => {
    const descriptor = openSync(join(workspace, "large.log"), "wx");
    try {
      writeSync(descriptor, Buffer.from("prefix\n"));
      ftruncateSync(descriptor, 512 * 1024 * 1024);
    } finally {
      closeSync(descriptor);
    }
    let requestedBytes = 0,
      readCalls = 0,
      closed = 0;
    vi.mocked(io.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args),
        read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = vi.fn(
        async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          readCalls++;
          requestedBytes += length;
          return read(buffer, offset, length, position);
        },
      ) as unknown as typeof handle.read;
      handle.close = vi.fn(async () => {
        closed++;
        await close();
      });
      return handle;
    });
    const result = await sandbox.readFile("/workspace/large.log");
    expect(result).toMatchObject({
      path: "/workspace/large.log",
      byteLength: 512 * 1024 * 1024,
      truncated: true,
    });
    expect(Buffer.byteLength(result.content)).toBe(3000);
    expect(result.content.startsWith("prefix\n")).toBe(true);
    expect(requestedBytes).toBe(3000);
    expect(readCalls).toBe(1);
    expect(closed).toBe(1);
  });

  it("enumerates at most 121 names and returns an explicitly partial directory view", async () => {
    for (let index = 0; index < 400; index++)
      writeFileSync(
        join(workspace, `entry-${String(index).padStart(3, "0")}`),
        "x",
      );
    let readCalls = 0,
      closed = 0;
    vi.mocked(io.opendir).mockImplementationOnce(async (...args) => {
      const directory = await actual.opendir(...args),
        read = directory.read.bind(directory),
        close = directory.close.bind(directory);
      directory.read = vi.fn(async () => {
        readCalls++;
        return read();
      });
      directory.close = vi.fn(async () => {
        closed++;
        await close();
      });
      return directory;
    });
    const result = await sandbox.listDirectory();
    expect(result.root).toBe("/workspace");
    expect(result.path).toBe("/workspace");
    expect(result.entries).toHaveLength(120);
    expect(result.truncated).toBe(true);
    expect(readCalls).toBe(121);
    expect(closed).toBe(1);
    expect(io.lstat).toHaveBeenCalledTimes(123); // target + two identity checks + bounded entry metadata
    expect(result.entries.map((entry) => entry.name)).toEqual(
      result.entries
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b)),
    );
  });

  it("keeps small listing and preview response shapes, ordering and truncation compatible", async () => {
    mkdirSync(join(workspace, "z-directory"));
    writeFileSync(join(workspace, "b.txt"), "hello 界\n");
    symlinkSync(join(other, "unread"), join(workspace, "a-link"));
    const view = await sandbox.listDirectory();
    expect(view.truncated).toBe(false);
    expect(view.entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "z-directory", kind: "directory" },
      { name: "a-link", kind: "symlink" },
      { name: "b.txt", kind: "file" },
    ]);
    expect(await sandbox.readFile("/workspace/b.txt")).toEqual({
      path: "/workspace/b.txt",
      content: "hello 界\n",
      byteLength: 10,
      truncated: false,
    });
    writeFileSync(join(workspace, "empty.txt"), "");
    expect(await sandbox.readFile("/workspace/empty.txt")).toEqual({
      path: "/workspace/empty.txt",
      content: "",
      byteLength: 0,
      truncated: false,
    });
  });

  it("rejects traversal, wrong types and links outside the selected root before reading", async () => {
    writeFileSync(join(other, "secret"), "outside");
    symlinkSync(join(other, "secret"), join(workspace, "escape"));
    for (const path of [
      "/outside/secret",
      "/workspace/../outside/secret",
      "/workspace/escape",
      "/workspace",
      "/workspace/" + "x".repeat(8192),
    ]) {
      await expect(sandbox.readFile(path)).rejects.toThrow(
        "desktop_sandbox_path_invalid",
      );
    }
    expect(io.open).not.toHaveBeenCalled();
  });

  it("closes an opened file and rejects stale results when workspace selection changes", async () => {
    writeFileSync(join(workspace, "read.txt"), "old workspace");
    const entered = deferred(),
      release = deferred();
    let closed = 0;
    vi.mocked(io.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args),
        close = handle.close.bind(handle);
      handle.close = vi.fn(async () => {
        closed++;
        await close();
      });
      entered.resolve();
      await release.promise;
      return handle;
    });
    const pending = sandbox.readFile("/workspace/read.txt");
    await entered.promise;
    try {
      authority.select(other, {
        expectedRevision: 0,
        idempotencyKey: "switch-root",
      });
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toThrow("desktop_sandbox_workspace_changed");
    expect(closed).toBe(1);
  });

  it("closes the directory after an I/O error and frees shared admission", async () => {
    let closed = 0;
    vi.mocked(io.opendir).mockImplementationOnce(async (...args) => {
      const directory = await actual.opendir(...args),
        close = directory.close.bind(directory);
      directory.read = vi.fn(async () => {
        throw new Error("injected_read_failure");
      });
      directory.close = vi.fn(async () => {
        closed++;
        await close();
      });
      return directory;
    });
    await expect(sandbox.listDirectory()).rejects.toThrow(
      "injected_read_failure",
    );
    expect(closed).toBe(1);
    await expect(sandbox.listDirectory()).resolves.toMatchObject({
      entries: [],
      truncated: false,
    });
  });

  it("shares four physical slots across readers without blocking unrelated event loop work", async () => {
    writeFileSync(join(workspace, "read.txt"), "text");
    const entered = deferred(),
      release = deferred();
    let opened = 0;
    vi.mocked(io.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (++opened === 4) entered.resolve();
      await release.promise;
      return handle;
    });
    const readers = Array.from(
      { length: 4 },
      () => new LocalWorkspaceSandbox(authority),
    );
    const pending = readers.map((reader) =>
      reader.readFile("/workspace/read.txt"),
    );
    await entered.promise;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await expect(sandbox.listDirectory()).rejects.toThrow(
        "desktop_sandbox_read_capacity_exhausted",
      );
      expect(io.opendir).not.toHaveBeenCalled();
      expect(opened).toBe(4);
    } finally {
      release.resolve();
      await Promise.all(pending);
    }
    await expect(sandbox.listDirectory()).resolves.toMatchObject({
      truncated: false,
    });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
