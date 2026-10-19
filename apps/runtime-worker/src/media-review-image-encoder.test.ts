import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  captureModelImageObservation,
  MAX_MODEL_IMAGE_BYTES,
} from "@crewon/agent-kernel";
import { MediaReviewImageEncoder } from "./media-review-image-encoder.ts";
import {
  materialPng,
  pngSignature,
  pngChunk,
  pngHeader,
} from "./project-material-png.test-support.ts";
const executable = process.env.CREWON_TEST_FFMPEG;
async function decodeRgb(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable!,
      [
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
      { stdio: ["pipe", "pipe", "ignore"], env: { LANG: "C" }, shell: false },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    timeout.unref();
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 512 * 512 * 3) child.kill("SIGKILL");
      else chunks.push(Buffer.from(chunk));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("named JPEG pixel decode failed"));
    });
    child.stdin.end(bytes);
  });
}
test("invalid PNG and host configuration fail before launching a decoder", () => {
  assert.throws(() => new MediaReviewImageEncoder({ ffmpegPath: "ffmpeg" }), {
    code: "media_review_image_configuration_invalid",
  });
  const encoder = new MediaReviewImageEncoder({
    ffmpegPath: "/does-not-exist/ffmpeg",
  });
  assert.throws(
    () =>
      encoder.encodePng(Buffer.from("not PNG"), {
        signal: new AbortController().signal,
      }),
    { code: "media_review_image_input_invalid" },
  );
});
test("spawn failure releases process-wide admission and does not expose bytes", async () => {
  const encoder = new MediaReviewImageEncoder({
    ffmpegPath: "/does-not-exist/ffmpeg",
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      encoder.encodePng(materialPng(), {
        signal: new AbortController().signal,
      }),
      { code: "media_review_image_process_failed" },
    );
  await encoder.close();
});
test(
  "real FFmpeg produces a bounded decodable JPEG preserving aspect ratio",
  { skip: !executable },
  async (t) => {
    const encoder = new MediaReviewImageEncoder({ ffmpegPath: executable! });
    t.after(() => encoder.close());
    const encoded = await encoder.encodePng(materialPng(1920, 1080), {
      signal: new AbortController().signal,
    });
    const image = captureModelImageObservation({
      scope: {
        runId: "review",
        segmentId: "segment",
        agentVersionId: "reviewer",
      },
      evidenceId: "frame",
      mediaType: "image/jpeg",
      detail: "high",
      bytes: encoded,
    });
    assert.deepEqual([image.width, image.height], [512, 288]);
    assert.ok(encoded.length <= MAX_MODEL_IMAGE_BYTES);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable!,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-xerror",
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
          "-f",
          "null",
          "-",
        ],
        {
          stdio: ["pipe", "ignore", "ignore"],
          env: { LANG: "C" },
          shell: false,
        },
      );
      child.on("error", reject);
      child.stdin.on("error", () => {});
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("named JPEG decode failed")),
      );
      child.stdin.end(encoded);
    });
  },
);
test(
  "concurrent owners are bounded and close joins cancellation before readmission",
  { skip: !executable },
  async () => {
    const first = new MediaReviewImageEncoder({ ffmpegPath: executable! });
    const second = new MediaReviewImageEncoder({ ffmpegPath: executable! });
    const pending = first.encodePng(materialPng(4096, 4096), {
      signal: new AbortController().signal,
    });
    const rejected = assert.rejects(pending, {
      code: "media_review_image_canceled",
    });
    assert.throws(
      () =>
        second.encodePng(materialPng(), {
          signal: new AbortController().signal,
        }),
      { code: "media_review_image_busy" },
    );
    await first.close();
    await rejected;
    assert.ok(
      (
        await second.encodePng(materialPng(), {
          signal: new AbortController().signal,
        })
      ).length > 0,
    );
    await second.close();
    assert.throws(
      () =>
        first.encodePng(materialPng(), {
          signal: new AbortController().signal,
        }),
      { code: "media_review_image_closed" },
    );
  },
);

test(
  "transparent PNG is reviewed over explicit white with its black subject still visible",
  { skip: !executable },
  async (t) => {
    const encoder = new MediaReviewImageEncoder({ ffmpegPath: executable! });
    t.after(() => encoder.close());
    const width = 32,
      height = 16,
      stride = width * 4 + 1,
      pixels = Buffer.alloc(stride * height);
    for (let y = 4; y < 12; y++)
      for (let x = 8; x < 24; x++) pixels[y * stride + 1 + x * 4 + 3] = 255;
    const png = Buffer.concat([
      pngSignature,
      pngChunk("IHDR", pngHeader(width, height, 6)),
      pngChunk("IDAT", deflateSync(pixels)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const encoded = await encoder.encodePng(png, {
      signal: new AbortController().signal,
    });
    const rgb = await decodeRgb(encoded);
    assert.equal(rgb.length, width * height * 3);
    assert.ok([...rgb.subarray(0, 3)].every((channel) => channel > 240));
    const center = (8 * width + 16) * 3;
    assert.ok(
      [...rgb.subarray(center, center + 3)].every((channel) => channel < 15),
    );
  },
);
