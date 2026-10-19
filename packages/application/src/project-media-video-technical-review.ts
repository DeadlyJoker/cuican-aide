/** Host-measured fields only. This input never constitutes model-send or publication permission. */
export type ProjectMediaVideoMetadata = Readonly<{
  durationMs: number;
  video: Readonly<{
    codec: string;
    width: number;
    height: number;
    framesPerSecond: number;
    sampleAspectRatio: number | null;
    rotationDegrees: number;
    startMs: number | null;
    durationMs: number | null;
  }>;
  audio: Readonly<{
    codec: string;
    sampleRate: number;
    channels: number;
    startMs: number | null;
    durationMs: number | null;
  }> | null;
}>;
export type ProjectMediaVideoTechnicalPolicy = Readonly<{
  durationMs: number;
  durationToleranceMs: number;
  displayAspectRatio: number;
  aspectTolerance: number;
  minimumWidth: number;
  minimumHeight: number;
  minimumFramesPerSecond: number;
  maximumFramesPerSecond: number;
  videoCodec: string;
  audio: "required" | "optional";
  audioCodec: string;
  minimumAudioSampleRate: number;
  audioAlignmentToleranceMs: number;
}>;
export type ProjectMediaVideoTechnicalFinding = Readonly<{
  check:
    | "full-decode"
    | "duration"
    | "resolution"
    | "aspect"
    | "frame-rate"
    | "video-codec"
    | "audio-presence"
    | "audio-codec"
    | "audio-sample-rate"
    | "audio-alignment";
  state: "failed" | "unverified";
}>;

/** Technical checks cannot certify story, motion, dialogue, lip sync, or commercial rights. */
export function reviewProjectMediaVideoTechnical(
  input: Readonly<{
    sourceByteDigest: string;
    metadata: ProjectMediaVideoMetadata;
    fullDecode: "verified" | "unverified";
    policy: ProjectMediaVideoTechnicalPolicy;
  }>,
) {
  const p = input.policy,
    m = input.metadata,
    v = m.video;
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(input.sourceByteDigest) ||
    [
      p.durationMs,
      p.displayAspectRatio,
      p.minimumWidth,
      p.minimumHeight,
      p.minimumFramesPerSecond,
      p.maximumFramesPerSecond,
      p.minimumAudioSampleRate,
    ].some((n) => !Number.isFinite(n) || n <= 0) ||
    [
      p.durationToleranceMs,
      p.aspectTolerance,
      p.audioAlignmentToleranceMs,
    ].some((n) => !Number.isFinite(n) || n < 0) ||
    p.minimumFramesPerSecond > p.maximumFramesPerSecond ||
    !["required", "optional"].includes(p.audio) ||
    !/^[a-z0-9_]{1,64}$/u.test(p.videoCodec) ||
    !/^[a-z0-9_]{1,64}$/u.test(p.audioCodec)
  )
    throw new Error("project_media_video_technical_policy_invalid");
  const findings: ProjectMediaVideoTechnicalFinding[] = [];
  const add = (
    check: ProjectMediaVideoTechnicalFinding["check"],
    state: "failed" | "unverified" = "failed",
  ) => {
    if (!findings.some((f) => f.check === check))
      findings.push(Object.freeze({ check, state }));
  };
  if (input.fullDecode !== "verified") add("full-decode", "unverified");
  if (
    !Number.isFinite(m.durationMs) ||
    Math.abs(m.durationMs - p.durationMs) > p.durationToleranceMs
  )
    add("duration");
  if (v.durationMs === null) add("duration", "unverified");
  else if (
    !Number.isFinite(v.durationMs) ||
    Math.abs(v.durationMs - p.durationMs) > p.durationToleranceMs
  )
    add("duration");
  const portraitRotation = Math.abs(v.rotationDegrees) === 90;
  const width = portraitRotation ? v.height : v.width,
    height = portraitRotation ? v.width : v.height;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < p.minimumWidth ||
    height < p.minimumHeight
  )
    add("resolution");
  if (v.sampleAspectRatio === null) add("aspect", "unverified");
  else {
    const ratio = (v.width * v.sampleAspectRatio) / v.height;
    const displayRatio = portraitRotation ? 1 / ratio : ratio;
    if (
      !Number.isFinite(displayRatio) ||
      Math.abs(displayRatio - p.displayAspectRatio) > p.aspectTolerance
    )
      add("aspect");
  }
  if (
    !Number.isFinite(v.framesPerSecond) ||
    v.framesPerSecond < p.minimumFramesPerSecond ||
    v.framesPerSecond > p.maximumFramesPerSecond
  )
    add("frame-rate");
  if (v.codec !== p.videoCodec) add("video-codec");
  const a = m.audio;
  if (a === null) {
    if (p.audio === "required") add("audio-presence");
  } else {
    if (a.codec !== p.audioCodec) add("audio-codec");
    if (
      !Number.isFinite(a.sampleRate) ||
      a.sampleRate < p.minimumAudioSampleRate
    )
      add("audio-sample-rate");
    if (
      a.startMs === null ||
      a.durationMs === null ||
      v.startMs === null ||
      v.durationMs === null
    )
      add("audio-alignment", "unverified");
    else if (
      ![a.startMs, a.durationMs, v.startMs, v.durationMs].every(
        Number.isFinite,
      ) ||
      Math.abs(a.startMs - v.startMs) > p.audioAlignmentToleranceMs ||
      Math.abs(a.startMs + a.durationMs - v.startMs - v.durationMs) >
        p.audioAlignmentToleranceMs
    )
      add("audio-alignment");
  }
  return Object.freeze({
    sourceByteDigest: input.sourceByteDigest,
    state:
      findings.length === 0
        ? ("ready-for-editorial-review" as const)
        : ("technical-checks-incomplete" as const),
    findings: Object.freeze(findings),
    notChecked: Object.freeze([
      "story",
      "motion",
      "dialogue",
      "lip-sync",
      "subtitles",
      "commercial-rights",
    ] as const),
  });
}
