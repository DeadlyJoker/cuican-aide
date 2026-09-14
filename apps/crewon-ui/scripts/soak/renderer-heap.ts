import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

type MessageListener = (
  event: unknown,
  method: string,
  params: unknown,
) => void;
type DetachListener = (event: unknown, reason: string) => void;
export type HeapDebugger = {
  isAttached(): boolean;
  attach(version: string): void;
  detach(): void;
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  on(event: "message", listener: MessageListener): unknown;
  on(event: "detach", listener: DetachListener): unknown;
  off(event: "message", listener: MessageListener): unknown;
  off(event: "detach", listener: DetachListener): unknown;
};

export const RENDERER_HEAP_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const RENDERER_HEAP_DEADLINE_MS = 10000;
// The current transcript reads 50 messages. Fill that working set before comparing retained heaps.
export const RENDERER_HEAP_WARM_TURNS = 30;

/** Explicit fixture-only diagnostics. Two snapshots; no production or periodic GC. */
export function createRendererHeapAudit(
  root: string,
  getDebugger: () => HeapDebugger,
  budget = {
    bytes: RENDERER_HEAP_SNAPSHOT_BYTES,
    deadlineMs: RENDERER_HEAP_DEADLINE_MS,
  },
) {
  if (
    !Number.isSafeInteger(budget.bytes) ||
    budget.bytes < 1 ||
    budget.bytes > RENDERER_HEAP_SNAPSHOT_BYTES ||
    !Number.isSafeInteger(budget.deadlineMs) ||
    budget.deadlineMs < 1 ||
    budget.deadlineMs > RENDERER_HEAP_DEADLINE_MS
  )
    throw new Error("soak_heap_budget_invalid");
  const captured = new Set<string>();
  let busy = false;
  return async (label: "warm" | "final") => {
    if (!["warm", "final"].includes(label) || captured.has(label) || busy)
      throw new Error("soak_heap_checkpoint_invalid");
    const debug = getDebugger();
    busy = true;
    const filename = `renderer-${label}.heapsnapshot`,
      temporary = join(root, `${filename}.tmp`);
    let attached = false,
      fd: number | null = null,
      ownedFile = false,
      bytes = 0,
      failure: Error | null = null;
    let rejectFailure: (reason: Error) => void = () => {};
    const failed = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    // Attach a handler before a synchronous snapshot event can fail.
    void failed.catch(() => {});
    const fail = (reason: Error) => {
      if (failure) return;
      failure = reason;
      rejectFailure(reason);
      if (attached) {
        attached = false;
        try {
          debug.detach();
        } catch {
          /* outer harness also owns process shutdown */
        }
      }
    };
    const onMessage: MessageListener = (_event, method, params) => {
      if (method !== "HeapProfiler.addHeapSnapshotChunk" || failure) return;
      try {
        const chunk = (params as { chunk?: unknown } | null)?.chunk;
        if (
          typeof chunk !== "string" ||
          chunk.length > 1024 * 1024 ||
          fd === null
        )
          throw new Error("soak_heap_chunk_invalid");
        const buffer = Buffer.from(chunk);
        if (bytes + buffer.length > budget.bytes)
          throw new Error("soak_heap_snapshot_capacity");
        let offset = 0;
        while (offset < buffer.length) {
          const written = writeSync(fd, buffer, offset, buffer.length - offset);
          if (written <= 0) throw new Error("soak_heap_snapshot_write_failed");
          offset += written;
        }
        bytes += buffer.length;
      } catch (cause) {
        fail(
          cause instanceof Error
            ? cause
            : new Error("soak_heap_snapshot_write_failed"),
        );
      }
    };
    const onDetach: DetachListener = (_event, reason) =>
      fail(new Error(`soak_heap_debugger_detached:${reason.slice(0, 100)}`));
    const command = (method: string, params?: Record<string, unknown>) => {
      if (failure) return Promise.reject(failure);
      return Promise.race([debug.sendCommand(method, params), failed]);
    };
    const started = performance.now();
    const timeout = setTimeout(
      () => fail(new Error("soak_heap_deadline")),
      budget.deadlineMs,
    );
    try {
      if (debug.isAttached())
        throw new Error("soak_heap_debugger_already_attached");
      if (existsSync(join(root, filename)))
        throw new Error("soak_heap_snapshot_exists");
      debug.attach("1.3");
      attached = true;
      debug.on("message", onMessage);
      debug.on("detach", onDetach);
      fd = openSync(temporary, "wx", 0o600);
      ownedFile = true;
      const before = heapUsage(await command("Runtime.getHeapUsage"));
      await command("HeapProfiler.collectGarbage");
      const afterGc = heapUsage(await command("Runtime.getHeapUsage"));
      const domAfterGc = domCounters(await command("Memory.getDOMCounters"));
      await command("HeapProfiler.takeHeapSnapshot", {
        reportProgress: false,
        captureNumericValue: false,
      });
      if (failure) throw failure;
      if (!bytes) throw new Error("soak_heap_snapshot_empty");
      closeSync(fd);
      fd = null;
      renameSync(temporary, join(root, filename));
      ownedFile = false;
      captured.add(label);
      return {
        label,
        sampledAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        explicitGc: true,
        before,
        afterGc,
        domAfterGc,
        snapshot: { filename, bytes, maxBytes: budget.bytes },
      };
    } finally {
      clearTimeout(timeout);
      debug.off("message", onMessage);
      debug.off("detach", onDetach);
      if (attached) {
        attached = false;
        try {
          debug.detach();
        } catch {
          /* target may have closed; do not skip file cleanup */
        }
      }
      try {
        if (fd !== null) closeSync(fd);
      } finally {
        try {
          if (ownedFile) rmSync(temporary, { force: true });
        } finally {
          busy = false;
        }
      }
    }
  };
}

function heapUsage(value: unknown) {
  const row = value as Record<string, unknown> | null;
  const required = (key: string) => {
    const number = row?.[key];
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 0
    )
      throw new Error("soak_heap_metrics_invalid");
    return number;
  };
  const optional = (key: string) =>
    row?.[key] === undefined ? null : required(key);
  return {
    usedSize: required("usedSize"),
    totalSize: required("totalSize"),
    embedderHeapUsedSize: optional("embedderHeapUsedSize"),
    backingStorageSize: optional("backingStorageSize"),
  };
}
function domCounters(value: unknown) {
  const row = value as Record<string, unknown> | null;
  const output: Record<string, number> = {};
  for (const key of ["documents", "nodes", "jsEventListeners"]) {
    const number = row?.[key];
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 0
    )
      throw new Error("soak_heap_dom_invalid");
    output[key] = number;
  }
  return output;
}
