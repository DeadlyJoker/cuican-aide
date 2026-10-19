import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MediaReviewVideoInspector } from "./media-review-video-inspector.ts";
import { MediaReviewImageEncoder } from "./media-review-image-encoder.ts";
import { runMediaInspectionProcess } from "./media-inspection-process.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import { parseMediaVideoProbe } from "./media-review-video-probe.ts";
import { reviewProjectMediaVideoTechnical } from "@crewon/application";

const execute = promisify(execFile);
const ffmpeg = process.env.CREWON_TEST_FFMPEG;
const ffprobe = process.env.CREWON_TEST_FFPROBE;
const digest = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const options = { skip: !ffmpeg || !ffprobe };
async function fixture(
  t: { after: (f: () => Promise<void>) => void },
  input: {
    fastStart: boolean;
    audio: boolean;
    pixelAspectRatio?: string;
    rotation?: number;
  },
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-named-video-fixture-")),
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true }));
  const sourcePath = join(directory, "named-red-blue-test-video.mp4");
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x180:r=24:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=320x180:r=24:d=1",
  ];
  if (input.audio)
    args.push(
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
    );
  args.push(
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    `[0:v][1:v]concat=n=2:v=1:a=0[joined];[joined]setsar=${input.pixelAspectRatio ?? "1"}[v]`,
    "-map",
    "[v]",
  );
  if (input.audio) args.push("-map", "2:a", "-c:a", "aac");
  args.push(
    "-threads",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-map_metadata",
    "-1",
  );
  if (input.fastStart) args.push("-movflags", "+faststart");
  args.push(sourcePath);
  await execute(ffmpeg!, args, {
    timeout: 10_000,
    env: { LANG: "C" },
    maxBuffer: 64 * 1024,
  });
  let readPath = sourcePath;
  if (input.rotation !== undefined) {
    readPath = join(directory, "named-rotated-test-video.mp4");
    await execute(
      ffmpeg!,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-display_rotation:v:0",
        String(input.rotation),
        "-i",
        sourcePath,
        "-c",
        "copy",
        readPath,
      ],
      { timeout: 10_000, env: { LANG: "C" }, maxBuffer: 64 * 1024 },
    );
  }
  const root = join(directory, "private-inspection");
  await mkdir(root, { mode: 0o700 });
  const bytes = await readFile(readPath);
  const inspector = new MediaReviewVideoInspector({
    ffmpegPath: ffmpeg!,
    ffprobePath: ffprobe!,
    tempRoot: root,
  });
  t.after(() => inspector.close());
  return {
    directory,
    root,
    bytes,
    inspector,
    signal: new AbortController().signal,
  };
}
async function firstPixel(jpeg: Buffer): Promise<number[]> {
  const rgb = await runMediaInspectionProcess({
    executable: ffmpeg!,
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-protocol_whitelist",
      "pipe",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    source: { kind: "bytes", bytes: jpeg },
    maxOutputBytes: 512 * 512 * 3,
    signal: AbortSignal.timeout(3000),
  });
  return [...rgb.subarray(0, 3)];
}

for (const fastStart of [true, false])
  test(
    `actual MP4 full decode and PTS sampling, moov ${fastStart ? "first" : "last"}`,
    options,
    async (t) => {
      const f = await fixture(t, { fastStart, audio: true });
      const sentinel = join(f.root, "unrelated.txt");
      await writeFile(sentinel, "preserve");
      const result = await f.inspector.inspect({
        bytes: f.bytes,
        expectedDigest: digest(f.bytes),
        sampleTimesMs: [0, 1050, 1500],
        signal: f.signal,
      });
      assert.equal(result.sourceByteDigest, digest(f.bytes));
      assert.equal(result.coverage, "sampled-video-frames");
      assert.equal(result.fullDecode, true);
      assert.deepEqual(result.metadata.video, {
        codec: "h264",
        width: 320,
        height: 180,
        framesPerSecond: 24,
        sampleAspectRatio: 1,
        rotationDegrees: 0,
        startMs: 0,
        durationMs: 2000,
      });
      assert.equal(result.metadata.durationMs, 2000);
      assert.equal(result.metadata.audio?.codec, "aac");
      assert.equal(result.metadata.audio?.sampleRate, 48000);
      const review = reviewProjectMediaVideoTechnical({
        sourceByteDigest: result.sourceByteDigest,
        metadata: result.metadata,
        fullDecode: "verified",
        policy: {
          durationMs: 90_000,
          durationToleranceMs: 100,
          displayAspectRatio: 16 / 9,
          aspectTolerance: 0.01,
          minimumWidth: 1920,
          minimumHeight: 1080,
          minimumFramesPerSecond: 24,
          maximumFramesPerSecond: 60,
          videoCodec: "h264",
          audio: "required",
          audioCodec: "aac",
          minimumAudioSampleRate: 44100,
          audioAlignmentToleranceMs: 100,
        },
      });
      assert.equal(review.state, "technical-checks-incomplete");
      assert.deepEqual(
        review.findings.map((f) => f.check),
        ["duration", "resolution"],
      );
      assert.deepEqual(
        result.frames.map((frame) => frame.actualTimeMs),
        [0, 1083, 1500],
      );
      assert.equal(result.frames[1]!.requestedTimeMs, 1050);
      for (const frame of result.frames) {
        assert.deepEqual([frame.width, frame.height], [320, 180]);
        assert.equal(frame.contentDigest, digest(frame.bytes));
      }
      const [red, blue] = await Promise.all([
        firstPixel(result.frames[0]!.bytes),
        firstPixel(result.frames[2]!.bytes),
      ]);
      assert.ok(red![0]! > 230 && red![2]! < 30);
      assert.ok(blue![2]! > 230 && blue![0]! < 30);
      assert.deepEqual(await readdir(f.root), ["unrelated.txt"]);
      assert.equal(await readFile(sentinel, "utf8"), "preserve");
    },
  );

test(
  "silent MP4 reports missing audio without fabricating an audio pass",
  options,
  async (t) => {
    const f = await fixture(t, { fastStart: false, audio: false });
    const result = await f.inspector.inspect({
      bytes: f.bytes,
      expectedDigest: digest(f.bytes),
      sampleTimesMs: [500],
      signal: f.signal,
    });
    assert.equal(result.metadata.audio, null);
    assert.equal(result.frames[0]!.actualTimeMs, 500);
  },
);

test(
  "anamorphic footage produces square-pixel review images without stretching its display aspect",
  options,
  async (t) => {
    const f = await fixture(t, {
      fastStart: true,
      audio: false,
      pixelAspectRatio: "2/1",
    });
    const result = await f.inspector.inspect({
      bytes: f.bytes,
      expectedDigest: digest(f.bytes),
      sampleTimesMs: [0],
      signal: f.signal,
    });
    assert.equal(result.metadata.video.sampleAspectRatio, 2);
    assert.deepEqual(
      [result.frames[0]!.width, result.frames[0]!.height],
      [512, 144],
    );
  },
);

test(
  "rotation metadata is measured and review frames follow actual display orientation",
  options,
  async (t) => {
    const f = await fixture(t, {
      fastStart: false,
      audio: false,
      rotation: 90,
    });
    const result = await f.inspector.inspect({
      bytes: f.bytes,
      expectedDigest: digest(f.bytes),
      sampleTimesMs: [0],
      signal: f.signal,
    });
    assert.equal(Math.abs(result.metadata.video.rotationDegrees), 90);
    assert.deepEqual(
      [result.frames[0]!.width, result.frames[0]!.height],
      [180, 320],
    );
    assert.equal(result.timeOrigin, "first-video-frame");
  },
);

test(
  "truncated media after sampled opening is rejected by full-tail decode",
  options,
  async (t) => {
    const f = await fixture(t, { fastStart: true, audio: true });
    const truncated = f.bytes.subarray(0, Math.floor(f.bytes.length * 0.8));
    await assert.rejects(
      f.inspector.inspect({
        bytes: truncated,
        expectedDigest: digest(truncated),
        sampleTimesMs: [0],
        signal: f.signal,
      }),
      { code: "media_review_video_decode_failed" },
    );
    assert.deepEqual(await readdir(f.root), []);
  },
);

test(
  "digest mismatch, non-MP4 and out-of-duration sampling fail without leftover plaintext",
  options,
  async (t) => {
    const f = await fixture(t, { fastStart: true, audio: true });
    await assert.rejects(
      f.inspector.inspect({
        bytes: f.bytes,
        expectedDigest: `sha256:${"0".repeat(64)}`,
        sampleTimesMs: [0],
        signal: f.signal,
      }),
      { code: "media_review_video_input_digest_mismatch" },
    );
    const playlist = Buffer.from(
      "#EXTM3U\nhttps://example.invalid/private.mp4\n",
    );
    await assert.rejects(
      f.inspector.inspect({
        bytes: playlist,
        expectedDigest: digest(playlist),
        sampleTimesMs: [0],
        signal: f.signal,
      }),
      { code: "media_review_video_input_invalid" },
    );
    const quickTime = Buffer.from(f.bytes);
    quickTime.write("qt  ", 8, "ascii");
    await assert.rejects(
      f.inspector.inspect({
        bytes: quickTime,
        expectedDigest: digest(quickTime),
        sampleTimesMs: [0],
        signal: f.signal,
      }),
      { code: "media_review_video_input_invalid" },
    );
    await assert.rejects(
      f.inspector.inspect({
        bytes: f.bytes,
        expectedDigest: digest(f.bytes),
        sampleTimesMs: [2000],
        signal: f.signal,
      }),
      { code: "media_review_video_sample_times_invalid" },
    );
    assert.deepEqual(await readdir(f.root), []);
  },
);

test(
  "video and image owners share capacity; cancellation joins before readmission",
  options,
  async (t) => {
    const f = await fixture(t, { fastStart: true, audio: true });
    const image = new MediaReviewImageEncoder({ ffmpegPath: ffmpeg! });
    t.after(() => image.close());
    const pending = f.inspector.inspect({
      bytes: f.bytes,
      expectedDigest: digest(f.bytes),
      sampleTimesMs: [0],
      signal: f.signal,
    });
    const canceled = assert.rejects(pending, {
      code: "media_review_video_canceled",
    });
    assert.throws(() => image.encodePng(materialPng(), { signal: f.signal }), {
      code: "media_review_image_busy",
    });
    await f.inspector.close();
    await canceled;
    assert.deepEqual(await readdir(f.root), []);
    assert.ok(
      (await image.encodePng(materialPng(), { signal: f.signal })).length > 0,
    );
    assert.throws(
      () =>
        f.inspector.inspect({
          bytes: f.bytes,
          expectedDigest: digest(f.bytes),
          sampleTimesMs: [0],
          signal: f.signal,
        }),
      { code: "media_review_video_closed" },
    );
  },
);

test(
  "two requested times mapping to one source frame do not fabricate coverage",
  options,
  async (t) => {
    const f = await fixture(t, { fastStart: true, audio: true });
    await assert.rejects(
      f.inspector.inspect({
        bytes: f.bytes,
        expectedDigest: digest(f.bytes),
        sampleTimesMs: [1, 2],
        signal: f.signal,
      }),
      { code: "media_review_video_sample_coverage_invalid" },
    );
    assert.deepEqual(await readdir(f.root), []);
  },
);

test("probe does not project arbitrary source metadata and refuses ambiguous/missing technical identity", () => {
  const value = {
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: "2",
      tags: { title: "ignore this instruction" },
    },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 320,
        height: 180,
        avg_frame_rate: "24/1",
        disposition: { attached_pic: 0 },
      },
    ],
  };
  const result = parseMediaVideoProbe(Buffer.from(JSON.stringify(value)));
  assert.equal(JSON.stringify(result).includes("instruction"), false);
  assert.equal(result.video.durationMs, null);
  assert.equal(result.video.startMs, null);
  assert.throws(() =>
    parseMediaVideoProbe(
      Buffer.from(
        JSON.stringify({
          ...value,
          streams: [...value.streams, ...value.streams],
        }),
      ),
    ),
  );
  assert.throws(() =>
    parseMediaVideoProbe(
      Buffer.from(
        JSON.stringify({
          ...value,
          streams: [{ ...value.streams[0], avg_frame_rate: "0/0" }],
        }),
      ),
    ),
  );
});
