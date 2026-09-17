import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measureSoakDisk,
  readSoakProcessRss,
  soakJournal,
} from "./observations.ts";
import { startSoakMetrics } from "./metrics.ts";
import { acquireSoakLease } from "./lease.ts";

describe("bounded soak observations", () => {
  it.skipIf(process.platform === "win32")(
    "includes an owned process without depending on its logging event loop",
    async () => {
      const snapshot = await readSoakProcessRss(process.pid);
      expect(snapshot.pid).toBe(process.pid);
      expect(snapshot.rssBytes).toBeGreaterThan(0);
      await expect(readSoakProcessRss(-1)).rejects.toThrow(
        "soak_process_pid_invalid",
      );
      await expect(readSoakProcessRss(Number.NaN)).rejects.toThrow(
        "soak_process_pid_invalid",
      );
    },
  );
  it("refuses overlapping runs and does not remove changed ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "crewon-soak-lease-"));
    try {
      const release = acquireSoakLease(root, "first");
      expect(() => acquireSoakLease(root, "second")).toThrow(
        "soak_active_or_stale_lease",
      );
      release();
      const second = acquireSoakLease(root, "second");
      writeFileSync(join(root, "active.json"), "changed");
      expect(second).toThrow("soak_lease_changed");
      expect(readFileSync(join(root, "active.json"), "utf8")).toBe("changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains at most two bounded journal segments", () => {
    const root = mkdtempSync(join(tmpdir(), "crewon-soak-journal-"));
    try {
      const journal = soakJournal(root, "metrics"),
        value = { payload: "x".repeat(100_000) };
      for (let index = 0; index < 250; index++) journal.append(value);
      expect(journal.snapshot().rotations).toBeGreaterThanOrEqual(2);
      for (const name of ["metrics.jsonl", "metrics.jsonl.previous"])
        expect(statSync(join(root, name)).size).toBeLessThanOrEqual(
          8 * 1024 ** 2,
        );
      expect(() => journal.append({ payload: "x".repeat(140_000) })).toThrow(
        "soak_observation_too_large",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow shared dependencies or other directories through symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewon-soak-disk-"));
    const outside = mkdtempSync(join(tmpdir(), "crewon-soak-outside-"));
    try {
      writeFileSync(join(root, "control.sqlite"), "1234");
      writeFileSync(join(root, "control.sqlite-wal"), "123");
      writeFileSync(join(outside, "data"), "x".repeat(100_000));
      symlinkSync(outside, join(root, "shared"));
      expect(await measureSoakDisk(root)).toMatchObject({
        logicalBytes: 7,
        categories: { sqlite: 4, wal: 3 },
        concurrentSnapshot: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads cached metrics without resetting histograms or writing on every UI poll", () => {
    const root = mkdtempSync(join(tmpdir(), "crewon-soak-metrics-"));
    const metrics = startSoakMetrics(root, "control");
    try {
      const path = join(root, `process-control-${process.pid}.json`),
        initial = readFileSync(path, "utf8");
      const sample = metrics.snapshot();
      for (let index = 0; index < 100; index++)
        expect(metrics.snapshot()).toBe(sample);
      expect(readFileSync(path, "utf8")).toBe(initial);
    } finally {
      metrics.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
