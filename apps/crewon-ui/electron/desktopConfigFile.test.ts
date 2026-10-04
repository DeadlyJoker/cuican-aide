import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discardInterruptedDesktopConfigWrites,
  writeDesktopConfigAtomically,
} from "./desktopConfigFile.ts";

const fault = vi.hoisted(() => ({ phase: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const fail = () => Object.assign(new Error("disk_fault"), { code: "ENOSPC" });
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.phase === "write" && typeof args[0] === "number") {
        fs.writeSync(args[0], "partial");
        throw fail();
      }
      return fs.writeFileSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      if (fault.phase === "sync") throw fail();
      return fs.fsyncSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fault.phase === "rename" || fault.phase === "cleanup") throw fail();
      return fs.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (fault.phase === "cleanup") throw new Error("cleanup_denied");
      return fs.unlinkSync(...args);
    },
  };
});

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "crewon-config-file-"));
  directories.push(directory);
  const path = join(directory, "desktop-workspace.json");
  return { directory, path, pending: `${path}.pending-v1` };
}
afterEach(() => {
  fault.phase = "";
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("bounded desktop configuration staging", () => {
  it("retains one blocked slot after cleanup failure while committed state remains usable", () => {
    const { path, directory, pending } = fixture();
    writeDesktopConfigAtomically(path, "committed");
    fault.phase = "cleanup";
    expect(() => writeDesktopConfigAtomically(path, "next")).toThrow(
      "desktop_config_write_and_cleanup_failed",
    );
    expect(
      discardInterruptedDesktopConfigWrites({
        dataDirectory: directory,
        ownsSingleInstance: true,
      }),
    ).toEqual({ removed: 0, retained: 1 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(() => writeDesktopConfigAtomically(path, "retry")).toThrow();
      expect(readFileSync(path, "utf8")).toBe("committed");
      expect(readFileSync(pending, "utf8")).toBe("next");
      expect(readdirSync(directory)).toHaveLength(2);
    }
    fault.phase = "";
    expect(
      discardInterruptedDesktopConfigWrites({
        dataDirectory: directory,
        ownsSingleInstance: true,
      }),
    ).toEqual({ removed: 1, retained: 0 });
    writeDesktopConfigAtomically(path, "recovered");
    expect(readFileSync(path, "utf8")).toBe("recovered");
  });

  it.each(["write", "sync", "rename"])(
    "keeps committed bytes and removes partial staging after %s failure",
    (phase) => {
      const { path, directory } = fixture();
      writeDesktopConfigAtomically(path, "committed");
      fault.phase = phase;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        expect(() => writeDesktopConfigAtomically(path, "next")).toThrow(
          "disk_fault",
        );
        expect(readFileSync(path, "utf8")).toBe("committed");
        expect(readdirSync(directory)).toEqual(["desktop-workspace.json"]);
      }
      fault.phase = "";
      writeDesktopConfigAtomically(path, "recovered");
      expect(readFileSync(path, "utf8")).toBe("recovered");
      if (process.platform !== "win32") {
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("rejects unknown targets and oversized UTF-8 before creating staging", () => {
    const { path, directory } = fixture();
    expect(() =>
      writeDesktopConfigAtomically(path, "界".repeat(44_000)),
    ).toThrow("desktop_config_too_large");
    expect(() =>
      writeDesktopConfigAtomically(join(directory, "history.json"), "x"),
    ).toThrow("desktop_config_target_invalid");
    expect(readdirSync(directory)).toEqual([]);
  });

  it("does not truncate an occupied staging slot or follow its symlink", () => {
    const { path, pending, directory } = fixture();
    writeFileSync(pending, "another writer");
    expect(() => writeDesktopConfigAtomically(path, "next")).toThrow();
    expect(readFileSync(pending, "utf8")).toBe("another writer");
    rmSync(pending);
    const outside = join(directory, "other-file");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, pending);
    expect(() => writeDesktopConfigAtomically(path, "next")).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(lstatSync(pending).isSymbolicLink()).toBe(true);
  });

  it("requires the instance lock and discards only four known pending files", () => {
    const { path, pending, directory } = fixture();
    writeFileSync(path, "committed");
    const names = [
      "provider-credentials.json",
      "agent-platform-credentials.json",
      "desktop-workspace.json",
      "desktop-model-catalog-cache.json",
    ];
    for (const name of names)
      writeFileSync(join(directory, `${name}.pending-v1`), "partial");
    for (const name of [
      "history.json",
      "other.pending-v1",
      "desktop-workspace.json.123.tmp",
    ]) {
      writeFileSync(join(directory, name), "retain");
    }
    expect(() =>
      discardInterruptedDesktopConfigWrites({
        dataDirectory: directory,
        ownsSingleInstance: false,
      }),
    ).toThrow("desktop_config_instance_lock_required");
    expect(existsSync(pending)).toBe(true);
    discardInterruptedDesktopConfigWrites({
      dataDirectory: directory,
      ownsSingleInstance: true,
    });
    expect(readdirSync(directory).sort()).toEqual([
      "desktop-workspace.json",
      "desktop-workspace.json.123.tmp",
      "history.json",
      "other.pending-v1",
    ]);
    expect(readFileSync(path, "utf8")).toBe("committed");
  });

  it.each(["symlink", "hardlink", "directory", "oversized"])(
    "refuses unexpected %s pending entries without changing their targets",
    (kind) => {
      const { directory, pending } = fixture();
      const other = join(directory, "other");
      writeFileSync(other, "retain");
      if (kind === "symlink") symlinkSync(other, pending);
      else if (kind === "hardlink") linkSync(other, pending);
      else if (kind === "directory") mkdirSync(pending);
      else writeFileSync(pending, Buffer.alloc(128 * 1024 + 1));
      expect(
        discardInterruptedDesktopConfigWrites({
          dataDirectory: directory,
          ownsSingleInstance: true,
        }),
      ).toEqual({ removed: 0, retained: 1 });
      expect(() =>
        writeDesktopConfigAtomically(
          join(directory, "desktop-workspace.json"),
          "next",
        ),
      ).toThrow();
      expect(existsSync(pending)).toBe(true);
      expect(readFileSync(other, "utf8")).toBe("retain");
    },
  );

  it.each(["before", "after"])(
    "bounds staging when the writer process crashes %s rename",
    (phase) => {
      const { directory, path, pending } = fixture();
      writeDesktopConfigAtomically(path, "committed");
      const source = new URL("./desktopConfigFile.ts", import.meta.url).href;
      const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        if (${JSON.stringify(phase)} === 'after') rename(...args);
        process.kill(process.pid, 'SIGKILL');
      };
      syncBuiltinESMExports();
      const { writeDesktopConfigAtomically } = await import(${JSON.stringify(source)});
      writeDesktopConfigAtomically(${JSON.stringify(path)}, 'uncommitted');
    `;
      for (let restart = 0; restart < 12; restart += 1) {
        const child = spawnSync(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", code],
          { timeout: 5_000, encoding: "utf8", maxBuffer: 16 * 1024 },
        );
        expect(child.error).toBeUndefined();
        expect(child.signal).toBe("SIGKILL");
        expect(child.stderr).toBe("");
        expect(readFileSync(path, "utf8")).toBe(
          phase === "before" ? "committed" : "uncommitted",
        );
        if (phase === "before")
          expect(readFileSync(pending, "utf8")).toBe("uncommitted");
        else expect(existsSync(pending)).toBe(false);
        expect(readdirSync(directory)).toHaveLength(phase === "before" ? 2 : 1);
        discardInterruptedDesktopConfigWrites({
          dataDirectory: directory,
          ownsSingleInstance: true,
        });
        expect(readdirSync(directory)).toHaveLength(1);
        expect(readFileSync(path, "utf8")).toBe(
          phase === "before" ? "committed" : "uncommitted",
        );
        writeDesktopConfigAtomically(path, "committed");
      }
      writeDesktopConfigAtomically(path, "recovered");
      expect(readFileSync(path, "utf8")).toBe("recovered");
    },
  );
});
