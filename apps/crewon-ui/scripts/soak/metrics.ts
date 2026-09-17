import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Test-only, fixed-size latest sample; does not store prompts or force garbage collection. */
export function startSoakMetrics(root: string, role: string) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const filename = join(root, `process-${role}-${process.pid}.json`);
  const sample = () => {
    const resources: Record<string, number> = {};
    for (const name of process.getActiveResourcesInfo()) {
      const key =
        Object.keys(resources).length < 32 || name in resources
          ? name
          : "other";
      resources[key] = (resources[key] ?? 0) + 1;
    }
    const value = {
      pid: process.pid,
      role,
      sampledAt: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      memory: process.memoryUsage(),
      resources,
      cpu: process.cpuUsage(),
      eventLoopP99Ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
      eventLoopMaxMs: histogram.count ? histogram.max / 1e6 : null,
    };
    writeFileSync(`${filename}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${filename}.tmp`, filename);
    histogram.reset();
    return value;
  };
  let latest = sample();
  const timer = setInterval(() => {
    latest = sample();
  }, 30_000);
  timer.unref();
  const close = () => {
    clearInterval(timer);
    histogram.disable();
    sample();
  };
  process.once("exit", close);
  return {
    snapshot: () => latest,
    close: () => {
      process.off("exit", close);
      close();
    },
  };
}
