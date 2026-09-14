import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { DownloadItem, WebContents, Event } from "electron";
import type { ToolExecutionCommand } from "@crewon/tool-broker";

const LIMIT = 10 * 1024 * 1024;
export type BrowserDownloadReceipt = {
  receiptId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};
type StoredDownload = BrowserDownloadReceipt & {
  executionId: string;
  actionDigest: string;
  runId: string;
};
export class BrowserExecutionDownloads {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  async capture(
    wc: WebContents,
    command: ToolExecutionCommand,
    signal: AbortSignal,
    click: () => Promise<unknown>,
  ): Promise<BrowserDownloadReceipt> {
    const receiptId = randomUUID();
    const path = join(this.directory, `${receiptId}.bytes`);
    let item: DownloadItem | null = null;
    let settled = false;
    let finish!: (receipt: BrowserDownloadReceipt) => void;
    let fail!: (error: Error) => void;
    const result = new Promise<BrowserDownloadReceipt>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const abort = () => {
      item?.cancel();
      stop(new Error("browser_download_canceled"));
    };
    const timer = setTimeout(() => {
      item?.cancel();
      stop(new Error("browser_download_timeout"));
    }, 25_000);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      wc.session.removeListener("will-download", onDownload);
    };
    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      fail(error);
    };
    const onDownload = (
      event: Event,
      candidate: DownloadItem,
      contents: WebContents,
    ) => {
      if (contents !== wc) return;
      if (item || signal.aborted || candidate.getTotalBytes() > LIMIT) {
        event.preventDefault();
        stop(new Error("browser_download_rejected"));
        return;
      }
      item = candidate;
      candidate.setSavePath(path);
      candidate.on("updated", () => {
        if (candidate.getReceivedBytes() > LIMIT || signal.aborted) {
          candidate.cancel();
          stop(new Error("browser_download_limit"));
        }
      });
      candidate.once("done", (_event, state) => {
        if (settled) return;
        if (state !== "completed" || signal.aborted) {
          stop(new Error("browser_download_incomplete"));
          return;
        }
        try {
          const size = statSync(path).size;
          if (size < 1 || size > LIMIT)
            throw new Error("browser_download_limit");
          const mediaType = candidate.getMimeType().split(";")[0]!.trim();
          if (
            ![
              "text/csv",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ].includes(mediaType)
          )
            throw new Error("browser_download_type_unsupported");
          const name =
            candidate
              .getFilename()
              .replace(/[\\/\x00-\x1f]/g, "_")
              .slice(0, 200) || "download.csv";
          const descriptor = openSync(path, "r");
          try {
            fsyncSync(descriptor);
          } finally {
            closeSync(descriptor);
          }
          const sha256 = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
          const receipt = {
            receiptId,
            name,
            mediaType,
            sizeBytes: size,
            sha256,
          };
          const record: StoredDownload = {
            ...receipt,
            executionId: command.executionId,
            actionDigest: command.actionDigest,
            runId: command.runId,
          };
          const meta = join(this.directory, `${receiptId}.json`);
          writeFileSync(meta, JSON.stringify(record), {
            mode: 0o600,
            flag: "wx",
          });
          const fd = openSync(meta, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          settled = true;
          cleanup();
          finish(receipt);
        } catch (error) {
          stop(
            error instanceof Error
              ? error
              : new Error("browser_download_failed"),
          );
        }
      });
    };
    wc.session.on("will-download", onDownload);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else
      void click().catch((error) =>
        stop(
          error instanceof Error
            ? error
            : new Error("browser_download_click_failed"),
        ),
      );
    return result;
  }
  read(receiptId: string, command: ToolExecutionCommand): Uint8Array {
    if (!/^[a-f0-9-]{36}$/.test(receiptId))
      throw new Error("browser_download_receipt_invalid");
    const meta = join(this.directory, `${receiptId}.json`);
    if (statSync(meta).size > 4096)
      throw new Error("browser_download_receipt_invalid");
    const record = JSON.parse(readFileSync(meta, "utf8")) as StoredDownload;
    if (
      record.receiptId !== receiptId ||
      record.executionId !== command.executionId ||
      record.actionDigest !== command.actionDigest ||
      record.runId !== command.runId
    )
      throw new Error("browser_download_receipt_forbidden");
    const path = join(this.directory, `${receiptId}.bytes`);
    if (statSync(path).size !== record.sizeBytes || record.sizeBytes > LIMIT)
      throw new Error("browser_download_receipt_invalid");
    const content = readFileSync(path);
    if (
      `sha256:${createHash("sha256").update(content).digest("hex")}` !==
      record.sha256
    )
      throw new Error("browser_download_receipt_invalid");
    return content;
  }
}
