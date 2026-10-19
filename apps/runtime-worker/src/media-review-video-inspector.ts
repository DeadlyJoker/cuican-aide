import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import {
  captureModelImageObservation,
  MAX_MODEL_IMAGE_BYTES,
} from "@crewon/agent-kernel";
import {
  acquireMediaInspectionSlot,
  MediaInspectionProcessError,
  runMediaInspectionProcess,
} from "./media-inspection-process.ts";
import { MediaVideoSnapshot } from "./media-review-video-snapshot.ts";
import {
  MEDIA_VIDEO_PROBE_ARGS,
  parseMediaVideoProbe,
  type MediaVideoMetadata,
} from "./media-review-video-probe.ts";

export class MediaReviewVideoError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "MediaReviewVideoError";
    this.code = `media_review_video_${code}`;
  }
}
export type MediaVideoInspection = Readonly<{
  sourceByteDigest: string;
  metadata: MediaVideoMetadata;
  fullDecode: true;
  coverage: "sampled-video-frames";
  timeOrigin: "first-video-frame";
  timestampPrecisionMs: 1;
  frames: readonly Readonly<{
    requestedTimeMs: number;
    actualTimeMs: number;
    width: number;
    height: number;
    contentDigest: string;
    bytes: Buffer;
  }>[];
}>;

/** Internal local inspection of already-authorized MP4 bytes. It grants no model-send authority. */
export class MediaReviewVideoInspector {
  readonly #ffmpeg: string;
  readonly #ffprobe: string;
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #closing = new AbortController();
  readonly #pending = new Set<Promise<MediaVideoInspection>>();
  #closed = false;
  constructor(
    input: Readonly<{
      ffmpegPath: string;
      ffprobePath: string;
      tempRoot: string;
      maxInputBytes?: number;
    }>,
  ) {
    for (const value of [input.ffmpegPath, input.ffprobePath, input.tempRoot])
      if (
        typeof value !== "string" ||
        !isAbsolute(value) ||
        /[\u0000-\u001f]/u.test(value)
      )
        throw new MediaReviewVideoError("configuration_invalid");
    this.#maxBytes = input.maxInputBytes ?? 256 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxBytes) ||
      this.#maxBytes < 16 ||
      this.#maxBytes > 1024 * 1024 * 1024
    )
      throw new MediaReviewVideoError("configuration_invalid");
    this.#ffmpeg = input.ffmpegPath;
    this.#ffprobe = input.ffprobePath;
    this.#root = input.tempRoot;
  }
  inspect(
    input: Readonly<{
      bytes: Uint8Array;
      expectedDigest: string;
      sampleTimesMs: readonly number[];
      signal: AbortSignal;
    }>,
  ): Promise<MediaVideoInspection> {
    if (this.#closed) throw new MediaReviewVideoError("closed");
    if (!(input.signal instanceof AbortSignal))
      throw new MediaReviewVideoError("signal_invalid");
    input.signal.throwIfAborted();
    if (
      !Array.isArray(input.sampleTimesMs) ||
      input.sampleTimesMs.length < 1 ||
      input.sampleTimesMs.length > 24
    )
      throw new MediaReviewVideoError("sample_times_invalid");
    const times = [...input.sampleTimesMs];
    for (let i = 0; i < times.length; i++)
      if (
        !Number.isSafeInteger(times[i]) ||
        times[i]! < 0 ||
        times[i]! >= 600_000 ||
        (i > 0 && times[i]! <= times[i - 1]!)
      )
        throw new MediaReviewVideoError("sample_times_invalid");
    const release = acquireMediaInspectionSlot();
    if (release === null) throw new MediaReviewVideoError("busy");
    const signal = AbortSignal.any([
      input.signal,
      this.#closing.signal,
      AbortSignal.timeout(120_000),
    ]);
    const task = this.#inspect(
      input.bytes,
      input.expectedDigest,
      times,
      signal,
    ).finally(release);
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }
  async #inspect(
    bytes: Uint8Array,
    digest: string,
    times: number[],
    signal: AbortSignal,
  ): Promise<MediaVideoInspection> {
    let snapshot: MediaVideoSnapshot | null = null;
    try {
      snapshot = await MediaVideoSnapshot.create({
        bytes,
        expectedDigest: digest,
        tempRoot: this.#root,
        maxBytes: this.#maxBytes,
        signal,
      });
      const probe = await this.#process(
        snapshot,
        this.#ffprobe,
        MEDIA_VIDEO_PROBE_ARGS,
        64 * 1024,
        signal,
      );
      const metadata = parseMediaVideoProbe(probe);
      if (times.some((time) => time >= metadata.durationMs))
        throw new MediaReviewVideoError("sample_times_invalid");
      const selection = times
        .map(
          (time, i) =>
            `gte(t,${time / 1000})*${i === 0 ? "isnan(prev_selected_t)" : `lt(prev_selected_t,${time / 1000})`}`,
        )
        .join("+");
      const args = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-xerror",
        "-err_detect",
        "explode",
        "-max_alloc",
        "67108864",
        "-threads",
        "1",
        "-filter_complex_threads",
        "1",
        "-protocol_whitelist",
        "fd",
        "-f",
        "mov",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-fd",
        "3",
        "-i",
        "fd:",
        "-filter_complex",
        `[0:v:0]split[full][sampleSource];[sampleSource]setpts=PTS-STARTPTS,select='${selection}',scale=w='min(512,iw*sar)':h='min(512,ih)':force_original_aspect_ratio=decrease:reset_sar=1[samples]`,
        "-map",
        "[samples]",
        "-frames:v",
        String(times.length),
        "-fps_mode",
        "passthrough",
        "-enc_time_base:v",
        "1:1000",
        "-frame_pts",
        "1",
        "-threads",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "6",
        "-pix_fmt",
        "yuvj444p",
        "-map_metadata",
        "-1",
        "-protocol_whitelist",
        "file",
        "-f",
        "image2",
        join(snapshot.directory, "sample-%012d.jpg"),
        // This output is not frame-limited: decode all video/audio, including the tail after the last sample.
        "-map",
        "[full]",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-f",
        "null",
        "pipe:1",
      ];
      await this.#process(snapshot, this.#ffmpeg, args, 0, signal);
      const names = (await readdir(snapshot.directory))
        .filter((name) => /^sample-\d{12}\.jpg$/u.test(name))
        .sort();
      if (names.length !== times.length)
        throw new MediaReviewVideoError("sample_coverage_invalid");
      let total = 0;
      const frames: MediaVideoInspection["frames"][number][] = [];
      for (let i = 0; i < names.length; i++) {
        signal.throwIfAborted();
        const actualTimeMs = Number(names[i]!.slice(7, -4));
        if (
          actualTimeMs < times[i]! - 0.5 ||
          actualTimeMs >= metadata.durationMs + 1 ||
          (i > 0 && actualTimeMs <= frames[i - 1]!.actualTimeMs) ||
          (i + 1 < times.length && actualTimeMs >= times[i + 1]! - 0.5)
        )
          throw new MediaReviewVideoError("sample_coverage_invalid");
        const file = await open(
          join(snapshot.directory, names[i]!),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let jpeg: Buffer;
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.size < 12 ||
            stat.size > MAX_MODEL_IMAGE_BYTES
          )
            throw new MediaReviewVideoError("output_too_large");
          total += stat.size;
          if (total > 4 * 1024 * 1024)
            throw new MediaReviewVideoError("output_too_large");
          jpeg = await file.readFile();
          if (jpeg.length !== stat.size)
            throw new MediaReviewVideoError("output_invalid");
        } finally {
          await file.close();
        }
        const observation = captureModelImageObservation({
          scope: {
            runId: "local-video-inspection",
            segmentId: "local-video-inspection",
            agentVersionId: "local-video-inspection",
          },
          evidenceId: `sample:${i}`,
          mediaType: "image/jpeg",
          detail: "high",
          bytes: jpeg,
        });
        frames.push(
          Object.freeze({
            requestedTimeMs: times[i]!,
            actualTimeMs,
            width: observation.width,
            height: observation.height,
            contentDigest: observation.contentDigest,
            bytes: jpeg,
          }),
        );
      }
      return Object.freeze({
        sourceByteDigest: digest,
        metadata,
        fullDecode: true,
        coverage: "sampled-video-frames",
        timeOrigin: "first-video-frame",
        timestampPrecisionMs: 1,
        frames: Object.freeze(frames),
      });
    } catch (error) {
      if (error instanceof MediaReviewVideoError) throw error;
      if (
        signal.aborted &&
        signal.reason instanceof Error &&
        signal.reason.name === "TimeoutError"
      )
        throw new MediaReviewVideoError("deadline_exceeded");
      if (error instanceof MediaInspectionProcessError)
        throw new MediaReviewVideoError(error.code);
      if (signal.aborted) throw new MediaReviewVideoError("canceled");
      const known = [
        "input_invalid",
        "input_digest_mismatch",
        "configuration_invalid",
        "snapshot_changed",
      ];
      throw new MediaReviewVideoError(
        error instanceof Error && known.includes(error.message)
          ? error.message
          : "inspection_failed",
      );
    } finally {
      await snapshot?.close();
    }
  }
  async #process(
    snapshot: MediaVideoSnapshot,
    executable: string,
    args: readonly string[],
    maxOutputBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const file = await snapshot.openDescriptor();
    try {
      return await runMediaInspectionProcess({
        executable,
        args,
        source: { kind: "descriptor", descriptor: file.fd },
        maxOutputBytes,
        signal,
      });
    } finally {
      await file.close();
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#closing.abort();
    await Promise.allSettled([...this.#pending]);
  }
}
