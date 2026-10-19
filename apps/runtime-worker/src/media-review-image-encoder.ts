import { isAbsolute } from "node:path";
import { MAX_MODEL_IMAGE_BYTES } from "@crewon/agent-kernel";
import { copyBoundedMaterialBytes } from "@crewon/media-runtime/material-byte-snapshot";
import {
  inspectProjectMaterialPng,
  MAX_PROJECT_MATERIAL_BYTES,
} from "@crewon/media-runtime/project-material-png";

import {
  acquireMediaInspectionSlot,
  MediaInspectionProcessError,
  runMediaInspectionProcess,
} from "./media-inspection-process.ts";

export class MediaReviewImageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "MediaReviewImageError";
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new MediaReviewImageError(`media_review_image_${code}`);
};

/** Host-configured local decoder. Only verified PNG bytes enter stdin; no paths or URLs enter argv. */
export class MediaReviewImageEncoder {
  readonly #executable: string;
  readonly #closing = new AbortController();
  readonly #pending = new Set<Promise<Buffer>>();
  #closed = false;
  constructor(input: Readonly<{ ffmpegPath: string }>) {
    if (
      typeof input.ffmpegPath !== "string" ||
      !isAbsolute(input.ffmpegPath) ||
      /[\u0000-\u001f]/u.test(input.ffmpegPath)
    )
      fail("configuration_invalid");
    this.#executable = input.ffmpegPath;
  }
  encodePng(
    input: Uint8Array,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<Buffer> {
    if (this.#closed) fail("closed");
    if (!(options.signal instanceof AbortSignal)) fail("signal_invalid");
    options.signal.throwIfAborted();
    // Process-wide, including separately constructed owners; no unbounded admission queue.
    const release = acquireMediaInspectionSlot();
    if (release === null) fail("busy");
    let bytes: Buffer;
    try {
      bytes = copyBoundedMaterialBytes(input, {
        maxBytes: MAX_PROJECT_MATERIAL_BYTES,
        expectedBytes: null,
      });
      inspectProjectMaterialPng(bytes);
    } catch {
      release!();
      fail("input_invalid");
    }
    const signal = AbortSignal.any([
      options.signal,
      this.#closing.signal,
      AbortSignal.timeout(10_000),
    ]);
    const task = this.#encode(bytes!, signal).finally(() => {
      release!();
    });
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }
  async #encode(bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-xerror",
      "-threads",
      "1",
      "-protocol_whitelist",
      "pipe",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "-i",
      "pipe:0",
      "-map",
      "[review]",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      "[0:v]scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease,setsar=1,format=rgba,split[image][background];[background]drawbox=color=white:t=fill:replace=1[white];[white][image]overlay=format=auto[review]",
      "-threads",
      "1",
      "-c:v",
      "mjpeg",
      "-q:v",
      "6",
      "-pix_fmt",
      "yuvj444p",
      "-f",
      "image2pipe",
      "pipe:1",
    ];
    let encoded: Buffer;
    try {
      encoded = await runMediaInspectionProcess({
        executable: this.#executable,
        args,
        source: { kind: "bytes", bytes },
        maxOutputBytes: MAX_MODEL_IMAGE_BYTES,
        signal,
      });
    } catch (error) {
      if (error instanceof MediaInspectionProcessError) fail(error.code);
      throw error;
    }
    if (encoded.length < 12) fail("decode_failed");
    if (
      encoded.readUInt16BE(0) !== 0xffd8 ||
      encoded.readUInt16BE(encoded.length - 2) !== 0xffd9
    )
      fail("output_invalid");
    return encoded;
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#closing.abort();
    await Promise.allSettled([...this.#pending]);
  }
}
