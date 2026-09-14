import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRendererHeapAudit } from "./renderer-heap.ts";

class Debugger extends EventEmitter {
  attached = false;
  calls: string[] = [];
  mode = "normal";
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  detach() {
    this.attached = false;
    this.emit("detach", {}, "closed");
  }
  async sendCommand(method: string) {
    this.calls.push(method);
    if (this.mode === "hang") return new Promise(() => {});
    if (method === "Runtime.getHeapUsage")
      return this.mode === "invalid" ? {} : { usedSize: 1000, totalSize: 2000 };
    if (method === "Memory.getDOMCounters")
      return { documents: 1, nodes: 100, jsEventListeners: 5 };
    if (method === "HeapProfiler.takeHeapSnapshot") {
      this.emit("message", {}, "HeapProfiler.addHeapSnapshotChunk", {
        chunk: '{"snapshot":',
      });
      if (this.mode === "disconnect") {
        this.detach();
        return {};
      }
      this.emit("message", {}, "HeapProfiler.addHeapSnapshotChunk", {
        chunk: this.mode === "large" ? "x".repeat(100) : '"完整🚀"}',
      });
    }
    return {};
  }
}
const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "crewon-heap-audit-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("explicit renderer heap diagnostics", () => {
  it("writes exact streamed UTF-8, two fixed checkpoints, and detaches without retaining listeners", async () => {
    const path = root(),
      debug = new Debugger(),
      capture = createRendererHeapAudit(path, () => debug);
    for (const label of ["warm", "final"] as const) {
      const result = await capture(label);
      expect(result.explicitGc).toBe(true);
      expect(result.afterGc).toEqual({
        usedSize: 1000,
        totalSize: 2000,
        embedderHeapUsedSize: null,
        backingStorageSize: null,
      });
      expect(readFileSync(join(path, result.snapshot.filename), "utf8")).toBe(
        '{"snapshot":"完整🚀"}',
      );
      expect(debug.attached).toBe(false);
      expect(debug.eventNames()).toEqual([]);
    }
    await expect(capture("warm")).rejects.toThrow(
      "soak_heap_checkpoint_invalid",
    );
    expect(
      debug.calls.filter((x) => x === "HeapProfiler.collectGarbage"),
    ).toHaveLength(2);
  });
  it("enforces bytes while receiving and removes only its partial file on overflow/disconnection", async () => {
    for (const mode of ["large", "disconnect", "invalid"]) {
      const path = root(),
        debug = new Debugger();
      debug.mode = mode;
      const capture = createRendererHeapAudit(path, () => debug, {
        bytes: 40,
        deadlineMs: 1000,
      });
      await expect(capture("warm")).rejects.toThrow(/soak_heap_/);
      expect(readdirSync(path)).toEqual([]);
      expect(debug.attached).toBe(false);
      expect(debug.eventNames()).toEqual([]);
      debug.mode = "normal";
      await capture("warm");
    }
  });
  it("bounds hung commands, rejects concurrency, and cleans listeners and files", async () => {
    const path = root(),
      debug = new Debugger();
    debug.mode = "hang";
    const capture = createRendererHeapAudit(path, () => debug, {
      bytes: 1000,
      deadlineMs: 20,
    });
    const pending = capture("warm");
    await expect(capture("final")).rejects.toThrow(
      "soak_heap_checkpoint_invalid",
    );
    await expect(pending).rejects.toThrow("soak_heap_deadline");
    expect(readdirSync(path)).toEqual([]);
    expect(debug.attached).toBe(false);
    expect(debug.eventNames()).toEqual([]);
  });
  it("does not take over another debugger or overwrite existing evidence", async () => {
    const path = root(),
      debug = new Debugger();
    debug.attached = true;
    const capture = createRendererHeapAudit(path, () => debug);
    await expect(capture("warm")).rejects.toThrow(
      "soak_heap_debugger_already_attached",
    );
    expect(debug.attached).toBe(true);
    debug.attached = false;
    writeFileSync(join(path, "renderer-warm.heapsnapshot"), "prior");
    await expect(capture("warm")).rejects.toThrow("soak_heap_snapshot_exists");
    expect(readFileSync(join(path, "renderer-warm.heapsnapshot"), "utf8")).toBe(
      "prior",
    );
    writeFileSync(join(path, "renderer-final.heapsnapshot.tmp"), "prior-temp");
    await expect(capture("final")).rejects.toThrow();
    expect(
      readFileSync(join(path, "renderer-final.heapsnapshot.tmp"), "utf8"),
    ).toBe("prior-temp");
  });
});
