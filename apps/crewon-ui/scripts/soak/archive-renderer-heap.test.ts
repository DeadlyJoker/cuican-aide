import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { archiveRendererHeaps } from "./archive-renderer-heap.ts";

const roots: string[] = [];
const data = JSON.stringify({
  snapshot: { meta: "fixture" },
  strings: ["保留原文😀".repeat(1000)],
});
const labels = ["warm", "final"];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "crewon-heap-archive-"));
  roots.push(root);
  writeFileSync(
    join(root, "status.json"),
    JSON.stringify({ phase: "durationReached" }),
  );
  writeFileSync(
    join(root, "cleanup.json"),
    JSON.stringify({ ownedGroupGone: true, desktopExitCode: 0 }),
  );
  writeFileSync(
    join(root, "controller.json"),
    JSON.stringify({ pid: 2147483647 }),
  );
  writeFileSync(
    join(root, "renderer-heap.json"),
    JSON.stringify({
      explicitGc: true,
      checkpoints: labels.map((label) => ({
        result: {
          label,
          snapshot: {
            filename: `renderer-${label}.heapsnapshot`,
            bytes: Buffer.byteLength(data),
          },
        },
      })),
    }),
  );
  for (const label of labels)
    writeFileSync(join(root, `renderer-${label}.heapsnapshot`), data);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("lossless completed renderer heap archive", () => {
  it("preserves exact UTF-8 bytes, writes a restore index and supports an idempotent retry", async () => {
    const root = fixture(),
      result = await archiveRendererHeaps(root);
    expect(result.savedBytes).toBeGreaterThan(0);
    expect(result.entries).toHaveLength(2);
    for (const entry of result.entries) {
      expect(existsSync(join(root, entry.filename))).toBe(false);
      expect(
        gunzipSync(readFileSync(join(root, entry.gzipFilename))).toString(),
      ).toBe(data);
    }
    expect(await archiveRendererHeaps(root)).toEqual(result);
    // Model a restart after the index was written, before the original was removed.
    writeFileSync(join(root, result.entries[0]!.filename), data);
    expect(await archiveRendererHeaps(root)).toEqual(result);
    expect(existsSync(join(root, ".renderer-heap-archive.lock"))).toBe(false);
  });
  it("recovers a matching published gzip without overwriting it", async () => {
    const root = fixture(),
      path = join(root, "renderer-warm.heapsnapshot.gz"),
      gzip = gzipSync(data);
    writeFileSync(path, gzip);
    await archiveRendererHeaps(root);
    expect(readFileSync(path)).toEqual(gzip);
  });
  it("rejects corrupt or oversized decoded archives and preserves the source", async () => {
    for (const body of [
      Buffer.from("broken"),
      gzipSync(data + data),
      gzipSync(data.replace("fixture", "changed")),
    ]) {
      const root = fixture();
      writeFileSync(join(root, "renderer-warm.heapsnapshot.gz"), body);
      await expect(archiveRendererHeaps(root)).rejects.toThrow();
      expect(
        readFileSync(join(root, "renderer-warm.heapsnapshot"), "utf8"),
      ).toBe(data);
      expect(existsSync(join(root, ".renderer-heap-archive.lock"))).toBe(false);
    }
  });
  it("refuses incomplete runs, symlinks and conflicting sources without removing data", async () => {
    const root = fixture();
    writeFileSync(
      join(root, "status.json"),
      JSON.stringify({ phase: "running" }),
    );
    await expect(archiveRendererHeaps(root)).rejects.toThrow(
      "soak_heap_archive_not_completed",
    );
    writeFileSync(
      join(root, "status.json"),
      JSON.stringify({ phase: "durationReached" }),
    );
    const source = join(root, "renderer-warm.heapsnapshot");
    unlinkSync(source);
    symlinkSync(join(root, "renderer-final.heapsnapshot"), source);
    await expect(archiveRendererHeaps(root)).rejects.toThrow(
      "soak_heap_archive_file_invalid",
    );
    expect(
      readFileSync(join(root, "renderer-final.heapsnapshot"), "utf8"),
    ).toBe(data);
    unlinkSync(source);
    writeFileSync(source, data);
    const result = await archiveRendererHeaps(root);
    writeFileSync(source, data.replace("fixture", "changed"));
    await expect(archiveRendererHeaps(root)).rejects.toThrow(
      "soak_heap_archive_source_changed",
    );
    expect(
      readFileSync(join(root, result.entries[0]!.gzipFilename)),
    ).toBeTruthy();
  });
});
