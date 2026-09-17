import { startSoakMetrics } from "./metrics.ts";
const root = process.env.CREWON_SOAK_METRICS_ROOT;
const entry = process.argv[1] ?? "";
if (root && entry.endsWith("/main.ts"))
  startSoakMetrics(root, entry.includes("control-api") ? "control" : "worker");
