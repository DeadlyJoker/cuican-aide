import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserExecutionDownloads } from "./browserExecutionDownload.ts";

const roots: string[] = [];
const command = {
  executionId: "execution-1",
  runId: "run-1",
  actionDigest: `sha256:${"a".repeat(64)}`,
} as ToolExecutionCommand;
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("BrowserExecutionDownloads action completion", () => {
  it("waits for click cleanup after a fast completed download before returning its persisted bytes", async () => {
    const { downloads, wc, finishDownload } = setup();
    const clickFinished = deferred<void>();
    let focusRestored = false;
    let finished = false;
    const pending = downloads
      .capture(
        wc as unknown as WebContents,
        command,
        new AbortController().signal,
        async () => {
          finishDownload();
          try {
            await clickFinished.promise;
          } finally {
            focusRestored = true;
          }
        },
      )
      .then((result) => {
        finished = true;
        return result;
      });
    await tick();
    expect(finished).toBe(false);
    expect(focusRestored).toBe(false);
    clickFinished.resolve(undefined);
    const receipt = await pending;
    expect(focusRestored).toBe(true);
    expect(
      Buffer.from(downloads.read(receipt.receiptId, command)).toString(),
    ).toBe("date,total\n2026-09-14,42\n");
    expect(wc.session.listenerCount("will-download")).toBe(0);
  });

  it("does not hide a click cleanup failure behind an already completed download", async () => {
    const { downloads, wc, finishDownload } = setup();
    const clickFinished = deferred<void>();
    const pending = downloads.capture(
      wc as unknown as WebContents,
      command,
      new AbortController().signal,
      async () => {
        finishDownload();
        await clickFinished.promise;
        throw new Error("focus_restore_failed");
      },
    );
    const result = pending.then(
      () => "completed",
      (error: Error) => error.message,
    );
    await tick();
    clickFinished.resolve(undefined);
    expect(await result).toBe("focus_restore_failed");
    expect(wc.session.listenerCount("will-download")).toBe(0);
  });

  it("waits for click cleanup even when the download fails first", async () => {
    const { downloads, wc, finishDownload } = setup();
    const clickFinished = deferred<void>();
    let settled = false;
    const pending = downloads
      .capture(
        wc as unknown as WebContents,
        command,
        new AbortController().signal,
        async () => {
          finishDownload("cancelled");
          await clickFinished.promise;
        },
      )
      .then(
        () => {
          settled = true;
          return "completed";
        },
        (error: Error) => {
          settled = true;
          return error.message;
        },
      );
    await tick();
    expect(settled).toBe(false);
    clickFinished.resolve(undefined);
    expect(await pending).toBe("browser_download_incomplete");
    expect(wc.session.listenerCount("will-download")).toBe(0);
  });

  it("cleans listeners when the click throws synchronously", async () => {
    const { downloads, wc } = setup();
    await expect(
      downloads.capture(
        wc as unknown as WebContents,
        command,
        new AbortController().signal,
        () => {
          throw new Error("click_failed");
        },
      ),
    ).rejects.toThrow("click_failed");
    expect(wc.session.listenerCount("will-download")).toBe(0);
  });

  it("does not dispatch an already canceled action", async () => {
    const { downloads, wc } = setup();
    const abort = new AbortController();
    abort.abort();
    const click = vi.fn(async () => undefined);
    await expect(
      downloads.capture(
        wc as unknown as WebContents,
        command,
        abort.signal,
        click,
      ),
    ).rejects.toThrow("browser_download_canceled");
    expect(click).not.toHaveBeenCalled();
    expect(wc.session.listenerCount("will-download")).toBe(0);
  });

  it("does not dispatch when canceled before the queued click begins", async () => {
    const { downloads, wc } = setup();
    const abort = new AbortController();
    const click = vi.fn(async () => undefined);
    const pending = downloads.capture(
      wc as unknown as WebContents,
      command,
      abort.signal,
      click,
    );
    abort.abort();
    await expect(pending).rejects.toThrow("browser_download_canceled");
    expect(click).not.toHaveBeenCalled();
    expect(wc.session.listenerCount("will-download")).toBe(0);
  });

  it("rejects cancellation during click cleanup even if downloaded bytes finished earlier", async () => {
    const { downloads, wc, finishDownload } = setup();
    const clickFinished = deferred<void>();
    const abort = new AbortController();
    const pending = downloads.capture(
      wc as unknown as WebContents,
      command,
      abort.signal,
      async () => {
        finishDownload();
        await clickFinished.promise;
      },
    );
    const result = pending.then(
      () => "completed",
      (error: Error) => error.message,
    );
    await tick();
    abort.abort();
    clickFinished.resolve(undefined);
    expect(await result).toBe("browser_download_canceled");
  });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "crewon-download-completion-"));
  roots.push(directory);
  const downloads = new BrowserExecutionDownloads(directory);
  const wc = { session: new EventEmitter() };
  const finishDownload = (state = "completed") => {
    const content = "date,total\n2026-09-14,42\n";
    const item = Object.assign(new EventEmitter(), {
      getTotalBytes: () => Buffer.byteLength(content),
      getReceivedBytes: () => Buffer.byteLength(content),
      getMimeType: () => "text/csv",
      getFilename: () => "report.csv",
      setSavePath: (path: string) => writeFileSync(path, content),
      cancel: vi.fn(),
    });
    wc.session.emit("will-download", { preventDefault: vi.fn() }, item, wc);
    item.emit("done", {}, state);
  };
  return { downloads, wc, finishDownload };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
