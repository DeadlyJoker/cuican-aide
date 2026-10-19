import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewProjectMediaVideoTechnical,
  type ProjectMediaVideoMetadata,
  type ProjectMediaVideoTechnicalPolicy,
} from "./project-media-video-technical-review.ts";

const policy: ProjectMediaVideoTechnicalPolicy = {
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
};
const metadata: ProjectMediaVideoMetadata = {
  durationMs: 90_000,
  video: {
    codec: "h264",
    width: 1920,
    height: 1080,
    framesPerSecond: 24,
    sampleAspectRatio: 1,
    rotationDegrees: 0,
    startMs: 0,
    durationMs: 90_000,
  },
  audio: {
    codec: "aac",
    sampleRate: 48000,
    channels: 2,
    startMs: 0,
    durationMs: 90_000,
  },
};
const review = (
  m: ProjectMediaVideoMetadata,
  fullDecode: "verified" | "unverified" = "verified",
) =>
  reviewProjectMediaVideoTechnical({
    sourceByteDigest: `sha256:${"a".repeat(64)}`,
    metadata: m,
    fullDecode,
    policy,
  });

test("technical success only opens editorial review; it never certifies commercial quality", () => {
  const result = review(metadata);
  assert.equal(result.state, "ready-for-editorial-review");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.notChecked, [
    "story",
    "motion",
    "dialogue",
    "lip-sync",
    "subtitles",
    "commercial-rights",
  ]);
  assert.equal("publishable" in result, false);
});
test("missing audio, missing duration and unverified decode cannot silently pass", () => {
  const result = review(
    {
      ...metadata,
      video: { ...metadata.video, durationMs: null },
      audio: null,
    },
    "unverified",
  );
  assert.equal(result.state, "technical-checks-incomplete");
  assert.deepEqual(result.findings, [
    { check: "full-decode", state: "unverified" },
    { check: "duration", state: "unverified" },
    { check: "audio-presence", state: "failed" },
  ]);
});
test("track start/end comparison finds offset and short audio; it cannot claim lip sync", () => {
  for (const audio of [
    { ...metadata.audio!, startMs: 500 },
    { ...metadata.audio!, durationMs: 85_000 },
    { ...metadata.audio!, startMs: null },
  ]) {
    const result = review({ ...metadata, audio });
    assert.ok(result.findings.some((f) => f.check === "audio-alignment"));
    assert.ok(result.notChecked.includes("lip-sync"));
  }
});
test("display geometry uses pixel aspect and rotation rather than coded dimensions alone", () => {
  assert.ok(
    review({
      ...metadata,
      video: { ...metadata.video, sampleAspectRatio: 2 },
    }).findings.some((f) => f.check === "aspect"),
  );
  assert.ok(
    review({
      ...metadata,
      video: { ...metadata.video, rotationDegrees: 90 },
    }).findings.some((f) => f.check === "aspect"),
  );
  assert.ok(
    review({
      ...metadata,
      video: { ...metadata.video, sampleAspectRatio: null },
    }).findings.some((f) => f.check === "aspect" && f.state === "unverified"),
  );
});
test("wrong encoding, frame rate and audio sample rate remain blocking findings", () => {
  const result = review({
    ...metadata,
    video: { ...metadata.video, codec: "hevc", framesPerSecond: 12 },
    audio: { ...metadata.audio!, codec: "mp3", sampleRate: 22050 },
  });
  assert.deepEqual(
    result.findings.map((f) => f.check),
    ["frame-rate", "video-codec", "audio-codec", "audio-sample-rate"],
  );
  assert.throws(() =>
    reviewProjectMediaVideoTechnical({
      sourceByteDigest: "unbound",
      metadata,
      fullDecode: "verified",
      policy,
    }),
  );
  assert.throws(() =>
    reviewProjectMediaVideoTechnical({
      sourceByteDigest: `sha256:${"a".repeat(64)}`,
      metadata,
      fullDecode: "verified",
      policy: { ...policy, durationMs: NaN },
    }),
  );
});
