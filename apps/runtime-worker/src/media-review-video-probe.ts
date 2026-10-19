import type { ProjectMediaVideoMetadata } from "@crewon/application";
export type MediaVideoMetadata = ProjectMediaVideoMetadata;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("probe_invalid");
  return value as Record<string, unknown>;
}
function numeric(value: unknown, maximum: number): number {
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error("probe_invalid");
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/u.test(value))
    throw new Error("probe_invalid");
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > maximum)
    throw new Error("probe_invalid");
  return result;
}
function optionalTime(value: unknown): number | null {
  if (value === undefined || value === "N/A") return null;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value))
    throw new Error("probe_invalid");
  const result = Number(value) * 1000;
  if (!Number.isFinite(result) || Math.abs(result) > 601_000)
    throw new Error("probe_invalid");
  return result;
}
function codec(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,64}$/u.test(value))
    throw new Error("probe_invalid");
  return value;
}

/** Projects only technical fields; never returns arbitrary tags, paths or titles. */
export function parseMediaVideoProbe(bytes: Buffer): MediaVideoMetadata {
  const root = record(JSON.parse(bytes.toString("utf8")));
  const format = record(root.format);
  if (format.format_name !== "mov,mp4,m4a,3gp,3g2,mj2")
    throw new Error("probe_invalid");
  if (
    !Array.isArray(root.streams) ||
    root.streams.length < 1 ||
    root.streams.length > 8
  )
    throw new Error("probe_invalid");
  const streams = root.streams.map(record);
  const videos = streams.filter((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  if (
    videos.length !== 1 ||
    audios.length > 1 ||
    record(videos[0]!.disposition).attached_pic !== 0
  )
    throw new Error("probe_invalid");
  const v = videos[0]!;
  if (
    typeof v.avg_frame_rate !== "string" ||
    !/^\d+\/\d+$/u.test(v.avg_frame_rate)
  )
    throw new Error("probe_invalid");
  const [n, d] = v.avg_frame_rate.split("/").map(Number);
  const fps = numeric(n! / d!, 120);
  const width = numeric(v.width, 4096),
    height = numeric(v.height, 4096);
  if (!Number.isInteger(width) || !Number.isInteger(height))
    throw new Error("probe_invalid");
  let sampleAspectRatio: number | null = null;
  if (v.sample_aspect_ratio !== undefined && v.sample_aspect_ratio !== "N/A") {
    if (
      typeof v.sample_aspect_ratio !== "string" ||
      !/^\d+:\d+$/u.test(v.sample_aspect_ratio)
    )
      throw new Error("probe_invalid");
    const [numerator, denominator] = v.sample_aspect_ratio
      .split(":")
      .map(Number);
    sampleAspectRatio = numeric(numerator! / denominator!, 100);
  }
  const rotations =
    v.side_data_list === undefined
      ? []
      : Array.isArray(v.side_data_list) && v.side_data_list.length <= 8
        ? v.side_data_list.map(record).filter((s) => s.rotation !== undefined)
        : null;
  if (rotations === null || rotations.length > 1)
    throw new Error("probe_invalid");
  const rotationDegrees = rotations[0]?.rotation ?? 0;
  if (
    typeof rotationDegrees !== "number" ||
    ![0, 90, -90, 180, -180].includes(rotationDegrees)
  )
    throw new Error("probe_invalid");
  const a = audios[0];
  const sampleRate = a ? numeric(a.sample_rate, 192000) : null;
  const channels = a ? numeric(a.channels, 8) : null;
  if (a && (!Number.isInteger(sampleRate) || !Number.isInteger(channels)))
    throw new Error("probe_invalid");
  return Object.freeze({
    durationMs: numeric(format.duration, 600) * 1000,
    video: Object.freeze({
      codec: codec(v.codec_name),
      width,
      height,
      framesPerSecond: fps,
      sampleAspectRatio,
      rotationDegrees,
      startMs: optionalTime(v.start_time),
      durationMs: optionalTime(v.duration),
    }),
    audio: a
      ? Object.freeze({
          codec: codec(a.codec_name),
          sampleRate: sampleRate!,
          channels: channels!,
          startMs: optionalTime(a.start_time),
          durationMs: optionalTime(a.duration),
        })
      : null,
  });
}

export const MEDIA_VIDEO_PROBE_ARGS = [
  "-v",
  "error",
  "-threads",
  "1",
  "-max_alloc",
  "67108864",
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
  "-show_entries",
  "format=duration,format_name:stream=codec_name,codec_type,width,height,avg_frame_rate,duration,start_time,sample_rate,channels,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation",
  "-of",
  "json",
] as const;
