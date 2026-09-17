import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SOAK_TREND_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BUCKETS = 2018; // Seven days, plus one interval for an in-flight turn to finish.
const MAX_LINE_BYTES = 8192;
const MAX_METRICS = 32;

type Range = {
  count: number;
  first: number | null;
  last: number | null;
  min: number | null;
  max: number | null;
};
type Bucket = {
  index: number;
  firstElapsedMs: number;
  lastElapsedMs: number;
  firstSampledAt: string;
  lastSampledAt: string;
  samples: number;
  maxGapMs: number;
  metrics: Record<string, Range>;
};

/** Fixed-size aggregation; raw observation rotation cannot erase the start of the run. */
export function createSoakTrend(root: string) {
  const filename = join(root, "trend.jsonl"),
    current = join(root, "trend-current.json");
  writeFileSync(filename, "", { flag: "wx", mode: 0o600 });
  let bucket: Bucket | null = null,
    lastElapsedMs: number | null = null;
  let bytes = 0,
    completedBuckets = 0;
  let keys: string[] | null = null;
  const encode = (value: Bucket) => {
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > MAX_LINE_BYTES)
      throw new Error("soak_trend_line_budget");
    return line;
  };
  return {
    observe(input: {
      elapsedMs: number;
      sampledAt: string;
      metrics: Record<string, number | null>;
    }) {
      if (
        !Number.isFinite(input.elapsedMs) ||
        input.elapsedMs < 0 ||
        (lastElapsedMs !== null && input.elapsedMs < lastElapsedMs)
      )
        throw new Error("soak_trend_time_invalid");
      if (
        typeof input.sampledAt !== "string" ||
        input.sampledAt.length > 40 ||
        !Number.isFinite(Date.parse(input.sampledAt))
      )
        throw new Error("soak_trend_timestamp_invalid");
      const index = Math.floor(input.elapsedMs / SOAK_TREND_INTERVAL_MS);
      if (index >= MAX_BUCKETS) throw new Error("soak_trend_duration_budget");
      const nextKeys = Object.keys(input.metrics).sort();
      if (
        !nextKeys.length ||
        nextKeys.length > MAX_METRICS ||
        nextKeys.some((key) => !/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key))
      )
        throw new Error("soak_trend_metrics_invalid");
      if (keys && JSON.stringify(keys) !== JSON.stringify(nextKeys))
        throw new Error("soak_trend_metrics_changed");
      for (const value of Object.values(input.metrics))
        if (
          value !== null &&
          (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        )
          throw new Error("soak_trend_value_invalid");
      keys ??= nextKeys;
      if (bucket && bucket.index !== index) {
        const line = encode(bucket);
        appendFileSync(filename, line);
        bytes += Buffer.byteLength(line);
        completedBuckets++;
        bucket = null;
      }
      bucket ??= {
        index,
        firstElapsedMs: input.elapsedMs,
        lastElapsedMs: input.elapsedMs,
        firstSampledAt: input.sampledAt,
        lastSampledAt: input.sampledAt,
        samples: 0,
        maxGapMs: 0,
        metrics: Object.create(null) as Record<string, Range>,
      };
      bucket.lastElapsedMs = input.elapsedMs;
      bucket.lastSampledAt = input.sampledAt;
      bucket.samples++;
      bucket.maxGapMs = Math.max(
        bucket.maxGapMs,
        lastElapsedMs === null ? 0 : input.elapsedMs - lastElapsedMs,
      );
      lastElapsedMs = input.elapsedMs;
      for (const key of keys) {
        const value = input.metrics[key]!;
        const range = (bucket.metrics[key] ??= {
          count: 0,
          first: null,
          last: null,
          min: null,
          max: null,
        });
        if (bucket.samples === 1) range.first = value;
        range.last = value;
        if (value !== null) {
          range.count++;
          range.min = range.min === null ? value : Math.min(range.min, value);
          range.max = range.max === null ? value : Math.max(range.max, value);
        }
      }
      writeFileSync(`${current}.tmp`, encode(bucket), { mode: 0o600 });
      renameSync(`${current}.tmp`, current);
    },
    snapshot: () => ({
      completedBuckets,
      completedBytes: bytes,
      currentBucket: bucket?.index ?? null,
      intervalMs: SOAK_TREND_INTERVAL_MS,
      maxBuckets: MAX_BUCKETS,
      maxLineBytes: MAX_LINE_BYTES,
      rotations: 0,
    }),
  };
}
