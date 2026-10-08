import {
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  type PluginProjectSourceUploadsClient,
  type ProjectSourceUploadInputMap,
  type ProjectSourceUploadFormat,
  type PublicProjectSourceUpload,
} from "@crewon/plugin-sdk/project-source-uploads";
import type { ProjectSourceUploadUiPort } from "./ProjectSourceUploadUiPort";
import type { ProjectFoundationSourceUpload } from "@crewon/plugin-sdk/project-foundation-ui";

type Request = Parameters<ProjectSourceUploadUiPort["uploadFile"]>[0];
type Session = {
  input: ProjectSourceUploadInputMap["begin"];
  bytes: Uint8Array<ArrayBuffer> | null;
  uploadId: string | null;
  phase: PublicProjectSourceUpload["phase"] | null;
};
export class ProjectSourceFileUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: string, message: string): never {
  throw new ProjectSourceFileUploadError(code, message);
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return (
    "sha256:" +
    Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
function format(fileName: string): ProjectSourceUploadFormat {
  if (/\.txt$/iu.test(fileName)) return "txt";
  if (/\.(?:md|markdown)$/iu.test(fileName)) return "md";
  if (/\.html?$/iu.test(fileName)) return "html";
  return fail(
    "project_source_import_format_invalid",
    "请选择 TXT、Markdown 或 HTML 文件。",
  );
}
function knownFailure(code: string | null): never {
  if (code === "project_source_import_file_limit")
    fail(code, "原文件超过 20MB，请缩短后导入。");
  if (code === "project_source_import_text_limit")
    fail(code, "原文规范化为 UTF-8 后超过 20MB，请缩短正文后导入。");
  if (
    code === "project_source_import_encoding_invalid" ||
    code === "project_source_import_unicode_invalid"
  )
    fail(
      code,
      "文件编码无法读取，请使用 UTF-8 或带 BOM 的 UTF-16 保存后重试。",
    );
  if (
    code === "project_source_import_empty_text" ||
    code === "project_source_import_empty_file"
  )
    fail(code, "文件中没有可读取的正文。");
  fail(
    code ?? "project_source_upload_rejected",
    "原文无法导入，请检查文件格式和正文内容。",
  );
}
/** One bounded immutable upload journal, with explicit user retry/cancel. No JSON byte transport or model execution. */
export class ProjectSourceFileUpload implements ProjectSourceUploadUiPort {
  readonly #client: PluginProjectSourceUploadsClient;
  readonly #pollIntervalMs: number;
  #session: Session | null = null;
  #request: AbortController | null = null;
  #operation: Promise<ProjectFoundationSourceUpload> | null = null;
  #cancelling = false;
  #disposed = false;
  constructor(
    client: PluginProjectSourceUploadsClient,
    options: Readonly<{ pollIntervalMs?: number }> = {},
  ) {
    const interval = options.pollIntervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 0 || interval > 1000)
      throw new Error("source_upload_poll_interval_invalid");
    this.#client = client;
    this.#pollIntervalMs = interval;
  }
  async uploadFile(input: Request): Promise<ProjectFoundationSourceUpload> {
    if (this.#disposed)
      fail("project_source_upload_unavailable", "上传服务已关闭。");
    if (this.#operation || this.#cancelling)
      fail("project_source_upload_busy", "请等待当前原文操作完成。");
    input.signal.throwIfAborted();
    const request = new AbortController();
    this.#request = request;
    const signal = AbortSignal.any([input.signal, request.signal]);
    const operation = this.#upload(input, signal);
    this.#operation = operation;
    try {
      return await operation;
    } finally {
      if (this.#operation === operation) {
        this.#operation = null;
        this.#request = null;
      }
    }
  }
  async #upload(
    input: Request,
    signal: AbortSignal,
  ): Promise<ProjectFoundationSourceUpload> {
    // Native File/Blob slots only: a caller's name/size/arrayBuffer getters cannot substitute original bytes.
    let fileName: string, byteLength: number, buffer: ArrayBuffer;
    try {
      fileName = Object.getOwnPropertyDescriptor(
        File.prototype,
        "name",
      )!.get!.call(input.file);
      byteLength = Object.getOwnPropertyDescriptor(
        Blob.prototype,
        "size",
      )!.get!.call(input.file);
    } catch {
      return fail(
        "project_source_import_file_invalid",
        "请选择本地文件后继续。",
      );
    }
    const actualFormat = format(fileName);
    if (byteLength < 1 || byteLength > PROJECT_SOURCE_UPLOAD_MAX_BYTES)
      fail(
        "project_source_import_file_limit",
        "请选择不超过 20MB（20,000,000 字节）的非空原文件。",
      );
    buffer = await Blob.prototype.arrayBuffer.call(input.file);
    signal.throwIfAborted();
    if (buffer.byteLength !== byteLength)
      fail(
        "project_source_upload_bytes_mismatch",
        "文件读取结果不一致，请重新选择文件。",
      );
    const bytes = new Uint8Array(buffer),
      fileDigest = await sha256(bytes);
    signal.throwIfAborted();
    const previous = this.#session;
    if (
      previous &&
      (previous.input.fileName !== fileName ||
        previous.input.fileDigest !== fileDigest ||
        previous.input.byteLength !== byteLength ||
        previous.input.format !== actualFormat)
    ) {
      if (
        previous.phase !== "ready" &&
        previous.phase !== "cancelled" &&
        previous.phase !== "expired" &&
        previous.phase !== "rejected"
      )
        fail(
          "project_source_upload_pending_file_change",
          "上次原文尚未完成，请先取消导入，再选择另一个文件。",
        );
      this.#session = null;
    }
    const session = this.#session ?? {
      input: {
        fileName,
        format: actualFormat,
        byteLength,
        fileDigest,
        idempotencyKey: crypto.randomUUID(),
      },
      bytes,
      uploadId: null,
      phase: null,
    };
    this.#session = session;
    if (session.phase !== "ready") session.bytes = bytes;
    const begun = await this.#client.begin(session.input, { signal });
    session.uploadId = begun.upload.uploadId;
    this.#accept(session, begun.upload);
    let upload = this.#accept(
      session,
      (await this.#client.status({ uploadId: session.uploadId }, { signal }))
        .upload,
    );
    if (upload.phase === "ready") return this.#ready(session, upload);
    this.#terminal(upload);
    input.progress({
      phase: "uploading",
      sentBytes: upload.receivedParts.reduce(
        (sum, part) => sum + part.byteLength,
        0,
      ),
      totalBytes: byteLength,
    });
    if (upload.phase === "receiving") {
      const acknowledged = new Map(
        upload.receivedParts.map((part) => [part.index, part]),
      );
      for (let index = 0; index < upload.partCount; index++) {
        signal.throwIfAborted();
        const offset = index * PROJECT_SOURCE_UPLOAD_PART_BYTES;
        const part = session.bytes!.slice(
          offset,
          Math.min(byteLength, offset + PROJECT_SOURCE_UPLOAD_PART_BYTES),
        );
        const rawDigest = await sha256(part);
        signal.throwIfAborted();
        const present = acknowledged.get(index);
        if (present) {
          if (
            present.rawDigest !== rawDigest ||
            present.byteLength !== part.byteLength
          )
            fail(
              "project_source_upload_part_mismatch",
              "原文分片与已保存记录不一致，请取消后重新导入。",
            );
          continue;
        }
        upload = this.#accept(
          session,
          (
            await this.#client.writePart(
              { uploadId: session.uploadId, partIndex: index, rawDigest },
              part,
              { signal },
            )
          ).upload,
        );
        input.progress({
          phase: "uploading",
          sentBytes: upload.receivedParts.reduce(
            (sum, p) => sum + p.byteLength,
            0,
          ),
          totalBytes: byteLength,
        });
      }
    }
    input.progress({
      phase: "preparing",
      sentBytes: byteLength,
      totalBytes: byteLength,
    });
    upload = this.#accept(
      session,
      (
        await this.#client.prepare(
          { uploadId: session.uploadId, expectedRevision: upload.revision },
          { signal },
        )
      ).upload,
    );
    for (let poll = 0; poll < 15; poll++) {
      if (upload.phase === "ready") return this.#ready(session, upload);
      this.#terminal(upload);
      await this.#wait(signal);
      upload = this.#accept(
        session,
        (await this.#client.status({ uploadId: session.uploadId }, { signal }))
          .upload,
      );
    }
    if (upload.phase === "ready") return this.#ready(session, upload);
    this.#terminal(upload);
    fail(
      "project_source_upload_preparation_pending",
      "原文仍在整理，可稍后重试同一次导入。",
    );
  }
  #accept(
    session: Session,
    upload: PublicProjectSourceUpload,
  ): PublicProjectSourceUpload {
    if (
      upload.uploadId !== session.uploadId ||
      upload.fileName !== session.input.fileName ||
      upload.format !== session.input.format ||
      upload.byteLength !== session.input.byteLength ||
      upload.fileDigest !== session.input.fileDigest
    )
      fail(
        "project_source_upload_response_mismatch",
        "上传记录与所选文件不一致，请重新检查。",
      );
    session.phase = upload.phase;
    return upload;
  }
  #ready(
    session: Session,
    upload: PublicProjectSourceUpload,
  ): ProjectFoundationSourceUpload {
    if (upload.phase !== "ready" || upload.prepared === null)
      fail("project_source_upload_result_invalid", "原文整理结果暂未确认。");
    session.bytes = null;
    return { uploadId: upload.uploadId, fileDigest: upload.fileDigest };
  }
  #terminal(upload: PublicProjectSourceUpload) {
    if (upload.phase === "rejected") knownFailure(upload.failureCode);
    if (upload.phase === "cancelled" || upload.phase === "expired")
      fail(
        "project_source_upload_terminal",
        "此次导入已取消或过期，请重新选择文件。",
      );
  }
  async #wait(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.#pollIntervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  /** Explicit cancellation only. Aborting a wait or disposing a mount alone never claims a remote cancellation. */
  async cancelUpload(): Promise<void> {
    if (this.#disposed || this.#cancelling)
      fail("project_source_upload_unavailable", "上传操作暂不可用。");
    this.#cancelling = true;
    this.#request?.abort();
    try {
      await this.#operation?.catch(() => undefined);
      const session = this.#session;
      if (!session) return;
      if (!session.uploadId)
        session.uploadId = (
          await this.#client.begin(session.input)
        ).upload.uploadId;
      const upload = this.#accept(
        session,
        (await this.#client.status({ uploadId: session.uploadId })).upload,
      );
      if (
        ["ready", "rejected", "cancelled", "expired"].includes(upload.phase)
      ) {
        this.#session = null;
        return;
      }
      await this.#client.cancel({
        uploadId: session.uploadId,
        expectedRevision: upload.revision,
      });
      this.#session = null;
    } finally {
      this.#cancelling = false;
    }
  }
  dispose() {
    this.#disposed = true;
    this.#request?.abort();
    this.#session = null;
  }
}
