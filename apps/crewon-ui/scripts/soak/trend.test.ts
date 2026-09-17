import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSoakTrend } from "./trend.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "crewon-soak-trend-"));
  roots.push(root);
  return { root, trend: createSoakTrend(root) };
};
const sample = (
  elapsedMs: number,
  metrics: Record<string, number | null> = { rss: 100, usage: null },
) => ({
  elapsedMs,
  sampledAt: new Date(1789100000000 + elapsedMs).toISOString(),
  metrics,
});

describe("full-run bounded trend evidence", () => {
  it("retains the initial interval and all five-minute intervals across seven simulated days", () => {
    const { root, trend } = fixture();
    for (
      let elapsedMs = 0;
      elapsedMs <= 7 * 24 * 60 * 60 * 1000;
      elapsedMs += 30_000
    )
      trend.observe(sample(elapsedMs));
    const rows = readFileSync(join(root, "trend.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2016);
    expect(rows[0]).toMatchObject({
      index: 0,
      firstElapsedMs: 0,
      samples: 10,
      maxGapMs: 30_000,
    });
    expect(rows.at(-1).index).toBe(2015);
    expect(
      JSON.parse(readFileSync(join(root, "trend-current.json"), "utf8")),
    ).toMatchObject({ index: 2016, samples: 1 });
    expect(statSync(join(root, "trend.jsonl")).size).toBeLessThan(
      16 * 1024 ** 2,
    );
    expect(trend.snapshot()).toMatchObject({
      completedBuckets: 2016,
      rotations: 0,
    });
  });
  it("keeps extrema, endpoint values and missing observations without inventing zeroes", () => {
    const { root, trend } = fixture();
    trend.observe(sample(0, { rss: 100, usage: null }));
    trend.observe(sample(30_000, { rss: 400, usage: 70 }));
    trend.observe(sample(60_000, { rss: 200, usage: null }));
    const current = JSON.parse(
      readFileSync(join(root, "trend-current.json"), "utf8"),
    );
    expect(current.metrics).toEqual({
      rss: { count: 3, first: 100, last: 200, min: 100, max: 400 },
      usage: { count: 1, first: null, last: null, min: 70, max: 70 },
    });
  });
  it("records missing intervals as sampling gaps, not continuous activity", () => {
    const { root, trend } = fixture();
    trend.observe(sample(0));
    trend.observe(sample(3_600_000));
    expect(
      readFileSync(join(root, "trend.jsonl"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(root, "trend-current.json"), "utf8")),
    ).toMatchObject({ index: 12, samples: 1, maxGapMs: 3_600_000 });
  });
  it("rejects non-finite data, clock reversal, changing metrics and unbounded duration", () => {
    const { trend } = fixture();
    trend.observe(sample(100));
    expect(() => trend.observe(sample(99))).toThrow("soak_trend_time_invalid");
    expect(() =>
      trend.observe(sample(200, { rss: Infinity, usage: null })),
    ).toThrow("soak_trend_value_invalid");
    expect(() => trend.observe(sample(200, { other: 1 }))).toThrow(
      "soak_trend_metrics_changed",
    );
    expect(() => trend.observe(sample(2018 * 300_000))).toThrow(
      "soak_trend_duration_budget",
    );
    expect(() => createSoakTrend(roots[0]!)).toThrow();
  });
});
